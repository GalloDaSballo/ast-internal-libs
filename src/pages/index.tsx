import Head from "next/head";

import styles from "@/styles/Home.module.css";
import FunctionParser from "@/components/FunctionParser";

export default function Home() {
  return (
    <>
      <Head>
        <title>Function Lister</title>
        <meta name="description" content="Given Contract, list out all external and public functions" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <main className={`${styles.main}`}>
        <FunctionParser />
      </main>
    </>
  );
}
