# Walkthrough: mint a collection on Ethereum or Base

Each collection gets **its own ERC-721 contract** that you deploy and own. **Base** is a layer built on Ethereum (run by
Coinbase) with the same wallets and addresses but fees of **cents instead of dollars**. OpenSea and the main wallets show both.

> **Practice first on Base Sepolia (or Sepolia)**: free test ETH, and practice records are kept apart from the real ones.

## What you need
- **A browser wallet:** MetaMask, Rabby, Coinbase Wallet or any other (a Ledger works through them). There's nothing else to
  set up: the page talks to the network through your wallet.
- **A place for the art on IPFS:** your own IPFS node, Pinata, or both.
- **Some ETH on the network you chose.** Deploying uses about 1.7 million gas and each piece about 30 thousand. On **Base**
  a whole collection usually costs a few dollars at most; on **Ethereum** the deploy alone can cost a few to tens of dollars.
  The page shows the exact estimate before each step.

## 1. Set up the app for Ethereum / Base
1. Start the minter (`./run.sh`, or `run.bat` on Windows). The setup wizard opens.
2. At **"What are you minting on?"** pick **💠 Ethereum / Base**.
3. **Ethereum / Base settings**:
   - **Network:** **🧪 Base Sepolia** (start here) or **🧪 Sepolia** to practice; **🔵 Base** or **💠 Ethereum mainnet** for real.
   - **Mint to:** leave blank to mint to the wallet you deploy with, or paste another `0x…` address.
4. **Where your art lives (IPFS)**: your node, Pinata, or both, then **Test**.
5. Optional: AI stories and rarity (needs Ollama), then set the **royalty %** and **✓ Save and open the minter**.

Free test ETH for Base Sepolia and Sepolia: the faucets run by Coinbase's developer platform and by Alchemy.

## 2. Build and store the collection
On the main page: name it, **⬆ Add images**, write the stories and rarity with **✨ AI** (or the manual builder), review every
piece, then press **☁ Store on IPFS**.

## 3. Deploy and mint (the Ethereum page)
Press **🔵 Go to mint on Base →** (or **💠 Go to mint on Ethereum →**).

1. **Connect your wallet**: press **Connect MetaMask** (or whichever wallet it lists). The page asks the wallet to switch
   to the right network and adds it if the wallet doesn't know it yet.
2. **Deploy the collection contract**:
   - **Symbol** (a short ticker, 1–10 letters/digits), **Royalty %**, **Royalty goes to** (blank = the connected wallet).
   - On mainnet, tick **"I understand this spends real ETH."**
   - Press **🚀 Deploy** and approve. The connected wallet becomes the contract's owner.
3. **Mint the pieces**:
   - **Pieces per transaction** (100 on Ethereum, 150 on Base are comfortable) and **Mint to** (blank = the connected wallet).
   - On mainnet, tick **"I understand this spends real ETH and minting can't be undone."**
   - Press **🪙 Mint**: one approval per batch, and the page keeps going until every piece is out.
   The contract numbers the pieces itself and refuses a batch that's already minted, so a closed page, a double click or a
   replayed transaction can **never mint extra**. If anything stops, press **Mint** again: it carries on from where the chain is.

## After minting
- **Edited something?** Press **☁ Store on IPFS** again, then **↻ Re-point to the latest version**: one transaction moves every
  piece to the new links and tells marketplaces to refresh.
- **Royalty (ERC-2981):** up to 30%, to any address, any time: **% Set the royalty above**.
- **🔒 Freeze forever:** type `FREEZE` and press **Freeze the links**. After that no link can ever change again.
- **Show the contract as "verified" on Etherscan/Basescan:** on your contract's page choose *Verify and Publish →
  Solidity (Standard-Json-Input)*, compiler **v0.8.37**, and upload `contracts/SonOfSatoshiCollection.verify.json` from this repo.

The contract source is [`contracts/SonOfSatoshiCollection.sol`](../contracts/SonOfSatoshiCollection.sol) (OpenZeppelin 5.6.1).
More detail: the in-app **Guide → 18. Ethereum and Base**.
