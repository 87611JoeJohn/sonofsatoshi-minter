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
- Releases are signed with minisign. Verify with `minisign -Vm <zip> -p minisign.pub`.
