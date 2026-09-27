import * as core from './ordinals-core.js';
import { base64 } from './btc.js';

const $ = s => document.querySelector(s);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAME = new URLSearchParams(location.search).get('name') || '';
const out = (id, m, c) => { const o = $(id); o.innerHTML = m; o.className = 'out' + (c ? ' ' + c : ''); };
const sats = n => Number(n).toLocaleString() + ' sats';
const btc = n => (Number(n) / 1e8).toFixed(8) + ' BTC';
let CFG = {}, PIECES = [], FEES = {}, BATCHES = [], BUSY = false;

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SOS-Minter': '1' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({ error: 'the app answered HTTP ' + r.status }));
  if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
const net = () => CFG.btc_network;
const txLink = id => net() === 'regtest' ? `<code>${esc(id.slice(0, 16))}…</code>` :
  `<a href="https://mempool.space${net() === 'mainnet' ? '' : '/' + net()}/tx/${esc(id)}" target="_blank" rel="noopener">${esc(id.slice(0, 12))}…</a>`;
const inscLink = id => net() === 'mainnet' ? `<a href="https://ordinals.com/inscription/${esc(id)}" target="_blank" rel="noopener">${esc(id.slice(0, 12))}…i0</a>` : `<code>${esc(id.slice(0, 14))}…i0</code>`;
const feeRate = () => Number($('#feeCustom').value) || Number($('#feePick').value) || 1;
const postage = () => BigInt(CFG.ord_postage || 546);
const toPiece = p => ({ id: p.id, contentType: p.contentType, body: base64.decode(p.body), metadata: p.metadata });

// ---------- 1. prepare ----------
async function loadPieces() {
  const r = await api('/api/ord/pieces', { collection_name: NAME, story_onchain: $('#story').checked });
  PIECES = r.pieces; renderTable();
}
function renderTable() {
  const rate = feeRate(), probe = core.newKey(); let totBytes = 0, totSats = 0n, tooBig = 0;
  const rows = PIECES.map(p => {
    let fee = '—', ok = true;
    try { const f = core.revealFee(probe, toPiece(p), net(), rate, CFG.ord_address, postage()) + postage(); fee = sats(f); totSats += f; }
    catch (e) { ok = false; tooBig++; fee = '<span class="out bad">' + esc(e.message) + '</span>'; }
    totBytes += p.bytes;
    return `<tr><td>#${String(p.id).padStart(4, '0')}</td><td><img src="${p.img}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:6px"></td>
      <td>${(p.bytes / 1024).toFixed(1)} KB${p.compressed ? ` <span class="tag">compressed from ${(p.original_bytes / 1024).toFixed(0)} KB</span>` : ''}</td>
      <td>${fee}</td><td>${p.compressed ? `<button class="ghost small" data-reset="${p.id}">use original</button>` : ''}</td></tr>`;
  }).join('');
  $('#table').innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px"><tr style="text-align:left;color:var(--dim)"><th>piece</th><th></th><th>size</th><th>inscribing it costs (at ${rate} sat/vB)</th><th></th></tr>${rows}</table>`;
  $('#totals').innerHTML = `<b>${PIECES.length}</b> pieces · ${(totBytes / 1024).toFixed(0)} KB · all of them together about <b>${sats(totSats)}</b> (${btc(totSats)}) plus a small batch fee` +
    (tooBig ? `<br><span class="out bad">${tooBig} piece(s) are too big for one inscription: compress them.</span>` : '');
}
function compressOne(p, maxPx, q) {
  return new Promise((res, rej) => {
    if (p.contentType === 'image/gif') return res(null);                       // keep animation
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxPx / Math.max(img.width, img.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob(b => { if (!b) return res(null); const fr = new FileReader(); fr.onload = () => res({ data: fr.result, size: b.size }); fr.readAsDataURL(b); }, 'image/webp', q);
    };
    img.onerror = () => rej(new Error('could not read piece ' + p.id));
    img.src = p.img;
  });
}
async function compressAll() {
  const maxPx = Number($('#maxPx').value) || 1024, q = Math.max(0.1, Math.min(1, Number($('#quality').value) || 0.8));
  $('#compressAll').disabled = true; $('#cBar').style.display = ''; let done = 0, saved = 0;
  try {
    for (const p of PIECES) {
      const r = await compressOne(p, maxPx, q);
      if (r && r.size < p.original_bytes) { await api('/api/ord/set-content', { collection_name: NAME, id: p.id, data: r.data }); saved += p.original_bytes - r.size; }
      done++; $('#cBar').firstElementChild.style.width = Math.round(done / PIECES.length * 100) + '%';
    }
    out('#oPrep', `✓ compressed ${done} piece(s), saving ${(saved / 1024).toFixed(0)} KB. Check a few at full size before inscribing.`, 'good');
  } catch (e) { out('#oPrep', '✕ ' + esc(e.message), 'bad'); }
  finally { $('#compressAll').disabled = false; setTimeout(() => $('#cBar').style.display = 'none', 1200); await loadPieces(); }
}

// ---------- 2. batches ----------
const inscribedIds = () => new Set(BATCHES.filter(b => b.status !== 'recovered').flatMap(b => b.items.map(i => i.id)));
async function startBatch() {
  try {
    if (!core.addressType(CFG.ord_address, net())) throw new Error('set a valid ordinals address in Settings first');
    if (!core.addressType(CFG.refund_address, net())) throw new Error('set a valid refund address in Settings first');
    const from = Number($('#from').value) || 1, to = Math.min(Number($('#to').value) || PIECES.length, from + 49);
    const taken = inscribedIds();
    const sel = PIECES.filter(p => p.id >= from && p.id <= to && !taken.has(p.id));
    if (!sel.length) throw new Error('every piece in that range is already in a batch');
    const key = core.newKey(), pieces = sel.map(toPiece);
    const plan = core.planBatch({ privHex: key, pieces, network: net(), feeRate: feeRate(), recipient: CFG.ord_address, refund: CFG.refund_address, postage: postage() });
    if (net() === 'mainnet') {
      if (!$('#iUnderstand').checked) throw new Error('tick the box to confirm you understand this spends real bitcoin');
      if (!confirm(`Inscribe ${sel.length} piece(s) permanently on Bitcoin for ${sats(plan.total)} (${btc(plan.total)})?`)) return;
    }
    const b = { id: 'b' + Date.now().toString(36), created: new Date().toISOString(), network: net(), key, plan, status: 'awaiting-funds',
      snapshot: Object.fromEntries(sel.map(p => [p.id, { contentType: p.contentType, body: p.body, metadata: p.metadata }])),
      items: plan.items.map(i => ({ id: i.id })) };
    await api('/api/ord/batch-save', { collection_name: NAME, batch: b });      // saved BEFORE the address is ever shown
    BATCHES.push(b); out('#oStart', `✓ batch ready: pay <b>${sats(plan.total)}</b> to the address in step 3`, 'good'); render();
  } catch (e) { out('#oStart', '✕ ' + esc(e.message), 'bad'); }
}
const save = b => api('/api/ord/batch-save', { collection_name: NAME, batch: b });
const snapPiece = (b, id) => { const s = b.snapshot[String(id)]; return { id, contentType: s.contentType, body: base64.decode(s.body), metadata: s.metadata }; };

async function step(b) {
  const P = b.plan;
  if (b.status === 'awaiting-funds') {
    const u = (await api('/api/btc/utxos', { address: P.fundingAddress })).utxos;
    const got = u.reduce((s, x) => s + BigInt(x.value), 0n); b.received = String(got);
    if (got >= BigInt(P.total)) {
      const commit = core.buildCommit({ privHex: b.key, plan: P, utxos: u });
      b.commit = { txid: commit.txid, hex: commit.hex, fee: commit.fee, vouts: commit.vouts };
      b.status = 'commit-built'; await save(b);                                 // saved before broadcasting
    }
  }
  if (b.status === 'commit-built') {
    await api('/api/btc/broadcast', { hex: b.commit.hex }); b.status = 'commit-sent'; await save(b);
  }
  if (b.status === 'commit-sent') {
    const t = await api('/api/btc/tx', { txid: b.commit.txid });
    if (!t.found) { try { await api('/api/btc/broadcast', { hex: b.commit.hex }); } catch { } }
    if (t.confirmed) { b.status = 'revealing'; await save(b); }
  }
  if (b.status === 'revealing') {
    for (const v of b.commit.vouts) {
      const it = b.items.find(i => i.id === v.id); if (it.reveal_txid) continue;
      const piece = snapPiece(b, v.id);
      const r = core.buildReveal({ privHex: b.key, plan: P, piece, commitTxid: b.commit.txid, vout: v.vout });
      const back = core.parseReveal(r.hex)[0];                                  // double-check what is about to be written
      if (!back || back.tags.contentType !== piece.contentType || back.body.length !== piece.body.length) throw new Error('reveal self-check failed for piece ' + v.id);
      it.reveal_hex = r.hex; it.reveal_txid = r.txid; it.inscription_id = r.inscriptionId; await save(b);
      await api('/api/btc/broadcast', { hex: r.hex });
    }
    b.status = 'revealed'; await save(b);
  }
  if (b.status === 'revealed') {
    let all = true;
    for (const it of b.items) {
      if (it.confirmed) continue;
      const t = await api('/api/btc/tx', { txid: it.reveal_txid });
      if (!t.found) { try { await api('/api/btc/broadcast', { hex: it.reveal_hex }); } catch { } }
      if (t.confirmed) it.confirmed = true; else all = false;
    }
    if (all) b.status = 'done';
    await save(b);
  }
}
async function recover(b) {
  try {
    const u = (await api('/api/btc/utxos', { address: b.plan.fundingAddress })).utxos;
    if (!u.length) throw new Error('nothing is on the funding address');
    const sw = core.buildSweep({ privHex: b.key, network: b.network, utxos: u, to: b.plan.refund, feeRate: feeRate() });
    if (!confirm(`Send ${sats(sw.amount)} back to your refund address ${b.plan.refund}?`)) return;
    await api('/api/btc/broadcast', { hex: sw.hex }); b.status = 'recovered'; b.recovery = { txid: sw.txid, amount: sw.amount }; await save(b); render();
  } catch (e) { alert('Recover: ' + e.message); }
}
const LABEL = { 'awaiting-funds': '⏳ waiting for your payment', 'commit-built': '📤 sending the commit', 'commit-sent': '⏳ waiting for the commit to confirm (about 10 min)',
  revealing: '✍️ writing the inscriptions', revealed: '⏳ waiting for the inscriptions to confirm', done: '✅ inscribed', recovered: '↩️ refunded' };
function render() {
  if (!BATCHES.length) { $('#batches').innerHTML = 'No batches yet.'; return; }
  $('#batches').innerHTML = BATCHES.slice().reverse().map(b => {
    const P = b.plan, pay = b.status === 'awaiting-funds';
    return `<div class="note"><b>Batch ${esc(b.id)}</b> · ${b.items.length} piece(s) · ${esc(LABEL[b.status] || b.status)}
      ${pay ? `<div style="margin-top:8px">Send exactly <b>${sats(P.total)}</b> (<code>${btc(P.total)}</code>) to:<br>
        <code style="font-size:14px">${esc(P.fundingAddress)}</code> <button class="ghost small" data-copy="${esc(P.fundingAddress)}">copy address</button>
        <button class="ghost small" data-copy="${(Number(P.total) / 1e8).toFixed(8)}">copy amount</button>
        <div class="sub">received so far: ${sats(b.received || 0)}. Any wallet works. Sending a bit more is fine: the rest comes back to your refund address.</div></div>` : ''}
      ${b.commit ? `<div class="sub">commit ${txLink(b.commit.txid)}</div>` : ''}
      <div style="margin-top:6px">${b.items.map(i => `<span class="trait"><small>#${String(i.id).padStart(4, '0')}</small>${i.inscription_id ? inscLink(i.inscription_id) + (i.confirmed ? ' ✓' : ' ⏳') : '—'}</span>`).join('')}</div>
      ${b.recovery ? `<div class="sub">refund ${txLink(b.recovery.txid)} (${sats(b.recovery.amount)})</div>` : ''}
      ${pay ? `<button class="ghost small" data-recover="${esc(b.id)}">↩️ Recover funds (cancel this batch)</button>` : ''}
      <div class="out" id="err-${esc(b.id)}"></div></div>`;
  }).join('');
}
const ERR = {};
async function tick() {
  if (BUSY) return; BUSY = true;
  try {
    for (const b of BATCHES.filter(x => !['done', 'recovered'].includes(x.status))) {
      try { await step(b); delete ERR[b.id]; } catch (e) { ERR[b.id] = e.message; }
    }
    render();
    for (const [bid, msg] of Object.entries(ERR)) { const el = document.getElementById('err-' + bid); if (el) { el.textContent = '⚠ ' + msg + ' (will retry)'; el.className = 'out warn'; } }
  } finally { BUSY = false; }
}

// ---------- wiring ----------
document.addEventListener('click', async e => {
  const c = e.target.closest('[data-copy]'); if (c) { navigator.clipboard.writeText(c.dataset.copy); c.textContent = 'copied ✓'; return; }
  const r = e.target.closest('[data-recover]'); if (r) return recover(BATCHES.find(b => b.id === r.dataset.recover));
  const x = e.target.closest('[data-reset]'); if (x) { await api('/api/ord/set-content', { collection_name: NAME, id: +x.dataset.reset, reset: true }); loadPieces(); }
});
(async () => {
  if (!NAME) { $('#info').innerHTML = '<span class="out bad">Open this page from the main screen.</span>'; return; }
  $('#back').href = '/?name=' + encodeURIComponent(NAME);
  CFG = await (await fetch('/api/config')).json();
  if (CFG.chain !== 'ordinals') { $('#info').innerHTML = '<span class="out bad">This collection is set up for Stacks. Choose Bitcoin Ordinals in Settings to inscribe.</span>'; return; }
  $('#net').textContent = CFG.btc_network === 'mainnet' ? 'BITCOIN MAINNET · real BTC' : 'bitcoin ' + CFG.btc_network + ' · practice';
  if (CFG.btc_network === 'mainnet') { $('#net').classList.add('main'); $('#mainnetBox').style.display = ''; }
  $('#toAddr').textContent = CFG.ord_address || '(set it in Settings)'; $('#story').checked = CFG.ord_story_onchain !== false;
  $('#info').innerHTML = `<b>${esc(NAME)}</b> · inscribing on Bitcoin ${esc(CFG.btc_network)} · refunds to <code>${esc(CFG.refund_address || 'not set')}</code>`;
  try { FEES = await api('/api/btc/fees'); } catch (e) { FEES = { fast: 2, normal: 1, slow: 1, minimum: 1 }; out('#oPrep', 'couldn\'t read fee rates (' + esc(e.message) + '): using 1–2 sat/vB', 'warn'); }
  $('#feePick').innerHTML = [['normal', 'normal (~30 min)'], ['fast', 'fast (next block)'], ['slow', 'slow (~1 hour)'], ['minimum', 'cheapest (may take long)']]
    .map(([k, l]) => `<option value="${FEES[k]}">${l}: ${FEES[k]} sat/vB</option>`).join('');
  await loadPieces(); $('#to').value = Math.min(PIECES.length, 50);
  BATCHES = (await api('/api/ord/batches', { collection_name: NAME })).batches; render();
  $('#feePick').onchange = renderTable; $('#feeCustom').oninput = renderTable; $('#story').onchange = loadPieces;
  $('#compressAll').onclick = compressAll; $('#startBatch').onclick = startBatch;
  $('#resetAll').onclick = async () => { for (const p of PIECES.filter(p => p.compressed)) await api('/api/ord/set-content', { collection_name: NAME, id: p.id, reset: true }); loadPieces(); };
  $('#collFile').onclick = async () => {
    try { const r = await api('/api/ord/collection-file', { collection_name: NAME });
      const url = URL.createObjectURL(new Blob([JSON.stringify(r.items, null, 2)], { type: 'application/json' }));
      out('#oColl', `✓ ${r.count} inscription(s) · <a href="${url}" download="${esc(NAME)}-collection.json">download the file</a> (also saved in your collection folder)`, 'good');
    } catch (e) { out('#oColl', '✕ ' + esc(e.message), 'bad'); }
  };
  tick(); setInterval(tick, 15000);
})();
