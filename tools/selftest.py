#!/usr/bin/env python3
"""Offline self-test: python3 tools/selftest.py   (no network, no wallet, no IPFS needed)."""
import base64, importlib.util, json, os, stat, sys, tempfile, threading, urllib.request, urllib.error
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
tmp = tempfile.mkdtemp(); os.environ["SOS_MINTER_HOME"] = tmp; os.environ["SOS_MINTER_PORT"] = "18731"
spec = importlib.util.spec_from_file_location("srv", ROOT / "server.py"); srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
FAIL = 0
def check(cond, msg):
    global FAIL
    print(("ok   " if cond else "FAIL ") + msg); FAIL += 0 if cond else 1

# contract
c = srv.build_contract("Test ✓ Collection — #1", "test-collection", "ipfs://bafyx/metadata/{id}.json", 500, "tx-sender", "mainnet", 42)
check(all(32 <= ord(ch) < 127 or ch in "\n\t" for ch in c), "contract is plain ASCII (the network rejects anything else)")
check("(define-constant max-supply u42)" in c, "supply is fixed in the contract")
check(c.count("(asserts! (<= token-id max-supply) err-sold-out)") == 2, "both mint paths enforce the supply cap")
for fn in ("set-base-uri", "set-token-uri", "refresh-metadata", "freeze-metadata", "set-royalty", "mint-many"):
    body = c.split(f"(define-public ({fn}", 1)[1].split("(define-", 1)[0]
    check("(is-eq contract-caller contract-owner) err-owner-only" in body, f"{fn} is owner-only")
check("as-contract" not in c and "impl-trait" not in c, "no as-contract / impl-trait (Clarity 4 + testnet safe)")
check(srv.contract_name("123 Go!") == "nft-123-go", "contract names start with a letter")
a = srv.contract_name("Chronicles of the Northern Lighthouse Keepers Volume One")
b = srv.contract_name("Chronicles of the Northern Lighthouse Keepers Volume Two")
check(a != b and len(a) <= 40 and len(b) <= 40, "long names never share a contract name")
check("(is-eq tx-sender contract-owner)" not in c and c.count("(is-eq contract-caller contract-owner) err-owner-only") == 7,
      "owner functions accept only the owner's direct call (contract-caller)")

# config
srv.save_config(dict(srv.DEFAULT_CONFIG, pinata_jwt="secret"))
check(stat.S_IMODE(os.stat(srv.CONFIG).st_mode) == 0o600, "settings file is owner-only (600)")
check("pinata_jwt" not in srv.public_config(srv.load_config()), "Pinata key is never sent to the browser")
check(srv.update_config({"network": "mainnet", "owner_address": "ST1Q8Z0762DQYDFPGVZ270C70WCM59TA6PH4XKNNA"})[0] == 400, "testnet address on mainnet is refused")
check(srv.do_check(srv.load_config(), {"what": "ipfs", "ipfs_api": "file:///etc/passwd"})[0] == 400, "checks refuse non-http URLs")

# uploads
png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 80).decode()
check(srv.do_upload({}, {"collection_name": "Junk", "images": [{"data": base64.b64encode(b"hello" * 30).decode()}]})[0] == 400, "non-images are refused")
check(not (srv.PROJECTS / "Junk").exists(), "a refused upload creates no collection")
check(srv.do_upload({}, {"collection_name": "Real One", "images": [{"data": png}] * 2})[1].get("total") == 2, "images upload and number")
check(srv.do_upload({}, {"collection_name": "real one", "images": [{"data": png}]})[0] == 409, "a clashing name is refused")

# review fixes
png2 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\1" * 80).decode()
srv.do_generate({}, {"collection_name": "Real One", "description": "OLD ART STORY OLD ART STORY"})
srv.do_upload({}, {"collection_name": "Real One", "mode": "replace", "images": [{"data": png2}] * 2})
check(not list((srv.PROJECTS / "Real_One" / "metadata").glob("*.json")), "replacing images clears the old stories")
check(srv.update_config({"public_gateway": "https://gw.example\\"})[0] == 400, "gateway URLs with odd characters are refused")
try: srv.do_generate({}, {"collection_name": "Real One", "royalty_pct": float("nan")}); nan_ok = False
except ValueError: nan_ok = True
check(nan_ok, "a non-number royalty is refused")
srv._write_state(srv.PROJECTS / "Real_One", base_uri="ipfs://bafyx/metadata/{id}.json", published_count=1)
check(srv.mint_info(srv.load_config(), "Real One")[1].get("ready") is False, "mint is blocked when images changed after storing")

# HTTP guards
t = threading.Thread(target=srv.ThreadingHTTPServer(("127.0.0.1", 18731), srv.H).serve_forever, daemon=True); t.start()
def req(path, method="GET", headers=None, body=None):
    r = urllib.request.Request("http://127.0.0.1:18731" + path, method=method, headers=headers or {}, data=body)
    try: return urllib.request.urlopen(r, timeout=5).status
    except urllib.error.HTTPError as e: return e.code
check(req("/api/config") == 200, "local page can read settings")
check(req("/api/config", headers={"Host": "evil.example"}) == 403, "foreign Host header refused (DNS rebinding)")
check(req("/api/config", "POST", {"Content-Type": "application/json"}, b"{}") == 403, "POST without the app header refused (CSRF)")
check(req("/api/config", "POST", {"Content-Type": "application/json", "X-SOS-Minter": "1", "Origin": "https://evil.example"}, b"{}") == 403, "cross-site POST refused")
check(req("/api/config", "POST", {"Content-Type": "application/json", "X-SOS-Minter": "1"}, b'{"royalty_pct": 7}') == 200, "the app's own POST works")
check(req("/static/../server.py") == 404, "no path traversal")
check(req("/api/config", "POST", {"Content-Type": "application/json", "X-SOS-Minter": "1"}, b'{"royalty_pct": NaN}') == 400, "NaN in a request is refused")
print("\n" + ("ALL PASSED" if not FAIL else f"{FAIL} FAILED")); sys.exit(1 if FAIL else 0)
