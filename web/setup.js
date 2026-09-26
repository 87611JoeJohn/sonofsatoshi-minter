'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-SOS-Minter': '1' },
    body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
let CFG = {}, STEP = 0;
const STEPS = $$('.step').length;
const S = { network: 'testnet', storage: 'node', link_style: 'ipfs' };

function show(n) {
  STEP = Math.max(0, Math.min(STEPS - 1, n));
  $$('.step').forEach(s => s.classList.toggle('on', +s.dataset.step === STEP));
  $('#dots').innerHTML = Array.from({ length: STEPS }, (_, i) => `<i class="${i <= STEP ? 'on' : ''}"></i>`).join('');
  if (STEP === 4) testAi();
  if (STEP === 5) summary();
  window.scrollTo(0, 0);
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
function setLink(v) { S.link_style = v; pick('#linkChoices', 'link', v); $('#gwBox').style.display = v === 'gateway' ? '' : 'none'; }

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
  const rows = [['Network', S.network], ['Mint to', $('#owner').value.trim() || '— not set'], ['Art stored on', store],
    ['AI stories', $('#aiOn').checked ? `on (${$('#visionModel').value} + ${$('#writerModel').value})` : 'off']];
  $('#summary').replaceChildren(...rows.map(([k, v]) => { const d = document.createElement('div'); const b = document.createElement('b');
    b.textContent = k + ': '; d.append(b, document.createTextNode(v)); return d; }));
}
async function finish() {
  if (!checkAddr()) { show(2); return; }
  const body = {
    network: S.network, owner_address: $('#owner').value.trim().toUpperCase(), storage: S.storage,
    ipfs_api: $('#ipfsApi').value.trim() || 'http://127.0.0.1:5001', ipfs_gateway: $('#ipfsGw').value.trim() || 'http://127.0.0.1:8080',
    link_style: S.link_style, public_gateway: $('#pubGw').value.trim(),
    ai_enabled: $('#aiOn').checked, ollama_url: $('#ollamaUrl').value.trim() || 'http://127.0.0.1:11434',
    vision_model: $('#visionModel').value, writer_model: $('#writerModel').value,
    royalty_pct: +$('#royalty').value || 0, setup_done: true
  };
  const jwt = $('#pinataJwt').value.trim(); if (jwt) body.pinata_jwt = jwt;
  if (S.storage !== 'node' && !jwt && !CFG.pinata_jwt_set) { $('#saveOut').textContent = '✕ add your Pinata key (step 4), or choose "My own IPFS node"'; $('#saveOut').className = 'out bad'; return; }
  const r = await api('/api/config', body);
  if (r.error) { $('#saveOut').textContent = '✕ ' + r.error; $('#saveOut').className = 'out bad'; return; }
  location.href = '/';
}

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) {
    const to = +go.dataset.go;
    if (STEP === 2 && to > 2 && !checkAddr()) { $('#ownerOut').textContent ||= '✕ paste your Stacks address'; $('#ownerOut').className = 'out bad'; return; }
    show(to); return;
  }
  const c = e.target.closest('.choice');
  if (c && c.dataset.net) setNet(c.dataset.net);
  if (c && c.dataset.store) setStore(c.dataset.store);
  if (c && c.dataset.link) setLink(c.dataset.link);
});
$('#owner').addEventListener('input', checkAddr);
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
  show(CFG.setup_done ? 1 : 0);   // returning from Settings: skip the welcome
})();
