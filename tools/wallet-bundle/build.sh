#!/usr/bin/env bash
# Rebuild web/stacks.js (the bundled Stacks wallet libraries) from pinned versions and check it matches, byte for byte.
#   ./build.sh           verify only (the default)
#   ./build.sh --write   also replace web/stacks.js (maintainers, after bumping versions in package.json + lock)
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund --silent
npx --no esbuild entry.js --bundle --format=esm --minify --platform=browser --define:global=window --outfile=stacks.js --log-level=error
NEW=$(sha256sum stacks.js | cut -d' ' -f1)
WANT=$(cut -d' ' -f1 ../../web/stacks.js.sha256)
HAVE=$(sha256sum ../../web/stacks.js | cut -d' ' -f1)
echo "rebuilt:   $NEW"; echo "recorded:  $WANT"; echo "shipped:   $HAVE"
if [ "${1:-}" = "--write" ]; then cp stacks.js ../../web/stacks.js; echo "$NEW  web/stacks.js" > ../../web/stacks.js.sha256; echo "web/stacks.js updated"; exit 0; fi
[ "$NEW" = "$WANT" ] && [ "$HAVE" = "$WANT" ] && echo "OK: the shipped wallet bundle is exactly what these sources build" || { echo "MISMATCH"; exit 1; }
