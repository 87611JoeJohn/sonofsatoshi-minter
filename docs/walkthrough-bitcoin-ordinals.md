# Walkthrough: inscribe a collection on Bitcoin (Ordinals)

Your art and its story are written **directly onto Bitcoin**. There's no IPFS, no gateway and nothing to keep online: once
inscribed, it's there forever. There's no contract and no royalty either: each piece is its own inscription.

> **Practice first on Testnet4.** It works exactly like the real thing with free test coins. Only switch to mainnet once a
> couple of test pieces went through end to end.

## What you need
- **An ordinals-aware wallet**: Xverse or Leather. You'll give the app two of its addresses:
  - your **Ordinals address** (taproot, starts with `bc1p`, or `tb1p` on testnet): the inscriptions land here.
    Never use an ordinary Bitcoin wallet for inscriptions: it can spend them as fees without warning.
  - a **refund address** (any of your Bitcoin addresses): leftover coins come back here.
- **A data source** to read the chain and send transactions: mempool.space (nothing to run), your own mempool/esplora
  server, or your own Bitcoin Core node (fully sovereign).
- Your art in a folder. Small files cost less (see step 3).

## 1. Set up the app for Bitcoin
1. Start the minter (`./run.sh`, or `run.bat` on Windows). The setup wizard opens.
2. At **"What are you minting on?"** pick **🟠 Bitcoin Ordinals**.
3. **Bitcoin settings**:
   - **Network:** **🧪 Testnet4** to practice (switch Xverse to Testnet4 too: Settings → Network), **🟠 Mainnet** for real.
   - Paste your **Ordinals address** and your **refund address**.
   - **Where to read the chain:** **🌐 mempool.space** (easiest) or **🏠 My own Bitcoin Core node** (fill in its RPC
     address, user and password).
   - Press **Test the connection**: it should say which network and block it sees.
4. Optional: AI stories and rarity (needs Ollama), then **✓ Save and open the minter**.

## 2. Build the collection
On the main page: name the collection, **⬆ Add images**, then write the stories and rarity with **✨ AI** (or the manual
builder). Review every piece, since inscriptions can never be edited. There is no "Store on IPFS" step for Ordinals.

## 3. Inscribe (the Inscribe page)
Press **🟠 Go to inscribe →**.

1. **Prepare the pieces**
   - Pick a **fee rate** (sats per vbyte) or type a custom one.
   - Tick **"Inscribe each piece's story and traits with it"** if you want the metadata on-chain too.
   - **You pay by the byte.** Open **Compress all pieces to WebP**, choose the longest side and quality, and press
     **🗜 Compress all**. A 2 MB PNG can cost hundreds of dollars; a 30–80 KB WebP looks the same on a phone and costs a
     fraction. The table shows the exact cost of every piece; **Use all originals** undoes it.
2. **Pay and inscribe**
   - Choose which pieces go in this batch (**from / to**, up to 50 per batch).
   - On mainnet, tick **"I understand this spends real bitcoin and inscriptions are permanent."**
   - Press **⚡ Create the batch**. The app makes a temporary key for this batch, **saves it on your computer first**,
     then shows **one address and one exact amount**.
   - Pay that amount to that address from any wallet.
3. **Batches**: watch it go by itself:
   - **commit**: your payment is split into one output per piece;
   - **reveal** (after the commit confirms, about 10 minutes): each piece is written in its own transaction and the
     inscription (546 sats of "postage") goes to your Ordinals address.
   You can close the page any time; it picks up where it stopped when you come back.
4. **Collection file**: when everything is inscribed, press **📄 Make the collection file**. It lists every inscription id
   with its name and traits, which is what marketplaces (for example Magic Eden) ask for when you submit a collection.

## If something goes wrong
- **Changed your mind before the commit?** Press **Recover funds**: everything goes back to your refund address.
- **Paid too little?** Send the rest to the same address; the page adds it up. **Paid too much?** The extra comes back to your
  refund address automatically.
- **After the commit** the money can only continue into the inscriptions, and the app finishes that by itself when you reopen it.
- The temporary keys live in `~/SonOfSatoshi-Minter/projects/<Name>/ordinals/batches/` (readable only by you).
  **Back that folder up and never share it.**

More detail: the in-app **Guide → 16. Bitcoin Ordinals**.
