import { AppConfig, UserSession, showConnect, openContractDeploy, openContractCall, StacksMainnet, StacksTestnet,
  listCV, standardPrincipalCV, stringAsciiCV, uintCV, PostConditionMode } from './stacks.js';

const $ = s => document.querySelector(s);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAME = new URLSearchParams(location.search).get('name') || '';
const SELF_ID = "'SELF.CONTRACT_ID";
let INFO = null, ADDR = null, CID = null;   // CID = deployed contract id "ADDR.name"
const session = new UserSession({ appConfig: new AppConfig(['store_write']) });
const app = () => ({ name: 'SonOfSatoshi Minter', icon: location.origin + '/static/icon.svg' });
const net = () => INFO.network === 'mainnet' ? new StacksMainnet() : new StacksTestnet();
const HIRO = () => INFO.network === 'mainnet' ? 'https://api.hiro.so' : 'https://api.testnet.hiro.so';
const explorer = tx => `https://explorer.hiro.so/txid/${tx}?chain=${INFO.network}`;
const log = m => $('#log').insertAdjacentHTML('afterbegin', '<div>' + new Date().toLocaleTimeString() + ' · ' + m + '</div>');
const out = (id, m, c) => { const o = $(id); o.innerHTML = m; o.className = 'out' + (c ? ' ' + c : ''); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const record = (kind, txid, extra = {}) => api('/api/record-tx', { collection_name: NAME, kind, txid, ...extra });

// ---------- reading the chain ----------
async function deployed() {
  if (!CID) return false;
  const [a, n] = CID.split('.');
  try { return (await fetch(`${HIRO()}/v2/contracts/interface/${a}/${n}`)).ok; } catch { return false; }
}
async function readOnly(fn, args = []) {
  const [a, n] = CID.split('.');
  const r = await fetch(`${HIRO()}/v2/contracts/call-read/${a}/${n}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: a, arguments: args }) });
  const j = await r.json(); if (!j.okay) throw new Error(j.cause || 'read failed'); return j.result;
}
const hexUint = h => parseInt(h.slice(-32), 16);                  // (ok uint)
function hexAsciiOpt(h) {                                          // (ok (some "string-ascii"))
  const b = h.slice(2); const i = b.indexOf('0a0d'); if (i < 0) return '';
  const len = parseInt(b.slice(i + 4, i + 12), 16); const s = b.slice(i + 12, i + 12 + len * 2);
  return s.match(/../g).map(x => String.fromCharCode(parseInt(x, 16))).join('');
}
async function waitTx(txid, label, outId) {
  for (let i = 0; i < 180; i++) {
    try {
      const j = await (await fetch(`${HIRO()}/extended/v1/tx/${txid}`)).json();
      if (j.tx_status === 'success') return true;
      if (j.tx_status && j.tx_status !== 'pending') { out(outId, `✕ ${label} failed on-chain: ${esc(j.tx_status)} ${esc(j.tx_result?.repr || '')}`, 'bad'); return false; }
    } catch { }
    out(outId, `⏳ waiting for ${label} to confirm… (${Math.floor(i * 10 / 60)} min — usually 1–10)`, 'warn');
    await sleep(10000);
  }
  out(outId, `still not confirmed after 30 min — check it on the <a href="${explorer(txid)}" target="_blank" rel="noopener">explorer</a> and reload this page`, 'warn');
  return false;
}

// ---------- state ----------
async function refreshState() {
  const isDeployed = await deployed();
  $('#deploy').disabled = !ADDR || isDeployed || !INFO.ready;
  if (isDeployed) out('#oDep', `✓ deployed: <code>${esc(CID)}</code>`, 'good');
  else if (ADDR) out('#oDep', INFO.ready ? 'ready to deploy from ' + `<code>${esc(ADDR)}</code>` : '✕ store the collection on IPFS first (step 4 on the main page)', INFO.ready ? '' : 'bad');
  let minted = 0;
  if (isDeployed) { try { minted = hexUint(await readOnly('get-last-token-id')); } catch { } }
  const total = INFO.count;
  $('#mintBar').style.width = Math.min(100, Math.round(minted / Math.max(1, total) * 100)) + '%';
  out('#oMintCount', `${minted} of ${total} minted`, minted >= total ? 'good' : '');
  const left = Math.max(0, total - minted), next = Math.min(200, left);
  $('#mint').textContent = left ? `② Mint ${next}${left > 200 ? ` (round ${Math.floor(minted / 200) + 1} of ${Math.ceil(total / 200)})` : ''}` : '✓ All minted';
  $('#mint').disabled = !ADDR || !isDeployed || !left || !owner();
  const tools = ADDR && isDeployed && owner();
  ['#repoint', '#refresh', '#royalty'].forEach(s => $(s).disabled = !tools);
  $('#freeze').disabled = !tools || $('#freezeConfirm').value.trim() !== 'FREEZE';
  if (isDeployed) {
    try {
      const frozen = (await readOnly('is-frozen')).endsWith('03');
      const onchain = hexAsciiOpt(await readOnly('get-token-uri', ['0x0100000000000000000000000000000001']));
      if (frozen) { out('#oUri', '🧊 This collection is frozen: its art and stories can never change.', 'good'); $('#repoint').disabled = $('#freeze').disabled = true; }
      else if (INFO.base_uri && onchain !== INFO.base_uri) out('#oUri', `⚠ The contract points at an older version.<br>on-chain: <code>${esc(onchain)}</code><br>latest: <code>${esc(INFO.base_uri)}</code>`, 'warn');
      else out('#oUri', '✓ the contract points at your latest version', 'good');
    } catch { }
  }
  return { isDeployed, minted };
}
const owner = () => CID && ADDR && CID.split('.')[0] === ADDR;

// ---------- actions ----------
function connect() {
  showConnect({ userSession: session, appDetails: app(), onFinish: onConnected, onCancel: () => log('connect cancelled') });
}
function onConnected() {
  const d = session.loadUserData();
  ADDR = INFO.network === 'mainnet' ? d.profile.stxAddress.mainnet : d.profile.stxAddress.testnet;
  CID = INFO.state.deployed_contract || `${ADDR}.${INFO.contract_name}`;
  out('#oConn', `✓ connected: <code>${esc(ADDR)}</code>` + (owner() ? '' :
    `<br>⚠ This collection was deployed by <code>${esc(CID.split('.')[0])}</code>. Connect that account to mint or change it.`), owner() ? 'good' : 'warn');
  $('#connect').style.display = 'none'; $('#disconnect').style.display = '';
  log('connected ' + esc(ADDR)); refreshState();
}
function deploy() {
  CID = `${ADDR}.${INFO.contract_name}`;
  const code = INFO.code_body.split(SELF_ID).join(`'${CID}`);
  openContractDeploy({ contractName: INFO.contract_name, codeBody: code, network: net(), appDetails: app(),
    onFinish: async d => {
      log(`deploy sent · <a href="${explorer(d.txId)}" target="_blank" rel="noopener">${d.txId.slice(0, 14)}…</a>`);
      await record('deploy', d.txId, { contract_id: CID });
      $('#deploy').disabled = true;
      if (await waitTx(d.txId, 'the deploy', '#oDep')) {
        for (let i = 0; i < 30 && !(await deployed()); i++) await sleep(5000);   // the API can lag the block by a moment
        log('✓ contract live'); INFO.state.deployed_contract = CID;
      }
      refreshState();
    }, onCancel: () => log('deploy cancelled') });
}
async function mint() {
  const { minted } = await refreshState();
  const left = INFO.count - minted; if (left <= 0) return;
  const n = Math.min(200, left), to = INFO.recipient || ADDR;
  openContractCall({ contractAddress: CID.split('.')[0], contractName: CID.split('.')[1], functionName: 'mint-many',
    functionArgs: [listCV(Array.from({ length: n }, () => standardPrincipalCV(to)))],
    network: net(), postConditionMode: PostConditionMode.Allow, appDetails: app(),
    onFinish: async d => {
      log(`mint of ${n} sent · <a href="${explorer(d.txId)}" target="_blank" rel="noopener">${d.txId.slice(0, 14)}…</a>`);
      await record('mint', d.txId, { count: n }); $('#mint').disabled = true;
      if (await waitTx(d.txId, `minting ${n}`, '#oMint')) out('#oMint', `✓ ${n} minted to <code>${esc(to)}</code>`, 'good');
      refreshState();
    }, onCancel: () => log('mint cancelled') });
}
function call(fn, args, label) {
  openContractCall({ contractAddress: CID.split('.')[0], contractName: CID.split('.')[1], functionName: fn, functionArgs: args,
    network: net(), postConditionMode: PostConditionMode.Allow, appDetails: app(),
    onFinish: async d => {
      log(`${label} sent · <a href="${explorer(d.txId)}" target="_blank" rel="noopener">${d.txId.slice(0, 14)}…</a>`);
      await record(fn, d.txId);
      if (await waitTx(d.txId, label, '#oAfter')) out('#oAfter', `✓ ${label} done`, 'good');
      refreshState();
    }, onCancel: () => log(label + ' cancelled') });
}

// ---------- start ----------
(async () => {
  if (!NAME) { $('#info').innerHTML = '<span class="out bad">Open this page from the main screen (step 5).</span>'; return; }
  $('#back').href = '/?name=' + encodeURIComponent(NAME);
  INFO = await api('/api/mintinfo?name=' + encodeURIComponent(NAME));
  if (INFO.error) { $('#info').innerHTML = `<span class="out bad">✕ ${esc(INFO.error)}</span>`; return; }
  $('#net').textContent = INFO.network === 'mainnet' ? 'MAINNET · real STX' : 'testnet · practice';
  if (INFO.network === 'mainnet') $('#net').classList.add('main');
  $('#info').innerHTML = `<b>${esc(NAME)}</b> · ${INFO.count} piece(s) · contract <code>${esc(INFO.contract_name)}</code> · ${esc(INFO.network)}` +
    (INFO.ready ? '' : '<div class="note bad">Not stored on IPFS yet: go back and do step 4 first.</div>');
  $('#rcpt').textContent = INFO.recipient || 'the connected wallet';
  $('#code').textContent = INFO.code_body;
  const cfg = await api('/api/config'); $('#rPct').value = cfg.royalty_pct ?? 5; $('#rAddr').value = cfg.owner_address || '';
  $('#connect').onclick = connect;
  $('#disconnect').onclick = () => { session.signUserOut(); location.reload(); };
  $('#deploy').onclick = deploy; $('#mint').onclick = mint;
  $('#repoint').onclick = () => call('set-base-uri', [stringAsciiCV(INFO.base_uri)], 're-point');
  $('#refresh').onclick = () => call('refresh-metadata', [], 'wallet refresh');
  $('#royalty').onclick = () => {
    const pct = Math.max(0, Math.min(30, +$('#rPct').value || 0)), a = $('#rAddr').value.trim().toUpperCase();
    if (!/^S[PMTN][0-9A-HJKMNP-TV-Z]{38,40}$/.test(a)) return out('#oAfter', '✕ enter the address royalties go to', 'bad');
    call('set-royalty', [uintCV(Math.round(pct * 100)), standardPrincipalCV(a)], `royalty ${pct}%`);
  };
  $('#freezeConfirm').oninput = () => { if (ADDR) refreshState(); };
  $('#freeze').onclick = () => { if (confirm('Freeze forever? Nobody, including you, can change the art or stories after this.')) call('freeze-metadata', [], 'freeze'); };
  if (session.isUserSignedIn()) onConnected();
})();
