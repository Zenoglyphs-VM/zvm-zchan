// Checks the deployed board against its rules, spending nothing: every case
// is an eth_call. Cases that need state the board does not have yet (a thread,
// a removed thread, a held name, a balance) get it through a state override
// rather than a transaction.
//
//   node scripts/check.mjs [-rpc url, default $ZVM_RPC] [-record deployments/zvm.json]
import {concat, encodeAbiParameters, keccak256, pad, parseEther, toHex} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {artifact, clients, flag, loadJSON, root} from './lib.mjs'

const rpc = flag('rpc', process.env.ZVM_RPC)
if (!rpc) throw new Error('pass -rpc, or set ZVM_RPC')
const rec = loadJSON(new URL(flag('record', 'deployments/zvm.json'), root))
if (!rec?.zchan) throw new Error('no deployment record')
const {reader} = await clients(rpc)
const address = rec.zchan
const abi = artifact.abi
const stranger = privateKeyToAccount(generatePrivateKey()).address
const other = privateKeyToAccount(generatePrivateKey()).address
const FEE = parseEther('1')

// Storage: slot 0 packs `posts` and `owner`; then janitors, isThread,
// removed, handleOf, holderOf, authorOf, deleted.
const SLOT = {janitors: 1n, isThread: 2n, removed: 3n, handleOf: 4n, holderOf: 5n, authorOf: 6n, deleted: 7n}
const at = (key, keyType, slot) => keccak256(encodeAbiParameters([{type: keyType}, {type: 'uint256'}], [key, slot]))
const on = (slot) => ({slot, value: pad('0x01')})
const thread = (id) => on(at(id, 'uint64', SLOT.isThread))
const removedThread = (id) => on(at(id, 'uint64', SLOT.removed))
const deletedThread = (id) => on(at(id, 'uint64', SLOT.deleted))
const author = (id, who) => ({slot: at(id, 'uint64', SLOT.authorOf), value: pad(who)})
// A short string (under 32 bytes) sits in its slot left-aligned, with twice
// its length in the last byte.
const handle = (who, name) => {
  const b = new TextEncoder().encode(name)
  const word = new Uint8Array(32)
  word.set(b)
  word[31] = b.length * 2
  return {slot: at(who, 'address', SLOT.handleOf), value: toHex(word)}
}
const holds = (who, name) => ({slot: keccak256(concat([keccak256(toHex(name.toLowerCase())), pad(toHex(SLOT.holderOf))])), value: pad(who)})
const state = (...stateDiff) => [{address, stateDiff}]
const rich = (who, ...stateDiff) => [{address, stateDiff}, {address: who, balance: parseEther('10')}]

let failures = 0
function report(ok, what, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
}

async function call(functionName, args, {from = stranger, stateOverride, value} = {}) {
  try {
    const {result} = await reader.simulateContract({address, abi, functionName, args, account: from, stateOverride, value})
    return {result, ok: true}
  } catch (e) {
    const name = e.walk?.((x) => x?.data?.errorName)?.data?.errorName
    return {error: name ?? e.shortMessage ?? String(e)}
  }
}
async function expectError(what, name, functionName, args, opts) {
  const r = await call(functionName, args, opts)
  report(r.error === name, what, r.error ? r.error : `returned ${r.result}`)
}
async function expectOk(what, functionName, args, opts, want) {
  const r = await call(functionName, args, opts)
  report(r.ok && (want === undefined || r.result === want), what, r.error ?? String(r.result))
}

const read = (functionName, args = []) => reader.readContract({address, abi, functionName, args})
const [owner, isJanitor, start, posts, fee] = await Promise.all([
  read('owner'),
  read('janitors', [rec.janitor]),
  read('startBlock'),
  read('posts'),
  read('HANDLE_FEE'),
])
report(owner.toLowerCase() === rec.owner.toLowerCase(), 'owner is the record’s', owner)
report(isJanitor, 'the record’s janitor is a janitor')
report(Number(start) === rec.startBlock, 'startBlock is the deploy block', String(start))
report(fee === FEE, 'a handle costs 1 ZNN')

const img = toHex(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]))
const big = (n) => toHex(new Uint8Array(n).fill(0x41))
const text = (n) => 'x'.repeat(n)
const next = posts + 1n
const SAGE = 1
const NAMED = 2

console.log('-- posting')
await expectOk('a thread at every cap opens as the next id', 'post', [0n, 0, text(100), text(4000), big(65536)], {}, next)
await expectError('a thread without an image', 'ThreadNeedsImage', 'post', [0n, 0, 'subject', 'body', '0x'])
await expectError('a subject over 100 bytes', 'SubjectTooLong', 'post', [0n, 0, text(101), '', img])
await expectError('a comment over 4000 bytes', 'BodyTooLong', 'post', [0n, 0, '', text(4001), img])
await expectError('an image over 64 KiB', 'ImageTooLarge', 'post', [0n, 0, '', '', big(65537)])
await expectError('a comment over 4000 bytes of UTF-8', 'BodyTooLong', 'post', [0n, 0, '', '€'.repeat(1334), img])
const t = 424242n
await expectError('a reply to a thread that does not exist', 'NoSuchThread', 'post', [t, 0, '', 'hi', '0x'])
await expectOk('a sage text reply', 'post', [t, SAGE, '', 'hi', '0x'], {stateOverride: state(thread(t))}, next)
await expectOk('an image-only reply', 'post', [t, 0, '', '', img], {stateOverride: state(thread(t))}, next)
await expectError('an empty reply', 'EmptyReply', 'post', [t, 0, '', '', '0x'], {stateOverride: state(thread(t))})
await expectError('a reply with a subject', 'ReplyHasSubject', 'post', [t, 0, 's', 'hi', '0x'], {stateOverride: state(thread(t))})
await expectError('a reply to a removed thread', 'ThreadRemoved', 'post', [t, 0, '', 'hi', '0x'], {
  stateOverride: state(thread(t), removedThread(t)),
})

await expectError('a reply to a thread its poster deleted', 'ThreadRemoved', 'post', [t, 0, '', 'hi', '0x'], {
  stateOverride: state(thread(t), deletedThread(t)),
})

console.log('-- deleting')
await expectError('deleting a post that does not exist', 'NotYourPost', 'deletePost', [posts + 7n])
await expectOk('a poster deletes their own post', 'deletePost', [7n], {stateOverride: state(author(7n, stranger))})
await expectError('but not someone else’s', 'NotYourPost', 'deletePost', [7n], {stateOverride: state(author(7n, other))})
await expectError('nor can a janitor delete for them', 'NotYourPost', 'deletePost', [7n], {from: rec.janitor, stateOverride: state(author(7n, other))})

console.log('-- handles')
await expectOk('registering a free name for 1 ZNN', 'register', ['Anon_42'], {value: FEE, stateOverride: rich(stranger)})
await expectError('registering for less', 'WrongFee', 'register', ['Anon_42'], {value: FEE - 1n, stateOverride: rich(stranger)})
await expectError('registering for nothing', 'WrongFee', 'register', ['Anon_42'])
for (const bad of ['a', 'x'.repeat(17), 'no spaces', 'émile', 'a-b', '']) {
  await expectError(`refusing ${JSON.stringify(bad)}`, 'BadHandle', 'register', [bad], {value: FEE, stateOverride: rich(stranger)})
}
await expectError('a name another wallet holds, in any case', 'HandleTaken', 'register', ['ANON_42'], {
  value: FEE,
  stateOverride: rich(stranger, holds(other, 'anon_42')),
})
await expectOk('choosing a name you hold again, for nothing', 'register', ['anon_42'], {stateOverride: state(holds(stranger, 'anon_42'))})
await expectError('but not for a fee', 'WrongFee', 'register', ['anon_42'], {value: FEE, stateOverride: rich(stranger, holds(stranger, 'anon_42'))})
await expectOk('holder() finds a held name without case', 'holder', ['aNoN_42'], {stateOverride: state(holds(other, 'anon_42'))}, other)
await expectOk('holder() is zero for a free name', 'holder', ['nobody_here'], {}, '0x0000000000000000000000000000000000000000')
await expectError('a named post without a handle', 'NoHandle', 'post', [0n, NAMED, '', 'hi', img])
await expectOk('a named post with one', 'post', [0n, NAMED, '', 'hi', img], {stateOverride: state(handle(stranger, 'Anon_42'))}, next)
await expectOk('an anonymous post from a wallet with one', 'post', [0n, 0, '', 'hi', img], {stateOverride: state(handle(stranger, 'Anon_42'))}, next)

console.log('-- owner and janitors')
await expectError('remove from a stranger', 'NotJanitor', 'remove', [1n, true])
await expectError('setJanitor from a stranger', 'NotOwner', 'setJanitor', [stranger, true])
await expectError('setJanitor from a janitor', 'NotOwner', 'setJanitor', [stranger, true], {from: rec.janitor})
await expectError('setOwner from a stranger', 'NotOwner', 'setOwner', [stranger])
await expectError('withdraw from a stranger', 'NotOwner', 'withdraw', [stranger, 0n])
await expectOk('the owner appoints a second janitor', 'setJanitor', [stranger, true], {from: owner})
await expectOk('the owner withdraws', 'withdraw', [owner, 0n], {from: owner})
await expectError('remove of post 0', 'NoSuchPost', 'remove', [0n, true], {from: rec.janitor})
await expectError('remove past the last post', 'NoSuchPost', 'remove', [posts + 1n, true], {from: rec.janitor})
await expectOk('a second janitor can remove', 'remove', [posts || 1n, true], {
  from: stranger,
  stateOverride: [{address, stateDiff: [on(at(stranger, 'address', SLOT.janitors)), {slot: pad('0x00'), value: pad(toHex(posts || 1n))}]}],
})

if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log(`ok: ${address} keeps every rule (${posts} posts so far)`)
