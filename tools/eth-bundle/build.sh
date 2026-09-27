#!/usr/bin/env bash
# Rebuild web/eth.js (viem, for Ethereum and Base), web/eth-contract.json (the collection contract compiled with the pinned
# solc + OpenZeppelin) and contracts/SonOfSatoshiCollection.verify.json (Etherscan input), and check all match, byte for byte.
#   ./build.sh = verify   ./build.sh --write = replace (after changing the contract or bumping versions + lock)
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund --silent
node compile.cjs
npx --no esbuild entry.js --bundle --format=esm --minify --platform=browser --outfile=eth.js --log-level=error
NEW=$(sha256sum eth.js eth-contract.json eth-verify.json | awk '{print $1}' | tr '\n' ' ')
WANT=$(awk '{print $1}' ../../web/eth.sha256 2>/dev/null | tr '\n' ' ' || true)
HAVE=$( (cd ../../web && sha256sum eth.js eth-contract.json 2>/dev/null; sha256sum ../contracts/SonOfSatoshiCollection.verify.json 2>/dev/null || true) | awk '{print $1}' | tr '\n' ' ')
echo "rebuilt:   $NEW"; echo "recorded:  $WANT"; echo "shipped:   $HAVE"
if [ "${1:-}" = "--write" ]; then
  cp eth.js eth-contract.json ../../web/; cp eth-verify.json ../../contracts/SonOfSatoshiCollection.verify.json
  (sha256sum eth.js | sed 's#  #  web/#'; sha256sum eth-contract.json | sed 's#  #  web/#'
   sha256sum eth-verify.json | sed 's#  eth-verify.json#  contracts/SonOfSatoshiCollection.verify.json#') > ../../web/eth.sha256
  echo "web/eth.js, web/eth-contract.json and the verify input updated"; exit 0
fi
[ "$NEW" = "$WANT" ] && [ "$HAVE" = "$WANT" ] && echo "OK: the shipped Ethereum bundle and contract are exactly what these sources build" || { echo "MISMATCH"; exit 1; }
