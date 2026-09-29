# Walkthrough: mint a collection on Solana (Metaplex Core)

Your collection becomes a **Metaplex Core collection**, the current standard on Solana: one collection account holds the name,
the picture and the royalty, and every piece is a Core asset inside it. Magic Eden, Tensor and the main wallets show them.

> **Practice first on Devnet**: free test SOL, and devnet records never mix with mainnet ones.

## What you need
- **A Solana wallet** as a browser extension: **Phantom**, **Solflare** or **Backpack** (a Ledger works through them).
- **A place for the art on IPFS**: your own IPFS node, Pinata, or both (the setup explains each). Solana wallets need
  `https` links, so the links go through your public gateway if you set one, otherwise through ipfs.io.
- **Some SOL.** About **0.004 SOL per piece** (mostly a deposit that keeps the piece on Solana, plus Metaplex's 0.0015 SOL
  creation fee) and about **0.003 SOL once** for the collection. The mint page shows the exact estimate first.
- Optional: **your own RPC address**. The free public RPC is slow and rate-limited; for a big mainnet collection a free account
  at an RPC provider (Helius, QuickNode, Triton…) or your own node is smoother. It never leaves your computer.

## 1. Set up the app for Solana
1. Start the minter (`./run.sh`, or `run.bat` on Windows). The setup wizard opens.
2. At **"What are you minting on?"** pick **🟪 Solana**.
3. **Solana settings**:
   - **Network:** **🧪 Devnet** to practice, **🟪 Mainnet** for real.
   - **Solana RPC address:** leave blank for the free public one, or paste your own.
   - **Mint to:** leave blank to mint to the wallet you connect, or paste another Solana address.
   - Press **Test the connection**: it should say the network answers and Metaplex Core is there.
4. **Where your art lives (IPFS)**: your node, Pinata, or both, then **Test**.
5. Optional: AI stories and rarity (needs Ollama), then set the **royalty %** and **✓ Save and open the minter**.

In your wallet, switch to the same network. Phantom: turn on testnet mode in its developer settings and pick
Solana Devnet (Solflare and Backpack have the same switch).

## 2. Build and store the collection
On the main page: name it, **⬆ Add images**, write the stories and rarity with **✨ AI** (or the manual builder), review every
piece, then press **☁ Store on IPFS**.

## 3. Mint (the Solana page)
Press **🟪 Go to mint on Solana →**.

1. **Connect your wallet**: press **Connect Phantom** (or Solflare/Backpack). On devnet, **🚰 Get 2 free test SOL** tops you up.
2. **Create the collection**: set the **royalty %** and **who receives it** (blank = the connected wallet), then press
   **✨ Create the collection** and approve it in your wallet.
3. **Mint the pieces**:
   - Choose **from piece / to**, and **pieces per approval** (24 is comfortable: your wallet approves the whole batch in
     one prompt, about three pieces per transaction).
   - **Mint to**: blank = the connected wallet.
   - On mainnet, tick **"I understand this spends real SOL and minting can't be undone."**
   - Press **🪙 Mint** and approve. Big collections go in several batches.
   Every signed transaction is saved before it's sent: if the page closes, reopen it, and the app checks what landed and skips
   those pieces. **Nothing is ever minted twice.**
4. **Minted pieces**: the list shows every piece's address and whether it points at your latest version.

## After minting
- **Edited a story or a picture?** Press **☁ Store on IPFS** again on the main page, then **↻ Re-point minted pieces**: the
  collection and every piece switch to the new version.
- **Royalty:** change the % or receiver, then **% Set the royalty above**.
- **🔒 Lock forever:** type `LOCK` and press **Lock the collection**. After that nobody, you included, can change a name or link
  again (the royalty can still change). Only do it when everything is final.

More detail: the in-app **Guide → 17. Solana**.
