// A bounded loopback JSON-RPC model. It never signs, funds or forwards calls.
import {createHash} from 'node:crypto'
import {encodeAbiParameters, encodeEventTopics, getAbiItem, toHex} from 'viem'
import {zchanAbi} from '../src/abi.ts'

export const contract = '0x1111111111111111111111111111111111111111'
const hash = text => '0x' + createHash('sha256').update(text).digest('hex')
const zero = '0x' + '0'.repeat(64)

export function fixture() {
  let head = 0, logs = [], versions = [{from: 0, tag: 0}], sequence = 0, flags = {}, pending = []
  const counts = {}, blocks = new Map()
  const version = n => versions.findLast(v => v.from <= n).tag
  const blockHash = n => hash(`fixture-block:${version(n)}:${n}`)
  function block(n) {
    const b = {number: toHex(n), hash: blockHash(n), parentHash: n ? blockHash(n - 1) : zero,
      timestamp: toHex(1700000000 + version(n) * 100000 + n), nonce: '0x0000000000000000',
      sha3Uncles: zero, logsBloom: '0x' + '00'.repeat(256), transactionsRoot: zero, stateRoot: zero,
      receiptsRoot: zero, miner: contract, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x',
      size: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], uncles: [], baseFeePerGas: '0x1'}
    blocks.set(b.hash, b)
    return b
  }
  function set(next) {
    if (next.fork !== undefined) {
      versions = versions.filter(v => v.from < next.fork)
      versions.push({from: next.fork, tag: ++sequence})
    }
    if (next.head !== undefined) head = next.head
    if (next.logs) logs = next.logs
    if (next.flags) flags = next.flags
    if (next.clearCounts) for (const k of Object.keys(counts)) delete counts[k]
    return {head, counts: {...counts}}
  }
  function event(item, index) {
    const declaration = getAbiItem({abi: zchanAbi, name: item.name})
    const args = Object.fromEntries(declaration.inputs.map(p => [p.name, /^uint/.test(p.type) ? BigInt(item.args[p.name]) : item.args[p.name]]))
    const inputs = declaration.inputs.filter(p => !p.indexed)
    const b = block(item.block)
    const out = {address: contract, blockNumber: b.number, blockHash: b.hash,
      transactionHash: hash(`fixture-tx:${version(item.block)}:${item.block}:${item.tx ?? index}`),
      transactionIndex: '0x0', logIndex: toHex(item.index ?? index), removed: false,
      topics: encodeEventTopics({abi: zchanAbi, eventName: item.name, args}),
      data: encodeAbiParameters(inputs, inputs.map(p => args[p.name]))}
    if (!flags.omitTimes) out.blockTimestamp = b.timestamp
    if (flags.corruptBlock === item.block) out.data = '0x'
    if (flags.wrongHashBlock === item.block) out.blockHash = zero
    if (flags.removedBlock === item.block) out.removed = true
    return out
  }
  async function rpc(req) {
    counts[req.method] = (counts[req.method] ?? 0) + 1
    try {
      let result
      if (req.method === 'eth_blockNumber') result = toHex(head)
      else if (req.method === 'eth_chainId') result = '0x7a69'
      else if (req.method === 'eth_getBlockByNumber') {
        const n = req.params[0] === 'latest' ? head : Number(BigInt(req.params[0]))
        result = n <= head ? block(n) : null
      } else if (req.method === 'eth_getBlockByHash') {
        const b = blocks.get(req.params[0])
        if (b && Number(BigInt(b.number)) === flags.failTimeBlock) throw {code: -32602, message: 'Fixture timestamp read refused'}
        result = b ?? null
      } else if (req.method === 'eth_getLogs') {
        const f = req.params[0], from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock))
        if (flags.failFrom !== undefined && from >= flags.failFrom) throw {code: -32602, message: 'Fixture page read refused'}
        if (flags.unavailable) throw {code: -32603, message: 'Fixture node unavailable'}
        if (flags.maxRange !== undefined && to - from + 1 > flags.maxRange) throw {code: -32005, message: 'Fixture block range limit'}
        result = logs.map(event).filter(l => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to &&
          f.topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : t === l.topics[i])))
        const image = getAbiItem({abi: zchanAbi, name: 'Image'})
        const isImage = f.topics[0] === encodeEventTopics({abi: [image], eventName: 'Image'})[0]
        if (isImage && flags.holdImages) await new Promise(resolve => pending.push(resolve))
        if (!isImage && flags.reorgAfterLogs) {const next = flags.reorgAfterLogs; flags = {}; set(next)}
      } else throw {code: -32601, message: 'Method is outside this read-only fixture'}
      return {jsonrpc: '2.0', id: req.id, result}
    } catch (err) {
      return {jsonrpc: '2.0', id: req.id, error: {code: err.code ?? -32603, message: err.message ?? 'Fixture refused'}}
    }
  }
  return {rpc, set, stats: () => ({head, counts: {...counts}, heldImages: pending.length}),
    release: () => {for (const resolve of pending) resolve(); pending = []}}
}
