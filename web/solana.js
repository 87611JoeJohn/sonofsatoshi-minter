import * as S from './sol-core.js';

const $ = s => document.querySelector(s);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAME = new URLSearchParams(location.search).get('name') || '';
const out = (id, m, c) => { const o = $(id); o.innerHTML = m; o.className = 'out' + (c ? ' ' + c : ''); };
const SOL = n => (Number(n) / 1e9).toFixed(Number(n) < 1e7 ? 6 : 4) + ' SOL';
let INFO = null, UMI = null, WALLET = null, ADDR = '', BUSY = false;

async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-SOS-Minter': '1' },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ error: 'the app answered HTTP ' + r.status }));
  if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
const save = body => api('/api/sol/save', { collection_name: NAME, ...body }).then(r => { INFO.sol = r.sol; return r; });
const net = () => INFO.network;
const cluster = () => ({ mainnet: '', devnet: '?cluster=devnet', localnet: '?cluster=custom&customUrl=' + encodeURIComponent('http://127.0.0.1:8899') })[net()];
const addrLink = a => `<a href="https://explorer.solana.com/address/${esc(a)}${cluster()}" target="_blank" rel="noopener"><code>${esc(a.slice(0, 6))}…${esc(a.slice(-4))}</code></a>`;
const txLink = s => `<a href="https://explorer.solana.com/tx/${esc(s)}${cluster()}" target="_blank" rel="noopener">${esc(s.slice(0, 10))}…</a>`;
const RPC = () => location.origin + '/api/sol/rpc';
const readUmi = () => S.makeUmi(RPC(), null, { 'X-SOS-Minter': '1' });   // read-only until a wallet connects

// ---------- wallets (the browser extensions each put a provider on window) ----------
function providers() {
  const w = window, list = [];
  if (w.phantom?.solana?.isPhantom) list.push(['Phantom', w.phantom.solana]);
  if (w.solflare?.isSolflare) list.push(['Solflare', w.solflare]);
  if (w.backpack?.isBackpack) list.push(['Backpack', w.backpack]);
  if (w.solana && !list.some(([, p]) => p === w.solana)) list.push(['Solana wallet', w.solana]);
  return list;
}
function showWallets() {
  const list = providers();
  $('#wallets').innerHTML = list.length ? list.map(([n], i) => `<button class="ghost" data-w="${i}">Connect ${esc(n)}</button> `).join('')
    : '<div class="note warn">No Solana wallet found in this browser. Install <b>Phantom</b>, <b>Solflare</b> or <b>Backpack</b>, then reload this page.</div>';
}
async function connect(i) {
  const [name, prov] = providers()[i];
  try {
    await prov.connect();
    const pk = prov.publicKey?.toString();
    if (!pk || !S.isAddress(pk)) throw new Error('the wallet did not share an address');
    WALLET = prov; ADDR = pk;
    UMI = S.makeUmi(RPC(), prov, { 'X-SOS-Minter': '1' });
    out('#oWallet', `✓ ${esc(name)} connected: ${addrLink(ADDR)}`, 'good');
    $('#airdrop').style.display = net() === 'mainnet' ? 'none' : '';
    await refreshBalance(); await recover(); render();
  } catch (e) { out('#oWallet', '✕ ' + esc(e.message || e), 'bad'); }
}
async function refreshBalance() {
  if (!UMI) return 0;
  const b = Number((await UMI.rpc.getBalance(UMI.identity.publicKey)).basisPoints);
  $('#oWallet').innerHTML = $('#oWallet').innerHTML.replace(/ · balance.*$/, '') + ` · balance <b>${SOL(b)}</b>`;
  return b;
}
async function airdrop() {
  try {
    out('#oWallet', 'asking the faucet…');
    await UMI.rpc.call('requestAirdrop', [ADDR, 2e9]);
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 1500)); if (await refreshBalanceQuiet() > 0) break; }
    out('#oWallet', `✓ connected: ${addrLink(ADDR)}`, 'good'); await refreshBalance();
  } catch (e) { out('#oWallet', '✕ the faucet said no (' + esc(e.message) + '). Devnet faucets are rate-limited: try faucet.solana.com.', 'bad'); }
}
const refreshBalanceQuiet = async () => Number((await UMI.rpc.getBalance(UMI.identity.publicKey)).basisPoints);

// ---------- sending, with every signed transaction saved before it goes out ----------
async function run(txs, kind, extra = {}) {
  const pend = () => INFO.sol.pending || [];
  const { signed, list } = await S.signAll(UMI, txs, l =>
    save({ pending: [...pend(), ...l.map(x => ({ sig: x.sig, lastValid: x.lastValid, kind, ids: x.ids, uri: extra.uri || '' }))] }));
  const known = await S.sendAll(UMI, signed, list);
  const res = await S.settle(UMI, list, { known });
  await apply(list.map(x => ({ ...x, kind, uri: extra.uri || '' })), res);
  const bad = list.map(x => res[x.sig]).filter(v => v !== 'ok');
  return { res, list, bad, landed: list.filter(x => res[x.sig] === 'ok').reduce((n, x) => n + Object.keys(x.ids).length, 0) };
}
// turns settled transactions into records: minted pieces, re-pointed links, the collection address
async function apply(entries, res) {
  const assets = {}, uris = {}, done = new Set(); let coll = null;
  for (const e of entries) {
    const r = res[e.sig];
    if (r === 'pending') continue;
    done.add(e.sig);
    if (r !== 'ok') continue;
    if (e.kind === 'collection') coll = Object.values(e.ids)[0];
    if (e.kind === 'mint') for (const [id, a] of Object.entries(e.ids)) { assets[id] = a; uris[id] = INFO.pieces[id - 1]?.uri; }
    if (e.kind === 'repoint') for (const id of Object.keys(e.ids)) uris[id] = e.uri + id + '.json';
  }
  const body = { assets, uris, pending: (INFO.sol.pending || []).filter(p => !done.has(p.sig)) };
  if (coll) body.collection = coll;
  await save(body);
}
// a page closed mid-batch: look up what happened to every saved transaction
async function recover() {
  const pend = INFO.sol.pending || [];
  if (!pend.length) return;
  out('#oMint', `checking ${pend.length} transaction(s) from last time…`);
  const res = await S.settle(UMI || readUmi(), pend, { timeoutMs: 5000 });
  await apply(pend, res);
  const left = (INFO.sol.pending || []).length;
  out('#oMint', left ? `${left} transaction(s) from last time are still in flight; reload in a minute.` : '✓ records from last time are up to date', left ? '' : 'good');
}

// ---------- 2. collection ----------
function creators() {
  const a = $('#royAddr').value.trim() || ADDR;
  if (!S.isAddress(a)) throw new Error('the royalty address is not a Solana address');
  return [{ address: a, percentage: 100 }];
}
const bps = () => Math.max(0, Math.min(3000, Math.round((+$('#royPct').value || 0) * 100)));
async function makeCollection() {
  if (!gate('#oColl')) return;
  BUSY = true; $('#mkColl').disabled = true;
  try {
    const c = S.collectionTx(UMI, { name: NAME, uri: INFO.collection_uri, royaltyBps: bps(), creators: creators() });
    out('#oColl', 'approve in your wallet…');
    const r = await run(c.txs, 'collection');
    if (r.bad.length) throw new Error(r.bad[0] === 'pending' ? 'still waiting for the network; reload in a minute' : r.bad[0]);
    await save({ royalty_bps: bps() });
    out('#oColl', `✓ collection created: ${addrLink(c.collection)}`, 'good');
  } catch (e) { out('#oColl', '✕ ' + esc(e.message || e), 'bad'); }
  finally { BUSY = false; render(); }
}

// ---------- 3. mint ----------
function todo() {
  const from = Math.max(1, +$('#from').value || 1), to = Math.min(INFO.pieces.length, +$('#to').value || INFO.pieces.length);
  const have = INFO.sol.assets || {}, flying = new Set((INFO.sol.pending || []).flatMap(p => Object.keys(p.ids)));
  return INFO.pieces.filter(p => p.id >= from && p.id <= to && !have[p.id] && !flying.has(String(p.id)));
}
async function estimate() {
  if (!UMI) return;
  try {
    const list = todo(), n = list.length; if (!n) { $('#cost').textContent = 'Every piece in this range is minted.'; return; }
    const each = await S.pieceCost(UMI, list[0]);
    $('#cost').innerHTML = `${n} piece(s) to mint · about <b>${SOL(each * n)}</b> in total (${SOL(each)} each, mostly the deposit that keeps the piece on Solana, plus Metaplex's 0.0015 SOL creation fee)` +
      (INFO.sol.collection ? '.' : ', plus about 0.003 SOL once for the collection.');
  } catch (e) { $('#cost').textContent = 'cost unknown: ' + (e.message || e); }
}
const ownerAddr = () => $('#owner').value.trim() || ADDR;
async function mint() {
  if (!gate('#oMint')) return;
  if (!INFO.sol.collection) return out('#oMint', '✕ create the collection first (step 2)', 'bad');
  if (!S.isAddress(ownerAddr())) return out('#oMint', '✕ the "mint to" address is not a Solana address', 'bad');
  if (net() === 'mainnet' && !$('#iUnderstand').checked) return out('#oMint', '✕ tick the box to confirm this spends real SOL', 'bad');
  BUSY = true; $('#mint').disabled = true; $('#mBar').style.display = '';
  const per = Math.max(1, Math.min(60, +$('#per').value || 24));
  let made = 0, total = todo().length, failed = [];
  try {
    const col = await S.getCollection(UMI, INFO.sol.collection);
    const prio = net() === 'mainnet' ? await S.suggestedPriority(UMI) : 0;
    while (todo().length) {
      const chunk = todo().slice(0, per);
      const txs = S.mintTxs(UMI, col, chunk, ownerAddr(), prio);
      out('#oMint', `approve ${txs.length} transaction(s) for pieces #${chunk[0].id}–#${chunk.at(-1).id} in your wallet…`);
      const r = await run(txs, 'mint');
      made += r.landed;
      $('#mBar i').style.width = Math.round(100 * made / total) + '%';
      if (r.bad.length) { failed = r.bad; break; }
      render(false);
    }
    await refreshBalance();
    out('#oMint', failed.length ? `minted ${made} of ${total}; ${failed.length} transaction(s) did not land: ${esc(failed[0])}. Press Mint again to retry the rest.`
      : `✓ minted ${made} piece(s)`, failed.length ? 'bad' : 'good');
  } catch (e) { out('#oMint', `minted ${made} of ${total} · ✕ ${esc(e.message || e)}`, 'bad'); }
  finally { BUSY = false; render(); }
}

// ---------- 4. manage ----------
async function repoint() {
  if (!gate('#oManage')) return;
  const assets = INFO.sol.assets || {}, uris = INFO.sol.uris || {};
  const stale = INFO.pieces.filter(p => assets[p.id] && uris[p.id] !== p.uri);
  if (INFO.sol.locked) return out('#oManage', '✕ the collection is locked; its links can never change', 'bad');
  BUSY = true;
  try {
    let col = await S.getCollection(UMI, INFO.sol.collection);
    if (col.uri !== INFO.collection_uri) {       // the collection's own card moves with the pieces
      out('#oManage', 'approve the collection\'s new link in your wallet…');
      const r = await run(S.collectionUriTx(UMI, INFO.sol.collection, INFO.collection_uri), 'coluri');
      if (r.bad.length) throw new Error(r.bad[0]);
      col = await S.getCollection(UMI, INFO.sol.collection);
    }
    if (!stale.length) return out('#oManage', '✓ the collection and every minted piece point at the latest version', 'good');
    const base = INFO.pieces[0].uri.replace(/\d+\.json$/, '');
    for (let i = 0; i < stale.length; i += 30) {
      const part = stale.slice(i, i + 30);
      const fetched = await Promise.all(part.map(p => S.getAsset(UMI, assets[p.id])));
      const txs = S.repointTxs(UMI, col, part.map((p, k) => ({ id: p.id, asset: fetched[k], uri: p.uri })));
      out('#oManage', `approve ${txs.length} transaction(s) to re-point ${part.length} piece(s)…`);
      const r = await run(txs, 'repoint', { uri: base });
      if (r.bad.length) throw new Error(r.bad[0]);
    }
    out('#oManage', `✓ re-pointed ${stale.length} piece(s). Wallets and marketplaces pick up the new version as they refresh.`, 'good');
  } catch (e) { out('#oManage', '✕ ' + esc(e.message || e), 'bad'); }
  finally { BUSY = false; render(); }
}
async function setRoyalty() {
  if (!gate('#oManage')) return;
  BUSY = true;
  try {
    const r = await run(S.royaltyTx(UMI, INFO.sol.collection, bps(), creators()), 'royalty');
    if (r.bad.length) throw new Error(r.bad[0]);
    await save({ royalty_bps: bps() });
    out('#oManage', `✓ royalty is now ${bps() / 100}%`, 'good');
  } catch (e) { out('#oManage', '✕ ' + esc(e.message || e), 'bad'); }
  finally { BUSY = false; render(); }
}
async function lock() {
  if (!gate('#oLock') || $('#lockWord').value.trim() !== 'LOCK') return;
  BUSY = true;
  try {
    const r = await run(S.lockTx(UMI, INFO.sol.collection), 'lock');
    if (r.bad.length) throw new Error(r.bad[0]);
    await save({ locked: true });
    out('#oLock', '✓ locked forever', 'good');
  } catch (e) { out('#oLock', '✕ ' + esc(e.message || e), 'bad'); }
  finally { BUSY = false; render(); }
}
function gate(o) {
  if (BUSY) { out(o, 'busy with the last step…'); return false; }
  if (!UMI) { out(o, '✕ connect your wallet first (step 1)', 'bad'); return false; }
  if (INFO.stale) { out(o, '✕ the collection changed since it was stored: press Store on the main page first', 'bad'); return false; }
  return true;
}

// ---------- page ----------
function render(full = true) {
  const sol = INFO.sol || {}, assets = sol.assets || {}, minted = Object.keys(assets).length, n = INFO.pieces.length;
  $('#info').innerHTML = `<b>${esc(INFO.collection)}</b> · ${n} piece(s) · Solana ${esc(net())} via <code>${esc(INFO.rpc_host)}</code>` +
    (sol.collection ? ` · collection ${addrLink(sol.collection)}` : '') + ` · minted <b>${minted}/${n}</b>` +
    (sol.royalty_bps != null ? ` · royalty ${sol.royalty_bps / 100}%` : '') + (sol.locked ? ' · 🔒 locked' : '') +
    (INFO.stale ? '<div class="note warn">The pieces changed since they were stored: press <b>Store on IPFS</b> on the main page first.</div>' : '');
  $('#mkColl').disabled = BUSY || !!sol.collection;
  if (sol.collection) out('#oColl', `✓ collection ${addrLink(sol.collection)}`, 'good');
  $('#mint').disabled = BUSY || !sol.collection || minted >= n;
  $('#setRoy').disabled = BUSY || !sol.collection;
  $('#repoint').disabled = BUSY || !sol.collection || !!sol.locked;
  $('#lock').disabled = BUSY || !sol.collection || !!sol.locked || $('#lockWord').value.trim() !== 'LOCK';
  const ids = Object.keys(assets).map(Number).sort((a, b) => a - b);
  $('#list').innerHTML = ids.length ? `<table style="width:100%;border-collapse:collapse;font-size:13.5px"><tr style="text-align:left;color:var(--dim)"><th>piece</th><th></th><th>asset</th><th>points at</th></tr>` +
    ids.slice(0, 500).map(i => `<tr><td>#${String(i).padStart(4, '0')}</td><td><img src="/api/img?c=${encodeURIComponent(NAME)}&id=${i}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px"></td>
      <td>${addrLink(assets[i])}</td><td>${(sol.uris || {})[i] === INFO.pieces[i - 1]?.uri ? 'latest ✓' : '<span class="tag">older version</span>'}</td></tr>`).join('') +
    '</table>' + (ids.length > 500 ? `<p class="sub">…and ${ids.length - 500} more</p>` : '') : 'Nothing minted yet.';
  if (full) estimate();
}

document.addEventListener('click', e => { const w = e.target.closest('[data-w]'); if (w) connect(+w.dataset.w); });
$('#airdrop').onclick = airdrop; $('#mkColl').onclick = makeCollection; $('#mint').onclick = mint;
$('#repoint').onclick = repoint; $('#setRoy').onclick = setRoyalty; $('#lock').onclick = lock;
$('#lockWord').addEventListener('input', () => render(false));
for (const id of ['#from', '#to', '#owner']) $(id).addEventListener('change', () => render());
$('#back').href = '/?name=' + encodeURIComponent(NAME);

(async () => {
  try { INFO = await api('/api/sol/info?name=' + encodeURIComponent(NAME)); }
  catch (e) { $('#info').innerHTML = '<span class="out bad">✕ ' + esc(e.message) + '</span>'; return; }
  const nb = $('#net'); nb.textContent = net() === 'mainnet' ? 'SOLANA · real SOL' : 'solana ' + net() + ' · practice';
  if (net() === 'mainnet') { nb.classList.add('main'); $('#mainnetBox').style.display = ''; }
  $('#royPct').value = (INFO.sol.royalty_bps ?? INFO.royalty_bps) / 100;
  $('#to').value = INFO.pieces.length; $('#owner').value = INFO.owner || '';
  render(false); showWallets();
  setTimeout(showWallets, 600);                // some extensions inject their provider a moment after the page loads
})();
