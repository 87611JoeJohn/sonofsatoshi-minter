// Compiles contracts/SonOfSatoshiCollection.sol with the pinned solc + OpenZeppelin into eth-contract.json
// (ABI + creation bytecode + the exact compiler settings, so anyone can verify it on Etherscan/Basescan).
const fs = require('fs'), path = require('path'), solc = require('solc');
const SRC = 'contracts/SonOfSatoshiCollection.sol', ROOT = path.resolve(__dirname, '../..');
const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } };
const input = { language: 'Solidity', sources: { [SRC]: { content: fs.readFileSync(path.join(ROOT, SRC), 'utf8') } }, settings };
const used = {};
const find = p => {
  const f = path.join(__dirname, 'node_modules', p);
  if (!fs.existsSync(f)) return { error: 'not found: ' + p };
  return { contents: (used[p] = fs.readFileSync(f, 'utf8')) };
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: find }));
const errs = (out.errors || []).filter(e => e.severity === 'error');
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errs.length) process.exit(1);
const c = out.contracts[SRC].SonOfSatoshiCollection;
fs.writeFileSync(path.join(__dirname, 'eth-contract.json'), JSON.stringify({
  contract: 'SonOfSatoshiCollection', source: SRC, compiler: 'v' + solc.version(), openzeppelin: '5.6.1',
  settings: { optimizer: settings.optimizer, evmVersion: settings.evmVersion },
  abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1) + '\n');
// the exact input for Etherscan/Basescan "Standard JSON input" verification (every source file, same settings)
const verify = { language: 'Solidity', settings: { optimizer: settings.optimizer, evmVersion: settings.evmVersion,
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }, sources: { [SRC]: input.sources[SRC] } };
for (const k of Object.keys(used).sort()) verify.sources[k] = { content: used[k] };
fs.writeFileSync(path.join(__dirname, 'eth-verify.json'), JSON.stringify(verify, null, 1) + '\n');
console.log('compiled: ' + (c.evm.bytecode.object.length / 2) + ' bytes of creation code');
