#!/usr/bin/env python3
"""
SonOfSatoshi Minter — a sovereign NFT minter for Stacks, Bitcoin Ordinals, Solana, Ethereum and Base.

Drop in a folder of art and get a finished collection:
  1. images numbered 0001, 0002 …
  2. rarity tiers + a backstory per piece, written by YOUR local AI (Ollama) from what is actually in each picture
     (or your own trait weights, no AI needed)
  3. SIP-016 metadata and a SIP-009 Clarity contract you can re-point, refresh and freeze later
  4. everything stored on IPFS: your own node, Pinata, or both
  5. deploy + mint from your own wallet (Xverse / Leather on Stacks, Phantom / Solflare / Backpack on Solana,
     MetaMask / Rabby / any browser wallet on Ethereum and Base).
     This app never sees a private key.

Pure Python standard library. Runs on your computer at http://127.0.0.1:8130 and nowhere else.

Copyright (C) 2026 SonOfSatoshi
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General
Public License as published by the Free Software Foundation, version 3. It is distributed WITHOUT ANY WARRANTY; see the
LICENSE file. The "SonOfSatoshi" name and logo are not covered by the license; see TRADEMARK.md.
"""
import os, re, io, json, base64, random, threading, mimetypes, urllib.request, urllib.error, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

VERSION = "1.0.0"
APP_DIR = Path(__file__).resolve().parent
WEB = APP_DIR / "web"
for _l in (APP_DIR / ".env").read_text().splitlines() if (APP_DIR / ".env").exists() else []:
    _l = _l.strip()
    if _l and not _l.startswith("#") and "=" in _l:
        _k, _v = _l.split("=", 1); os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))
DATA = Path(os.environ.get("SOS_MINTER_HOME") or (Path.home() / "SonOfSatoshi-Minter"))
PROJECTS = Path(os.environ.get("SOS_MINTER_PROJECTS") or (DATA / "projects"))
CONFIG = DATA / "config.json"
PORT = int(os.environ.get("SOS_MINTER_PORT", "8130"))
MAX_BODY = 256 * 1024 * 1024          # one upload request; the page sends big collections in chunks
SECRET_KEYS = ("pinata_jwt", "rpc_pass", "sol_rpc")   # never sent back to the browser (paid Solana RPC links carry an API key)

DEFAULT_CONFIG = {
    "setup_done": False,
    "network": "testnet",              # testnet | mainnet — start on testnet, it's free
    "owner_address": "",               # your STX address: mints land here, royalties go here
    "storage": "node",                 # node | pinata | both
    "ipfs_api": "http://127.0.0.1:5001",
    "ipfs_gateway": "http://127.0.0.1:8080",
    "pinata_jwt": "",
    "link_style": "ipfs",              # ipfs  -> ipfs://CID/...   (portable, wallets pick their own gateway)
                                       # gateway -> https://<public_gateway>/ipfs/CID/... (your own public gateway)
    "public_gateway": "",
    "ai_enabled": False,
    "ollama_url": "http://127.0.0.1:11434",
    "vision_model": "llava",
    "writer_model": "qwen2.5:14b",
    "royalty_pct": 5,
    "rarity_tiers": None,
    # ---- Bitcoin Ordinals ----
    "chain": "stacks",                 # stacks | ordinals | solana | ethereum
    "btc_network": "testnet4",         # mainnet | testnet4 | signet | regtest
    "btc_backend": "esplora",          # esplora (mempool.space or your own) | rpc (your own Bitcoin Core)
    "esplora_url": "",                 # blank = mempool.space for the chosen network
    "rpc_url": "http://127.0.0.1:8332",
    "rpc_user": "",
    "rpc_pass": "",
    "ord_address": "",                 # your ordinals (taproot) address: inscriptions land here
    "refund_address": "",              # leftover sats go back here
    "ord_postage": 546,                # sats that travel with each inscription
    "ord_story_onchain": True,         # inscribe the story + traits with the art
    # ---- Solana (Metaplex Core) ----
    "sol_network": "devnet",           # devnet | mainnet | localnet
    "sol_rpc": "",                     # blank = the network's free public RPC; paid ones (Helius, QuickNode…) are faster
    "sol_owner": "",                   # where minted pieces go; blank = the wallet that mints
    # ---- Ethereum / Base (one ERC-721 contract per collection) ----
    "eth_network": "base-sepolia",     # mainnet | sepolia | base | base-sepolia | localhost
    "eth_owner": "",                   # where minted pieces go; blank = the wallet that deploys
}

# ---------------- config ----------------
_CFG_LOCK = threading.Lock()

def load_config():
    if CONFIG.exists():
        try: return {**DEFAULT_CONFIG, **json.loads(CONFIG.read_text())}
        except Exception: pass
    return dict(DEFAULT_CONFIG)

def save_config(cfg):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)   # owner-only from the first byte (holds the Pinata key)
    with os.fdopen(fd, "w") as f: f.write(json.dumps(cfg, indent=2))
    os.chmod(tmp, 0o600)
    tmp.replace(CONFIG)

def public_config(cfg):
    out = {k: v for k, v in cfg.items() if k not in SECRET_KEYS}
    for k in SECRET_KEYS:
        out[k + "_set"] = bool(cfg.get(k))
    out["version"] = VERSION
    out["projects_dir"] = str(PROJECTS)
    out["sol_rpc_host"] = urllib.parse.urlparse(sol_endpoint(cfg)).hostname or ""
    return out

_ADDR_RE = re.compile(r"^S[PMTN][0-9A-HJKMNP-TV-Z]{38,40}$")
_BTC_HRP = {"mainnet": "bc", "testnet4": "tb", "signet": "tb", "regtest": "bcrt"}
def _btc_addr_ok(a, network):
    """Bech32/bech32m address for this network (segwit v0 or taproot). Exact checksum is verified again in the page."""
    hrp = _BTC_HRP.get(network, "bc")
    return bool(re.fullmatch(hrp + r"1[02-9ac-hj-np-z]{8,87}", a.lower())) and (a == a.lower() or a == a.upper())
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def _sol_addr_ok(a):
    """A Solana address is 32 bytes written in base58."""
    if not isinstance(a, str) or not 32 <= len(a) <= 44 or any(c not in _B58 for c in a): return False
    n = 0
    for c in a: n = n * 58 + _B58.index(c)
    pad = len(a) - len(a.lstrip("1"))
    return pad + (n.bit_length() + 7) // 8 == 32
_ETH_NETS = ("mainnet", "sepolia", "base", "base-sepolia", "localhost")
_ETH_ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")
_ETH_TX = re.compile(r"^0x[0-9a-fA-F]{64}$")
_SOL_RPC = {"mainnet": "https://api.mainnet-beta.solana.com", "devnet": "https://api.devnet.solana.com", "localnet": "http://127.0.0.1:8899"}
def sol_endpoint(cfg):
    return cfg.get("sol_rpc") or _SOL_RPC.get(cfg.get("sol_network"), _SOL_RPC["devnet"])
_URL_RE = re.compile(r"^https?://[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+$")   # plain ASCII URL characters only

def update_config(body):
    """Validate + merge settings coming from the setup wizard / settings page."""
    with _CFG_LOCK:
        cfg = load_config(); errs = []
        if "network" in body:
            if body["network"] in ("testnet", "mainnet"): cfg["network"] = body["network"]
            else: errs.append("network must be testnet or mainnet")
        if "owner_address" in body:
            a = str(body["owner_address"]).strip().upper()
            if a and not _ADDR_RE.match(a): errs.append("that doesn't look like a Stacks address (SP… or ST…)")
            else: cfg["owner_address"] = a
        if "storage" in body:
            if body["storage"] in ("node", "pinata", "both"): cfg["storage"] = body["storage"]
            else: errs.append("storage must be node, pinata or both")
        for k in ("ipfs_api", "ipfs_gateway", "public_gateway", "ollama_url"):
            if k in body:
                v = str(body[k]).strip().rstrip("/")
                if v and not _URL_RE.match(v): errs.append(f"{k} must start with http:// or https://")
                else: cfg[k] = v
        if "link_style" in body:
            if body["link_style"] in ("ipfs", "gateway"): cfg["link_style"] = body["link_style"]
        if body.get("pinata_jwt"):                       # empty = keep the stored key
            cfg["pinata_jwt"] = str(body["pinata_jwt"]).strip()
        if body.get("pinata_clear"): cfg["pinata_jwt"] = ""
        for k in ("vision_model", "writer_model"):
            if k in body: cfg[k] = re.sub(r"[^A-Za-z0-9_.:/-]", "", str(body[k]))[:80]
        if "ai_enabled" in body: cfg["ai_enabled"] = bool(body["ai_enabled"])
        if "royalty_pct" in body:
            try: cfg["royalty_pct"] = max(0.0, min(30.0, float(body["royalty_pct"])))
            except Exception: errs.append("royalty must be a number")
        if "setup_done" in body: cfg["setup_done"] = bool(body["setup_done"])
        # ---- Bitcoin Ordinals settings ----
        if "chain" in body:
            if body["chain"] in ("stacks", "ordinals", "solana", "ethereum"): cfg["chain"] = body["chain"]
            else: errs.append("chain must be stacks, ordinals, solana or ethereum")
        if "btc_network" in body:
            if body["btc_network"] in _BTC_HRP: cfg["btc_network"] = body["btc_network"]
            else: errs.append("bitcoin network must be mainnet, testnet4, signet or regtest")
        if "btc_backend" in body:
            if body["btc_backend"] in ("esplora", "rpc"): cfg["btc_backend"] = body["btc_backend"]
            else: errs.append("data source must be esplora or rpc")
        for k in ("esplora_url", "rpc_url"):
            if k in body:
                v = str(body[k]).strip().rstrip("/")
                if v and not _URL_RE.match(v): errs.append(f"{k} must start with http:// or https://")
                else: cfg[k] = v
        if "rpc_user" in body: cfg["rpc_user"] = str(body["rpc_user"]).strip()[:100]
        if body.get("rpc_pass"): cfg["rpc_pass"] = str(body["rpc_pass"])[:200]
        for k in ("ord_address", "refund_address"):
            if k in body:
                v = str(body[k]).strip()
                if v and not _btc_addr_ok(v, cfg["btc_network"]): errs.append(f"that {k.replace('_', ' ')} isn't a valid {cfg['btc_network']} Bitcoin address")
                else: cfg[k] = v
        if "ord_postage" in body:
            try: cfg["ord_postage"] = max(546, min(100000, int(body["ord_postage"])))
            except Exception: errs.append("postage must be a whole number of sats")
        if "ord_story_onchain" in body: cfg["ord_story_onchain"] = bool(body["ord_story_onchain"])
        # ---- Solana settings ----
        if "sol_network" in body:
            if body["sol_network"] in _SOL_RPC: cfg["sol_network"] = body["sol_network"]
            else: errs.append("solana network must be mainnet, devnet or localnet")
        if "sol_rpc" in body:                            # empty = back to the public RPC
            v = str(body["sol_rpc"]).strip().rstrip("/")
            if v and not _URL_RE.match(v): errs.append("the Solana RPC must start with http:// or https://")
            else: cfg["sol_rpc"] = v
        if "sol_owner" in body:
            v = str(body["sol_owner"]).strip()
            if v and not _sol_addr_ok(v): errs.append("that isn't a Solana address")
            else: cfg["sol_owner"] = v
        # ---- Ethereum / Base settings ----
        if "eth_network" in body:
            if body["eth_network"] in _ETH_NETS: cfg["eth_network"] = body["eth_network"]
            else: errs.append("network must be mainnet, sepolia, base, base-sepolia or localhost")
        if "eth_owner" in body:
            v = str(body["eth_owner"]).strip()
            if v and not _ETH_ADDR.match(v): errs.append("that isn't an Ethereum address (0x followed by 40 characters)")
            else: cfg["eth_owner"] = v
        if cfg.get("chain") == "ordinals" and cfg.get("btc_network") == "regtest" and cfg.get("btc_backend") != "rpc":
            errs.append("regtest needs your own Bitcoin Core node (data source: rpc)")
        a = cfg.get("owner_address", "")
        if cfg.get("chain", "stacks") == "stacks" and a and (a[:2] in ("ST", "SN")) != (cfg["network"] == "testnet"):
            errs.append("your address doesn't match the network: testnet addresses start with ST, mainnet with SP")
        if cfg["link_style"] == "gateway" and not cfg.get("public_gateway"):
            errs.append("gateway links need your public gateway address")
        if errs: return 400, {"error": "; ".join(errs)}
        save_config(cfg)
        return 200, {"ok": True, "config": public_config(cfg)}

# ---------------- health checks (setup wizard) ----------------
def _get(url, timeout=8, headers=None, data=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

def check_ipfs(api):
    try:
        _, b = _get(api.rstrip("/") + "/api/v0/version", data=b"", method="POST")
        return {"ok": True, "detail": "IPFS node v" + json.loads(b).get("Version", "?")}
    except Exception as e:
        return {"ok": False, "detail": f"can't reach an IPFS node at {api} ({type(e).__name__}). Is it running? See the Guide."}

_PRIVATE = re.compile(r"^/ip[46]/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fe80|fc|fd|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)", re.I)

def check_reachable(api):
    """Can the internet reach this node directly? A home node behind a router is often only reachable through a
    slow relay; public gateways then time out and wallets show blank boxes for ipfs:// links."""
    try:
        _, b = _get(api.rstrip("/") + "/api/v0/id", data=b"", method="POST")
        addrs = json.loads(b).get("Addresses") or []
    except Exception:
        return {"ok": False, "detail": "couldn't ask the node about its addresses"}
    direct = [a for a in addrs if "/p2p-circuit" not in a and not _PRIVATE.match(a)]
    if direct:
        return {"ok": True, "detail": "your node has a public address, so ipfs:// links should work"}
    return {"ok": False, "detail": "your node is only reachable through a relay (it's behind a router). Public gateways "
            "will likely time out on ipfs:// links, so use 'My public gateway', add Pinata, or forward port 4001 (see the Guide)."}

def check_pinata(jwt):
    if not jwt: return {"ok": False, "detail": "no Pinata key saved yet"}
    try:
        _get("https://api.pinata.cloud/data/testAuthentication", headers={"Authorization": "Bearer " + jwt})
        return {"ok": True, "detail": "Pinata key works"}
    except urllib.error.HTTPError as e:
        return {"ok": False, "detail": f"Pinata rejected the key (HTTP {e.code}) — make a new JWT with pinning permission"}
    except Exception as e:
        return {"ok": False, "detail": f"couldn't reach Pinata ({type(e).__name__})"}

def check_ollama(url):
    try:
        _, b = _get(url.rstrip("/") + "/api/tags")
        models = [m["name"] for m in json.loads(b).get("models", [])]
        return {"ok": True, "detail": f"Ollama is running with {len(models)} model(s)", "models": models}
    except Exception:
        return {"ok": False, "detail": f"no Ollama at {url} — AI is optional; install it from ollama.com to use it", "models": []}

def check_gateway(gw):
    if not gw: return {"ok": False, "detail": "no public gateway set"}
    try:
        # a tiny well-known CID (the empty directory) every gateway can serve
        s, _ = _get(gw.rstrip("/") + "/ipfs/bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354", timeout=15)
        return {"ok": s == 200, "detail": "gateway answers" if s == 200 else f"gateway returned {s}"}
    except Exception as e:
        return {"ok": False, "detail": f"gateway didn't answer ({type(e).__name__})"}

def do_check(cfg, body):
    what = body.get("what") or "all"
    c = dict(cfg)
    for k in ("ipfs_api", "ollama_url", "public_gateway"):
        if k in body:
            v = str(body[k]).strip().rstrip("/")
            if v and not _URL_RE.match(v): return 400, {"error": f"{k} must start with http:// or https://"}
            c[k] = v
    jwt = body.get("pinata_jwt") or cfg.get("pinata_jwt", "")
    out = {}
    if what in ("all", "ipfs"):
        out["ipfs"] = check_ipfs(c["ipfs_api"])
        if out["ipfs"]["ok"]: out["reach"] = check_reachable(c["ipfs_api"])
    if what in ("all", "pinata"): out["pinata"] = check_pinata(jwt)
    if what in ("all", "ollama"): out["ollama"] = check_ollama(c["ollama_url"])
    if what in ("all", "gateway"): out["gateway"] = check_gateway(c.get("public_gateway", ""))
    return 200, out

# ---------------- names / paths ----------------
def sanitize(name):
    name = re.sub(r"[^a-zA-Z0-9 ]", "", name or "").strip()
    return re.sub(r" +", "_", name.title()) or "My_NFT_Collection"

def contract_name(name):
    """Clarity contract names: lowercase letters, digits, hyphens; start with a letter; max 40.
    Long names get a short tag from the full name, so two collections can never share a contract name."""
    import hashlib
    c = sanitize(name).lower().replace("_", "-")
    if not c[0].isalpha(): c = "nft-" + c
    if len(c) > 40:
        c = c[:33].rstrip("-") + "-" + hashlib.sha256(sanitize(name).encode()).hexdigest()[:6]
    return c

def _contract_file(base, name):
    """<collection>/contract/<contract-name>.clar, checked to stay inside the collection's folder."""
    d = os.path.realpath(os.path.join(str(base), "contract"))
    f = os.path.realpath(os.path.join(d, contract_name(name) + ".clar"))
    if not f.startswith(d + os.sep): raise ValueError("bad contract path")
    return Path(f)

def project_path(name):
    """The collection's folder, guaranteed to be directly inside the projects folder (no path tricks)."""
    root = os.path.realpath(str(PROJECTS))
    full = os.path.realpath(os.path.join(root, sanitize(name)))
    if not full.startswith(root + os.sep) or os.path.dirname(full) != root:
        raise ValueError("bad collection name")
    return Path(full)

def _claim(base, name):
    """One folder = one collection: refuse to mix two collections whose names sanitize alike."""
    marker = base / ".collection"
    if marker.exists():
        existing = marker.read_text(errors="ignore").strip()
        if existing and existing != name:
            return f"the folder '{base.name}' already holds the collection '{existing}' — pick a different name"
    base.mkdir(parents=True, exist_ok=True)
    marker.write_text(name)
    return None

# ---------------- rarity ----------------
# 12 tiers, rarest first. Each cutoff is a CUMULATIVE percentile, so the bands scale to any collection size.
RARITY_TIERS = [("Mythic", 0.005), ("Celestial", 0.015), ("Divine", 0.030), ("Legendary", 0.060),
                ("Ascendant", 0.100), ("Relic", 0.160), ("Epic", 0.240), ("Rare", 0.360),
                ("Elite", 0.500), ("Uncommon", 0.680), ("Common", 0.860), ("Base", 1.000)]

def resolve_tiers(cfg=None, body=None):
    raw = (body or {}).get("rarity_tiers") or (cfg or {}).get("rarity_tiers") or RARITY_TIERS
    out = []
    try:
        for n, cut in raw: out.append((str(n)[:32], float(cut)))
        out.sort(key=lambda x: x[1])
        if not out: raise ValueError
        out[-1] = (out[-1][0], 1.0)
    except Exception:
        out = list(RARITY_TIERS)
    return out

def _rank_to_tiers(scored, tiers):
    """Tie-aware: identical rarity scores share the same tier."""
    order = sorted(scored, key=lambda x: -x[1])
    n = len(order); ranking = {}; prev_score = prev_tier = None
    for i, (tid, score, attrs) in enumerate(order):
        tier = next(t for t, cut in tiers if (i + 1) / n <= cut)
        if prev_score is not None and abs(score - prev_score) < 1e-9: tier = prev_tier
        ranking[tid] = {"rank": i + 1, "score": round(score, 2), "tier": tier, "attrs": attrs}
        prev_score, prev_tier = score, tier
    return ranking

def _score(token_traits):
    total = len(token_traits); counts = {}
    for attrs in token_traits:
        for cat, val in attrs.items():
            counts.setdefault(cat, {}); counts[cat][val] = counts[cat].get(val, 0) + 1
    return [(i, sum(total / counts[c][v] for c, v in a.items()), a) for i, a in enumerate(token_traits, 1)]

def assign_rarity(total, traits_spec, seed, tiers):
    """Manual engine: traits_spec {"Background": [["Void", 50], ["Gold", 10]], …} (value, weight). Deterministic per seed."""
    rng = random.Random(seed); tokens = []
    for _ in range(total):
        attrs = {}
        for cat, values in traits_spec.items():
            if values:
                attrs[cat] = rng.choices([v[0] for v in values], weights=[max(1, int(v[1])) for v in values], k=1)[0]
        tokens.append(attrs)
    return _rank_to_tiers(_score(tokens), tiers)

def _tier_counts(ranking, tiers):
    c = {n: 0 for n, _ in tiers}
    for r in ranking.values(): c[r["tier"]] = c.get(r["tier"], 0) + 1
    return c

# ---------------- images ----------------
IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
_CT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

def _img_ext(raw):
    if raw[:8] == b"\x89PNG\r\n\x1a\n": return ".png"
    if raw[:3] == b"\xff\xd8\xff": return ".jpg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP": return ".webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"): return ".gif"
    return None

def list_images(imgdir):
    if not imgdir.exists(): return []
    return sorted((p for p in imgdir.iterdir() if p.suffix.lower() in IMG_EXTS and not p.name.startswith(".")),
                  key=lambda p: p.name)

def _renumber(imgdir):
    """Contiguous 0001<ext>, 0002<ext> … keeping order and format. Two-phase so names never collide."""
    staged = []
    for i, old in enumerate(list_images(imgdir), 1):
        t = imgdir / f".stage_{i:05d}{old.suffix.lower()}"; old.rename(t); staged.append(t)
    for i, t in enumerate(staged, 1):
        t.rename(imgdir / f"{i:04d}{t.suffix.lower()}")
    return list_images(imgdir)

def do_upload(cfg, body):
    """body: {collection_name, images:[{data:"<base64 or data-URI>"}], mode:"append"|"replace"}"""
    name = str(body.get("collection_name", "")).strip()
    if not name: return 400, {"error": "give the collection a name first"}
    incoming = body.get("images") or []
    if not isinstance(incoming, list) or not incoming: return 400, {"error": "no images in this upload"}
    good, skipped = [], 0
    for im in incoming:                       # check everything BEFORE touching the disk
        data = (im.get("data") if isinstance(im, dict) else im) or ""
        if isinstance(data, str) and data.startswith("data:") and "," in data: data = data.split(",", 1)[1]
        try: raw = base64.b64decode(data, validate=False)
        except Exception: skipped += 1; continue
        ext = _img_ext(raw)
        if not ext or len(raw) < 64: skipped += 1; continue
        good.append((raw, ext))
    if not good: return 400, {"error": "none of those files are images (PNG, JPG, WEBP or GIF)"}
    base = project_path(name)
    err = _claim(base, name)
    if err: return 409, {"error": err}
    imgdir = base / "images"; imgdir.mkdir(parents=True, exist_ok=True)
    if body.get("mode") == "replace":
        # new art = start fresh: old stories, AI notes and the old story of the collection no longer match
        import shutil
        for f in list_images(imgdir): f.unlink()
        for f in (base / "metadata").glob("*.json") if (base / "metadata").exists() else []: f.unlink()
        shutil.rmtree(base / ".ai-vision", ignore_errors=True)
        if (base / "collection.json").exists(): (base / "collection.json").unlink()
    start = len(list_images(imgdir))
    for i, (raw, ext) in enumerate(good, 1):
        (imgdir / f"{start + i:04d}{ext}").write_bytes(raw)
    files = _renumber(imgdir)
    return 200, {"ok": True, "collection": name, "uploaded": len(good), "skipped": skipped, "total": len(files)}

def list_projects():
    out = []
    if PROJECTS.exists():
        for p in sorted(PROJECTS.iterdir()):
            if p.is_dir() and (p / ".collection").exists():
                st = _read_state(p)
                out.append({"name": (p / ".collection").read_text().strip(), "images": len(list_images(p / "images")),
                            "has_metadata": (p / "metadata").exists() and any((p / "metadata").glob("*.json")),
                            "cid": st.get("cid", ""), "deployed": st.get("deployed_contract", "")})
    return out

def _read_state(base):
    f = base / "state.json"
    try: return json.loads(f.read_text()) if f.exists() else {}
    except Exception: return {}

def _write_state(base, **kw):
    st = _read_state(base); st.update(kw)
    (base / "state.json").write_text(json.dumps(st, indent=2))
    return st

# ---------------- build (metadata + contract) ----------------
def _meta_file(base, i):
    return base / "metadata" / f"{int(i)}.json"

def do_generate(cfg, body):
    """Number the images, write metadata for every token (keeping any AI rarity + backstory), write the contract."""
    name = str(body.get("collection_name", "")).strip()
    if not name: return 400, {"error": "give the collection a name first"}
    base = project_path(name)
    if not list_images(base / "images"): return 400, {"error": "add your images first (step 1)"}
    err = _claim(base, name)
    if err: return 409, {"error": err}
    (base / "metadata").mkdir(parents=True, exist_ok=True)
    files = _renumber(base / "images")
    description = str(body.get("description", "")).strip() or f"A piece from the {name} collection."
    traits_spec = body.get("traits") or {}
    overwrite = bool(body.get("overwrite"))
    tiers = resolve_tiers(cfg, body)
    ranking = assign_rarity(len(files), traits_spec, body.get("seed", 1337), tiers) if traits_spec else {}
    kept = 0
    for i, f in enumerate(files, 1):
        mf = _meta_file(base, i)
        # keep existing stories (AI-written or hand-edited) unless the manual builder explicitly asks to redo them
        if not overwrite and mf.exists():
            try:
                old = json.loads(mf.read_text())
                old["image"] = f"<IMAGES>/{f.name}"; mf.write_text(json.dumps(old, indent=2)); kept += 1; continue
            except Exception: pass
        attrs = [{"trait_type": "Collection", "value": name}]
        r = ranking.get(i)
        if r:
            attrs += [{"trait_type": c, "value": v} for c, v in r["attrs"].items()]
            attrs += [{"trait_type": "Rarity", "value": r["tier"]}, {"trait_type": "Rarity Rank", "value": r["rank"]}]
        mf.write_text(json.dumps({"name": f"{name} #{i:04d}", "description": description,
                                  "image": f"<IMAGES>/{f.name}", "attributes": attrs}, indent=2))
    # drop metadata for images that no longer exist
    for mf in (base / "metadata").glob("*.json"):
        if mf.stem.isdigit() and int(mf.stem) > len(files): mf.unlink()
    write_contract(cfg, base, name, body)
    return 200, {"ok": True, "collection": name, "total": len(files), "kept_ai": kept,
                 "tiers": _tier_counts(ranking, tiers) if ranking else None, "contract": contract_name(name)}

def _royalty(cfg, body, st=None):
    """body (this build) > the collection's saved choice > Settings."""
    st = st or {}
    try: pct = float(body.get("royalty_pct", st.get("royalty_pct", cfg.get("royalty_pct", 5))))
    except Exception: pct = 5.0
    bps = max(0, min(3000, int(round(pct * 100))))
    addr = str(body.get("royalty_addr") or st.get("royalty_addr") or cfg.get("owner_address") or "").strip().upper()
    return bps, (f"'{addr}" if _ADDR_RE.match(addr) else "tx-sender")

# The wallet page swaps SELF_ID for 'DEPLOYER.contract-name right before deploy: the contract's own id, which the
# SIP-019 refresh notice must carry. (as-contract is gone in Clarity 4, so we don't compute it on-chain.)
SELF_ID = "'SELF.CONTRACT_ID"

def write_contract(cfg, base, name, body=None, base_uri=None):
    """(Re)write the contract. Keeps the stored base-uri unless a new one is given."""
    body = body or {}; st = _read_state(base)
    if "royalty_pct" in body:
        import math
        try: rp = float(body["royalty_pct"])
        except Exception: rp = float("nan")
        if not math.isfinite(rp) or not 0 <= rp <= 30: raise ValueError("royalty must be a number from 0 to 30")
    if "royalty_pct" in body or body.get("royalty_addr"):
        st = _write_state(base, royalty_pct=body.get("royalty_pct", st.get("royalty_pct")),
                          royalty_addr=str(body.get("royalty_addr") or st.get("royalty_addr") or "").strip().upper())
    bps, raddr = _royalty(cfg, body, st)
    cname = contract_name(name)
    if base_uri is None: base_uri = st.get("base_uri") or "<BASE_URI>"
    (base / "contract").mkdir(parents=True, exist_ok=True)
    supply = max(1, len(list_images(base / "images")))
    _contract_file(base, name).write_text(
        build_contract(name, cname, base_uri, bps, raddr, cfg.get("network", "testnet"), supply))
    return cname

def build_contract(display, cname, base_uri, royalty_bps, royalty_addr, network="testnet", max_supply=1):
    safe_display = re.sub(r"[^A-Za-z0-9 #'.,!-]", "", display)[:80]
    code = f""";; {safe_display} - SIP-009 NFT, made with SonOfSatoshi Minter {VERSION}
;; Owner functions only accept the owner's DIRECT call (contract-caller), so no other contract
;; the owner interacts with can ever act on this collection in their name.
;; The owner (the wallet that deploys this) mints, can re-point the metadata after edits,
;; can ask wallets to refresh (SIP-019), and can FREEZE the metadata forever.

(define-non-fungible-token {cname} uint)

(define-constant contract-owner tx-sender)
(define-constant err-owner-only (err u100))
(define-constant err-not-token-owner (err u101))
(define-constant err-frozen (err u102))
(define-constant err-sold-out (err u104))

;; the collection size is fixed forever: not even the owner can mint more than this
(define-constant max-supply u{int(max_supply)})

(define-data-var last-token-id uint u0)
(define-data-var base-uri (string-ascii 256) "{base_uri}")
(define-data-var frozen bool false)
(define-map token-uris uint (string-ascii 256))

;; ---- royalties (basis points: 500 = 5%) ----
(define-data-var royalty-bps uint u{royalty_bps})
(define-data-var royalty-address principal {royalty_addr})

(define-read-only (get-royalty-info)
  (ok {{ bps: (var-get royalty-bps), address: (var-get royalty-address) }}))

(define-public (set-royalty (bps uint) (addr principal))
  (begin (asserts! (is-eq contract-caller contract-owner) err-owner-only)
    (asserts! (<= bps u3000) (err u103))
    (var-set royalty-bps bps) (var-set royalty-address addr) (ok true)))

;; ---- minting (owner only) ----
(define-public (mint (recipient principal))
  (let ((token-id (+ (var-get last-token-id) u1)))
    (asserts! (is-eq contract-caller contract-owner) err-owner-only)
    (asserts! (<= token-id max-supply) err-sold-out)
    (try! (nft-mint? {cname} token-id recipient))
    (var-set last-token-id token-id)
    (ok token-id)))

;; mint up to 200 at a time: (mint-many (list 'SP... 'SP... ...)) - one token per recipient
(define-public (mint-many (recipients (list 200 principal)))
  (begin
    (asserts! (is-eq contract-caller contract-owner) err-owner-only)
    (ok (map mint-one recipients))))

(define-private (mint-one (recipient principal))
  (let ((token-id (+ (var-get last-token-id) u1)))
    (asserts! (<= token-id max-supply) err-sold-out)
    (try! (nft-mint? {cname} token-id recipient))
    (var-set last-token-id token-id)
    (ok true)))

;; ---- metadata ----
(define-read-only (get-last-token-id) (ok (var-get last-token-id)))

(define-read-only (get-max-supply) (ok max-supply))

(define-read-only (get-token-uri (token-id uint))
  (ok (some (default-to (var-get base-uri) (map-get? token-uris token-id)))))

(define-read-only (is-frozen) (ok (var-get frozen)))

;; point the whole collection at a new metadata folder (after edits / moving storage)
(define-public (set-base-uri (uri (string-ascii 256)))
  (begin (asserts! (is-eq contract-caller contract-owner) err-owner-only)
    (asserts! (not (var-get frozen)) err-frozen)
    (var-set base-uri uri) (ok true)))

;; give one token its own metadata address
(define-public (set-token-uri (token-id uint) (uri (string-ascii 256)))
  (begin (asserts! (is-eq contract-caller contract-owner) err-owner-only)
    (asserts! (not (var-get frozen)) err-frozen)
    (map-set token-uris token-id uri) (ok true)))

;; SIP-019: tell indexers (Hiro -> Xverse, Leather, marketplaces) to re-read every token's metadata
(define-public (refresh-metadata)
  (begin (asserts! (is-eq contract-caller contract-owner) err-owner-only)
    (print {{ notification: "token-metadata-update", payload: {{ token-class: "nft", contract-id: {SELF_ID} }} }})
    (ok true)))

;; one-way: after this the art and stories can never be changed by anyone, including you
(define-public (freeze-metadata)
  (begin (asserts! (is-eq contract-caller contract-owner) err-owner-only)
    (var-set frozen true) (ok true)))

;; ---- ownership ----
(define-read-only (get-owner (token-id uint)) (ok (nft-get-owner? {cname} token-id)))

(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) err-not-token-owner)
    (nft-transfer? {cname} token-id sender recipient)))
"""
    # the Stacks network rejects any contract that isn't plain printable ASCII
    bad = sorted({c for c in code if ord(c) > 126 or (ord(c) < 32 and c not in "\n\t")})
    if bad: raise ValueError(f"contract has non-ASCII characters: {bad}")
    return code

# ---------------- AI (local Ollama) ----------------
def has_cjk(text):
    return any((0x4E00 <= ord(c) <= 0x9FFF) or (0x3040 <= ord(c) <= 0x30FF) or (0xAC00 <= ord(c) <= 0xD7AF)
               or (0x3400 <= ord(c) <= 0x4DBF) for c in text or "")

def _ollama(cfg, model, prompt, images=None, fmt=None, temperature=0.7, npredict=420):
    url = cfg.get("ollama_url", "http://127.0.0.1:11434").rstrip("/") + "/api/chat"
    def call(p, temp):
        msg = {"role": "user", "content": p}
        if images: msg["images"] = images
        b = {"model": model, "stream": False, "messages": [msg], "options": {"temperature": temp, "num_predict": npredict}}
        if fmt: b["format"] = fmt
        for attempt in range(3):                       # a busy GPU sometimes answers 500 — retry
            try:
                req = urllib.request.Request(url, data=json.dumps(b).encode(), headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=600) as r:
                    return json.loads(r.read())["message"]["content"].strip()
            except Exception:
                if attempt == 2: raise
                threading.Event().wait(5 * (attempt + 1))
    out = call(prompt, temperature)
    if has_cjk(out) and not fmt:                       # models sometimes drift into another language
        for _ in range(2):
            out = call("Write ONLY in English.\n\n" + prompt, max(0.3, temperature - 0.2))
            if not has_cjk(out): break
    return out

def vision_describe(cfg, img_path):
    b = base64.b64encode(Path(img_path).read_bytes()).decode()
    q = ("Describe exactly what is in this image in 3-4 sentences: who or what is there, what they are doing, "
         "what they hold or wear (with colours), the setting, the light and the mood. Only what you can actually see.")
    return _ollama(cfg, cfg["vision_model"], q, images=[b], temperature=0.3)

TRAIT_KEYS = ("Subject", "Setting", "Artifact", "Palette", "Mood")

def extract_traits(cfg, desc):
    q = ("Extract collectible traits from this description as JSON with EXACTLY these keys: "
         + ", ".join(TRAIT_KEYS) + ". Each value 1-3 words, Title Case, grounded in the text.\n\n" + desc)
    try: d = json.loads(_ollama(cfg, cfg["writer_model"], q, fmt="json", temperature=0.2))
    except Exception: d = {}
    return {k: (str(d.get(k, "Unknown")).strip()[:40] or "Unknown") for k in TRAIT_KEYS}

def collection_lore(cfg, name, theme, descs):
    joined = "\n".join(f"- {d}" for d in descs[:8])
    q = (f"You are the loremaster for an art collection called '{name}'. Theme: {theme or 'let the art decide'}.\n"
         f"Some of its pieces:\n{joined}\n\nWrite the collection's story in 120-180 words: the world, who lives in it, "
         "what ties the pieces together. Vivid and consistent. Prose only, no headings.")
    return _ollama(cfg, cfg["writer_model"], q, temperature=0.8)

def token_backstory(cfg, name, lore, idx, desc, traits, tier, canon=""):
    tset = ", ".join(f"{k}: {v}" for k, v in traits.items())
    q = (f"You are the storyteller for the collection '{name}'.\nCANON (always true):\n{canon or lore}\n\n"
         f"WHAT IS IN PIECE #{idx:04d} (rarity {tier}):\n{desc}\nTraits: {tset}\n\n"
         "Tell the story of this exact moment in 90-140 words, present tense. Stay true to what is in the picture, "
         "weave the canon in naturally. Rarer pieces feel more legendary. Never call it an image. Prose only.")
    return _ollama(cfg, cfg["writer_model"], q, temperature=0.85, npredict=260)

_JOBS = {}; _JOBS_LOCK = threading.Lock()

def do_lore_start(cfg, body):
    name = str(body.get("collection_name", "")).strip()
    if not name: return 400, {"error": "give the collection a name first"}
    if not cfg.get("ai_enabled"): return 400, {"error": "AI is off — turn it on in Settings (needs Ollama), or use the manual trait engine"}
    base = project_path(name); imgs = list_images(base / "images")
    if not imgs: return 400, {"error": "add your images first (step 1)"}
    ok = check_ollama(cfg["ollama_url"])
    if not ok["ok"]: return 400, {"error": ok["detail"]}
    missing = [m for m in (cfg["vision_model"], cfg["writer_model"]) if not any(x == m or x.startswith(m + ":") or m == x.split(":")[0] for x in ok["models"])]
    if missing: return 400, {"error": "Ollama doesn't have: " + ", ".join(missing) + " — run  ollama pull " + missing[0] + "  or pick another model in Settings"}
    with _JOBS_LOCK:
        if _JOBS.get(name, {}).get("status") == "running": return 200, {"ok": True, "already": True, "total": len(imgs)}
        _JOBS[name] = {"status": "running", "phase": "starting", "done": 0, "total": len(imgs), "error": None}
    def run():
        try:
            res = do_lore(cfg, name, str(body.get("theme", "")).strip(), str(body.get("canon", "")).strip(), body)
            with _JOBS_LOCK: _JOBS[name].update({"status": "done", "result": res})
        except Exception as e:
            with _JOBS_LOCK: _JOBS[name].update({"status": "error", "error": f"{type(e).__name__}: {str(e)[:200]}"})
    threading.Thread(target=run, daemon=True).start()
    return 200, {"ok": True, "started": True, "total": len(imgs)}

def _progress(name, **kw):
    with _JOBS_LOCK: _JOBS.setdefault(name, {}).update(kw)

def do_lore(cfg, name, theme, canon, body):
    base = project_path(name); imgs = list_images(base / "images"); n = len(imgs)
    (base / "metadata").mkdir(parents=True, exist_ok=True)
    vdir = base / ".ai-vision"; vdir.mkdir(exist_ok=True)   # checkpoint: a restart skips what's already described
    descs = []
    for i, p in enumerate(imgs, 1):
        cache = vdir / (p.stem + ".txt")
        if cache.exists() and cache.stat().st_size > 20: descs.append(cache.read_text())
        else:
            d = vision_describe(cfg, p); cache.write_text(d); descs.append(d)
        _progress(name, phase="looking", done=i)
    tcache = vdir / "traits.json"
    traits = json.loads(tcache.read_text()) if tcache.exists() else []
    for i in range(len(traits), n):
        traits.append(extract_traits(cfg, descs[i])); tcache.write_text(json.dumps(traits))
        _progress(name, phase="traits", done=i + 1)
    tiers = resolve_tiers(cfg, body)
    ranking = _rank_to_tiers(_score(traits), tiers)
    lcache = base / "collection.json"
    old = json.loads(lcache.read_text()) if lcache.exists() else {}
    lore = old.get("lore") if old.get("theme") == theme and old.get("lore") else collection_lore(cfg, name, theme, descs)
    lcache.write_text(json.dumps({"name": name, "theme": theme, "lore": lore, "count": n}, indent=2))
    for i, p in enumerate(imgs, 1):
        r = ranking[i]; mf = _meta_file(base, i); story = ""
        if mf.exists():
            try:
                s = (json.loads(mf.read_text()).get("description") or "").strip()
                if len(s) > 60 and not s.startswith("A piece from the"): story = s   # resume
            except Exception: pass
        if not story: story = token_backstory(cfg, name, lore, i, descs[i - 1], r["attrs"], r["tier"], canon)
        attrs = [{"trait_type": "Collection", "value": name}] + [{"trait_type": c, "value": v} for c, v in r["attrs"].items()]
        attrs += [{"trait_type": "Rarity", "value": r["tier"]}, {"trait_type": "Rarity Rank", "value": r["rank"]}]
        mf.write_text(json.dumps({"name": f"{name} #{i:04d}", "description": story, "image": f"<IMAGES>/{p.name}",
                                  "attributes": attrs}, indent=2))
        _progress(name, phase="writing", done=i)
    write_contract(cfg, base, name, body)
    return {"count": n, "lore": lore, "tiers": _tier_counts(ranking, tiers)}

def do_lore_status(name):
    with _JOBS_LOCK: j = dict(_JOBS.get(name) or {})
    return (200, j) if j else (404, {"error": "no AI job for this collection"})

# ---------------- review / edit ----------------
def collection_view(name):
    base = project_path(name)
    if not (base / ".collection").exists(): return 404, {"error": "unknown collection"}
    imgs = list_images(base / "images"); lore = ""
    try: lore = json.loads((base / "collection.json").read_text()).get("lore", "")
    except Exception: pass
    toks = []
    for i, img in enumerate(imgs, 1):
        mf = _meta_file(base, i); tier = rank = ""; traits = {}; meta = None
        if mf.exists():
            try:
                meta = json.loads(mf.read_text())
                for a in meta.get("attributes", []):
                    t, v = a.get("trait_type"), a.get("value")
                    if t == "Rarity": tier = v
                    elif t == "Rarity Rank": rank = v
                    elif t != "Collection": traits[t] = v
            except Exception: meta = None
        toks.append({"id": i, "img": f"/api/img?c={urllib.parse.quote(name)}&id={i}", "tier": tier, "rank": rank,
                     "traits": traits, "meta": meta})
    return 200, {"ok": True, "collection": name, "lore": lore, "tier_ladder": [t for t, _ in resolve_tiers(load_config())],
                 "tokens": toks, "state": _read_state(base)}

def token_edit(body):
    name = str(body.get("collection_name", "")).strip(); tid = int(body.get("id") or 0)
    mf = _meta_file(project_path(name), tid)
    if not mf.exists(): return 404, {"error": "this piece has no metadata yet — run step 2 or Build first"}
    d = json.loads(mf.read_text())
    if body.get("backstory") is not None: d["description"] = str(body["backstory"])[:4000]
    if body.get("name") and str(body["name"]).strip(): d["name"] = str(body["name"]).strip()[:120]
    attrs = d.get("attributes", [])
    if isinstance(body.get("traits"), dict):
        new = [{"trait_type": str(k).strip()[:60], "value": str(v).strip()[:120]} for k, v in body["traits"].items()
               if str(k).strip() and str(k).strip() not in ("Collection", "Rarity", "Rarity Rank")][:30]
        attrs = [a for a in attrs if a.get("trait_type") == "Collection"] + new + \
                [a for a in attrs if a.get("trait_type") in ("Rarity", "Rarity Rank")]
    if body.get("tier") is not None:
        if body["tier"] not in {t for t, _ in resolve_tiers(load_config())}: return 400, {"error": "unknown rarity tier"}
        attrs = [a for a in attrs if a.get("trait_type") != "Rarity"] + [{"trait_type": "Rarity", "value": body["tier"]}]
    d["attributes"] = attrs
    mf.write_text(json.dumps(d, indent=2))
    return 200, {"ok": True, "id": tid}

# ---------------- IPFS: own node / Pinata ----------------
def _publish_files(base):
    """Only the art and the metadata go public — never notes, AI caches or settings."""
    root = base.name; files = []
    for sub in ("images", "metadata"):
        for p in sorted((base / sub).iterdir()):
            if p.is_file() and not p.name.startswith("."):
                files.append((f"{root}/{sub}/{p.name}", p))
    return root, files

def _multipart(parts, boundary):
    """parts: [(field, filename|None, bytes)]"""
    out = io.BytesIO()
    for field, fname, data in parts:
        out.write(f"--{boundary}\r\n".encode())
        if fname:
            out.write(f'Content-Disposition: form-data; name="{field}"; filename="{urllib.parse.quote(fname, safe="/")}"\r\n'.encode())
            out.write(b"Content-Type: application/octet-stream\r\n\r\n")
        else:
            out.write(f'Content-Disposition: form-data; name="{field}"\r\n\r\n'.encode())
        out.write(data); out.write(b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue()

def ipfs_add_node(api, base):
    root, files = _publish_files(base)
    boundary = "----sosminter" + base64.b16encode(os.urandom(8)).decode()
    body = _multipart([("file", rel, p.read_bytes()) for rel, p in files], boundary)
    url = api.rstrip("/") + "/api/v0/add?recursive=true&wrap-with-directory=false&cid-version=1&pin=true"
    req = urllib.request.Request(url, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    resp = urllib.request.urlopen(req, timeout=1800).read().decode()
    for line in resp.strip().splitlines():
        o = json.loads(line)
        if o.get("Name") == root: return o["Hash"]
    raise RuntimeError("the IPFS node didn't return a folder CID")

def ipfs_add_pinata(jwt, base, label):
    root, files = _publish_files(base)
    boundary = "----sosminter" + base64.b16encode(os.urandom(8)).decode()
    parts = [("file", rel, p.read_bytes()) for rel, p in files]
    parts.append(("pinataMetadata", None, json.dumps({"name": label[:90]}).encode()))
    parts.append(("pinataOptions", None, json.dumps({"cidVersion": 1}).encode()))
    req = urllib.request.Request("https://api.pinata.cloud/pinning/pinFileToIPFS", data=_multipart(parts, boundary),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                                          "Authorization": "Bearer " + jwt})
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=1800).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Pinata said HTTP {e.code}: {e.read()[:200].decode(errors='ignore')}")
    return resp["IpfsHash"]

def _link(cfg, cid, path):
    if cfg.get("chain") == "solana":                  # Solana wallets and marketplaces expect https links
        return f"{(cfg.get('public_gateway') or 'https://ipfs.io').rstrip('/')}/ipfs/{cid}/{path}"
    if cfg.get("link_style") == "gateway" and cfg.get("public_gateway"):
        return f"{cfg['public_gateway'].rstrip('/')}/ipfs/{cid}/{path}"
    return f"ipfs://{cid}/{path}"

def _push(cfg, base, name):
    """Store on the chosen place(s). Returns (cid, notes)."""
    mode = cfg.get("storage", "node"); notes = []; cid = None
    if mode in ("node", "both"):
        cid = ipfs_add_node(cfg["ipfs_api"], base); notes.append("your IPFS node")
    if mode in ("pinata", "both"):
        if not cfg.get("pinata_jwt"): raise RuntimeError("no Pinata key saved — add it in Settings")
        pc = ipfs_add_pinata(cfg["pinata_jwt"], base, name)
        if cid and pc != cid:
            notes.append(f"Pinata (warning: Pinata made a different CID {pc[:16]}… — your node's copy is the one used)")
        else:
            notes.append("Pinata")
        cid = cid or pc
    return cid, notes

def _collection_card(cfg, base, name, cid1, metas, sol):
    """The collection's own card (Solana collection link, Ethereum contractURI): name, description, first piece as picture."""
    first = json.loads(metas[0].read_text())
    lore = ""
    try: lore = json.loads((base / "collection.json").read_text()).get("lore", "")
    except Exception: pass
    img = first.get("image", "")
    card = {"name": name, "description": (lore or first.get("description", ""))[:1000], "image": img}
    if sol: card["properties"] = {"files": [{"uri": img, "type": first.get("properties", {}).get("files", [{}])[0].get("type", "image/png")}],
                                  "category": "image"}
    (base / "metadata" / "collection.json").write_text(json.dumps(card, indent=2))

def do_publish(cfg, body):
    """Two passes: 1) store to learn the images' CID, 2) write those links into the metadata and store again.
    The final folder CID is the collection; the contract's base-uri points at <cid>/metadata/{id}.json."""
    name = str(body.get("collection_name", "")).strip()
    base = project_path(name)
    metas = sorted(f for f in (base / "metadata").glob("*.json") if f.stem.isdigit()) if (base / "metadata").exists() else []
    if not metas: return 400, {"error": "build the collection first (step 2 or Build)"}
    sol = cfg.get("chain") == "solana"; eth = cfg.get("chain") == "ethereum"
    if len(metas) != len(list_images(base / "images")):
        return 400, {"error": "the number of images and metadata files differ — press Build again"}
    try:
        cid1, _ = _push(cfg, base, name + " (pass 1)")
        for jf in metas:
            d = json.loads(jf.read_text()); img = d.get("image", "")
            fname = img.rsplit("/", 1)[-1]
            d["image"] = _link(cfg, cid1, f"images/{fname}")
            if sol:   # Metaplex JSON: the file list tells wallets what kind of media it is
                d.pop("sip", None)
                d["properties"] = {"files": [{"uri": d["image"], "type": _CT.get(Path(fname).suffix.lower(), "image/png")}], "category": "image"}
                jf.write_text(json.dumps(d, indent=2)); continue
            order = ["name", "description", "image", "attributes"]
            if eth:   # the OpenSea / ERC-721 metadata layout
                d.pop("sip", None); d.pop("properties", None)
                jf.write_text(json.dumps({**{k: d[k] for k in order if k in d}, **{k: v for k, v in d.items() if k not in order}}, indent=2))
                continue
            # SIP-016: "sip": 16 first — without it Xverse shows a gray box instead of the art
            d = {"sip": 16, **{k: d[k] for k in order if k in d}, **{k: v for k, v in d.items() if k not in order + ["sip"]}}
            jf.write_text(json.dumps(d, indent=2))
        if sol or eth: _collection_card(cfg, base, name, cid1, metas, sol)
        cid, notes = _push(cfg, base, name)
    except Exception as e:
        return 502, {"error": f"storing failed: {e}"}
    if sol:
        bps, _ = _royalty(cfg, body, _read_state(base))
        st = _write_state(base, cid=cid, sol_base=_link(cfg, cid, "metadata/"), stored_on=notes, published_count=len(metas),
                          royalty_pct=bps / 100)
        return 200, {"ok": True, "cid": cid, "base_uri": st["sol_base"] + "{id}.json", "stored_on": notes,
                     "preview": _link(cfg, cid, "images/" + list_images(base / "images")[0].name),
                     "redeploy_note": bool((st.get("sol_" + cfg.get("sol_network", "devnet")) or {}).get("assets"))}
    if eth:
        bps, _ = _royalty(cfg, body, _read_state(base))
        st = _write_state(base, cid=cid, eth_base_uri=_link(cfg, cid, "metadata/"), stored_on=notes, published_count=len(metas),
                          royalty_pct=bps / 100)
        return 200, {"ok": True, "cid": cid, "base_uri": st["eth_base_uri"] + "{id}.json", "stored_on": notes,
                     "preview": _link(dict(cfg, link_style="gateway", public_gateway=cfg.get("public_gateway") or "https://ipfs.io"), cid,
                                      "images/" + list_images(base / "images")[0].name),
                     "redeploy_note": bool((st.get("eth_" + cfg.get("eth_network", "base-sepolia")) or {}).get("contract"))}
    uri = _link(cfg, cid, "metadata/{id}.json")
    if len(uri) > 256: return 400, {"error": "the metadata address is too long for the contract — use ipfs:// links in Settings"}
    write_contract(cfg, base, name, body, base_uri=uri)
    st = _write_state(base, cid=cid, base_uri=uri, stored_on=notes, published_count=len(metas))
    first = list_images(base / "images")[0].name
    return 200, {"ok": True, "cid": cid, "base_uri": uri, "stored_on": notes,
                 "preview": f"{cfg.get('ipfs_gateway','').rstrip('/')}/ipfs/{cid}/images/{first}" if cfg.get("storage") != "pinata"
                            else f"https://gateway.pinata.cloud/ipfs/{cid}/images/{first}",
                 "redeploy_note": bool(st.get("deployed_contract"))}

# ---------------- wallet step (mint page) ----------------
def mint_info(cfg, name):
    base = project_path(name)
    cname = contract_name(name)
    cf = _contract_file(base, name)
    if not cf.exists(): return 400, {"error": "build the collection first"}
    st = _read_state(base)
    count = len(list_images(base / "images"))
    stale = bool(st.get("base_uri")) and st.get("published_count") != count
    if not st.get("deployed_contract") and not stale: write_contract(cfg, base, name)   # follow settings until deployed
    code = cf.read_text()
    return 200, {"collection": name, "contract_name": cname, "code_body": code,
                 "ready": "<BASE_URI>" not in code and not stale, "count": count, "stale": stale,
                 "recipient": cfg.get("owner_address", ""), "network": cfg.get("network", "testnet"),
                 "base_uri": st.get("base_uri", ""), "state": st}

def record_tx(body):
    name = str(body.get("collection_name", "")).strip(); base = project_path(name)
    if not (base / ".collection").exists(): return 404, {"error": "unknown collection"}
    kind = str(body.get("kind", ""))[:30]; txid = str(body.get("txid", ""))[:80]
    st = _read_state(base); txs = st.get("txs", []); txs.append({"kind": kind, "txid": txid, "extra": body.get("extra")})
    upd = {"txs": txs[-200:]}
    if kind == "deploy" and body.get("contract_id"): upd["deployed_contract"] = str(body["contract_id"])[:160]
    if kind == "mint": upd["minted"] = int(st.get("minted", 0)) + int(body.get("count") or 0)
    _write_state(base, **upd)
    return 200, {"ok": True}

# ---------------- Bitcoin Ordinals: reading the chain + broadcasting (your node or mempool.space) ----------------
_ESPLORA_DEFAULT = {"mainnet": "https://mempool.space/api", "testnet4": "https://mempool.space/testnet4/api",
                    "signet": "https://mempool.space/signet/api"}
_TXID = re.compile(r"^[0-9a-f]{64}$")

def _esplora(cfg):
    base = (cfg.get("esplora_url") or _ESPLORA_DEFAULT.get(cfg.get("btc_network"), "")).rstrip("/")
    if not base: raise RuntimeError("no data source for this network — set your own node in Settings")
    return base

def _rpc(cfg, method, params=None):
    auth = base64.b64encode(f"{cfg.get('rpc_user', '')}:{cfg.get('rpc_pass', '')}".encode()).decode()
    body = json.dumps({"jsonrpc": "1.0", "id": "sosm", "method": method, "params": params or []}).encode()
    req = urllib.request.Request(cfg.get("rpc_url", "http://127.0.0.1:8332"), data=body,
                                 headers={"Content-Type": "application/json", "Authorization": "Basic " + auth})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        try: r = json.loads(e.read())
        except Exception: raise RuntimeError(f"your node answered HTTP {e.code} (check the RPC user/password)")
    if r.get("error"): raise RuntimeError(str(r["error"].get("message", r["error"]))[:200])
    return r.get("result")

def btc_fees(cfg):
    """sat/vB presets: fast / normal / slow / minimum."""
    if cfg.get("btc_backend") == "rpc":
        def est(n):
            try: return max(1.0, round(float(_rpc(cfg, "estimatesmartfee", [n]).get("feerate", 0)) * 1e5, 1))
            except Exception: return 1.0
        return {"fast": est(1), "normal": est(3), "slow": est(6), "minimum": 1.0}
    base = _esplora(cfg)
    try:
        d = json.loads(urllib.request.urlopen(base + "/v1/fees/recommended", timeout=15).read())
        return {"fast": d["fastestFee"], "normal": d["halfHourFee"], "slow": d["hourFee"], "minimum": d.get("minimumFee", 1)}
    except Exception:
        d = json.loads(urllib.request.urlopen(base + "/fee-estimates", timeout=15).read())
        g = lambda k: round(float(d.get(k, 1)), 1)
        return {"fast": g("1"), "normal": g("3"), "slow": g("6"), "minimum": g("144")}

def btc_utxos(cfg, address):
    if not _btc_addr_ok(address, cfg.get("btc_network")): raise RuntimeError("not an address on this network")
    if cfg.get("btc_backend") == "rpc":
        res = _rpc(cfg, "scantxoutset", ["start", [f"addr({address})"]]) or {}
        return [{"txid": u["txid"], "vout": u["vout"], "value": int(round(u["amount"] * 1e8)), "confirmed": True} for u in res.get("unspents", [])]
    d = json.loads(urllib.request.urlopen(f"{_esplora(cfg)}/address/{address}/utxo", timeout=20).read())
    return [{"txid": u["txid"], "vout": u["vout"], "value": u["value"], "confirmed": bool(u.get("status", {}).get("confirmed"))} for u in d]

def btc_broadcast(cfg, hexstr):
    if not re.fullmatch(r"[0-9a-f]{120,800000}", hexstr or ""): raise RuntimeError("not a raw transaction")
    if cfg.get("btc_backend") == "rpc": return _rpc(cfg, "sendrawtransaction", [hexstr])
    req = urllib.request.Request(f"{_esplora(cfg)}/tx", data=hexstr.encode(), headers={"Content-Type": "text/plain"})
    try: return urllib.request.urlopen(req, timeout=30).read().decode().strip()
    except urllib.error.HTTPError as e: raise RuntimeError("the network refused it: " + e.read().decode(errors="ignore")[:300])

def btc_tx(cfg, txid):
    if not _TXID.match(txid or ""): raise RuntimeError("bad txid")
    if cfg.get("btc_backend") == "rpc":
        try:
            t = _rpc(cfg, "getrawtransaction", [txid, True])
            return {"found": True, "confirmed": int(t.get("confirmations", 0)) > 0, "confirmations": int(t.get("confirmations", 0))}
        except RuntimeError:
            o = _rpc(cfg, "gettxout", [txid, 0, True])
            return {"found": bool(o), "confirmed": bool(o) and int(o.get("confirmations", 0)) > 0, "confirmations": int((o or {}).get("confirmations", 0))}
    try:
        d = json.loads(urllib.request.urlopen(f"{_esplora(cfg)}/tx/{txid}/status", timeout=20).read())
        return {"found": True, "confirmed": bool(d.get("confirmed")), "height": d.get("block_height")}
    except urllib.error.HTTPError as e:
        if e.code == 404: return {"found": False, "confirmed": False}
        raise

def btc_check(cfg, body):
    c = {**cfg, **{k: body[k] for k in ("btc_network", "btc_backend", "esplora_url", "rpc_url", "rpc_user") if k in body}}
    if body.get("rpc_pass"): c["rpc_pass"] = body["rpc_pass"]
    for k in ("esplora_url", "rpc_url"):
        if c.get(k) and not _URL_RE.match(str(c[k])): return 400, {"error": f"{k} must start with http:// or https://"}
    try:
        if c.get("btc_backend") == "rpc":
            info = _rpc(c, "getblockchaininfo")
            want = {"mainnet": "main", "testnet4": "testnet4", "signet": "signet", "regtest": "regtest"}[c.get("btc_network", "mainnet")]
            if info.get("chain") != want: return 200, {"ok": False, "detail": f"your node is on '{info.get('chain')}', not {c.get('btc_network')}"}
            return 200, {"ok": True, "detail": f"your Bitcoin node is on {info.get('chain')} at block {info.get('blocks')}", "fees": btc_fees(c)}
        h = urllib.request.urlopen(_esplora(c) + "/blocks/tip/height", timeout=15).read().decode().strip()
        return 200, {"ok": True, "detail": f"{_esplora(c).split('/')[2]} answers: block {h}", "fees": btc_fees(c)}
    except Exception as e:
        return 200, {"ok": False, "detail": f"can't reach it ({type(e).__name__}: {str(e)[:120]})"}

# ---------------- Ordinals: pieces + batches (the temporary key lives here, owner-only) ----------------
def _ord_dir(name):
    d = project_path(name) / "ordinals"; d.mkdir(parents=True, exist_ok=True); return d

def ord_pieces(cfg, body):
    """Each piece as it will be inscribed: the chosen file (a compressed version if you made one) + its metadata."""
    name = str(body.get("collection_name", "")).strip()
    base = project_path(name)
    imgs = list_images(base / "images")
    if not imgs: return 400, {"error": "add your images first (step 1)"}
    story = body.get("story_onchain", cfg.get("ord_story_onchain", True))
    odir = base / "ordinals"; out = []
    for i, img in enumerate(imgs, 1):
        alt = next((f for f in sorted(odir.glob(f"{i:04d}.*")) if f.suffix.lower() in IMG_EXTS), None) if odir.exists() else None
        f = alt or img; raw = f.read_bytes()
        meta = {}
        mf = _meta_file(base, i)
        if mf.exists():
            try:
                m = json.loads(mf.read_text())
                meta = {"name": m.get("name") or f"{name} #{i:04d}", "collection": name,
                        "attributes": [a for a in m.get("attributes", []) if a.get("trait_type") != "Collection"]}
                if story and m.get("description"): meta["description"] = m["description"]
            except Exception: meta = {}
        if not meta: meta = {"name": f"{name} #{i:04d}", "collection": name}
        out.append({"id": i, "contentType": _CT.get(f.suffix.lower(), "application/octet-stream"), "bytes": len(raw),
                    "compressed": bool(alt), "original_bytes": img.stat().st_size, "body": base64.b64encode(raw).decode(),
                    "metadata": meta, "img": f"/api/img?c={urllib.parse.quote(name)}&id={i}"})
    return 200, {"ok": True, "pieces": out}

def ord_set_content(body):
    """Save the compressed version of one piece (or remove it to go back to the original)."""
    name = str(body.get("collection_name", "")).strip(); i = int(body.get("id") or 0)
    base = project_path(name)
    if not 1 <= i <= len(list_images(base / "images")): return 400, {"error": "no such piece"}
    odir = _ord_dir(name)
    for f in odir.glob(f"{i:04d}.*"): f.unlink()
    if body.get("reset"): return 200, {"ok": True, "reset": True}
    data = str(body.get("data", ""))
    if data.startswith("data:") and "," in data: data = data.split(",", 1)[1]
    try: raw = base64.b64decode(data, validate=False)
    except Exception: return 400, {"error": "bad image data"}
    ext = _img_ext(raw)
    if not ext: return 400, {"error": "not an image"}
    (odir / f"{i:04d}{ext}").write_bytes(raw)
    return 200, {"ok": True, "bytes": len(raw)}

_BATCH_ID = re.compile(r"^[a-z0-9-]{6,40}$")
def _batch_file(name, bid):
    if not _BATCH_ID.match(bid or ""): raise ValueError("bad batch id")
    d = _ord_dir(name) / "batches"; d.mkdir(exist_ok=True); os.chmod(d, 0o700)
    root = os.path.realpath(str(d)); full = os.path.realpath(os.path.join(root, bid + ".json"))
    if not full.startswith(root + os.sep) or os.path.dirname(full) != root: raise ValueError("bad batch id")
    return Path(full)

def ord_batch_save(body):
    name = str(body.get("collection_name", "")).strip(); b = body.get("batch")
    if not isinstance(b, dict): return 400, {"error": "no batch"}
    f = _batch_file(name, str(b.get("id", "")))
    old = json.loads(f.read_text()) if f.exists() else {}
    if old.get("key") and b.get("key") and old["key"] != b["key"]: return 409, {"error": "this batch already has a different key — refusing to overwrite it"}
    merged = {**old, **b}
    tmp = f.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)                 # holds the temporary key: owner-only
    with os.fdopen(fd, "w") as fh: fh.write(json.dumps(merged))
    tmp.replace(f)
    return 200, {"ok": True}

def ord_batches(body):
    name = str(body.get("collection_name", "")).strip()
    d = project_path(name) / "ordinals" / "batches"
    out = [json.loads(f.read_text()) for f in sorted(d.glob("*.json"))] if d.exists() else []
    return 200, {"ok": True, "batches": out}

def ord_collection_file(body):
    """The list marketplaces (Magic Eden etc.) ask for: every inscription id with its name and traits."""
    name = str(body.get("collection_name", "")).strip()
    _, r = ord_batches({"collection_name": name}); items = []
    for b in r["batches"]:
        for it in b.get("items", []):
            if it.get("inscription_id"):
                m = (b.get("snapshot", {}).get(str(it["id"])) or {}).get("metadata", {})
                items.append({"id": it["inscription_id"], "meta": {"name": m.get("name", f"{name} #{it['id']:04d}"), "attributes": m.get("attributes", [])}})
    items.sort(key=lambda x: x["meta"]["name"])
    f = project_path(name) / "ordinals" / "collection.json"; f.write_text(json.dumps(items, indent=2))
    return 200, {"ok": True, "count": len(items), "items": items, "path": str(f)}

# ---------------- HTTP ----------------
# ---------------- Solana (Metaplex Core): RPC relay + mint records ----------------
_SOL_GENESIS = {"mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"}
# only what the mint page needs; the relay is not a general-purpose proxy for your RPC key
_SOL_METHODS = {"getLatestBlockhash", "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getBlockHeight",
                "getAccountInfo", "getMultipleAccounts", "getBalance", "getRecentPrioritizationFees", "getVersion", "getGenesisHash",
                "getMinimumBalanceForRentExemption", "getSlot", "getTransaction", "getFeeForMessage", "getProgramAccounts",
                "isBlockhashValid", "requestAirdrop"}
_SOL_LOCK = threading.Lock()

def _sol_call(cfg, method, params=None):
    req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    _, b = _get(sol_endpoint(cfg), timeout=15, headers={"Content-Type": "application/json"}, data=req)
    o = json.loads(b)
    if o.get("error"): raise RuntimeError(o["error"].get("message", "RPC error"))
    return o.get("result")

def sol_relay(cfg, raw):
    """Pass the page's JSON-RPC calls to your Solana RPC (keeps a paid RPC's key out of the browser)."""
    try: body = json.loads(raw)
    except Exception: return 400, b'{"error":"bad request"}'
    calls = body if isinstance(body, list) else [body]
    if not calls or len(calls) > 100 or not all(isinstance(c, dict) and c.get("method") in _SOL_METHODS for c in calls):
        return 403, b'{"error":"that call is not allowed through this app"}'
    if cfg.get("sol_network") == "mainnet" and any(c.get("method") == "requestAirdrop" for c in calls):
        return 403, b'{"error":"no airdrops on mainnet"}'
    try:
        return _get(sol_endpoint(cfg), timeout=30, headers={"Content-Type": "application/json"}, data=raw)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:4000]

def sol_check(cfg, body):
    net = body.get("sol_network", cfg.get("sol_network"))
    if net not in _SOL_RPC: return 400, {"error": "unknown Solana network"}
    # same as saving it: the typed RPC, else the saved one (if it belongs to this network), else the public one
    c = {**cfg, "sol_network": net, "sol_rpc": cfg.get("sol_rpc", "") if net == cfg.get("sol_network") else ""}
    if body.get("sol_rpc"): c["sol_rpc"] = str(body["sol_rpc"]).strip().rstrip("/")
    if c["sol_rpc"] and not _URL_RE.match(c["sol_rpc"]): return 400, {"error": "the RPC must start with http:// or https://"}
    ep = sol_endpoint(c)
    try:
        g = _sol_call(c, "getGenesisHash"); v = _sol_call(c, "getVersion")
        acc = _sol_call(c, "getAccountInfo", ["CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", {"encoding": "base64", "dataSlice": {"offset": 0, "length": 0}}])
    except Exception as e:
        return 200, {"ok": False, "detail": f"no answer from {urllib.parse.urlparse(ep).hostname} ({type(e).__name__})"}
    if net in _SOL_GENESIS and g != _SOL_GENESIS[net]: return 200, {"ok": False, "detail": f"that RPC is not on Solana {net}"}
    if not (acc or {}).get("value"): return 200, {"ok": False, "detail": "the Metaplex Core program is not on this network (a local validator needs it loaded, see the Guide)"}
    return 200, {"ok": True, "detail": f"Solana {net} answers (version {v.get('solana-core', '?')}), Metaplex Core is there"}

def sol_info(cfg, name):
    base = project_path(name)
    if not (base / ".collection").exists(): return 404, {"error": "unknown collection"}
    st = _read_state(base); count = len(list_images(base / "images"))
    if not st.get("sol_base"): return 400, {"error": "store the collection first (Publish), with Solana chosen in Settings"}
    pieces = []
    for i in range(1, count + 1):
        try: nm = json.loads(_meta_file(base, i).read_text()).get("name", "")
        except Exception: nm = ""
        pieces.append({"id": i, "name": nm or f"{name} #{i:04d}", "uri": f"{st['sol_base']}{i}.json"})
    net = cfg.get("sol_network", "devnet")
    bps, _ = _royalty(cfg, {}, st)
    return 200, {"collection": name, "pieces": pieces, "collection_uri": st["sol_base"] + "collection.json",
                 "stale": st.get("published_count") != count, "network": net,
                 "owner": cfg.get("sol_owner", ""), "royalty_bps": bps, "sol": st.get("sol_" + net) or {},
                 "rpc_host": urllib.parse.urlparse(sol_endpoint(cfg)).hostname or ""}

def sol_save(body):
    """Records what happened on-chain, so a closed page never loses track of a collection or a batch."""
    name = str(body.get("collection_name", "")).strip(); base = project_path(name)
    if not (base / ".collection").exists(): return 404, {"error": "unknown collection"}
    key = "sol_" + load_config().get("sol_network", "devnet")    # devnet practice never mixes with mainnet records
    with _SOL_LOCK:
        st = _read_state(base); sol = st.get(key) or {}
        c = body.get("collection")
        if c is not None:
            if not _sol_addr_ok(c): return 400, {"error": "bad collection address"}
            if sol.get("collection") and sol["collection"] != c and not body.get("replace"):
                return 409, {"error": "this collection already has a Solana collection address"}
            sol["collection"] = c
        if isinstance(body.get("assets"), dict):
            a = sol.get("assets") or {}
            for k, v in body["assets"].items():
                if not (str(k).isdigit() and _sol_addr_ok(v)): return 400, {"error": "bad asset record"}
                a[str(int(k))] = v
            sol["assets"] = a
        if isinstance(body.get("pending"), list):
            pend = []
            for x in body["pending"][:500]:
                if not (isinstance(x, dict) and re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{64,90}", str(x.get("sig", ""))) and
                        isinstance(x.get("lastValid"), int)): return 400, {"error": "bad pending record"}
                ids = x.get("ids") or {}
                if not (isinstance(ids, dict) and all(str(k).isdigit() and _sol_addr_ok(v) for k, v in ids.items())):
                    return 400, {"error": "bad pending record"}
                pend.append({"sig": x["sig"], "lastValid": x["lastValid"], "kind": str(x.get("kind", ""))[:20], "ids": ids,
                             "uri": str(x.get("uri", ""))[:300]})
            sol["pending"] = pend
        if "royalty_bps" in body: sol["royalty_bps"] = max(0, min(3000, int(body["royalty_bps"])))
        if "uris" in body and isinstance(body["uris"], dict):   # link each piece currently points to (after a re-point)
            u = sol.get("uris") or {}
            u.update({str(int(k)): str(v)[:300] for k, v in body["uris"].items() if str(k).isdigit()}); sol["uris"] = u
        if body.get("locked") is True: sol["locked"] = True
        _write_state(base, **{key: sol})
    return 200, {"ok": True, "sol": sol}

# ---------------- Ethereum / Base: records (the wallet talks to the chain itself) ----------------
_ETH_LOCK = threading.Lock()

def eth_info(cfg, name):
    base = project_path(name)
    if not (base / ".collection").exists(): return 404, {"error": "unknown collection"}
    st = _read_state(base); count = len(list_images(base / "images"))
    if not st.get("eth_base_uri"): return 400, {"error": "store the collection first (Publish), with Ethereum chosen in Settings"}
    net = cfg.get("eth_network", "base-sepolia")
    bps, _ = _royalty(cfg, {}, st)
    return 200, {"collection": name, "count": count, "base_uri": st["eth_base_uri"], "stale": st.get("published_count") != count,
                 "network": net, "owner": cfg.get("eth_owner", ""), "royalty_bps": bps, "eth": st.get("eth_" + net) or {}}

def eth_save(body):
    """Records the contract and the transactions the wallet sent, so a closed page never loses track of them."""
    name = str(body.get("collection_name", "")).strip(); base = project_path(name)
    if not (base / ".collection").exists(): return 404, {"error": "unknown collection"}
    key = "eth_" + load_config().get("eth_network", "base-sepolia")    # testnet records never mix with mainnet ones
    with _ETH_LOCK:
        st = _read_state(base); e = st.get(key) or {}
        c = body.get("contract")
        if c is not None:
            if not _ETH_ADDR.match(str(c)): return 400, {"error": "bad contract address"}
            if e.get("contract") and e["contract"].lower() != str(c).lower() and not body.get("replace"):
                return 409, {"error": "this collection already has a contract on this network"}
            e["contract"] = c; e.pop("deploy", None)
        if "deploy" in body:                             # a deploy in flight: who sent it, with which nonce, where it lands
            d = body["deploy"]
            if d is None: e.pop("deploy", None)
            elif not (isinstance(d, dict) and _ETH_ADDR.match(str(d.get("from", ""))) and _ETH_ADDR.match(str(d.get("predicted", "")))
                      and isinstance(d.get("nonce"), int) and d["nonce"] >= 0 and (not d.get("tx") or _ETH_TX.match(str(d["tx"])))):
                return 400, {"error": "bad deploy record"}
            else: e["deploy"] = {k: d[k] for k in ("from", "predicted", "nonce", "tx") if d.get(k) is not None}
        if isinstance(body.get("pending"), list):
            pend = []
            for x in body["pending"][:200]:
                if not (isinstance(x, dict) and _ETH_TX.match(str(x.get("tx", "")))): return 400, {"error": "bad pending record"}
                pend.append({"tx": x["tx"], "kind": str(x.get("kind", ""))[:20], "note": str(x.get("note", ""))[:120]})
            e["pending"] = pend
        if "royalty_bps" in body: e["royalty_bps"] = max(0, min(3000, int(body["royalty_bps"])))
        if body.get("frozen") is True: e["frozen"] = True
        _write_state(base, **{key: e})
    return 200, {"ok": True, "eth": e}

PAGES = {"/": "index.html", "/index.html": "index.html", "/setup": "setup.html", "/guide": "guide.html", "/inscribe": "inscribe.html", "/solana": "solana.html", "/ethereum": "ethereum.html",
         "/mint": "mint.html", "/settings": "setup.html"}
STATIC = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json"}
# the only files /static/ can ever serve: the app's own web/ folder, listed once at startup
STATIC_FILES = {f.name: f for f in WEB.iterdir() if f.is_file() and f.suffix in STATIC} if WEB.exists() else {}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "connect-src 'self' https://api.hiro.so https://api.mainnet.hiro.so https://api.testnet.hiro.so; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

class H(BaseHTTPRequestHandler):
    server_version = "SonOfSatoshiMinter"
    def log_message(self, *a): pass

    def _send(self, code, obj, ctype="application/json"):
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(data)

    def _host_ok(self):
        # DNS-rebinding guard: only answer to the loopback names this app is opened with
        h = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return h in ("127.0.0.1", "localhost", "::1")

    def _origin_ok(self):
        for hdr in ("Origin", "Referer"):
            v = self.headers.get(hdr, "")
            if v:
                return v.split("://", 1)[-1].split("/", 1)[0].rsplit(":", 1)[0].strip("[]").lower() in ("127.0.0.1", "localhost", "::1")
        return True

    def do_GET(self):
        try: return self._get()
        except Exception as e: return self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def _get(self):
        if not self._host_ok(): return self._send(403, {"error": "open the app at http://127.0.0.1:%d" % PORT})
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query); p = u.path
        cfg = load_config()
        if p in PAGES:
            if p in ("/", "/index.html") and not cfg.get("setup_done"):
                self.send_response(302); self.send_header("Location", "/setup"); self.end_headers(); return
            return self._send(200, (WEB / PAGES[p]).read_bytes(), "text/html; charset=utf-8")
        if p.startswith("/static/"):
            f = STATIC_FILES.get(p[len("/static/"):])
            if f: return self._send(200, f.read_bytes(), STATIC[f.suffix])
            return self._send(404, {"error": "not found"})
        if p == "/api/config": return self._send(200, public_config(cfg))
        if p == "/api/projects": return self._send(200, {"projects": list_projects()})
        if p == "/api/collection": return self._send(*collection_view((q.get("name") or [""])[0]))
        if p == "/api/lore-status": return self._send(*do_lore_status((q.get("name") or [""])[0]))
        if p == "/api/mintinfo": return self._send(*mint_info(cfg, (q.get("name") or [""])[0]))
        if p == "/api/sol/info": return self._send(*sol_info(cfg, (q.get("name") or [""])[0]))
        if p == "/api/eth/info": return self._send(*eth_info(cfg, (q.get("name") or [""])[0]))
        if p == "/api/img":
            name = (q.get("c") or [""])[0]
            try: tid = int((q.get("id") or ["0"])[0])
            except ValueError: tid = 0
            imgs = list_images(project_path(name) / "images")
            if 1 <= tid <= len(imgs):
                f = imgs[tid - 1]; return self._send(200, f.read_bytes(), _CT.get(f.suffix.lower(), "application/octet-stream"))
            return self._send(404, {"error": "no image"})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._host_ok() or not self._origin_ok() or self.headers.get("X-SOS-Minter") != "1":
            return self._send(403, {"error": "blocked"})
        try: n = int(self.headers.get("Content-Length", 0))
        except ValueError: n = -1
        if n < 0 or n > MAX_BODY: return self._send(413, {"error": "upload too big for one request"})
        if self.path == "/api/sol/rpc":             # JSON-RPC can be a list, so it skips the dict check below
            if n > 4 * 1024 * 1024: return self._send(413, {"error": "too big"})
            try: return self._send(*sol_relay(load_config(), self.rfile.read(n)))
            except Exception as e: return self._send(502, {"error": f"Solana RPC: {type(e).__name__}"})
        try: body = json.loads(self.rfile.read(n) or b"{}", parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
        except Exception: return self._send(400, {"error": "bad request"})
        if not isinstance(body, dict): return self._send(400, {"error": "bad request"})
        cfg = load_config(); p = self.path
        try:
            if p == "/api/config": return self._send(*update_config(body))
            if p == "/api/check": return self._send(*do_check(cfg, body))
            if p == "/api/upload": return self._send(*do_upload(cfg, body))
            if p == "/api/generate": return self._send(*do_generate(cfg, body))
            if p == "/api/lore": return self._send(*do_lore_start(cfg, body))
            if p == "/api/token-edit": return self._send(*token_edit(body))
            if p == "/api/publish": return self._send(*do_publish(cfg, body))
            if p == "/api/record-tx": return self._send(*record_tx(body))
            if p == "/api/btc/check": return self._send(*btc_check(cfg, body))
            if p == "/api/btc/fees": return self._send(200, btc_fees(cfg))
            if p == "/api/btc/utxos": return self._send(200, {"utxos": btc_utxos(cfg, str(body.get("address", "")))})
            if p == "/api/btc/broadcast": return self._send(200, {"txid": btc_broadcast(cfg, str(body.get("hex", "")))})
            if p == "/api/btc/tx": return self._send(200, btc_tx(cfg, str(body.get("txid", ""))))
            if p == "/api/ord/pieces": return self._send(*ord_pieces(cfg, body))
            if p == "/api/ord/set-content": return self._send(*ord_set_content(body))
            if p == "/api/ord/batch-save": return self._send(*ord_batch_save(body))
            if p == "/api/ord/batches": return self._send(*ord_batches(body))
            if p == "/api/ord/collection-file": return self._send(*ord_collection_file(body))
            if p == "/api/sol/check": return self._send(*sol_check(cfg, body))
            if p == "/api/sol/save": return self._send(*sol_save(body))
            if p == "/api/eth/save": return self._send(*eth_save(body))
        except Exception as e:
            return self._send(500, {"error": f"{type(e).__name__}: {e}"})
        return self._send(404, {"error": "not found"})

if __name__ == "__main__":
    PROJECTS.mkdir(parents=True, exist_ok=True)
    if not CONFIG.exists(): save_config(dict(DEFAULT_CONFIG))
    print(f"SonOfSatoshi Minter {VERSION}  ->  http://127.0.0.1:{PORT}")
    print(f"your collections live in {PROJECTS}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
