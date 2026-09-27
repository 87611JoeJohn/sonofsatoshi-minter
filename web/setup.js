'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-SOS-Minter': '1' },
    body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
let CFG = {}, STEP = '0';
const S = { network: 'testnet', storage: 'node', link_style: 'ipfs', chain: 'stacks', btc_network: 'testnet4', btc_backend: 'esplora', sol_network: 'devnet', eth_network: 'base-sepolia' };
// the steps each chain walks through (Ordinals has no Stacks wallet, IPFS or royalty steps)
const ORDER = { stacks: ['0', 'c', '1', '2', '3', '4', '5'], ordinals: ['0', 'c', 'b', '4', '5'], solana: ['0', 'c', 's', '3', '4', '5'], ethereum: ['0', 'c', 'e', '3', '4', '5'] };
const order = () => ORDER[S.chain] || ORDER.stacks;
function show(id) {
  if (!order().includes(id)) id = order()[0];
  STEP = id; const o = order(), k = o.indexOf(id);
  $$('.step').forEach(s => s.classList.toggle('on', s.dataset.step === id));
  $('#dots').innerHTML = o.map((_, i) => `<i class="${i <= k ? 'on' : ''}"></i>`).join('');
  if (id === '4') testAi();
  if (id === '5') summary();
  window.scrollTo(0, 0);
}
const step = d => { const o = order(), k = o.indexOf(STEP); return o[Math.max(0, Math.min(o.length - 1, k + d))]; };
const PREFIX = { mainnet: 'bc1', testnet4: 'tb1', signet: 'tb1', regtest: 'bcrt1' };
function setChain(v) {
  S.chain = v; pick('#chainChoices', 'chain', v);
  const ord = v === 'ordinals';
  $('#royaltyBox').style.display = ord ? 'none' : ''; $('#finishTitle').textContent = ord ? 'Finish' : 'Royalty and finish';
  const sol = v === 'solana';                        // Solana links are always https: only the gateway choice is left
  $('#linkChoices').style.display = sol ? 'none' : ''; $('#solLinkNote').style.display = sol ? '' : 'none';
  $('#linkSummary').textContent = sol ? 'Your public gateway (optional)' : 'How NFTs link to the art (advanced)';
  $('#gwBox').style.display = sol || S.link_style === 'gateway' ? '' : 'none';
}
const SOL58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function setEthNet(v) { S.eth_network = v; pick('#ethNetChoices', 'ethnet', v); }
function checkEthOwner() {
  const a = $('#ethOwner').value.trim(), o = $('#ethOwnerOut'), ok = !a || /^0x[0-9a-fA-F]{40}$/.test(a);
  o.textContent = a ? (ok ? '✓ looks right' : '✕ that isn\'t an Ethereum address (0x followed by 40 characters)') : ''; o.className = 'out ' + (ok ? 'good' : 'bad');
  return ok;
}
function setSolNet(v) { S.sol_network = v; pick('#solNetChoices', 'solnet', v); }
function checkSolOwner() {
  const a = $('#solOwner').value.trim(), o = $('#solOwnerOut');
  const ok = !a || SOL58.test(a);
  o.textContent = a ? (ok ? '✓ looks right' : '✕ that isn\'t a Solana address') : ''; o.className = 'out ' + (ok ? 'good' : 'bad');
  return ok;
}
async function testSol() {
  $('#solOut').textContent = 'testing…';
  const r = await api('/api/sol/check', { sol_network: S.sol_network, sol_rpc: $('#solRpc').value.trim() });
  dot('#solDot', !!r.ok, r.detail || r.error || 'no answer', '#solOut'); return !!r.ok;
}
function setBtcNet(v) { S.btc_network = v; pick('#btcNetChoices', 'btcnet', v); $('#ordPrefix').textContent = PREFIX[v] + 'p'; checkBtcAddrs(); }
function setBtcSrc(v) { S.btc_backend = v; pick('#btcSrcChoices', 'btcsrc', v); $('#esploraBox').style.display = v === 'esplora' ? '' : 'none'; $('#rpcBox').style.display = v === 'rpc' ? '' : 'none'; }
function checkBtcAddrs() {
  const pre = PREFIX[S.btc_network], o = $('#btcAddrOut'), a = $('#ordAddr').value.trim(), r = $('#refundAddr').value.trim();
  const bad = [];
  if (a && !a.toLowerCase().startsWith(pre)) bad.push(`the ordinals address should start with ${pre}p on ${S.btc_network}`);
  else if (a && !a.toLowerCase().startsWith(pre + 'p')) bad.push('your ordinals address is not a taproot (…1p…) address; use your wallet\'s Ordinals address');
  if (r && !r.toLowerCase().startsWith(pre)) bad.push(`the refund address should start with ${pre} on ${S.btc_network}`);
  o.textContent = bad.length ? '✕ ' + bad.join('; ') : (a && r ? '✓ looks right' : ''); o.className = 'out ' + (bad.length ? 'bad' : 'good');
  return !bad.length && !!a && !!r;
}
async function testBtc() {
  $('#btcOut').textContent = 'testing…';
  const body = { btc_network: S.btc_network, btc_backend: S.btc_backend, esplora_url: $('#esploraUrl').value.trim(), rpc_url: $('#rpcUrl').value.trim(), rpc_user: $('#rpcUser').value.trim() };
  if ($('#rpcPass').value) body.rpc_pass = $('#rpcPass').value;
  const r = await api('/api/btc/check', body);
  dot('#btcDot', !!r.ok, r.detail || r.error || 'no answer', '#btcOut'); return !!r.ok;
}
function pick(group, attr, val) {
  $$(group + ' .choice').forEach(c => c.classList.toggle('on', c.dataset[attr] === val));
}
function setNet(v) {
  S.network = v; pick('#netChoices', 'net', v);
  $('#faucetNote').style.display = v === 'testnet' ? '' : 'none';
  $('#addrPrefix').textContent = v === 'testnet' ? 'ST…' : 'SP…';
  checkAddr();
}
function setStore(v) {
  S.storage = v; pick('#storeChoices', 'store', v);
  $('#nodeBox').style.display = v === 'pinata' ? 'none' : '';
  $('#pinataBox').style.display = v === 'node' ? 'none' : '';
}
function setLink(v) { S.link_style = v; pick('#linkChoices', 'link', v); $('#gwBox').style.display = v === 'gateway' || S.chain === 'solana' ? '' : 'none'; }

function checkAddr() {
  const a = $('#owner').value.trim().toUpperCase(), o = $('#ownerOut');
  if (!a) { o.textContent = ''; o.className = 'out'; return false; }
  if (!/^S[PMTN][0-9A-HJKMNP-TV-Z]{38,40}$/.test(a)) { o.textContent = '✕ that isn\'t a Stacks address'; o.className = 'out bad'; return false; }
  const test = a.startsWith('ST') || a.startsWith('SN');
  if (test && S.network === 'mainnet') { o.textContent = '✕ that\'s a testnet address (ST…) but you chose mainnet'; o.className = 'out bad'; return false; }
  if (!test && S.network === 'testnet') { o.textContent = '✕ that\'s a mainnet address (SP…); on testnet your wallet shows an ST… address'; o.className = 'out bad'; return false; }
  o.textContent = '✓ looks right'; o.className = 'out good'; return true;
}
function dot(id, ok, text, outId) { $(id).className = 'dot ' + (ok ? 'ok' : 'no'); $(outId).textContent = text; }

async function testNode() {
  $('#nodeOut').textContent = 'testing…';
  const r = await api('/api/check', { what: 'ipfs', ipfs_api: $('#ipfsApi').value.trim() || 'http://127.0.0.1:5001' });
  dot('#nodeDot', r.ipfs.ok, r.ipfs.detail, '#nodeOut');
  const w = $('#reachOut');
  if (r.reach) {
    w.style.display = ''; w.className = 'note' + (r.reach.ok ? '' : ' warn');
    w.innerHTML = (r.reach.ok ? '✓ ' : '⚠ ') + r.reach.detail.replace(/[<>&]/g, '');
    if (!r.reach.ok && S.storage === 'node' && S.link_style === 'ipfs') { $('#linkDetails').open = true; }
  } else w.style.display = 'none';
  return r.ipfs.ok;
}
async function testPinata() {
  $('#pinOut').textContent = 'testing…';
  const r = await api('/api/check', { what: 'pinata', pinata_jwt: $('#pinataJwt').value.trim() });
  dot('#pinDot', r.pinata.ok, r.pinata.detail, '#pinOut'); return r.pinata.ok;
}
async function testGw() {
  $('#gwOut').textContent = 'testing…';
  const r = await api('/api/check', { what: 'gateway', public_gateway: $('#pubGw').value.trim() });
  dot('#gwDot', r.gateway.ok, r.gateway.detail, '#gwOut'); return r.gateway.ok;
}
function fillModels(sel, models, want, prefer) {
  const opts = models.length ? models : [want];
  let chosen = opts.find(m => m === want || m.split(':')[0] === want.split(':')[0]);
  if (!chosen) chosen = opts.find(m => prefer.some(p => m.startsWith(p))) || opts[0];
  sel.replaceChildren(...opts.map(m => { const o = document.createElement('option'); o.textContent = m; o.selected = m === chosen; return o; }));
}
async function testAi() {
  $('#aiOut').textContent = 'checking for Ollama…';
  const r = await api('/api/check', { what: 'ollama', ollama_url: $('#ollamaUrl').value.trim() || 'http://127.0.0.1:11434' });
  const o = r.ollama, models = o.models || [];
  dot('#aiDot', o.ok, o.detail, '#aiOut');
  const vis = models.filter(m => /llava|vision|bakllava|moondream|minicpm-v|qwen2\.5vl|gemma3/i.test(m));
  const txt = models.filter(m => !/guard|embed/i.test(m));
  fillModels($('#visionModel'), vis, CFG.vision_model || 'llava', ['llava', 'llama3.2-vision']);
  fillModels($('#writerModel'), txt, CFG.writer_model || 'qwen2.5:14b', ['qwen2.5', 'llama3', 'mistral']);
  if (o.ok && !CFG.setup_done && vis.length && txt.length) $('#aiOn').checked = true;
  if (!o.ok) $('#aiOn').checked = false;
  $('#aiHelp').style.display = o.ok && vis.length ? 'none' : '';
}
function summary() {
  const store = { node: 'your own IPFS node', pinata: 'Pinata', both: 'your IPFS node + Pinata' }[S.storage];
  const ai = ['AI stories', $('#aiOn').checked ? `on (${$('#visionModel').value} + ${$('#writerModel').value})` : 'off'];
  const EN = { mainnet: 'Ethereum mainnet', sepolia: 'Sepolia (practice)', base: 'Base', 'base-sepolia': 'Base Sepolia (practice)', localhost: 'your local test chain' };
  const rows = S.chain === 'ethereum'
    ? [['Minting on', EN[S.eth_network]], ['Mint to', $('#ethOwner').value.trim() || 'the wallet you deploy with'], ['Art stored on', store], ai]
    : S.chain === 'solana'
    ? [['Minting on', 'Solana ' + S.sol_network + ' (Metaplex Core)'], ['Mint to', $('#solOwner').value.trim() || 'the wallet you mint with'],
       ['RPC', $('#solRpc').value.trim() || CFG.sol_rpc_set && S.sol_network === CFG.sol_network ? 'your own RPC' : 'the free public RPC'], ['Art stored on', store], ai]
    : S.chain === 'ordinals'
    ? [['Minting on', 'Bitcoin Ordinals (' + S.btc_network + ')'], ['Inscriptions go to', $('#ordAddr').value.trim() || '— not set'],
       ['Refunds go to', $('#refundAddr').value.trim() || '— not set'], ['Chain data', S.btc_backend === 'rpc' ? 'your own Bitcoin node' : ($('#esploraUrl').value.trim() || 'mempool.space')], ai]
    : [['Network', S.network], ['Mint to', $('#owner').value.trim() || '— not set'], ['Art stored on', store], ai];
  $('#summary').replaceChildren(...rows.map(([k, v]) => { const d = document.createElement('div'); const b = document.createElement('b');
    b.textContent = k + ': '; d.append(b, document.createTextNode(v)); return d; }));
}
async function finish() {
  if (S.chain === 'ordinals') {
    if (!checkBtcAddrs()) { show('b'); return; }
    const body = { chain: 'ordinals', btc_network: S.btc_network, btc_backend: S.btc_backend, esplora_url: $('#esploraUrl').value.trim(),
      rpc_url: $('#rpcUrl').value.trim() || 'http://127.0.0.1:8332', rpc_user: $('#rpcUser').value.trim(),
      ord_address: $('#ordAddr').value.trim(), refund_address: $('#refundAddr').value.trim(),
      ai_enabled: $('#aiOn').checked, ollama_url: $('#ollamaUrl').value.trim() || 'http://127.0.0.1:11434',
      vision_model: $('#visionModel').value, writer_model: $('#writerModel').value, setup_done: true };
    if ($('#rpcPass').value) body.rpc_pass = $('#rpcPass').value;
    const r = await api('/api/config', body);
    if (r.error) { $('#saveOut').textContent = '✕ ' + r.error; $('#saveOut').className = 'out bad'; return; }
    location.href = '/'; return;
  }
  if (S.chain === 'solana' && !checkSolOwner()) { show('s'); return; }
  if (S.chain === 'ethereum' && !checkEthOwner()) { show('e'); return; }
  if (S.chain === 'stacks' && !checkAddr()) { show('2'); return; }
  const body = { chain: S.chain,
    network: S.network, owner_address: $('#owner').value.trim().toUpperCase(), storage: S.storage,
    ipfs_api: $('#ipfsApi').value.trim() || 'http://127.0.0.1:5001', ipfs_gateway: $('#ipfsGw').value.trim() || 'http://127.0.0.1:8080',
    link_style: S.link_style, public_gateway: $('#pubGw').value.trim(),
    ai_enabled: $('#aiOn').checked, ollama_url: $('#ollamaUrl').value.trim() || 'http://127.0.0.1:11434',
    vision_model: $('#visionModel').value, writer_model: $('#writerModel').value,
    royalty_pct: +$('#royalty').value || 0, setup_done: true
  };
  if (S.chain === 'solana') {
    delete body.network; delete body.owner_address;
    Object.assign(body, { sol_network: S.sol_network, sol_owner: $('#solOwner').value.trim() });
    if ($('#solRpc').value.trim()) body.sol_rpc = $('#solRpc').value.trim();
    else if (S.sol_network !== CFG.sol_network) body.sol_rpc = '';     // a saved RPC belongs to the old network
  }
  if (S.chain === 'ethereum') {
    delete body.network; delete body.owner_address;
    Object.assign(body, { eth_network: S.eth_network, eth_owner: $('#ethOwner').value.trim() });
  }
  const jwt = $('#pinataJwt').value.trim(); if (jwt) body.pinata_jwt = jwt;
  if (S.storage !== 'node' && !jwt && !CFG.pinata_jwt_set) { $('#saveOut').textContent = '✕ add your Pinata key (step 4), or choose "My own IPFS node"'; $('#saveOut').className = 'out bad'; return; }
  const r = await api('/api/config', body);
  if (r.error) { $('#saveOut').textContent = '✕ ' + r.error; $('#saveOut').className = 'out bad'; return; }
  location.href = '/';
}

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    const fwd = nav.dataset.nav === 'next';
    if (fwd && STEP === '2' && !checkAddr()) { $('#ownerOut').textContent ||= '✕ paste your Stacks address'; $('#ownerOut').className = 'out bad'; return; }
    if (fwd && STEP === 's' && !checkSolOwner()) return;
    if (fwd && STEP === 'e' && !checkEthOwner()) return;
    if (fwd && STEP === 'b' && !checkBtcAddrs()) { $('#btcAddrOut').textContent ||= '✕ paste your ordinals and refund addresses'; $('#btcAddrOut').className = 'out bad'; return; }
    show(step(fwd ? 1 : -1)); return;
  }
  const c = e.target.closest('.choice');
  if (c && c.dataset.chain) setChain(c.dataset.chain);
  if (c && c.dataset.btcnet) setBtcNet(c.dataset.btcnet);
  if (c && c.dataset.solnet) setSolNet(c.dataset.solnet);
  if (c && c.dataset.ethnet) setEthNet(c.dataset.ethnet);
  if (c && c.dataset.btcsrc) setBtcSrc(c.dataset.btcsrc);
  if (c && c.dataset.net) setNet(c.dataset.net);
  if (c && c.dataset.store) setStore(c.dataset.store);
  if (c && c.dataset.link) setLink(c.dataset.link);
});
$('#owner').addEventListener('input', checkAddr);
$('#ordAddr').addEventListener('input', checkBtcAddrs); $('#refundAddr').addEventListener('input', checkBtcAddrs);
$('#testBtc').onclick = testBtc; $('#testSol').onclick = testSol; $('#solOwner').addEventListener('input', checkSolOwner); $('#ethOwner').addEventListener('input', checkEthOwner);
$('#testNode').onclick = testNode; $('#testPinata').onclick = testPinata; $('#testGw').onclick = testGw;
$('#testAi').onclick = testAi; $('#finish').onclick = finish;

(async () => {
  CFG = await api('/api/config');
  $('#owner').value = CFG.owner_address || '';
  $('#ipfsApi').value = CFG.ipfs_api || ''; $('#ipfsGw').value = CFG.ipfs_gateway || '';
  $('#pubGw').value = CFG.public_gateway || ''; $('#ollamaUrl').value = CFG.ollama_url || '';
  $('#royalty').value = CFG.royalty_pct ?? 5; $('#aiOn').checked = !!CFG.ai_enabled;
  if (CFG.pinata_jwt_set) $('#jwtSaved').style.display = '';
  setNet(CFG.network || 'testnet'); setStore(CFG.storage || 'node'); setLink(CFG.link_style || 'ipfs');
  $('#ordAddr').value = CFG.ord_address || ''; $('#refundAddr').value = CFG.refund_address || '';
  $('#esploraUrl').value = CFG.esplora_url || ''; $('#rpcUrl').value = CFG.rpc_url || ''; $('#rpcUser').value = CFG.rpc_user || '';
  if (CFG.rpc_pass_set) $('#rpcSaved').style.display = '';
  $('#solOwner').value = CFG.sol_owner || ''; if (CFG.sol_rpc_set) $('#solRpcSaved').style.display = '';
  setSolNet(CFG.sol_network || 'devnet');
  $('#ethOwner').value = CFG.eth_owner || ''; setEthNet(CFG.eth_network || 'base-sepolia');
  setChain(CFG.chain || 'stacks'); setBtcNet(CFG.btc_network || 'testnet4'); setBtcSrc(CFG.btc_backend || 'esplora');
  show(CFG.setup_done ? 'c' : '0');   // returning from Settings: skip the welcome
})();
