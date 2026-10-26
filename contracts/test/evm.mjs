// Current Solidity, fresh compilation and synthetic in-memory Paris frames.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createBlock} from '@ethereumjs/block'
import {createCustomCommon, Hardfork, Mainnet} from '@ethereumjs/common'
import {createAccount, createAddressFromString, bytesToHex, hexToBytes} from '@ethereumjs/util'
import {createVM} from '@ethereumjs/vm'
import {decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeDeployData, encodeFunctionData, getAddress} from 'viem'
import solc from 'solc'

export const ZERO = '0x0000000000000000000000000000000000000000'
export const FEE = 10n ** 18n
assert.match(solc.version(), /^0\.8\.19\+commit\.7dd6d404\./, 'the locked Solidity compiler is required')
export const input = {
  language: 'Solidity',
  sources: {'ZChan.sol': {content: readFileSync(new URL('../ZChan.sol', import.meta.url), 'utf8')}},
  settings: {evmVersion: 'paris', libraries: {}, metadata: {bytecodeHash: 'ipfs'},
    optimizer: {enabled: true, runs: 200}, remappings: [],
    outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata']}},
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
assert.deepEqual((output.errors ?? []).filter((e) => e.severity === 'error'), [], 'current production source must compile')
const compiled = output.contracts['ZChan.sol'].ZChan
assert.ok(compiled.evm.deployedBytecode.object.length / 2 <= 24_576, 'ZChan must fit EIP-170')
export const artifact = {contractName: 'ZChan', sourceName: 'ZChan.sol', compiler: solc.version(),
  compilerVersion: 'v0.8.19+commit.7dd6d404', abi: compiled.abi, bytecode: '0x' + compiled.evm.bytecode.object,
  deployedBytecode: '0x' + compiled.evm.deployedBytecode.object, standardJsonInput: input}
const fixtureInput = {language: 'Solidity', sources: {'Fixtures.sol': {content: readFileSync(new URL('./Fixtures.sol', import.meta.url), 'utf8')}},
  settings: {evmVersion: 'paris', optimizer: {enabled: true, runs: 200}, outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object']}}}}
const fixtureOutput = JSON.parse(solc.compile(JSON.stringify(fixtureInput)))
assert.deepEqual((fixtureOutput.errors ?? []).filter((e) => e.severity === 'error'), [])
export const fixtureArtifacts = Object.fromEntries(Object.entries(fixtureOutput.contracts['Fixtures.sol']).map(([name, c]) =>
  [name, {abi: c.abi, bytecode: '0x' + c.evm.bytecode.object}]))

export async function fixture({initialOwner, initialJanitor} = {}) {
  const common = createCustomCommon({chainId: 7340469}, Mainnet, {hardfork: Hardfork.Paris})
  const vm = await createVM({common})
  const actors = Array.from({length: 8}, (_, n) => '0x' + (0x10000n + BigInt(n)).toString(16).padStart(40, '0'))
  const [deployer, owner, janitor, alice, bob, carol, heir, recipient] = actors
  const address = (at) => createAddressFromString(at), initial = 10n ** 30n
  for (const actor of actors) await vm.stateManager.putAccount(address(actor), createAccount({balance: initial}))
  const abis = new Map(), deployments = []
  let blockNumber = 100n
  const root = async () => bytesToHex(await vm.stateManager.getStateRoot())
  const balance = async (at) => (await vm.stateManager.getAccount(address(at)))?.balance ?? 0n
  function mine() { blockNumber++ }
  async function frame({from = owner, to, data = '0x', value = 0n, gas = 50_000_000n, isStatic = false, error}) {
    vm.stateManager.originalStorageCache.clear(); vm.evm.journal.cleanJournal()
    const before = to ? await root() : undefined
    const block = createBlock({header: {number: blockNumber, timestamp: 1_900_000_000n + blockNumber, gasLimit: 60_000_000n}}, {common})
    // These frames include value transfer and failure checkpoints. They omit
    // signing, inclusion, intrinsic gas, transaction fee charging and ZVM.
    const result = await vm.evm.runCall({caller: address(from), ...(to ? {to: address(to)} : {}), data: hexToBytes(data),
      value, gasLimit: gas, isStatic, block, skipNonceIncrement: Boolean(to)})
    const returned = bytesToHex(result.execResult.returnValue), failed = Boolean(result.execResult.exceptionError)
    if (error !== undefined) {
      assert.ok(failed, 'expected EVM failure')
      if (typeof error === 'string') {
        const decoded = decodeErrorResult({abi: artifact.abi, data: returned})
        assert.equal(decoded.errorName, error)
      }
      if (to) assert.equal(await root(), before, 'failed frames restore the complete state root and balances')
      assert.equal(result.execResult.logs?.length ?? 0, 0, 'failed frames retain no logs')
    } else assert.equal(result.execResult.exceptionError, undefined, `EVM frame failed: ${returned}`)
    return {...result, returned, failed}
  }
  async function deploy(code, args = []) {
    const result = await frame({from: deployer, data: encodeDeployData({abi: code.abi, bytecode: code.bytecode, args})})
    const at = getAddress(result.createdAddress.toString())
    assert.ok((await vm.stateManager.getCode(address(at))).length > 0)
    abis.set(at.toLowerCase(), code.abi); deployments.push({address: at, result}); return at
  }
  async function write(from, to, functionName, args = [], value = 0n, options = {}) {
    const abi = abis.get(to.toLowerCase()); assert.ok(abi, 'an explicit freshly compiled ABI is required')
    return frame({from, to, data: encodeFunctionData({abi, functionName, args}), value, ...options})
  }
  async function read(to, functionName, args = []) {
    const abi = abis.get(to.toLowerCase())
    const result = await frame({to, data: encodeFunctionData({abi, functionName, args}), isStatic: true})
    return decodeFunctionResult({abi, functionName, data: result.returned})
  }
  function events(result) {
    return (result.execResult.logs ?? []).map(([at, topics, data]) => {
      const location = bytesToHex(at)
      return {address: location, ...decodeEventLog({abi: abis.get(location.toLowerCase()), topics: topics.map(bytesToHex), data: bytesToHex(data)})}
    })
  }
  const board = await deploy(artifact, [initialOwner ?? owner, initialJanitor ?? janitor])
  const deploymentResult = deployments[0].result
  async function post({from = alice, thread = 0n, flags = 0, subject = '', body = '', image = '0x01', ...options} = {}) {
    const result = await write(from, board, 'post', [thread, flags, subject, body, image], 0n, options)
    return {...result, id: result.failed ? undefined : decodeFunctionResult({abi: artifact.abi, functionName: 'post', data: result.returned})}
  }
  async function conserved() {
    const inventory = new Set([...actors, ZERO, ...abis.keys()].map((at) => at.toLowerCase()))
    let total = 0n
    for (const at of inventory) total += await balance(at)
    assert.equal(total, BigInt(actors.length) * initial, 'the complete known synthetic native-value inventory is conserved')
  }
  return {vm, actors, deployer, owner, janitor, alice, bob, carol, heir, recipient, board, deploymentResult,
    root, balance, mine, frame, deploy, write, read, events, post, conserved, get blockNumber() { return blockNumber }}
}
