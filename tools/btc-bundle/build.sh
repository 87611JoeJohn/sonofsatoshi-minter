#!/usr/bin/env bash
# Rebuild web/btc.js (Bitcoin + Ordinals libraries: @scure/btc-signer, micro-ordinals, @scure/base) from pinned versions and
# check it matches, byte for byte.   ./build.sh = verify   ./build.sh --write = replace (after bumping versions + lock)
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund --silent
npx --no esbuild entry.js --bundle --format=esm --minify --platform=neutral --main-fields=module,main --outfile=btc.js --log-level=error
NEW=$(sha256sum btc.js | cut -d' ' -f1); WANT=$(cut -d' ' -f1 ../../web/btc.js.sha256 2>/dev/null || true); HAVE=$(sha256sum ../../web/btc.js | cut -d' ' -f1)
echo "rebuilt:   $NEW"; echo "recorded:  $WANT"; echo "shipped:   $HAVE"
if [ "${1:-}" = "--write" ]; then cp btc.js ../../web/btc.js; echo "$NEW  web/btc.js" > ../../web/btc.js.sha256; echo "web/btc.js updated"; exit 0; fi
[ "$NEW" = "$WANT" ] && [ "$HAVE" = "$WANT" ] && echo "OK: the shipped Bitcoin bundle is exactly what these sources build" || { echo "MISMATCH"; exit 1; }
