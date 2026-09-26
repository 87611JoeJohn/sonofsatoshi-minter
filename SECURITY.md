# Security

## Reporting a problem
Please **don't** open a public issue for a security hole.

Report it privately on GitHub: open the **Security** tab of this repository → **Report a vulnerability**. Only the
maintainer can see it. Include what you found, how to reproduce it, and what an attacker could do with it.

You'll get a reply as soon as possible. Once a fix is out, you'll be credited in the release notes if you'd like.

## What counts
- Anything that could leak or misuse a user's keys, wallet approvals, Pinata key or files.
- The app answering requests from other websites or other computers (it must only serve `127.0.0.1`).
- Contract bugs: minting by anyone but the owner, changing frozen metadata, royalty abuse.
- Anything in a release that doesn't match this repository's source.

## How the app protects users
- It never asks for, receives or stores a seed phrase or private key; every transaction is signed in the user's wallet.
- It listens only on `127.0.0.1`, rejects other host names (DNS-rebinding) and cross-site requests.
- Pages run under a strict Content-Security-Policy (`script-src 'self'`); the wallet libraries ship inside the app, not from a CDN.
- The settings file (with the optional Pinata key) is written with owner-only permissions and the key is never sent to the browser.
- Every POST must carry the app's own `X-SOS-Minter` header, which other websites can't add; the pages also send the
  settings file only to themselves (`Cross-Origin-Resource-Policy: same-origin`).
- Every wallet request uses **post-condition Deny mode**: the wallet refuses any transaction that would move STX or
  tokens out of the user's account. None of this app's transactions need to, so a tampered copy can't sneak a transfer in.
- The generated contract has a **fixed maximum supply**: not even the owner can mint more pieces than the collection has.
  Owner-only functions (mint, re-point, refresh, royalty, freeze) are checked by `tools/selftest.py`.
- `web/stacks.js` (the bundled wallet libraries) is **reproducible**: `bash tools/wallet-bundle/build.sh` rebuilds it
  from pinned versions and checks it's byte-for-byte what ships. CI does this on every change, plus CodeQL scanning.
- Releases are signed with minisign. Verify with `minisign -Vm <zip> -p minisign.pub`.
