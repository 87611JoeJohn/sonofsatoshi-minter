// SonOfSatoshi Minter: the Ethereum / Base engine.
// The page talks to the chain only through the user's own wallet (EIP-1193): no RPC keys, no server in between.
//
// How a collection works here:
//   1. DEPLOY: one ERC-721 contract per collection (contracts/SonOfSatoshiCollection.sol), with its max supply, base link,
//      owner and royalty fixed in the deploy transaction.
//   2. MINT: the owner mints numbered batches (1, 2, 3 …). Each batch names the number it starts at, so the contract itself
//      refuses a batch that was already minted: a retried or replayed transaction can never mint extra pieces.
//   3. RE-POINT: one transaction changes the base link for every piece and tells marketplaces to refresh (ERC-4906).
//   4. FREEZE: one transaction makes the links permanent. Royalty (ERC-2981) can change any time, capped at 30%.
import { createPublicClient, createWalletClient, custom, encodeDeployData, getContractAddress, getAddress, isAddress, formatEther,
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError, mainnet, sepolia, base, baseSepolia, foundry } from './eth.js';

export const NETWORKS = {
  mainnet: { chain: mainnet, name: 'Ethereum', explorer: 'https://etherscan.io', market: 'ethereum', real: true },
  sepolia: { chain: sepolia, name: 'Sepolia (Ethereum practice)', explorer: 'https://sepolia.etherscan.io' },
  base: { chain: base, name: 'Base', explorer: 'https://basescan.org', market: 'base', real: true },
  'base-sepolia': { chain: baseSepolia, name: 'Base Sepolia (practice)', explorer: 'https://sepolia.basescan.org' },
  localhost: { chain: foundry, name: 'Local test chain', explorer: '' },
};
export { getAddress, isAddress, formatEther };

let CONTRACT = null;
export async function contractArtifact() {
  if (!CONTRACT) CONTRACT = await (await fetch('/static/eth-contract.json')).json();
  return CONTRACT;
}

// ---- wallets: EIP-6963 lets every installed wallet announce itself; window.ethereum is the old fallback ----
export function discoverWallets(onChange) {
  const found = new Map();
  const list = () => {
    const l = [...found.values()];
    if (!l.length && window.ethereum) l.push({ name: window.ethereum.isRabby ? 'Rabby' : window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: window.ethereum });
    return l;
  };
  window.addEventListener('eip6963:announceProvider', e => {
    const { info, provider } = e.detail || {};
    if (info?.uuid && provider && !found.has(info.uuid)) { found.set(info.uuid, { name: info.name, icon: info.icon, provider }); onChange(list()); }
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  return list;
}

export async function connect(provider) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw new Error('the wallet did not share an address');
  return getAddress(accounts[0]);
}

// make sure the wallet is on the right network, adding it to the wallet if it doesn't know it yet
export async function ensureChain(provider, net) {
  const c = NETWORKS[net].chain, want = '0x' + c.id.toString(16);
  if ((await provider.request({ method: 'eth_chainId' })).toLowerCase() === want) return;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); }
  catch (e) {
    const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added|4902/i.test(e?.message || '');
    if (!unknown) throw e;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, chainName: c.name, nativeCurrency: c.nativeCurrency,
      rpcUrls: c.rpcUrls.default.http, blockExplorerUrls: c.blockExplorers ? [c.blockExplorers.default.url] : undefined }] });
  }
  if ((await provider.request({ method: 'eth_chainId' })).toLowerCase() !== want) throw new Error('switch your wallet to ' + NETWORKS[net].name);
}

export function clients(provider, net, account) {
  const chain = NETWORKS[net].chain, transport = custom(provider);
  return { pub: createPublicClient({ chain, transport, pollingInterval: 2000 }), wal: createWalletClient({ account, chain, transport }) };
}

// ---- reading ----
export async function state(pub, address) {
  const C = await contractArtifact(), rd = (functionName, args = []) => pub.readContract({ address, abi: C.abi, functionName, args });
  const [maxSupply, totalMinted, owner, baseURI, frozen, roy] = await Promise.all([
    rd('maxSupply'), rd('totalMinted'), rd('owner'), rd('baseURI'), rd('metadataFrozen'), rd('royaltyInfo', [1n, 10000n])]);
  return { maxSupply: Number(maxSupply), totalMinted: Number(totalMinted), owner, baseURI, frozen, royaltyReceiver: roy[0], royaltyBps: Number(roy[1]) };
}
export async function hasCode(pub, address) { const c = await pub.getCode({ address }); return !!c && c !== '0x'; }

// ---- sending: every function returns the transaction hash as soon as the wallet sends it ----
export async function deployData(args) {
  const C = await contractArtifact();
  return encodeDeployData({ abi: C.abi, bytecode: C.bytecode, args });
}
export async function predictDeploy(pub, from) {
  const nonce = await pub.getTransactionCount({ address: from, blockTag: 'pending' });
  return { from, nonce, predicted: getContractAddress({ from, nonce: BigInt(nonce) }) };
}
export async function deploy(wal, { name, symbol, maxSupply, baseURI, owner, royaltyReceiver, royaltyBps }) {
  const C = await contractArtifact();
  return wal.deployContract({ abi: C.abi, bytecode: C.bytecode,
    args: [name, symbol, BigInt(maxSupply), baseURI, owner, royaltyReceiver, BigInt(royaltyBps)] });
}
async function write(wal, address, functionName, args) {
  const C = await contractArtifact();
  return wal.writeContract({ address, abi: C.abi, functionName, args });
}
export const mintBatch = (wal, a, to, count, start) => write(wal, a, 'mintBatch', [to, BigInt(count), BigInt(start)]);
export const setBaseURI = (wal, a, uri) => write(wal, a, 'setBaseURI', [uri]);
export const setRoyalty = (wal, a, to, bps) => write(wal, a, 'setRoyalty', [to, BigInt(bps)]);
export const freeze = (wal, a) => write(wal, a, 'freezeMetadata', []);

export async function receipt(pub, hash, timeout = 600_000) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout });   // follows "speed up" / "cancel" replacements too
  if (r.status !== 'success') throw new Error('the transaction was included but failed (reverted)');
  return r;
}

// ---- cost ----
export async function estimate(pub, account, request) {      // request: {data} for deploy, {to, data} for a call
  const [gas, price] = await Promise.all([pub.estimateGas({ account, ...request }), pub.getGasPrice()]);
  return { gas, price, wei: gas * price };
}
export async function mintEstimate(pub, account, address, to, count, start) {
  const C = await contractArtifact();
  const gas = await pub.estimateContractGas({ account, address, abi: C.abi, functionName: 'mintBatch', args: [to, BigInt(count), BigInt(start)] });
  const price = await pub.getGasPrice();
  return { gas, price, wei: gas * price };
}

// plain words for the errors people actually hit
export function why(e) {
  if (e instanceof BaseError) {
    if (e.walk(x => x instanceof UserRejectedRequestError) || /rejected|denied/i.test(e.shortMessage || '')) return 'you declined it in the wallet';
    const rev = e.walk(x => x instanceof ContractFunctionRevertedError);
    const n = rev?.data?.errorName;
    const map = { WrongStart: 'that batch is already minted (the page will pick up where the chain is)', SoldOut: 'that would pass the max supply',
      MetadataIsFrozen: 'the links are frozen forever', RoyaltyTooHigh: 'royalty can be at most 30%', BadCount: 'nothing to mint',
      OwnableUnauthorizedAccount: 'the connected wallet is not the owner of this contract' };
    if (n) return map[n] || n;
    if (/insufficient funds/i.test(e.message)) return 'not enough ETH in the wallet for this (plus the network fee)';
    return e.shortMessage || e.message;
  }
  return String(e?.message || e);
}
