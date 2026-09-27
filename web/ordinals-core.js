// SonOfSatoshi Minter: the Bitcoin Ordinals engine.
// Pure functions, no network access: the page asks the local server to read the chain and broadcast.
//
// How an inscription batch works:
//   1. A temporary key is made for this batch and saved locally (so funds can ALWAYS be recovered).
//   2. You send the exact total to the batch's FUNDING address (a normal taproot address of that key).
//   3. COMMIT: one transaction splits the funding into one output per piece, each locked to that piece's
//      inscription script.
//   4. REVEAL: one transaction per piece spends its output, which writes the art (+ metadata) into the witness
//      and sends the inscribed sat to YOUR ordinals address.
//   Recover: the funding address can always be swept back to your refund address with the same key.
import { btc, ordinals, hex } from './btc.js';

export const NETWORKS = {
  mainnet: btc.NETWORK,
  testnet4: btc.TEST_NETWORK,
  signet: btc.TEST_NETWORK,
  regtest: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
};
export const DUST = 546n;                       // smallest output wallets and nodes accept everywhere
export const MAX_BODY = 360_000;                // keeps each reveal well under the 400k-weight standard limit
const customScripts = [ordinals.OutOrdinalReveal];
const net = n => { const x = NETWORKS[n]; if (!x) throw new Error('unknown network ' + n); return x; };
const big = v => BigInt(v);
const ceilFee = (vsize, rate) => BigInt(Math.ceil(vsize * Number(rate)));

export function newKey() {
  const k = new Uint8Array(32);
  for (;;) { crypto.getRandomValues(k); try { btc.utils.pubSchnorr(k); return hex.encode(k); } catch { /* out of range: retry */ } }
}
const pub = privHex => btc.utils.pubSchnorr(hex.decode(privHex));

/** Check an address is valid for the network; returns its type ('tr', 'wpkh', ...). */
export function addressType(address, network) {
  try { return btc.Address(net(network)).decode(address).type; } catch { return null; }
}

function inscription(piece) {
  if (!(piece.body instanceof Uint8Array)) throw new Error('piece body must be bytes');
  if (piece.body.length > MAX_BODY) throw new Error(`piece ${piece.id} is ${piece.body.length} bytes; the limit is ${MAX_BODY}. Compress it.`);
  const tags = { contentType: piece.contentType };
  if (piece.metadata && Object.keys(piece.metadata).length) tags.metadata = piece.metadata;
  return { tags, body: piece.body };
}

/** The per-piece reveal script address (where the commit sends this piece's funds). */
export function revealPayment(privHex, piece, network) {
  return btc.p2tr(undefined, ordinals.p2tr_ord_reveal(pub(privHex), [inscription(piece)]), net(network), false, customScripts);
}

/** The batch's funding address: a plain taproot key-path address of the temporary key. */
export function fundingPayment(privHex, network) {
  return btc.p2tr(pub(privHex), undefined, net(network));
}

function buildRevealTx(privHex, piece, network, commitTxid, vout, amount, recipient, postage) {
  const pay = revealPayment(privHex, piece, network);
  const tx = new btc.Transaction({ customScripts });
  tx.addInput({ ...pay, txid: commitTxid, index: vout, witnessUtxo: { script: pay.script, amount } });
  tx.addOutputAddress(recipient, postage, net(network));
  tx.sign(hex.decode(privHex));             // random aux data (BIP340)
  tx.finalize();
  return tx;
}

/** Exact reveal fee for one piece: build it with a placeholder input, measure, price it. */
export function revealFee(privHex, piece, network, feeRate, recipient, postage = DUST) {
  const dummy = buildRevealTx(privHex, piece, network, '00'.repeat(32), 0, 10_000_000n, recipient, postage);
  return ceilFee(dummy.vsize, feeRate);
}

/**
 * Plan a batch. pieces: [{id, contentType, body: Uint8Array, metadata}].
 * Returns amounts in sats (as strings, safe for JSON) and the funding address + exact total to send.
 */
export function planBatch({ privHex, pieces, network, feeRate, recipient, refund, postage = DUST }) {
  if (!addressType(recipient, network)) throw new Error('your ordinals address is not valid for ' + network);
  if (!addressType(refund, network)) throw new Error('your refund address is not valid for ' + network);
  if (!pieces.length) throw new Error('no pieces in this batch');
  postage = big(postage); if (postage < DUST) throw new Error('postage must be at least 546 sats');
  const items = pieces.map(p => {
    const fee = revealFee(privHex, p, network, feeRate, recipient, postage);
    return { id: p.id, revealAddress: revealPayment(privHex, p, network).address, revealFee: String(fee), amount: String(fee + postage), bytes: p.body.length };
  });
  // commit: 1 funding input (taproot key path) -> N reveal outputs + change; +1 input of headroom for split payments
  const commitFee = estimateCommitFee(items.length, feeRate, 2);
  const need = items.reduce((s, i) => s + big(i.amount), 0n) + commitFee;
  return { network, feeRate: Number(feeRate), postage: String(postage), recipient, refund,
    fundingAddress: fundingPayment(privHex, network).address, commitFeeEstimate: String(commitFee), total: String(need), items };
}

function estimateCommitFee(nOut, feeRate, nIn = 1) {
  // taproot key-path input ~57.5 vB, taproot output 43 vB, tx overhead ~10.5 vB, +1 change output
  return ceilFee(10.5 + 57.5 * nIn + 43 * (nOut + 1), feeRate);
}

/** Commit tx: spend the funding UTXOs into one output per piece (+ change back to the refund address). */
export function buildCommit({ privHex, plan, utxos }) {
  const network = plan.network, fund = fundingPayment(privHex, network);
  const tx = new btc.Transaction();
  let inTotal = 0n;
  for (const u of utxos) {
    tx.addInput({ ...fund, txid: u.txid, index: u.vout, witnessUtxo: { script: fund.script, amount: big(u.value) } });
    inTotal += big(u.value);
  }
  const outs = plan.items.map(i => big(i.amount));
  plan.items.forEach(i => tx.addOutputAddress(i.revealAddress, big(i.amount), net(network)));
  const outTotal = outs.reduce((a, b) => a + b, 0n);
  // price the real tx: first without change, then decide if change is worth an output
  const feeNoChange = ceilFee(signedSize(privHex, tx.clone()), plan.feeRate);
  if (inTotal < outTotal + feeNoChange) throw new Error(`the funding address holds ${inTotal} sats but ${outTotal + feeNoChange} are needed`);
  const leftover = inTotal - outTotal - feeNoChange;
  let change = 0n, feeChange = feeNoChange;
  if (leftover >= DUST * 2n) {                          // only worth a change output if something real comes back
    const withChange = tx.clone(); withChange.addOutputAddress(plan.refund, DUST, net(network));   // probe with a spendable amount
    feeChange = ceilFee(signedSize(privHex, withChange), plan.feeRate);
    change = inTotal - outTotal - feeChange;
  }
  if (change >= DUST) tx.addOutputAddress(plan.refund, change, net(network));   // otherwise the small rest becomes fee
  tx.sign(hex.decode(privHex)); tx.finalize();
  return { hex: hex.encode(tx.extract()), txid: tx.id, fee: String(change >= DUST ? feeChange : feeNoChange + leftover),
    vouts: plan.items.map((i, n) => ({ id: i.id, vout: n, amount: i.amount })) };
}

function signedSize(privHex, tx) { tx.sign(hex.decode(privHex)); tx.finalize(); return tx.vsize; }

/** Reveal tx for one piece. Returns the inscription id (<reveal txid>i0). */
export function buildReveal({ privHex, plan, piece, commitTxid, vout }) {
  const item = plan.items.find(i => i.id === piece.id);
  if (!item) throw new Error('piece not in this batch');
  if (revealPayment(privHex, piece, plan.network).address !== item.revealAddress)
    throw new Error(`piece ${piece.id} changed since the batch was planned; it can't be revealed with different content`);
  const tx = buildRevealTx(privHex, piece, plan.network, commitTxid, vout, big(item.amount), plan.recipient, big(plan.postage));
  const fee = big(item.amount) - big(plan.postage);
  if (ceilFee(tx.vsize, 1) > fee) throw new Error('reveal fee below 1 sat/vB');
  return { hex: hex.encode(tx.extract()), txid: tx.id, inscriptionId: tx.id + 'i0' };
}

/** Recovery: send everything on the funding address back to the refund address. */
export function buildSweep({ privHex, network, utxos, to, feeRate }) {
  const fund = fundingPayment(privHex, network);
  const tx = new btc.Transaction();
  let total = 0n;
  for (const u of utxos) { tx.addInput({ ...fund, txid: u.txid, index: u.vout, witnessUtxo: { script: fund.script, amount: big(u.value) } }); total += big(u.value); }
  const probe = tx.clone(); probe.addOutputAddress(to, 1000n, net(network));
  const fee = ceilFee(signedSize(privHex, probe), feeRate);
  if (total - fee < DUST) throw new Error('too little on the funding address to cover the fee');
  tx.addOutputAddress(to, total - fee, net(network));
  tx.sign(hex.decode(privHex)); tx.finalize();
  return { hex: hex.encode(tx.extract()), txid: tx.id, amount: String(total - fee) };
}

/** Read back an inscription from a reveal tx (used to double-check before broadcasting). */
export function parseReveal(txHex) {
  const tx = btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true });
  return ordinals.parseWitness(tx.getInput(0).finalScriptWitness);
}
