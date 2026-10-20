// Builds ZChan.sol into ../out/ZChan.json, which the deploy script sends, and
// writes the ABI into the page as ../../web/src/abi.ts, typed `as const` so
// viem checks every call and event the page makes against the contract that
// was compiled. The artifact carries the standard JSON input that produced it,
// so the node's verifier is handed exactly what was compiled.
//
// solc 0.8.19 targeting paris is what Bullet Game's and Rain's contracts run
// on the ZVM, so it is the combination known to execute there unchanged.
import {createRequire} from 'node:module'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'

const require = createRequire(import.meta.url)
const solc = require('solc')

const unit = 'ZChan.sol'
const input = {
  language: 'Solidity',
  sources: {[unit]: {content: readFileSync(new URL('../ZChan.sol', import.meta.url), 'utf8')}},
  settings: {
    evmVersion: 'paris',
    libraries: {},
    metadata: {bytecodeHash: 'ipfs'},
    optimizer: {enabled: true, runs: 200},
    remappings: [],
    outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata']}},
  },
}
const out = JSON.parse(solc.compile(JSON.stringify(input)))
for (const e of out.errors ?? []) console.error(e.formattedMessage)
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1)
const c = out.contracts[unit].ZChan

const dir = new URL('../out/', import.meta.url)
mkdirSync(dir, {recursive: true})
const artifact = {
  contractName: 'ZChan',
  sourceName: unit,
  compiler: solc.version(),
  compilerVersion: 'v0.8.19+commit.7dd6d404',
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
  deployedBytecode: '0x' + c.evm.deployedBytecode.object,
  standardJsonInput: input,
}
writeFileSync(new URL('ZChan.json', dir), JSON.stringify(artifact, null, 1) + '\n')
writeFileSync(
  new URL('../../web/src/abi.ts', import.meta.url),
  '// Written by contracts/scripts/build.mjs from ZChan.sol. Do not edit.\n' +
    `export const zchanAbi = ${JSON.stringify(c.abi, null, 2)} as const\n`,
)
console.log(`ZChan: ${c.evm.bytecode.object.length / 2} bytes creation code`)
