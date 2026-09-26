#!/usr/bin/env bash
# Start SonOfSatoshi Minter and open it in your browser (Linux / macOS).
cd "$(dirname "$0")"
PORT="${SOS_MINTER_PORT:-8130}"
command -v python3 >/dev/null || { echo "Python 3 is needed: install it from python.org or your package manager."; exit 1; }
if ! (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then
  nohup python3 server.py > "${TMPDIR:-/tmp}/sos-minter.log" 2>&1 &
  sleep 1
fi
URL="http://127.0.0.1:$PORT"
echo "SonOfSatoshi Minter is running at $URL"
( command -v xdg-open >/dev/null && xdg-open "$URL" ) || ( command -v open >/dev/null && open "$URL" ) || true
