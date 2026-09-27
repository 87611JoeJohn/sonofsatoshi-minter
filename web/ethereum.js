import * as E from './eth-core.js';

const $ = s => document.querySelector(s);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAME = new URLSearchParams(location.search).get('name') || '';
const out = (id, m, c) => { const o = $(id); o.innerHTML = m; o.className = 'out' + (c ? ' ' + c : ''); };
const ETH = wei => { const v = Number(E.formatEther(wei)); return (v < 0.001 ? v.toFixed(6) : v.toFixed(4)) + ' ETH'; };
let INFO = null, NET = null, PROV = null, ACCT = '', C = null, ST = null, BUSY = false, walletList = () => [];

async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-SOS-Minter': '1' },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ error: 'the app answered HTTP ' + r.status }));
  if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
const save = body => api('/api/eth/save', { collection_name: NAME, ...body }).then(r => { INFO.eth = r.eth; return r; });
const link = (kind, v) => NET.explorer ? `<a href="${NET.explorer}/${kind}/${esc(v)}" target="_blank" rel="noopener"><code>${esc(v.slice(0, 8))}…${esc(v.slice(-4))}</code></a>` : `<code>${esc(v.slice(0, 8))}…${esc(v.slice(-4))}</code>`;
const contract = () => INFO.eth.contract;
const mintTo = () => ($('#mintTo').value.trim() || ACCT);
const isOwner = () => ST && ACCT && ST.owner.toLowerCase() === ACCT.toLowerCase();
const confirmed = n => !NET.real || $('#iUnderstand' + n).checked;

// ---------- wallet ----------
function showWallets(list) {
  $('#wallets').innerHTML = list.length ? list.map((w, i) => `<button class="ghost" data-w="${i}">Connect ${esc(w.name)}</button> `).join('')
    : '<div class="note warn">No Ethereum wallet found in this browser. Install <b>MetaMask</b> or <b>Rabby</b>, then reload this page.</div>';
}
async function connect(i) {
  const w = walletList()[i];
  try {
    ACCT = await E.connect(w.provider); PROV = w.provider;
    await E.ensureChain(PROV, INFO.network);
    C = E.clients(PROV, INFO.network, ACCT);
    const bal = await C.pub.getBalance({ address: ACCT });
    out('#oWallet', `✓ ${esc(w.name)} connected on ${esc(NET.name)}: ${link('address', ACCT)} · balance <b>${ETH(bal)}</b>`, 'good');
    PROV.on?.('chainChanged', () => out('#oWallet', 'the wallet changed network; press Connect again', 'bad'));
    PROV.on?.('accountsChanged', () => out('#oWallet', 'the wallet changed account; press Connect again', 'bad'));
    await recover(); await refresh();
  } catch (e) { out('#oWallet', '✕ ' + esc(E.why(e)), 'bad'); }
}
// before every action: the wallet may have been switched in the meantime
async function ready(o) {
  if (BUSY) { out(o, 'busy with the last step…'); return false; }
  if (!C) { out(o, '✕ connect your wallet first (step 1)', 'bad'); return false; }
  if (INFO.stale) { out(o, '✕ the collection changed since it was stored: press Store on the main page first', 'bad'); return false; }
  try { await E.ensureChain(PROV, INFO.network); } catch (e) { out(o, '✕ ' + esc(E.why(e)), 'bad'); return false; }
  return true;
}

// ---------- records: every sent transaction is saved the moment the wallet returns it ----------
async function track(kind, note, send) {
  const tx = await send();
  await save({ pending: [...(INFO.eth.pending || []), { tx, kind, note }] });
  try { return await E.receipt(C.pub, tx); }
  finally { await save({ pending: (INFO.eth.pending || []).filter(p => p.tx !== tx) }); }
}
// a page closed mid-way: finish the story of every saved transaction
async function recover() {
  const d = INFO.eth.deploy;
  if (d && !contract()) {
    try {
      if (d.tx) { const r = await E.receipt(C.pub, d.tx, 120_000); await save({ contract: r.contractAddress }); }
      else if (await E.hasCode(C.pub, d.predicted)) await save({ contract: d.predicted });
      else if ((await C.pub.getTransactionCount({ address: d.from })) > d.nonce) await save({ deploy: null });  // that nonce went elsewhere
    } catch { /* still in flight: leave it */ }
  }
  for (const p of INFO.eth.pending || []) {
    try { await E.receipt(C.pub, p.tx, 60_000); } catch { /* failed or still pending: the chain state below is the truth */ }
  }
  if ((INFO.eth.pending || []).length) await save({ pending: [] });
}

// ---------- reading the contract ----------
async function refresh() {
  ST = null;
  if (C && contract()) {
    try { ST = await E.state(C.pub, contract()); } catch (e) { out('#oDeploy', '✕ could not read the contract: ' + esc(E.why(e)), 'bad'); }
  }
  render(); estimate();
}
async function estimate() {
  if (!C) return;
  try {
    if (!contract()) {
      const data = await E.deployData(deployArgs());
      const e = await E.estimate(C.pub, ACCT, { data });
      $('#deployCost').innerHTML = `Deploying costs about <b>${ETH(e.wei)}</b> right now (${e.gas.toLocaleString()} gas). Fees move with the network.`;
      $('#mintCost').textContent = 'Deploy first.';
      return;
    }
    $('#deployCost').textContent = '';
    if (!ST) return;
    const left = ST.maxSupply - ST.totalMinted;
    if (!left) { $('#mintCost').textContent = 'Every piece is minted.'; return; }
    if (!isOwner()) { $('#mintCost').textContent = 'Only the contract owner can mint.'; return; }
    const n = Math.min(left, per()), e = await E.mintEstimate(C.pub, ACCT, contract(), mintTo(), n, ST.totalMinted + 1);
    const each = e.wei / BigInt(n);
    $('#mintCost').innerHTML = `${left} piece(s) left · about <b>${ETH(each * BigInt(left))}</b> for all of them (${ETH(e.wei)} per batch of ${n}). Fees move with the network.`;
  } catch (e) { $('#mintCost').textContent = 'cost unknown: ' + E.why(e); }
}
const per = () => Math.max(1, Math.min(300, +$('#per').value || 100));

// ---------- 2. deploy ----------
function deployArgs() {
  const bps = Math.max(0, Math.min(3000, Math.round((+$('#royPct').value || 0) * 100)));
  const recv = $('#royAddr').value.trim() || ACCT;
  if (!E.isAddress(recv)) throw new Error('the royalty address is not an Ethereum address');
  const sym = $('#symbol').value.trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(sym)) throw new Error('the symbol should be 1–10 letters or digits');
  return [NAME, sym, BigInt(INFO.count), INFO.base_uri, ACCT, E.getAddress(recv), BigInt(bps)];
}
async function deploy() {
  if (!(await ready('#oDeploy'))) return;
  if (contract()) return out('#oDeploy', '✓ already deployed', 'good');
  if (!confirmed(1)) return out('#oDeploy', '✕ tick the box to confirm this spends real ETH', 'bad');
  BUSY = true; $('#deploy').disabled = true;
  try {
    const [name, symbol, maxSupply, baseURI, owner, royaltyReceiver, royaltyBps] = deployArgs();
    const pre = await E.predictDeploy(C.pub, ACCT);
    await save({ deploy: pre });
    out('#oDeploy', 'approve the deploy in your wallet…');
    const tx = await E.deploy(C.wal, { name, symbol, maxSupply, baseURI, owner, royaltyReceiver, royaltyBps });
    await save({ deploy: { ...pre, tx } });
    out('#oDeploy', `sent ${link('tx', tx)}, waiting for it to be included…`);
    const r = await E.receipt(C.pub, tx);
    await save({ contract: r.contractAddress, royalty_bps: Number(royaltyBps) });
    out('#oDeploy', `✓ deployed: ${link('address', r.contractAddress)}`, 'good');
  } catch (e) { out('#oDeploy', '✕ ' + esc(E.why(e)), 'bad'); }
  finally { BUSY = false; await refresh(); }
}

// ---------- 3. mint ----------
async function mint() {
  if (!(await ready('#oMint'))) return;
  if (!ST) return out('#oMint', '✕ deploy the contract first (step 2)', 'bad');
  if (!isOwner()) return out('#oMint', '✕ the connected wallet is not the owner of this contract', 'bad');
  if (!E.isAddress(mintTo())) return out('#oMint', '✕ the "mint to" address is not an Ethereum address', 'bad');
  if (!confirmed(2)) return out('#oMint', '✕ tick the box to confirm this spends real ETH', 'bad');
  BUSY = true; $('#mint').disabled = true; $('#mBar').style.display = '';
  let made = 0;
  try {
    for (;;) {
      ST = await E.state(C.pub, contract());                     // the chain is the truth for where to start
      const left = ST.maxSupply - ST.totalMinted; if (!left) break;
      const n = Math.min(left, per()), start = ST.totalMinted + 1;
      out('#oMint', `approve pieces #${start}–#${start + n - 1} in your wallet…`);
      await track('mint', `#${start}-#${start + n - 1}`, () => E.mintBatch(C.wal, contract(), E.getAddress(mintTo()), n, start));
      made += n; $('#mBar i').style.width = Math.round(100 * (start + n - 1) / ST.maxSupply) + '%';
      render();
    }
    out('#oMint', `✓ minted ${made} piece(s); all ${ST.maxSupply} are out`, 'good');
  } catch (e) { out('#oMint', (made ? `minted ${made} · ` : '') + '✕ ' + esc(E.why(e)) + '. Press Mint again to carry on.', 'bad'); }
  finally { BUSY = false; await refresh(); }
}

// ---------- 4. manage ----------
async function owned(o) {
  if (!(await ready(o))) return false;
  if (!ST) { out(o, '✕ deploy the contract first (step 2)', 'bad'); return false; }
  if (!isOwner()) { out(o, '✕ the connected wallet is not the owner of this contract', 'bad'); return false; }
  return true;
}
async function repoint() {
  if (!(await owned('#oManage'))) return;
  if (ST.baseURI === INFO.base_uri) return out('#oManage', '✓ the contract already points at the latest version', 'good');
  if (ST.frozen) return out('#oManage', '✕ the links are frozen forever', 'bad');
  BUSY = true;
  try {
    out('#oManage', 'approve the new links in your wallet…');
    await track('repoint', INFO.base_uri, () => E.setBaseURI(C.wal, contract(), INFO.base_uri));
    out('#oManage', '✓ re-pointed. Marketplaces were told to refresh every piece.', 'good');
  } catch (e) { out('#oManage', '✕ ' + esc(E.why(e)), 'bad'); }
  finally { BUSY = false; await refresh(); }
}
async function setRoyalty() {
  if (!(await owned('#oManage'))) return;
  BUSY = true;
  try {
    const bps = Math.max(0, Math.min(3000, Math.round((+$('#royPct').value || 0) * 100)));
    const recv = $('#royAddr').value.trim() || ACCT;
    if (!E.isAddress(recv)) throw new Error('the royalty address is not an Ethereum address');
    out('#oManage', 'approve the royalty in your wallet…');
    await track('royalty', String(bps), () => E.setRoyalty(C.wal, contract(), E.getAddress(recv), bps));
    await save({ royalty_bps: bps });
    out('#oManage', `✓ royalty is now ${bps / 100}%`, 'good');
  } catch (e) { out('#oManage', '✕ ' + esc(E.why(e)), 'bad'); }
  finally { BUSY = false; await refresh(); }
}
async function freeze() {
  if ($('#freezeWord').value.trim() !== 'FREEZE' || !(await owned('#oFreeze'))) return;
  if (ST.baseURI !== INFO.base_uri && !confirm('The contract does not point at your latest stored version. Freeze the OLD links forever anyway?')) return;
  BUSY = true;
  try {
    out('#oFreeze', 'approve in your wallet…');
    await track('freeze', '', () => E.freeze(C.wal, contract()));
    await save({ frozen: true });
    out('#oFreeze', '✓ frozen forever', 'good');
  } catch (e) { out('#oFreeze', '✕ ' + esc(E.why(e)), 'bad'); }
  finally { BUSY = false; await refresh(); }
}

// ---------- page ----------
function render() {
  const c = contract();
  let s = `<b>${esc(INFO.collection)}</b> · ${INFO.count} piece(s) · ${esc(NET.name)}`;
  if (c) s += ` · contract ${link('address', c)}`;
  if (ST) {
    s += ` · minted <b>${ST.totalMinted}/${ST.maxSupply}</b> · royalty ${ST.royaltyBps / 100}%` + (ST.frozen ? ' · 🔒 frozen' : '') +
      (ST.baseURI !== INFO.base_uri ? ' · <span class="tag">points at an older version</span>' : '');
    if (NET.market && ST.totalMinted) s += ` · <a href="https://opensea.io/assets/${NET.market}/${esc(c)}/1" target="_blank" rel="noopener">see it on OpenSea</a>`;
    if (!isOwner()) s += '<div class="note warn">The connected wallet is not this contract\'s owner, so it can only look.</div>';
    if (ST.maxSupply !== INFO.count) s += `<div class="note warn">This contract holds ${ST.maxSupply} pieces but the collection now has ${INFO.count}. The supply of a deployed contract can't change.</div>`;
  }
  if (INFO.stale) s += '<div class="note warn">The pieces changed since they were stored: press <b>Store on IPFS</b> on the main page first.</div>';
  $('#info').innerHTML = s;
  if (c) out('#oDeploy', `✓ deployed: ${link('address', c)}`, 'good');
  $('#deploy').disabled = BUSY || !!c;
  $('#mint').disabled = BUSY || !ST || ST.totalMinted >= ST.maxSupply;
  $('#repoint').disabled = BUSY || !ST || ST.frozen;
  $('#setRoy').disabled = BUSY || !ST;
  $('#freeze').disabled = BUSY || !ST || ST.frozen || $('#freezeWord').value.trim() !== 'FREEZE';
}

document.addEventListener('click', e => { const w = e.target.closest('[data-w]'); if (w) connect(+w.dataset.w); });
$('#deploy').onclick = deploy; $('#mint').onclick = mint; $('#repoint').onclick = repoint; $('#setRoy').onclick = setRoyalty; $('#freeze').onclick = freeze;
$('#freezeWord').addEventListener('input', render);
for (const id of ['#per', '#mintTo', '#royPct', '#royAddr', '#symbol']) $(id).addEventListener('change', estimate);
$('#back').href = '/?name=' + encodeURIComponent(NAME);

(async () => {
  try { INFO = await api('/api/eth/info?name=' + encodeURIComponent(NAME)); }
  catch (e) { $('#info').innerHTML = '<span class="out bad">✕ ' + esc(e.message) + '</span>'; return; }
  NET = E.NETWORKS[INFO.network];
  const nb = $('#net'); nb.textContent = NET.real ? NET.name.toUpperCase() + ' · real ETH' : NET.name.toLowerCase();
  if (NET.real) { nb.classList.add('main'); document.querySelectorAll('.mainnetBox').forEach(x => x.style.display = ''); }
  $('#title').textContent = 'Mint on ' + NET.name.replace(/ \(.*\)/, '');
  $('#royPct').value = (INFO.eth.royalty_bps ?? INFO.royalty_bps) / 100;
  $('#symbol').value = (NAME.match(/[A-Za-z0-9]+/g) || ['NFT']).map(w => w[0]).join('').toUpperCase().slice(0, 6) || 'NFT';
  $('#mintTo').value = INFO.owner || '';
  if (INFO.network === 'base' || INFO.network === 'base-sepolia') $('#per').value = 150;
  render();
  walletList = E.discoverWallets(showWallets);
  showWallets(walletList());
  setTimeout(() => showWallets(walletList()), 600);   // some wallets announce themselves a moment after the page loads
})();
