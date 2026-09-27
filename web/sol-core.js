// SonOfSatoshi Minter: the Solana engine (Metaplex Core).
// Every call goes through the local server's RPC relay (/api/sol/rpc), so the page never talks to the internet itself.
//
// How a Solana collection works here:
//   1. COLLECTION: one Core collection account carries the name, the collection link and the Royalties plugin
//      (creators + basis points, enforced by marketplaces that honor Core royalties).
//   2. MINT: each piece is one Core asset inside the collection. Several pieces go in one transaction; your wallet
//      approves the whole batch at once. Each asset's address is a fresh key made here, signed with, and thrown away.
//   3. RE-POINT: if the art or stories move, every asset's link can be changed (one small transaction per few pieces).
//   4. LOCK: adding the ImmutableMetadata plugin to the collection freezes the name and link of the collection and
//      every piece in it, forever. Nobody, including you, can change them after that.
//   Safe retries: before sending, the page saves each transaction's signature + its expiry block. If the page closes,
//   the next visit checks them: landed = recorded, expired without landing = safe to send again.
import {
  createUmi, mplCore, walletAdapterIdentity, keypairIdentity, generateSigner, signAllTransactions, publicKey, transactionBuilder,
  createCollection, create, update, updateCollection, updateCollectionPlugin, addCollectionPlugin, fetchCollection, fetchAsset, ruleSet, base58,
} from './sol.js';

export const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const MAX_NAME = 32;                     // Core stores any length, but wallets and marketplaces cut long names
export const MAX_URI = 200;
const COMPUTE_BUDGET = publicKey('ComputeBudget111111111111111111111111111111');

// wallet = a browser wallet provider (Phantom / Solflare / Backpack) or, in tests, a umi Keypair
export function makeUmi(endpoint, wallet, headers = {}) {
  const umi = createUmi(endpoint, { commitment: 'confirmed', httpHeaders: headers, disableRetryOnRateLimit: false }).use(mplCore());
  if (!wallet) return umi;                        // read-only
  return wallet.secretKey ? umi.use(keypairIdentity(wallet)) : umi.use(walletAdapterIdentity(wallet));
}

export function isAddress(a) {
  try { return typeof a === 'string' && base58.serialize(a).length === 32; } catch { return false; }
}

// a tiny priority fee helps transactions land when the network is busy (micro-lamports per compute unit)
function priorityIx(microLamports) {
  const data = new Uint8Array(9); data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, BigInt(Math.max(0, Math.floor(microLamports || 0))), true);
  return { instruction: { programId: COMPUTE_BUDGET, keys: [], data }, signers: [], bytesCreatedOnChain: 0 };
}

export async function suggestedPriority(umi) {
  try {
    const r = await umi.rpc.call('getRecentPrioritizationFees', [[CORE_PROGRAM]]);
    const fees = r.map(x => x.prioritizationFee).filter(x => x > 0).sort((a, b) => a - b);
    return fees.length ? Math.min(fees[Math.floor(fees.length * 0.75)], 2_000_000) : 0;
  } catch { return 0; }
}

function royaltiesPlugin(bps, creators) {
  const cs = creators.filter(c => c.percentage > 0);
  if (cs.reduce((s, c) => s + c.percentage, 0) !== 100) throw new Error('royalty shares must add up to 100%');
  return { type: 'Royalties', basisPoints: bps, creators: cs.map(c => ({ address: publicKey(c.address), percentage: c.percentage })),
           ruleSet: ruleSet('None') };
}

// ---- building (no network needed except the blockhash in send) ----
export function collectionTx(umi, { name, uri, royaltyBps, creators }) {
  if (uri.length > MAX_URI) throw new Error('the collection link is too long');
  const collection = generateSigner(umi), address = collection.publicKey.toString();
  const builder = createCollection(umi, { collection, name: name.slice(0, MAX_NAME), uri,
                                          plugins: [royaltiesPlugin(royaltyBps, creators)] });
  return { collection: address, txs: [{ ids: { 0: address }, builder }] };
}

// pieces: [{id, name, uri}] -> transactions that each fit, each with the {id: asset address} of the pieces it makes
export function mintTxs(umi, collection, pieces, owner, priority = 0) {
  return pack(umi, pieces.map(p => {
    if (p.uri.length > MAX_URI) throw new Error(`piece ${p.id}: link too long`);
    const asset = generateSigner(umi);
    return { id: p.id, address: asset.publicKey.toString(),
             builder: create(umi, { asset, collection, name: p.name.slice(0, MAX_NAME), uri: p.uri, owner: owner ? publicKey(owner) : undefined }) };
  }), priority);
}

// pieces: [{id, asset: fetched AssetV1, uri}]
export function repointTxs(umi, collection, pieces, priority = 0) {
  return pack(umi, pieces.map(p => ({ id: p.id, address: p.asset.publicKey.toString(),
                                      builder: update(umi, { asset: p.asset, collection, uri: p.uri }) })), priority);
}

export function royaltyTx(umi, collection, bps, creators, priority = 0) {
  return [{ ids: {}, builder: transactionBuilder().add(priorityIx(priority))
    .add(updateCollectionPlugin(umi, { collection: publicKey(collection), plugin: royaltiesPlugin(bps, creators) })) }];
}

export function collectionUriTx(umi, collection, uri, priority = 0) {
  if (uri.length > MAX_URI) throw new Error('the collection link is too long');
  return [{ ids: {}, builder: transactionBuilder().add(priorityIx(priority)).add(updateCollection(umi, { collection: publicKey(collection), uri })) }];
}

// what one piece costs: the rent deposit that keeps its account on Solana (a Core asset is 82 bytes + name + link),
// Metaplex's creation fee, and the network fee for the piece's own signature plus its share of the payer's
export const CORE_CREATE_FEE = 1_500_000;       // lamports (0.0015 SOL), measured on the live program
export async function pieceCost(umi, piece, perTx = 3) {
  const rent = Number((await umi.rpc.getRent(82 + Math.min(piece.name.length, MAX_NAME) + piece.uri.length)).basisPoints);
  return rent + CORE_CREATE_FEE + 5000 + Math.ceil(5000 / perTx);
}

export function lockTx(umi, collection, priority = 0) {
  return [{ ids: {}, builder: transactionBuilder().add(priorityIx(priority))
    .add(addCollectionPlugin(umi, { collection: publicKey(collection), plugin: { type: 'ImmutableMetadata' } })) }];
}

// parts: [{id, address, builder}] -> [{ids: {id: address}, builder}], each builder one transaction (≤ 1232 bytes)
// with the priority fee instruction in front
function pack(umi, parts, priority) {
  const out = []; let cur = null;
  const fresh = () => ({ ids: {}, builder: transactionBuilder().add(priorityIx(priority)) });
  for (const p of parts) {
    cur = cur || fresh();
    const next = cur.builder.add(p.builder);
    if (next.fitsInOneTransaction(umi)) { cur = { ids: { ...cur.ids, [p.id]: p.address }, builder: next }; continue; }
    if (!Object.keys(cur.ids).length) throw new Error(`piece ${p.id} does not fit in a transaction (name or link too long?)`);
    out.push(cur); cur = fresh();
    const one = cur.builder.add(p.builder);
    if (!one.fitsInOneTransaction(umi)) throw new Error(`piece ${p.id} does not fit in a transaction (name or link too long?)`);
    cur = { ids: { [p.id]: p.address }, builder: one };
  }
  if (cur && Object.keys(cur.ids).length) out.push(cur);
  return out;
}

// ---- signing + sending ----
// Builds every transaction with one fresh blockhash, has the wallet approve them all in one prompt, then calls
// onSigned(list of {sig, lastValid, ids}) BEFORE anything is sent, so the page can save them first.
export async function signAll(umi, txs, onSigned) {
  const bh = await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' });
  const built = txs.map(t => ({ transaction: t.builder.setBlockhash(bh).build(umi), signers: t.builder.getSigners(umi) }));
  const signed = await signAllTransactions(built);
  const list = signed.map((t, i) => ({ sig: base58.deserialize(t.signatures[0])[0], lastValid: bh.lastValidBlockHeight, ids: txs[i].ids }));
  if (onSigned) await onSigned(list);
  return { signed, list };
}

// sends each one; a transaction the network rejects up front comes back as {sig: 'failed: why'}
export async function sendAll(umi, signed, list) {
  const res = {};
  for (let i = 0; i < signed.length; i++) {
    try { await umi.rpc.sendTransaction(signed[i], { skipPreflight: false, commitment: 'confirmed' }); }
    catch (e) { res[list[i].sig] = 'failed: ' + String(e.message || e).split('\n')[0].slice(0, 200); }
  }
  return res;
}

// Poll (no websockets): returns {sig: 'ok' | 'failed: …' | 'expired' | 'pending'} once every transaction is settled
// or `timeoutMs` passes. 'expired' means the network can never include it any more: safe to try again.
export async function settle(umi, list, { timeoutMs = 90_000, every = 1500, known = {} } = {}) {
  const out = { ...known }; const t0 = Date.now();
  for (;;) {
    const open = list.filter(x => !out[x.sig] || out[x.sig] === 'pending');
    if (!open.length) return out;
    const st = await umi.rpc.getSignatureStatuses(open.map(x => base58.serialize(x.sig)), { searchTransactionHistory: true });
    const height = await umi.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }]);
    open.forEach((x, i) => {
      const s = st[i];
      if (s && s.error) out[x.sig] = 'failed: ' + JSON.stringify(s.error);
      else if (s && (s.commitment === 'confirmed' || s.commitment === 'finalized')) out[x.sig] = 'ok';
      else if (height > x.lastValid) out[x.sig] = 'expired';
      else out[x.sig] = 'pending';
    });
    if (Date.now() - t0 > timeoutMs) return out;
    await new Promise(r => setTimeout(r, every));
  }
}

export async function getCollection(umi, address) { return fetchCollection(umi, publicKey(address)); }
export async function getAsset(umi, address) { return fetchAsset(umi, publicKey(address)); }
export async function existing(umi, addresses) {
  const accs = await umi.rpc.getAccounts(addresses.map(a => publicKey(a)));
  return addresses.filter((a, i) => accs[i].exists);
}
