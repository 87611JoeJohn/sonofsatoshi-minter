'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-SOS-Minter': '1' },
    body: body ? JSON.stringify(body) : undefined });
  try { return await r.json(); } catch { return { error: 'the app answered HTTP ' + r.status }; }
}
function out(id, msg, cls) { const o = $(id); o.innerHTML = msg; o.className = 'out' + (cls ? ' ' + cls : ''); }
function bar(id, frac) { const b = $(id); b.style.display = frac === null ? 'none' : ''; if (frac !== null) b.firstElementChild.style.width = Math.round(frac * 100) + '%'; }
const NAME = () => $('#cname').value.trim();
let CFG = {};

// ---------- collections list ----------
async function loadProjects() {
  const r = await api('/api/projects'); const ps = r.projects || [];
  $('#projCard').style.display = ps.length ? '' : 'none';
  $('#projects').innerHTML = ps.map(p => `<div class="proj"><div><b>${esc(p.name)}</b><br><span class="sub">${p.images} image(s)` +
    `${p.has_metadata ? ' · built' : ''}${p.cid ? ' · on IPFS' : ''}${p.deployed ? ' · deployed' : ''}</span></div>` +
    `<button class="ghost small" data-open="${esc(p.name)}">Open</button></div>`).join('');
}
function openProject(n) {
  $('#cname').value = n; syncMintLink(); loadReview();
  $('#cname').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function syncMintLink() { $('#mintLink').href = ({ ordinals: '/inscribe?name=', solana: '/solana?name=', ethereum: '/ethereum?name=' }[CFG.chain] || '/mint?name=') + encodeURIComponent(NAME()); }

// ---------- step 1: upload in chunks (big collections never hit one giant request) ----------
const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
async function upload() {
  const name = NAME(); if (!name) return out('#o1', '✕ give the collection a name first', 'bad');
  const files = [...$('#files').files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) return out('#o1', '✕ choose your images first', 'bad');
  $('#upBtn').disabled = true; let done = 0, skipped = 0, total = 0, first = true;
  const LIMIT = 40 * 1024 * 1024;           // ~40 MB per request
  try {
    let batch = [], size = 0;
    const send = async () => {
      if (!batch.length) return;
      const r = await api('/api/upload', { collection_name: name, mode: first && $('#replace').checked ? 'replace' : 'append', images: batch });
      if (r.error) throw new Error(r.error);
      first = false; done += r.uploaded; skipped += r.skipped; total = r.total; batch = []; size = 0;
      bar('#upBar', done / files.length); out('#o1', `uploading… ${done} of ${files.length}`);
    };
    for (const f of files) {
      if (size + f.size > LIMIT) await send();
      batch.push({ data: await readFile(f) }); size += f.size;
    }
    await send();
    out('#o1', `✓ added ${done} image(s)${skipped ? ` · skipped ${skipped} that weren't images` : ''} · the collection now has <b>${total}</b>`, 'good');
    loadProjects(); syncMintLink();
  } catch (e) { out('#o1', '✕ ' + esc(e.message), 'bad'); }
  finally { $('#upBtn').disabled = false; setTimeout(() => bar('#upBar', null), 1500); }
}

// ---------- step 2: AI ----------
let POLL = null;
async function startAI() {
  const name = NAME(); if (!name) return out('#oAI', '✕ give the collection a name and add images first', 'bad');
  $('#aiBtn').disabled = true; out('#oAI', 'starting…');
  const r = await api('/api/lore', { collection_name: name, theme: $('#theme').value, canon: $('#canon').value });
  if (r.error) { $('#aiBtn').disabled = false; return out('#oAI', '✕ ' + esc(r.error), 'bad'); }
  watchAI(name, r.total);
}
function watchAI(name, total) {
  clearInterval(POLL);
  POLL = setInterval(async () => {
    const j = await api('/api/lore-status?name=' + encodeURIComponent(name));
    if (j.error) { clearInterval(POLL); $('#aiBtn').disabled = false; return; }
    const n = j.total || total || 1;
    if (j.status === 'running') {
      const ph = { looking: 'looking at piece', traits: 'finding traits for piece', writing: 'writing the story for piece' }[j.phase] || 'starting';
      const step = { looking: 0, traits: 1, writing: 2 }[j.phase] ?? 0;
      bar('#aiBar', (step + (j.done || 0) / n) / 3); out('#oAI', `✨ ${ph} ${j.done || 0} of ${n}…`);
    } else if (j.status === 'done') {
      clearInterval(POLL); $('#aiBtn').disabled = false; bar('#aiBar', null);
      const t = Object.entries((j.result || {}).tiers || {}).filter(([, v]) => v).map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
      out('#oAI', `✓ done: ${j.result.count} stories written · ${t}. Review them in step 3.`, 'good');
      loadReview();
    } else if (j.status === 'error') {
      clearInterval(POLL); $('#aiBtn').disabled = false; bar('#aiBar', null);
      out('#oAI', '✕ ' + esc(j.error) + ' — press the button again to resume where it stopped', 'bad');
    }
  }, 3000);
}

// ---------- step 2b: manual ----------
function addTrait(cat = '', vals = '') {
  const d = document.createElement('div'); d.className = 'row trait-row'; d.style.marginTop = '6px';
  d.innerHTML = `<input placeholder="Category, e.g. Background" value="${esc(cat)}"><input placeholder="Value:weight, e.g. Gold:5, Night:30, Dawn:65" value="${esc(vals)}"><button class="ghost small" data-del>✕</button>`;
  $('#traits').appendChild(d);
}
function collectTraits() {
  const t = {};
  $$('#traits .trait-row').forEach(row => {
    const [c, v] = row.querySelectorAll('input'); const cat = c.value.trim(); if (!cat) return;
    const vals = v.value.split(',').map(x => { const [n, w] = x.split(':'); return n && n.trim() ? [n.trim(), parseInt(w) || 1] : null; }).filter(Boolean);
    if (vals.length) t[cat] = vals;
  });
  return t;
}
async function manualBuild() {
  const name = NAME(); if (!name) return out('#oMan', '✕ name the collection first', 'bad');
  const r = await api('/api/generate', { collection_name: name, description: $('#desc').value, traits: collectTraits(), overwrite: true });
  if (r.error) return out('#oMan', '✕ ' + esc(r.error), 'bad');
  out('#oMan', `✓ built ${r.total} pieces${r.tiers ? ' · ' + Object.entries(r.tiers).filter(([, v]) => v).map(([k, v]) => esc(k) + ' ' + v).join(' · ') : ''}`, 'good');
  loadReview();
}

// ---------- step 3: review ----------
let REV = { tokens: {}, tiers: [] };
async function loadReview() {
  const name = NAME(); if (!name) return out('#oRev', '✕ name the collection first', 'bad');
  out('#oRev', 'loading…');
  const d = await api('/api/collection?name=' + encodeURIComponent(name));
  if (d.error) { $('#grid').innerHTML = ''; return out('#oRev', '✕ ' + esc(d.error), 'bad'); }
  REV = { tiers: d.tier_ladder, tokens: {} }; d.tokens.forEach(t => REV.tokens[t.id] = t);
  const built = d.tokens.filter(t => t.meta).length;
  out('#oRev', `${d.tokens.length} piece(s) · ${built} with metadata${built < d.tokens.length ? ' — run step 2 to build the rest' : ''}`);
  $('#lore').style.display = d.lore ? '' : 'none'; $('#lore').innerHTML = d.lore ? '<b>The collection\'s story</b><br>' + esc(d.lore) : '';
  const shown = d.tokens.slice(0, 300);
  $('#grid').innerHTML = shown.map(t => `<div class="tok"><img src="${t.img}" loading="lazy" alt="#${t.id}">
    <div class="b"><b>${esc(t.meta ? t.meta.name : '#' + String(t.id).padStart(4, '0'))}</b>
    <span class="t">${esc(t.tier || 'no rarity yet')}${t.rank ? ' · rank ' + esc(t.rank) : ''}</span>
    <span class="s">${esc(t.meta ? t.meta.description : 'not built yet')}</span>
    <button class="ghost small" data-prev="${t.id}">👁 Preview and edit</button></div></div>`).join('') +
    (d.tokens.length > 300 ? `<div class="note">Showing the first 300 of ${d.tokens.length}. Every piece is still minted.</div>` : '');
  if (d.state && d.state.deployed_contract) out('#oRev', $('#oRev').innerHTML + ` · deployed as <code>${esc(d.state.deployed_contract)}</code>`);
}
function preview(id) {
  const t = REV.tokens[id]; if (!t || !t.meta) return alert('This piece has no metadata yet — run step 2 first.');
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
    <h2 style="margin:0">👁 As it will be minted · #${id}</h2><button class="ghost small" data-close>✕ Close</button></div>
    <div class="two" style="margin-top:12px">
      <div><img src="${t.img}" style="width:100%;border-radius:12px" alt="">
        <div class="note"><b id="pvN"></b><div style="margin:4px 0"><span class="tag" id="pvT" style="border-color:var(--gold);color:var(--gold)"></span></div>
        <div id="pvS" style="white-space:pre-wrap;font-size:14px"></div><div id="pvTr" style="margin-top:8px"></div></div></div>
      <div><label>Name</label><input id="eN" value="${esc(t.meta.name)}">
        <label>Rarity</label><select id="eT">${REV.tiers.map(x => `<option${x === t.tier ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>
        <label>Story</label><textarea id="eS" rows="8">${esc(t.meta.description)}</textarea>
        <label>Traits</label><div id="eTr"></div><button class="ghost small" data-addtr>＋ add a trait</button>
        <div><button id="eSave">💾 Save</button> <span id="eMsg" class="out"></span></div>
        <details style="margin-top:10px"><summary>The exact metadata that goes on IPFS</summary><pre id="eJ"></pre></details></div>
    </div></div>`;
  document.body.appendChild(ov);
  const trBox = ov.querySelector('#eTr');
  const addRow = (k, v) => { const r = document.createElement('div'); r.className = 'row'; r.style.marginTop = '4px';
    r.innerHTML = `<input class="k" placeholder="trait" value="${esc(k)}"><input class="v" placeholder="value" value="${esc(v)}"><button class="ghost small" data-deltr>✕</button>`; trBox.appendChild(r); };
  Object.entries(t.traits || {}).forEach(([k, v]) => addRow(k, v)); if (!Object.keys(t.traits || {}).length) addRow('', '');
  const traits = () => { const o = {}; trBox.querySelectorAll('.row').forEach(r => { const k = r.querySelector('.k').value.trim(); if (k) o[k] = r.querySelector('.v').value.trim(); }); return o; };
  const live = () => {
    const m = JSON.parse(JSON.stringify(t.meta)), tr = traits(), tier = ov.querySelector('#eT').value;
    m.name = ov.querySelector('#eN').value; m.description = ov.querySelector('#eS').value;
    const a = m.attributes || [];
    m.attributes = a.filter(x => x.trait_type === 'Collection').concat(Object.entries(tr).map(([k, v]) => ({ trait_type: k, value: v })),
      [{ trait_type: 'Rarity', value: tier }], a.filter(x => x.trait_type === 'Rarity Rank'));
    ov.querySelector('#eJ').textContent = JSON.stringify(m, null, 2);
    ov.querySelector('#pvN').textContent = m.name; ov.querySelector('#pvT').textContent = tier; ov.querySelector('#pvS').textContent = m.description;
    ov.querySelector('#pvTr').innerHTML = Object.entries(tr).map(([k, v]) => `<span class="trait"><small>${esc(k)}</small>${esc(v)}</span>`).join('');
  };
  ov.addEventListener('input', live); ov.addEventListener('change', live);
  ov.addEventListener('click', async e => {
    if (e.target.closest('[data-close]') || e.target === ov) { ov.remove(); loadReview(); return; }
    if (e.target.closest('[data-addtr]')) { addRow('', ''); return; }
    const del = e.target.closest('[data-deltr]'); if (del) { del.parentElement.remove(); live(); return; }
    if (e.target.id === 'eSave') {
      const r = await api('/api/token-edit', { collection_name: NAME(), id, name: ov.querySelector('#eN').value,
        tier: ov.querySelector('#eT').value, backstory: ov.querySelector('#eS').value, traits: traits() });
      const m = ov.querySelector('#eMsg'); m.textContent = r.ok ? '✓ saved' : '✕ ' + (r.error || 'error'); m.className = 'out ' + (r.ok ? 'good' : 'bad');
    }
  });
  live();
}

// ---------- step 4: store ----------
async function publish() {
  const name = NAME(); if (!name) return out('#oPub', '✕ name the collection first', 'bad');
  $('#pubBtn').disabled = true; out('#oPub', 'checking the collection…');
  try {
    const c = await api('/api/collection?name=' + encodeURIComponent(name));
    if (c.error) return out('#oPub', '✕ ' + esc(c.error), 'bad');
    if (!c.tokens.length) return out('#oPub', '✕ add images first (step 1)', 'bad');
    if (c.tokens.some(t => !t.meta)) {          // only fill in what's missing — never overwrite stories you wrote or edited
      const g = await api('/api/generate', { collection_name: name, description: $('#desc').value });
      if (g.error) return out('#oPub', '✕ ' + esc(g.error), 'bad');
    }
    out('#oPub', `uploading ${c.tokens.length} piece(s) to IPFS — big collections take a while, keep this page open…`);
    const r = await api('/api/publish', { collection_name: name, royalty_pct: +$('#royPct').value, royalty_addr: $('#royAddr').value.trim() });
    if (r.error) return out('#oPub', '✕ ' + esc(r.error), 'bad');
    out('#oPub', `✓ stored on ${esc(r.stored_on.join(' + '))}<br>collection CID <code>${esc(r.cid)}</code> · <a href="${esc(r.preview)}" target="_blank" rel="noopener">preview piece 1</a>` +
      (r.redeploy_note ? '<br>⚠ This collection is already deployed: open the mint page and press <b>Re-point</b> so wallets see the new version.' : '<br>Next: step 5.'), 'good');
    loadProjects();
  } finally { $('#pubBtn').disabled = false; }
}

// ---------- wiring ----------
document.addEventListener('click', e => {
  const o = e.target.closest('[data-open]'); if (o) return openProject(o.dataset.open);
  const p = e.target.closest('[data-prev]'); if (p) return preview(+p.dataset.prev);
  const d = e.target.closest('[data-del]'); if (d) return d.parentElement.remove();
});
$('#upBtn').onclick = upload; $('#aiBtn').onclick = startAI; $('#manBtn').onclick = manualBuild;
$('#addTrait').onclick = () => addTrait(); $('#loadBtn').onclick = loadReview; $('#pubBtn').onclick = publish;
$('#cname').addEventListener('input', syncMintLink);

(async () => {
  CFG = await api('/api/config');
  const nb = $('#net');
  if (CFG.chain === 'ordinals') {
    nb.textContent = CFG.btc_network === 'mainnet' ? 'BITCOIN · real BTC' : 'bitcoin ' + CFG.btc_network + ' · practice';
    if (CFG.btc_network === 'mainnet') nb.classList.add('main');
    $('#pubBtn').closest('.card').style.display = 'none';                     // no IPFS: the art goes on-chain
    const c5 = $('#mintLink').closest('.card');
    c5.querySelector('h2').innerHTML = '<span class="n">4</span>Inscribe on Bitcoin';
    c5.querySelector('.sub').textContent = 'Compress the pieces, see the exact cost, then pay one address from any Bitcoin wallet. The art is written onto Bitcoin itself.';
    $('#mintLink').textContent = '🟠 Go to inscribe →';
  } else if (CFG.chain === 'solana') {
    nb.textContent = CFG.sol_network === 'mainnet' ? 'SOLANA · real SOL' : 'solana ' + CFG.sol_network + ' · practice';
    if (CFG.sol_network === 'mainnet') nb.classList.add('main');
    $('#royAddr').closest('div').style.display = 'none';                      // royalties go to the minting wallet (or Settings)
    $('#pubBtn').textContent = '☁ Store on IPFS';
    $('#pubBtn').closest('.card').querySelector('.sub').innerHTML = 'Uploads the art and stories to <b id="storeName">your storage</b> with https links, the way Solana wallets and marketplaces read them. ' +
      'Run this again any time you edit something (then use <i>Re-point</i> on the mint page if you have already minted).';
    const c5 = $('#mintLink').closest('.card');
    c5.querySelector('h2').innerHTML = '<span class="n">5</span>Mint on Solana';
    c5.querySelector('.sub').textContent = 'Connect Phantom, Solflare or Backpack, create the collection with its royalty, then mint the pieces in batches.';
    $('#mintLink').textContent = '🟪 Go to mint on Solana →';
  } else if (CFG.chain === 'ethereum') {
    const EN = { mainnet: 'ETHEREUM · real ETH', base: 'BASE · real ETH', sepolia: 'sepolia · practice', 'base-sepolia': 'base sepolia · practice', localhost: 'local test chain' };
    nb.textContent = EN[CFG.eth_network] || CFG.eth_network;
    if (CFG.eth_network === 'mainnet' || CFG.eth_network === 'base') nb.classList.add('main');
    const onBase = String(CFG.eth_network).startsWith('base');
    $('#royAddr').closest('div').style.display = 'none';                      // set on the mint page, with the deploy
    $('#pubBtn').textContent = '☁ Store on IPFS';
    $('#pubBtn').closest('.card').querySelector('.sub').innerHTML = 'Uploads the art and stories to <b id="storeName">your storage</b> in the standard ERC-721 layout marketplaces read. ' +
      'Run this again any time you edit something (then use <i>Re-point</i> on the mint page if you have already deployed).';
    const c5 = $('#mintLink').closest('.card');
    c5.querySelector('h2').innerHTML = '<span class="n">5</span>Deploy + mint on ' + (onBase ? 'Base' : 'Ethereum');
    c5.querySelector('.sub').textContent = 'Connect MetaMask, Rabby or any browser wallet, deploy the collection contract, then mint the pieces in batches.';
    $('#mintLink').textContent = (onBase ? '🔵 Go to mint on Base →' : '💠 Go to mint on Ethereum →');
  } else {
    nb.textContent = CFG.network === 'mainnet' ? 'MAINNET · real STX' : 'testnet · practice';
    if (CFG.network === 'mainnet') nb.classList.add('main');
  }
  $('#storeName').textContent = { node: 'your IPFS node', pinata: 'Pinata', both: 'your IPFS node and Pinata' }[CFG.storage] || 'your storage';
  $('#royPct').value = CFG.royalty_pct ?? 5;
  $('#aiBox').style.display = CFG.ai_enabled ? '' : 'none'; $('#aiOff').style.display = CFG.ai_enabled ? 'none' : '';
  if (!CFG.ai_enabled) $('#manual').open = true;
  addTrait(); loadProjects();
  const last = new URLSearchParams(location.search).get('name'); if (last) openProject(last);
})();
