import { useEffect, useState } from "react";
import parser from "@solidity-parser/parser"
import styles from "./FunctionParser.module.css";
import CopyToClipboardButton from "./CopyToClipboardButton";
import { FunctionDefinition } from "@solidity-parser/parser/dist/src/ast-types";

const DEFAULT_TEXT = ""
const DEFAULT_TEXT_DEP = `
// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol';
import '@openzeppelin/contracts/access/Ownable.sol';
import './Interfaces/ISwapPair.sol';
import './Dependencies/LiquityBase.sol';
import './Interfaces/ISwapOperations.sol';
import './Interfaces/IBorrowerOperations.sol';
import './Interfaces/ITokenManager.sol';
import './Dependencies/CheckContract.sol';
import './Interfaces/IPriceFeed.sol';
import './Interfaces/ITroveManager.sol';
import './Interfaces/IStakingOperations.sol';

contract SwapOperations is ISwapOperations, Ownable(msg.sender), CheckContract, LiquityBase {
  // --- Connected contract declarations ---

  ITroveManager public troveManager;
  IBorrowerOperations public borrowerOperations;
  IPriceFeed public priceFeed;
  ITokenManager public tokenManager;
  IStakingOperations public stakingOperations;

  // --- Data structures ---

  uint public swapBaseFee = 0.003e18; // 0.3% /// @audit Should limit in some way
  uint public govSwapFee = 0.5e18; // 50% of the final (base + dynamic) swap fee

  mapping(address => mapping(address => address)) public getPair;
  mapping(address => bool) public isPair;
  address[] public allPairs;

  // --- Dependency setters ---

  function setAddresses(
    address _borrowerOperationsAddress,
    address _troveManagerAddress,
    address _priceFeedAddress,
    address _tokenManager,
    address _stakingOperations
  ) external onlyOwner {
    checkContract(_borrowerOperationsAddress);
    checkContract(_troveManagerAddress);
    checkContract(_priceFeedAddress);
    checkContract(_tokenManager);
    checkContract(_stakingOperations);

    borrowerOperations = IBorrowerOperations(_borrowerOperationsAddress);
    troveManager = ITroveManager(_troveManagerAddress);
    priceFeed = IPriceFeed(_priceFeedAddress);
    tokenManager = ITokenManager(_tokenManager);
    stakingOperations = IStakingOperations(_stakingOperations);

    emit SwapOperationsInitialized(
      _borrowerOperationsAddress,
      _troveManagerAddress,
      _priceFeedAddress,
      _tokenManager,
      _stakingOperations
    );
  }

  modifier ensure(uint deadline) {
    if (deadline < block.timestamp) revert Expired();
    _;
  }

  // --- Pair Management ---

  function allPairsLength() external view returns (uint) {
    return allPairs.length;
  }

  function createPair(address _plainSwapPair, address tokenA, address tokenB) external onlyOwner {
    if (tokenA == tokenB) revert IdenticalAddresses();
    if (tokenA != address(tokenManager.getStableCoin()) && tokenB != address(tokenManager.getStableCoin()))
      revert PairRequiresStable();

    (address token0, address token1) = sortTokens(tokenA, tokenB);
    if (token0 == address(0)) revert ZeroAddress();
    if (getPair[token0][token1] != address(0)) revert PairExists(); // single check is sufficient
    /// @audit QA: Why not just deploy the Pair here?
    ISwapPair pair = ISwapPair(_plainSwapPair);
    ISwapPair(pair).initialize(token0, token1, address(tokenManager), address(priceFeed), address(stakingOperations));

    getPair[token0][token1] = _plainSwapPair;
    getPair[token1][token0] = _plainSwapPair; // populate mapping in the reverse direction
    allPairs.push(_plainSwapPair);
    isPair[_plainSwapPair] = true;

    // initialize staking
    stakingOperations.setPool(pair, 0);

    emit PairCreated(token0, token1, _plainSwapPair, allPairs.length);
  }

  function getSwapBaseFee() external view returns (uint) {
    return swapBaseFee;
  }

  function setSwapBaseFee(uint _swapBaseFee) external onlyOwner {
    if (_swapBaseFee > DECIMAL_PRECISION) revert FeeExceedMaxPercentage();
    swapBaseFee = _swapBaseFee;
  }

  function getGovSwapFee() external view returns (uint) {
    return govSwapFee;
  }

  function setGovSwapFee(uint _govSwapFee) external onlyOwner {
    if (_govSwapFee > DECIMAL_PRECISION) revert FeeExceedMaxPercentage();
    govSwapFee = _govSwapFee;
  }

  // --- Getter functions ---

  function quote(uint amountA, uint reserveA, uint reserveB) public pure virtual override returns (uint amountB) {
    if (amountA == 0) revert InsufficientAmount();
    if (reserveA == 0 || reserveB == 0) revert InsufficientLiquidity();

    amountB = (amountA * reserveB) / reserveA;
  }

  function getAmountsOut(
    uint amountIn,
    address[] memory path
  ) public view virtual override returns (SwapAmount[] memory amounts) {
    if (path.length < 2) revert InvalidPath();

    amounts = new SwapAmount[](path.length);
    for (uint i; i < path.length - 1; i++) {
      if (amountIn == 0) revert InsufficientInputAmount();

      (address token0, address token1) = sortTokens(path[i], path[i + 1]);
      address pairAddress = getPair[token0][token1];
      if (pairAddress == address(0)) revert PairDoesNotExist();

      ISwapPair pair = ISwapPair(pairAddress);
      (uint reserve0, uint reserve1, ) = pair.getReserves();
      if (reserve0 == 0 || reserve1 == 0) revert InsufficientLiquidity();

      uint feePercentage;
      uint reserveIn;
      uint reserveOut;
      if (path[i] == token0) {
        // amountIn is token0 of the pool pair /// @audit what are these multiplications?
        feePercentage = pair.getSwapFee(reserve0 + amountIn, (uint(reserve1) * reserve0) / (reserve0 + amountIn)); /// @audit Looks wrong
        reserveIn = reserve0; /// @audit Fee is accounting for amounts in but not amounts out (should be reserve 1 - amtOut)
        reserveOut = reserve1;
      } else {
        // amountIn is token1 of the pool pair
        feePercentage = pair.getSwapFee((uint(reserve0) * reserve1) / (reserve1 + amountIn), reserve1 + amountIn);
        reserveIn = reserve1;
        reserveOut = reserve0;
      }

      uint amountInFee = (amountIn * feePercentage) / DECIMAL_PRECISION;
      amounts[i] = SwapAmount(amountIn, amountInFee);

      // calculate amountOut, which will be amountIn in the next iteration
      uint amountInWithoutFee = amountIn - amountInFee; /// @audit TODO
      amountIn = (amountInWithoutFee * reserveOut) / (reserveIn + amountInWithoutFee);
    }
    amounts[amounts.length - 1] = SwapAmount(amountIn, 0); /// @audit Why is this excluding fees? | Why is this amountIn?
    /// @audit Can you sidestep fees, by just doing multiple one-step swaps?
    return amounts;
  }

  function getAmountsIn( // TODO
    uint amountOut,
    address[] memory path
  ) public view virtual override returns (SwapAmount[] memory amounts) {
    if (path.length < 2) revert InvalidPath();

    amounts = new SwapAmount[](path.length);
    amounts[amounts.length - 1] = SwapAmount(amountOut, 0); // Last one is amountOut | 0
    for (uint i = path.length - 1; i > 0; i--) { /// @audit TODO: this is in reverse
      if (amountOut == 0) revert InsufficientOutputAmount();

      (address token0, address token1) = sortTokens(path[i - 1], path[i]);
      address pairAddress = getPair[token0][token1];
      if (pairAddress == address(0)) revert PairDoesNotExist();

      ISwapPair pair = ISwapPair(pairAddress);
      (uint reserve0, uint reserve1, ) = pair.getReserves();
      if (reserve0 == 0 || reserve1 == 0) revert InsufficientLiquidity();

      uint feePercentage;
      if (path[i] == token0) {
        // amountOut is token0 of the pool pair
        feePercentage = pair.getSwapFee(reserve0 - amountOut, (uint(reserve0) * reserve1) / (reserve0 - amountOut));

        // calculate amountIn, which will be amountOut in the next iteration
        amountOut = ((reserve1 * amountOut) / (reserve0 - amountOut)) + 1;
      } else {
        // amountOut is token1 of the pool pair
        feePercentage = pair.getSwapFee((uint(reserve0) * reserve1) / (reserve1 - amountOut), reserve1 - amountOut);

        // calculate amountIn, which will be amountOut in the next iteration
        amountOut = ((reserve0 * amountOut) / (reserve1 - amountOut)) + 1;
      }

      uint amountInFee = (amountOut * feePercentage) / DECIMAL_PRECISION;
      amountOut += amountInFee;
      amounts[i - 1] = SwapAmount(amountOut, amountInFee);
    }

    return amounts;
  }

  // --- Liquidity functions ---

  struct ProvidingVars {
    address pair;
    uint senderBalanceA;
    uint senderBalanceB;
    uint fromBalanceA;
    uint fromBalanceB;
    uint fromMintA;
    uint fromMintB;
    uint reserveA;
    uint reserveB;
  }

  function addLiquidity(
    address tokenA,
    address tokenB,
    uint amountADesired,
    uint amountBDesired,
    uint amountAMin,
    uint amountBMin,
    PriceUpdateAndMintMeta memory _priceAndMintMeta,
    uint deadline
  ) public payable virtual override ensure(deadline) returns (uint amountA, uint amountB, uint liquidity) {
    ProvidingVars memory vars;
    vars.pair = getPair[tokenA][tokenB]; /// @audit QA not sorting tokens means this can revert | No fix is ok but it's a gotcha
    if (vars.pair == address(0)) revert PairDoesNotExist();
    /// @audit not checking that min < desired
    {
      (vars.reserveA, vars.reserveB) = getReserves(tokenA, tokenB);
      if (vars.reserveA == 0 && vars.reserveB == 0) {
        (amountA, amountB) = (amountADesired, amountBDesired); /// @audit First LP Can attack by massively imbalancing by performing a single sided swap or similar
      } else {
        uint amountBOptimal = quote(amountADesired, vars.reserveA, vars.reserveB);
        if (amountBOptimal <= amountBDesired) {
          if (amountBOptimal < amountBMin) revert InsufficientBAmount();
          (amountA, amountB) = (amountADesired, amountBOptimal);
        } else {
          uint amountAOptimal = quote(amountBDesired, vars.reserveB, vars.reserveA);
          assert(amountAOptimal <= amountADesired); /// @audit Looks wrong
          if (amountAOptimal < amountAMin) revert InsufficientAAmount();
          (amountA, amountB) = (amountAOptimal, amountBDesired);
        }
      }
    }
    // AmountA and B = Amts after optimal math

    vars.senderBalanceA = IERC20(tokenA).balanceOf(msg.sender);
    vars.senderBalanceB = IERC20(tokenB).balanceOf(msg.sender);
    // Pick Min between available and optimal
    vars.fromBalanceA = LiquityMath._min(vars.senderBalanceA, amountA); /// @audit WHY?
    vars.fromBalanceB = LiquityMath._min(vars.senderBalanceB, amountB);
    // Optimal - From Balance
    vars.fromMintA = amountA - vars.fromBalanceA;
    vars.fromMintB = amountB - vars.fromBalanceB;

    // mint new tokens if the sender did not have enough
    if (vars.fromMintA != 0 || vars.fromMintB != 0) {
      TokenAmount[] memory debtsToMint;
      if (vars.fromMintA != 0 && vars.fromMintB != 0) {
        // mint both
        debtsToMint = new TokenAmount[](2);
        debtsToMint[0] = TokenAmount(tokenA, vars.fromMintA);
        debtsToMint[1] = TokenAmount(tokenB, vars.fromMintB);
      } else {
        // mint only 1 token
        debtsToMint = new TokenAmount[](1);
        debtsToMint[0] = (
          vars.fromMintA != 0
            ? TokenAmount(tokenA, vars.fromMintA) // mint A
            : TokenAmount(tokenB, vars.fromMintB) // mint B
        );
      }
      borrowerOperations.increaseDebt{ value: msg.value }(
        msg.sender, // OK 
        vars.pair, // OK
        debtsToMint, // OK - See above
        _priceAndMintMeta.meta, /// @audit this looks griefable | TODO
        _priceAndMintMeta.priceUpdateData // TODO
      );
    }

    // transfer tokens sourced from senders balance
    if (vars.fromBalanceA != 0) safeTransferFrom(tokenA, msg.sender, vars.pair, vars.fromBalanceA);
    if (vars.fromBalanceB != 0) safeTransferFrom(tokenB, msg.sender, vars.pair, vars.fromBalanceB);

    // deposit into staking
    liquidity = ISwapPair(vars.pair).mint(msg.sender); /// @audit-ok this doesn't send tokens, it credits the stakingPool Deposit to msg.sender
  }

  function addLiquidityWithPermit(
    address tokenA,
    address tokenB,
    uint amountADesired,
    uint amountBDesired,
    uint amountAMin,
    uint amountBMin,
    PriceUpdateAndMintMeta memory _priceAndMintMeta,
    uint deadline,
    uint8[] memory v,
    bytes32[] memory r,
    bytes32[] memory s
  ) external payable returns (uint amountA, uint amountB, uint liquidity) { /// @audit QA: Permits will have some dangling allowances
    IERC20Permit(tokenA).permit(msg.sender, address(this), amountADesired, deadline, v[0], r[0], s[0]);
    IERC20Permit(tokenB).permit(msg.sender, address(this), amountBDesired, deadline, v[1], r[1], s[1]);
    return
      addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin, _priceAndMintMeta, deadline);
  }

  struct RemovalVars {
    address token0;
    address token1;
    uint amount0;
    uint amount1;
    uint burned0;
    uint burned1;
    address pair;
  }

  struct RemoveLiquidityParams {
    address tokenA;
    address tokenB;
    uint liquidity;
    uint amountAMin;
    uint amountBMin;
    address upperHint;
    address lowerHint;
    uint deadline;
    bytes[] priceUpdateData;
  }

  function removeLiquidity(
    address tokenA,
    address tokenB,
    uint liquidity,
    uint amountAMin,
    uint amountBMin,
    address _upperHint,
    address _lowerHint,
    uint deadline,
    bytes[] memory _priceUpdateData
  ) public payable virtual override ensure(deadline) returns (uint amountA, uint amountB) {
    return
      _removeLiquidity(
        RemoveLiquidityParams({
          tokenA: tokenA,
          tokenB: tokenB,
          liquidity: liquidity,
          amountAMin: amountAMin,
          amountBMin: amountBMin,
          upperHint: _upperHint,
          lowerHint: _lowerHint,
          deadline: deadline,
          priceUpdateData: _priceUpdateData
        })
      );
  }

  function _removeLiquidity(
    RemoveLiquidityParams memory _params
  ) internal ensure(_params.deadline) returns (uint amountA, uint amountB) {
    RemovalVars memory vars;
    (vars.token0, vars.token1) = sortTokens(_params.tokenA, _params.tokenB);

    // update prices and build price cache
    priceFeed.updatePythPrices{ value: msg.value }(_params.priceUpdateData);

    // receive tokens from pair
    vars.pair = getPair[_params.tokenA][_params.tokenB]; /// @audit QA: Not checking for pair existence
    (vars.amount0, vars.amount1, vars.burned0, vars.burned1) = ISwapPair(vars.pair).burn(
      msg.sender,
      _params.liquidity,
      // check if there are some debts which has to be repaid first, skipping borrowing fee interest calculation here, to safe gas
      tokenManager.isDebtToken(vars.token0)
        ? troveManager.getTroveRepayableDebt(msg.sender, vars.token0, false, false)
        : 0,
      tokenManager.isDebtToken(vars.token1)
        ? troveManager.getTroveRepayableDebt(msg.sender, vars.token1, false, false)
        : 0
    ); /// @audit what's the deal with interest fee? TODO: Deeper

    // handle trove debt repayment
    if (vars.burned0 != 0 || vars.burned1 != 0) {
      TokenAmount[] memory debtsToRepay;
      if (vars.burned0 != 0 && vars.burned1 != 0) {
        // repay both
        debtsToRepay = new TokenAmount[](2);
        debtsToRepay[0] = TokenAmount(vars.token0, vars.burned0); /// @audit How do you fully repay? | Can you overpay = DOS revert?
        debtsToRepay[1] = TokenAmount(vars.token1, vars.burned1); /// @audit what happens when you own more than what you need to repay?
      } else {
        // repay only 1 token
        debtsToRepay = new TokenAmount[](1);
        debtsToRepay[0] = (
          vars.burned0 != 0 ? TokenAmount(vars.token0, vars.burned0) : TokenAmount(vars.token1, vars.burned1)
        );
      } /// TODO: Check BO | Prices are validated here | Sends underlying to 'msg.sender' if available
      borrowerOperations.repayDebtFromPoolBurn(msg.sender, debtsToRepay, _params.upperHint, _params.lowerHint);
    }

    (amountA, amountB) = _params.tokenA == vars.token0 ? (vars.amount0, vars.amount1) : (vars.amount1, vars.amount0);
    if (amountA < _params.amountAMin) revert InsufficientAAmount();
    if (amountB < _params.amountBMin) revert InsufficientBAmount();
    return (amountA, amountB);
  }

  // --- Swap functions ---

  struct SwapVars {
    address input;
    address output;
    address token0;
    uint amountInFee;
    uint amountOut;
    uint amount0InFee;
    uint amount1InFee;
    uint amount0Out;
    uint amount1Out;
    address to;
  }

  // requires the initial amount to have already been sent to the first pair
  function _swap(
    SwapAmount[] memory amounts,
    address[] memory path,
    address _to,
    bytes[] memory _priceUpdateData,
    bool _skipUpdate
  ) internal virtual {
    // update prices
    if (!_skipUpdate) priceFeed.updatePythPrices{ value: msg.value }(_priceUpdateData);

    SwapVars memory vars;
    for (uint i; i < path.length - 1; i++) {
      (vars.input, vars.output) = (path[i], path[i + 1]);
      (vars.token0, ) = sortTokens(vars.input, vars.output);

      vars.amountInFee = amounts[i].fee;
      vars.amountOut = amounts[i + 1].amount;
      (vars.amount0InFee, vars.amount1InFee) = (
        vars.input == vars.token0 ? (vars.amountInFee, uint(0)) : (uint(0), vars.amountInFee)
      );
      (vars.amount0Out, vars.amount1Out) = (
        vars.input == vars.token0 ? (uint(0), vars.amountOut) : (vars.amountOut, uint(0))
      );
      /// @audit is this safe? It will overflow when path.length <= 1 | Also path[i+2] can go OOB but that seems safe
      vars.to = i < path.length - 2 ? getPair[vars.output][path[i + 2]] : _to;
      ISwapPair(getPair[vars.input][vars.output]).swap( /// @audit IMO needs to have a fee checked here
        vars.amount0InFee,
        vars.amount1InFee,
        vars.amount0Out,
        vars.amount1Out,
        vars.to
      );
    }
  }

  function swapExactTokensForTokens(
    uint amountIn,
    uint amountOutMin,
    address[] calldata path,
    address to,
    uint deadline,
    bytes[] memory _priceUpdateData
  ) public payable virtual override ensure(deadline) returns (SwapAmount[] memory amounts) {
    amounts = getAmountsOut(amountIn, path); /// @audit Used old prices
    if (amounts[amounts.length - 1].amount < amountOutMin) revert InsufficientOutputAmount();

    safeTransferFrom(path[0], msg.sender, getPair[path[0]][path[1]], amounts[0].amount);
    _swap(amounts, path, to, _priceUpdateData, false); /// @audit Updates prices after having used old prices
  }

  function swapTokensForExactTokens(
    uint amountOut,
    uint amountInMax,
    address[] calldata path,
    address to,
    uint deadline,
    bytes[] memory _priceUpdateData
  ) public payable virtual override ensure(deadline) returns (SwapAmount[] memory amounts) {
    amounts = getAmountsIn(amountOut, path);
    if (amounts[0].amount > amountInMax) revert ExcessiveInputAmount();

    safeTransferFrom(path[0], msg.sender, getPair[path[0]][path[1]], amounts[0].amount);
    _swap(amounts, path, to, _priceUpdateData, false);
  }

  function swapExactTokensForTokensWithPermit(
    uint amountIn,
    uint amountOutMin,
    address[] calldata path,
    address to,
    uint deadline,
    uint8 v,
    bytes32 r,
    bytes32 s,
    bytes[] memory _priceUpdateData
  ) external payable returns (SwapAmount[] memory amounts) {
    IERC20Permit(path[0]).permit(msg.sender, address(this), amountIn, deadline, v, r, s);
    return swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline, _priceUpdateData);
  }

  // --- Position functions ---

  function openLongPosition(
    uint stableToMintIn,
    uint debtOutMin,
    address debtTokenAddress,
    address to,
    MintMeta memory _mintMeta,
    uint deadline,
    bytes[] memory _priceUpdateData
  ) external payable override ensure(deadline) returns (SwapAmount[] memory amounts) {
    address[] memory path = new address[](2);
    path[0] = address(tokenManager.getStableCoin());
    path[1] = debtTokenAddress;

    return _openPosition(stableToMintIn, debtOutMin, path, to, _mintMeta, _priceUpdateData);
  }

  function openShortPosition(
    uint debtToMintIn,
    uint stableOutMin,
    address debtTokenAddress,
    address to,
    MintMeta memory _mintMeta,
    uint deadline,
    bytes[] memory _priceUpdateData
  ) external payable override ensure(deadline) returns (SwapAmount[] memory amounts) {
    address[] memory path = new address[](2);
    path[0] = debtTokenAddress;
    path[1] = address(tokenManager.getStableCoin());

    return _openPosition(debtToMintIn, stableOutMin, path, to, _mintMeta, _priceUpdateData);
  }

  function _openPosition(
    uint amountIn,
    uint amountOutMin,
    address[] memory path,
    address to,
    MintMeta memory _mintMeta,
    bytes[] memory _priceUpdateData
  ) internal returns (SwapAmount[] memory amounts) {
    address pair = getPair[path[0]][path[1]];
    if (pair == address(0)) revert PairDoesNotExist();

    amounts = getAmountsOut(amountIn, path);
    if (amounts[amounts.length - 1].amount < amountOutMin) revert InsufficientOutputAmount();
    /// @audit why not 'isDebtToken'?
    tokenManager.getDebtToken(path[0]); //check if debt token /// @audit-ok will not revert due to being stablecoin
    /// Unclear if you can pass random debts on the other part of the path, since the other token is not validated
    // mint the debt token and transfer it to the pair
    TokenAmount[] memory debtsToMint = new TokenAmount[](1);
    debtsToMint[0] = TokenAmount(path[0], amounts[0].amount);
    borrowerOperations.increaseDebt{ value: msg.value }(msg.sender, pair, debtsToMint, _mintMeta, _priceUpdateData);
    /// @audit need to ask more about this, since they are minting the other token as debt, which doesn't quite make sense to me
    // execute the swap (skip update, because increase debt already updated)
    _swap(amounts, path, to, _priceUpdateData, true);

    return amounts;
  }

  // --- Helper functions ---

  function getReserves(address tokenA, address tokenB) internal view returns (uint reserveA, uint reserveB) {
    address pairAddress = getPair[tokenA][tokenB];
    if (pairAddress == address(0)) revert PairDoesNotExist();

    ISwapPair pair = ISwapPair(pairAddress);
    (uint reserve0, uint reserve1, ) = pair.getReserves();

    (address token0, ) = sortTokens(tokenA, tokenB);
    if (tokenA == token0) return (reserve0, reserve1);
    return (reserve1, reserve0);
  }

  function sortTokens(address tokenA, address tokenB) internal view returns (address token0, address token1) {
    if (tokenA == tokenB) revert IdenticalAddresses();
    if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();

    address stableCoin = address(tokenManager.getStableCoin());
    if (tokenA == stableCoin) return (tokenA, tokenB);
    if (tokenB == stableCoin) return (tokenB, tokenA);
    return tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
  }

  function safeTransferFrom(address token, address from, address to, uint256 value) internal {
    // bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
    (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
    if (!success || (data.length > 0 && abi.decode(data, (bool)) == false)) revert TransferFromFailed();
  }
}
`

/// type location name


export interface FunctionInput {
  internalType: string;
  name: string;
  type: string; // Pretty sure we don't care about the type
}

interface FunctionAbi {
  name: string;
  stateMutability: "pure" | "constant" | "payable" | "view";
  inputs: FunctionInput[];
  outputs: FunctionOutput[];
  visibility: "default" | "external" | "internal" | "public" | "private";
}

export interface FunctionOutput {
  internalType: string;
  name?: string;
  type: string; // Pretty sure we don't care about the type
}

interface LibraryDetails {
  name: string, functions: FunctionDefinition[]
}


function parseText(text: string): LibraryDetails[] {
  let found: LibraryDetails[] = []

  // We need to return abi like
  // Function, inputs, etc...
  try {
    const ast = parser.parse(text)
    
    parser.visit(ast, {
      ContractDefinition: function (def) {
        const index = found.length;
        found.push({name: def.name, functions: []})
        parser.visit(def, {
          FunctionDefinition: function (def) {
            // @ts-ignore
            found[index].functions.push(def)
          },
        })
      },
    })
  } catch {

  }

  return found
}

export function getAbi(def: FunctionDefinition): FunctionAbi {
  if(!def?.name) {
    throw Error("No name")
  }
  if(!def?.stateMutability) {
    throw Error("No fn visibility")
  }
  return {
    // https://github.com/aave/protocol-v2/blob/master/contracts/protocol/libraries/configuration/ReserveConfiguration.sol
    // IMO for location we need custom ABI format
    name: def.name as string,
    visibility: def.visibility,
    stateMutability: def?.stateMutability,
    inputs: def.parameters.map(param => ({
      // @ts-ignore | Some types have name and not namePath
      internalType: "NOT IMPLEMENTED",
      name: param.name ? param.name : "",
      // export type TypeName = ElementaryTypeName | UserDefinedTypeName | Mapping | ArrayTypeName | FunctionTypeName;
      // @ts-ignore | Some types have name and not namePath
      type: param.typeName.name ? param.typeName?.name : param.typeName?.namePath
      // type: param.typeName ? param.typeName | ""
    })), 
    outputs: def.returnParameters ? def.returnParameters.map(param => ({
      // @ts-ignore | Some types have name and not namePath
      internalType: "NOT IMPLEMENTED",
      name: param.name ? param.name : "",
      // @ts-ignore | Some types have name and not namePath
      type: param.typeName.name ? param.typeName?.name : param.typeName?.namePath
      // type: param.typeName ? param.typeName | ""
    })) : [],  
  }

}

export function getAbis(defs: FunctionDefinition[]): FunctionAbi[] {
  return defs.map(def => getAbi(def))
}
export default function FunctionParser() {
  const [text, setText] = useState(DEFAULT_TEXT)
  const [parsed, setParsed] = useState<LibraryDetails[]>([])
  
  useEffect(() => {
    setParsed(parseText(text)) // TODO
  }, [text])


  // TODO Make Recon Boilerplate
  function makeText(parsed: LibraryDetails[]): string {
    return `
      ${Object.keys(parsed).map(entry => `
${entry}`).join("\n")}
`
  }
  return (
    <div>
      <div>
      <textarea defaultValue="Paste here" onChange={e => setText(e.target.value)}>
       
      </textarea>
      </div>
      <div>
      <CopyToClipboardButton text={makeText(parsed)} />
      </div>
      <div>
        <h2>List of all external functions with calls to external contracts</h2>
        {(parsed).map(entry => 
        <div className={styles.entry} key={entry.name}>
          <h3 >Library: {entry.name}</h3>
        </div>
        )}
      </div>

      <div>
        {parsed.map(entry => 
          JSON.stringify(getAbis(entry?.functions || []))
        )}
      </div>

      <CopyToClipboardButton text={makeText(parsed)} />

    </div>
  );
}
