#!/usr/bin/env bash
# Rebuild web/sol.js (Solana libraries: Metaplex Umi + mpl-core + the wallet bridge, @solana/web3.js, buffer) from pinned
# versions and check it matches, byte for byte.   ./build.sh = verify   ./build.sh --write = replace (after bumping versions + lock)
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund --silent
npx --no esbuild entry.js --bundle --format=esm --minify --platform=browser --inject:./buffer-shim.js --define:global=globalThis \
  '--define:process.env.NODE_ENV="production"' --outfile=sol.js --log-level=error
NEW=$(sha256sum sol.js | cut -d' ' -f1); WANT=$(cut -d' ' -f1 ../../web/sol.js.sha256 2>/dev/null || true); HAVE=$(sha256sum ../../web/sol.js | cut -d' ' -f1)
echo "rebuilt:   $NEW"; echo "recorded:  $WANT"; echo "shipped:   $HAVE"
if [ "${1:-}" = "--write" ]; then cp sol.js ../../web/sol.js; echo "$NEW  web/sol.js" > ../../web/sol.js.sha256; echo "web/sol.js updated"; exit 0; fi
[ "$NEW" = "$WANT" ] && [ "$HAVE" = "$WANT" ] && echo "OK: the shipped Solana bundle is exactly what these sources build" || { echo "MISMATCH"; exit 1; }
