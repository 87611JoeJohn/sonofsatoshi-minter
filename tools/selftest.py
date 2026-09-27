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

# Bitcoin Ordinals
check(srv._btc_addr_ok("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", "mainnet"), "mainnet taproot address accepted")
check(not srv._btc_addr_ok("tb1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", "mainnet"), "testnet address refused on mainnet")
check(srv.update_config({"chain": "ordinals", "btc_network": "regtest", "btc_backend": "esplora"})[0] == 400, "regtest without your own node is refused")
srv.update_config({"chain": "ordinals", "btc_network": "testnet4", "btc_backend": "rpc", "rpc_pass": "hunter2"})
check("rpc_pass" not in srv.public_config(srv.load_config()) and srv.public_config(srv.load_config()).get("rpc_pass_set"), "node RPC password is never sent to the browser")
check(srv.btc_check(srv.load_config(), {"esplora_url": "file:///etc/passwd", "btc_backend": "esplora"})[0] == 400, "chain data source must be http(s)")
try: srv._batch_file("Real One", "../../evil"); bad = False
except ValueError: bad = True
check(bad, "batch ids can't escape the batches folder")
srv.ord_batch_save({"collection_name": "Real One", "batch": {"id": "btest01", "key": "aa" * 32, "status": "awaiting-funds"}})
bf = srv._batch_file("Real One", "btest01")
check(stat.S_IMODE(os.stat(bf).st_mode) == 0o600, "batch file with the temporary key is owner-only (600)")
check(srv.ord_batch_save({"collection_name": "Real One", "batch": {"id": "btest01", "key": "bb" * 32}})[0] == 409, "a batch's key can never be replaced")
check(srv.ord_set_content({"collection_name": "Real One", "id": 1, "data": base64.b64encode(b"not an image").decode()})[0] == 400, "compressed version must be an image")
try: srv.btc_broadcast(srv.load_config(), "zz"); bad2 = False
except RuntimeError: bad2 = True
check(bad2, "broadcast only accepts a raw transaction")
srv.update_config({"chain": "stacks"})

# Solana
check(srv._sol_addr_ok("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d") and srv._sol_addr_ok("11111111111111111111111111111111"), "Solana addresses accepted")
check(not srv._sol_addr_ok("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7O") and not srv._sol_addr_ok("1111111111111111111111111111111"),
      "non-base58 or short Solana addresses refused")
check(srv.update_config({"chain": "solana", "sol_owner": "0xdeadbeef"})[0] == 400, "a non-Solana mint-to address is refused")
srv.update_config({"chain": "solana", "sol_network": "mainnet", "sol_rpc": "https://rpc.example/?api-key=sekrit"})
pc = srv.public_config(srv.load_config())
check("sol_rpc" not in pc and pc.get("sol_rpc_set") and "sekrit" not in json.dumps(pc), "a paid Solana RPC link (with its key) never reaches the browser")
check(srv.sol_relay(srv.load_config(), b'{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts2"}')[0] == 403, "the RPC relay only passes the calls the mint page needs")
check(srv.sol_relay(srv.load_config(), b'[{"jsonrpc":"2.0","id":1,"method":"getBalance"},{"method":"minimumLedgerSlot"}]')[0] == 403, "a batch with one disallowed call is refused whole")
check(srv.sol_relay(srv.load_config(), b'{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","params":[]}')[0] == 403, "no airdrop calls on mainnet")
check(srv.sol_check(srv.load_config(), {"sol_network": "devnet", "sol_rpc": "file:///etc/passwd"})[0] == 400, "the Solana RPC must be http(s)")
srv.update_config({"sol_network": "devnet", "sol_rpc": "", "public_gateway": ""})
srv.do_upload({}, {"collection_name": "Sol One", "images": [{"data": png}] * 3})
srv.do_generate({}, {"collection_name": "Sol One", "description": "Three sparks."})
_real_push = srv._push; srv._push = lambda cfg, base, name: ("bafytestcid", ["test"])
r = srv.do_publish(srv.load_config(), {"collection_name": "Sol One", "royalty_pct": 6})
srv._push = _real_push
m1 = json.loads((srv.PROJECTS / "Sol_One" / "metadata" / "1.json").read_text())
check(r[0] == 200 and m1["image"].startswith("https://ipfs.io/ipfs/") and m1["properties"]["files"][0]["type"] == "image/png" and "sip" not in m1,
      "Solana metadata uses https links and the Metaplex file list")
check((srv.PROJECTS / "Sol_One" / "metadata" / "collection.json").exists(), "the collection gets its own Solana card")
info = srv.sol_info(srv.load_config(), "Sol One")[1]
check(len(info["pieces"]) == 3 and info["royalty_bps"] == 600 and info["pieces"][2]["uri"].endswith("/metadata/3.json"), "mint page gets every piece's link and the royalty")
good = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
check(srv.sol_save({"collection_name": "Sol One", "collection": "not-an-address"})[0] == 400, "a bad collection address is not recorded")
srv.sol_save({"collection_name": "Sol One", "collection": good})
check(srv.sol_save({"collection_name": "Sol One", "collection": "11111111111111111111111111111111"})[0] == 409, "a recorded collection is never silently replaced")
check(srv.sol_save({"collection_name": "Sol One", "assets": {"1": "../../x"}})[0] == 400, "bad asset records are refused")
check(srv.sol_save({"collection_name": "Sol One", "pending": [{"sig": "x", "lastValid": 1}]})[0] == 400, "bad pending records are refused")
srv.update_config({"sol_network": "mainnet"})
check(not srv.sol_info(srv.load_config(), "Sol One")[1]["sol"], "devnet records never show up on mainnet")
srv.update_config({"chain": "stacks", "sol_network": "devnet", "sol_rpc": ""})

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
check(req("/api/sol/rpc", "POST", {"Content-Type": "application/json"}, b'{"method":"getBalance"}') == 403, "the Solana relay needs the app header too (CSRF)")
check(req("/api/sol/rpc", "POST", {"Content-Type": "application/json", "X-SOS-Minter": "1", "Origin": "https://evil.example"}, b'{"method":"getBalance"}') == 403, "cross-site Solana relay calls refused")
print("\n" + ("ALL PASSED" if not FAIL else f"{FAIL} FAILED")); sys.exit(1 if FAIL else 0)
