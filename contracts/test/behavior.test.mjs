import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {keccak256} from 'viem'
import {artifact, FEE, fixture, fixtureArtifacts, ZERO} from './evm.mjs'

const image = '0xffd8ff010203'
const SAGE = 1, NAMED = 2
const first = (f, result, name) => f.events(result).find((e) => e.eventName === name).args
const key = (name) => keccak256(new TextEncoder().encode(name.toLowerCase()))
function poster(sender, thread, named) {
  // Independent ABI words: address, uint64 and bool, each padded to 32 bytes.
  const words = sender.slice(2).toLowerCase().padStart(64, '0') + thread.toString(16).padStart(64, '0') + (named ? '1' : '0').padStart(64, '0')
  return keccak256('0x' + words).slice(0, 18)
}
function random(seed) {
  let state = seed >>> 0
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
}

function replayState() {
  return {posts: new Map(), images: new Map(), removed: new Set(), deleted: new Set(), janitors: new Set(),
    owner: null, handles: new Map(), holders: new Map(), fees: 0n}
}
function replay(state, events) {
  for (const {eventName: name, args: a} of events) {
    if (name === 'Posted') {
      assert.ok(!state.posts.has(a.id), 'a new receipt must not reuse a post id')
      state.posts.set(a.id, {...a})
    } else if (name === 'Image') {
      assert.ok(state.posts.has(a.id))
      assert.equal((a.data.length - 2) / 2, state.posts.get(a.id).imageBytes)
      state.images.set(a.id, a.data)
    } else if (name === 'Removed') {
      if (a.removed) state.removed.add(a.id); else state.removed.delete(a.id)
    } else if (name === 'Deleted') state.deleted.add(a.id)
    else if (name === 'OwnerChanged') state.owner = a.owner
    else if (name === 'JanitorSet') {
      if (a.active) state.janitors.add(a.janitor); else state.janitors.delete(a.janitor)
    } else if (name === 'HandleChosen') {
      state.handles.set(a.holder, a.name)
      if (a.registered) { assert.ok(!state.holders.has(a.name.toLowerCase())); state.fees += FEE }
      else assert.equal(state.holders.get(a.name.toLowerCase()), a.holder)
      state.holders.set(a.name.toLowerCase(), a.holder)
    } else if (name === 'Withdrawn') state.fees -= a.amount
    else assert.fail('unexpected board event ' + name)
  }
}
const visible = (state, id) => {
  const p = state.posts.get(id)
  return !state.removed.has(id) && !state.deleted.has(id) && !state.removed.has(p.thread) && !state.deleted.has(p.thread)
}

test('fresh source, full creation/runtime artifact, compiler input and frontend ABI agree', () => {
  assert.deepEqual(artifact, JSON.parse(readFileSync(new URL('../out/ZChan.json', import.meta.url), 'utf8')))
  const abi = '// Written by contracts/scripts/build.mjs from ZChan.sol. Do not edit.\n' +
    `export const zchanAbi = ${JSON.stringify(artifact.abi, null, 2)} as const\n`
  assert.equal(readFileSync(new URL('../../web/src/abi.ts', import.meta.url), 'utf8'), abi)
})

test('construction records the actual block, owner and optional janitor without storing posts', async () => {
  const f = await fixture()
  assert.equal(await f.read(f.board, 'startBlock'), 100n)
  assert.equal(await f.read(f.board, 'owner'), f.owner)
  assert.equal(await f.read(f.board, 'janitors', [f.janitor]), true)
  assert.equal(await f.read(f.board, 'janitors', [f.owner]), false)
  assert.equal(await f.read(f.board, 'posts'), 0n)
  assert.equal(await f.read(f.board, 'HANDLE_FEE'), FEE)
  assert.deepEqual(f.events(f.deploymentResult).map((e) => e.eventName), ['OwnerChanged', 'JanitorSet'])
  f.mine()
  assert.equal(await f.read(f.board, 'startBlock'), 100n)
  const empty = await fixture({initialOwner: ZERO, initialJanitor: ZERO})
  assert.equal(await empty.read(empty.board, 'owner'), ZERO)
  assert.equal(await empty.read(empty.board, 'janitors', [ZERO]), false)
  assert.deepEqual(empty.events(empty.deploymentResult).map((e) => e.eventName), ['OwnerChanged'])
})

test('an actual thread returns its id and emits separate exact text and image records', async () => {
  const f = await fixture(), result = await f.post({subject: 'Fixture subject', body: 'Fixture body', image, flags: SAGE})
  assert.equal(result.id, 1n)
  assert.equal(await f.read(f.board, 'posts'), 1n)
  assert.equal(await f.read(f.board, 'isThread', [1n]), true)
  assert.deepEqual(f.events(result).map((e) => e.eventName), ['Posted', 'Image'])
  assert.deepEqual(first(f, result, 'Posted'), {id: 1n, thread: 1n, poster: poster(f.alice, 1n, false), sage: false,
    imageBytes: 6, name: '', subject: 'Fixture subject', body: 'Fixture body'})
  assert.deepEqual(first(f, result, 'Image'), {id: 1n, data: image})
})

test('text, image-only and sage replies reference the actual existing thread', async () => {
  const f = await fixture(); await f.post({image})
  const text = await f.post({from: f.bob, thread: 1n, body: 'Reply', image: '0x', flags: SAGE})
  assert.equal(text.id, 2n)
  assert.deepEqual(f.events(text).map((e) => e.eventName), ['Posted'])
  assert.deepEqual(first(f, text, 'Posted'), {id: 2n, thread: 1n, poster: poster(f.bob, 1n, false), sage: true,
    imageBytes: 0, name: '', subject: '', body: 'Reply'})
  const img = await f.post({thread: 1n, image})
  assert.equal(img.id, 3n)
  assert.equal(await f.read(f.board, 'isThread', [2n]), false)
  assert.equal(first(f, img, 'Posted').imageBytes, 6)
})

test('posting rules fail with exact errors and preserve all earlier state', async () => {
  const f = await fixture(); await f.post({image})
  for (const [options, error] of [
    [{image: '0x'}, 'ThreadNeedsImage'], [{thread: 9n, body: 'Reply', image: '0x'}, 'NoSuchThread'],
    [{thread: 1n, body: '', image: '0x'}, 'EmptyReply'], [{thread: 1n, subject: 'Reply subject', body: 'Reply'}, 'ReplyHasSubject'],
  ]) await f.post({...options, error})
  await f.post({thread: 1n, body: 'Valid reply', image: '0x'})
  await f.post({thread: 2n, body: 'A reply is not a thread', image: '0x', error: 'NoSuchThread'})
  assert.equal(await f.read(f.board, 'posts'), 2n)
})

test('byte limits accept exact subject/body/image caps and reject ASCII and UTF-8 overflow', async () => {
  const f = await fixture()
  await f.post({subject: 'x'.repeat(100), body: 'x'.repeat(4000), image: '0x' + '41'.repeat(65_536)})
  for (const [options, error] of [
    [{subject: 'x'.repeat(101)}, 'SubjectTooLong'], [{body: 'x'.repeat(4001)}, 'BodyTooLong'],
    [{image: '0x' + '41'.repeat(65_537)}, 'ImageTooLarge'],
    [{subject: String.fromCodePoint(0x20ac).repeat(34)}, 'SubjectTooLong'],
    [{body: String.fromCodePoint(0x20ac).repeat(1334)}, 'BodyTooLong'],
  ]) await f.post({...options, error})
  const exactSubject = String.fromCodePoint(0x20ac).repeat(33) + 'x'
  const exactBody = String.fromCodePoint(0x20ac).repeat(1333) + 'x'
  await f.post({subject: exactSubject, body: exactBody})
  assert.equal(await f.read(f.board, 'posts'), 2n)
})

test('a late NoHandle failure restores counter, new-thread marker and private authorship', async () => {
  const f = await fixture()
  await f.post({flags: NAMED, image, error: 'NoHandle'})
  assert.equal(await f.read(f.board, 'posts'), 0n)
  assert.equal(await f.read(f.board, 'isThread', [1n]), false)
  await f.write(f.alice, f.board, 'deletePost', [1n], 0n, {error: 'NotYourPost'})
  assert.equal((await f.post({image})).id, 1n)
})

test('poster IDs are stable within a thread and distinct by sender, thread and named mode', async () => {
  const f = await fixture()
  await f.write(f.alice, f.board, 'register', ['Fixture_A'], FEE)
  const op = await f.post({image}), reply = await f.post({thread: 1n, body: 'Reply', image: '0x'})
  const other = await f.post({from: f.bob, thread: 1n, body: 'Other', image: '0x'})
  const named = await f.post({thread: 1n, body: 'Named', image: '0x', flags: NAMED})
  const next = await f.post({image})
  assert.equal(first(f, op, 'Posted').poster, first(f, reply, 'Posted').poster)
  for (const result of [other, named, next]) assert.notEqual(first(f, op, 'Posted').poster, first(f, result, 'Posted').poster)
  assert.equal(first(f, named, 'Posted').poster, poster(f.alice, 1n, true))
  assert.equal(first(f, named, 'Posted').name, 'Fixture_A')
  assert.equal(first(f, reply, 'Posted').name, '')
  await f.write(f.alice, f.board, 'register', ['Fixture_B'], FEE)
  const renamed = await f.post({thread: 1n, body: 'New chosen handle', image: '0x', flags: NAMED})
  assert.equal(first(f, renamed, 'Posted').poster, first(f, named, 'Posted').poster)
  assert.equal(first(f, renamed, 'Posted').name, 'Fixture_B')
})

test('handle validation and lowercase hashing agree with an independent ASCII model', async (t) => {
  const f = await fixture(), valid = (name) => /^[A-Za-z0-9_]{2,16}$/.test(name)
  const boundary = ['', 'a', 'ab', 'A_2', '_0', 'x'.repeat(16), 'x'.repeat(17), 'a-b', 'a b',
    String.fromCodePoint(0xe9) + 'mile', String.fromCodePoint(0x430) + 'bc']
  const check = async (name) => {
    if (valid(name)) assert.equal(await f.read(f.board, 'handleKey', [name]), key(name))
    else await f.write(f.alice, f.board, 'handleKey', [name], 0n, {isStatic: true, error: 'BadHandle'})
  }
  for (const name of boundary) await check(name)
  for (const seed of [3, 17, 0x12345678, 0x9e3779b9]) await t.test('seed ' + seed, async () => {
    const next = random(seed), alphabet = 'AbCxyZ019_- .'
    for (let i = 0; i < 64; i++) await check(Array.from({length: next() % 20}, () => alphabet[next() % alphabet.length]).join(''))
  })
})

test('fresh handles require the exact fee and ownership cannot be taken over by case or payment', async () => {
  const f = await fixture(), before = await f.balance(f.alice)
  for (const amount of [0n, FEE - 1n, FEE + 1n]) await f.write(f.alice, f.board, 'register', ['Fixture_A'], amount, {error: 'WrongFee'})
  for (const name of ['a', 'a-b', 'a b']) await f.write(f.alice, f.board, 'register', [name], FEE, {error: 'BadHandle'})
  const result = await f.write(f.alice, f.board, 'register', ['Fixture_A'], FEE)
  assert.deepEqual(first(f, result, 'HandleChosen'), {holder: f.alice, name: 'Fixture_A', registered: true})
  assert.equal(await f.read(f.board, 'holder', ['fIXTURE_a']), f.alice)
  assert.equal(await f.read(f.board, 'holderOf', [key('fixture_a')]), f.alice)
  assert.equal(await f.read(f.board, 'handleOf', [f.alice]), 'Fixture_A')
  assert.equal(await f.balance(f.alice), before - FEE)
  assert.equal(await f.balance(f.board), FEE)
  for (const amount of [0n, FEE]) await f.write(f.bob, f.board, 'register', ['FIXTURE_a'], amount, {error: 'HandleTaken'})
  await f.conserved()
})

test('one wallet retains several handles and can reselect or recase them without paying twice', async () => {
  const f = await fixture()
  await f.write(f.alice, f.board, 'register', ['Fixture_A'], FEE)
  await f.write(f.alice, f.board, 'register', ['Fixture_B'], FEE)
  await f.write(f.alice, f.board, 'register', ['fixture_a'], FEE, {error: 'WrongFee'})
  const result = await f.write(f.alice, f.board, 'register', ['fIXTURE_a'])
  assert.deepEqual(first(f, result, 'HandleChosen'), {holder: f.alice, name: 'fIXTURE_a', registered: false})
  assert.equal(await f.read(f.board, 'holder', ['Fixture_A']), f.alice)
  assert.equal(await f.read(f.board, 'holder', ['Fixture_B']), f.alice)
  assert.equal(await f.read(f.board, 'holder', ['Free_Name']), ZERO)
  assert.equal(await f.balance(f.board), 2n * FEE)
})

test('janitors remove and restore actual threads while unauthorized callers cannot moderate', async () => {
  const f = await fixture(); await f.post({image})
  await f.write(f.owner, f.board, 'remove', [1n, true], 0n, {error: 'NotJanitor'})
  await f.write(f.alice, f.board, 'remove', [1n, true], 0n, {error: 'NotJanitor'})
  for (const id of [0n, 2n]) await f.write(f.janitor, f.board, 'remove', [id, true], 0n, {error: 'NoSuchPost'})
  const removed = await f.write(f.janitor, f.board, 'remove', [1n, true])
  assert.deepEqual(first(f, removed, 'Removed'), {id: 1n, removed: true})
  await f.post({thread: 1n, body: 'Closed', image: '0x', error: 'ThreadRemoved'})
  await f.write(f.janitor, f.board, 'remove', [1n, false])
  assert.equal((await f.post({thread: 1n, body: 'Restored', image: '0x'})).id, 2n)
  await f.write(f.owner, f.board, 'setJanitor', [f.carol, true])
  await f.write(f.owner, f.board, 'setJanitor', [f.janitor, false])
  await f.write(f.janitor, f.board, 'remove', [1n, true], 0n, {error: 'NotJanitor'})
  await f.write(f.carol, f.board, 'remove', [2n, true])
  assert.equal(await f.read(f.board, 'removed', [2n]), true)
})

test('only the original author deletes a post and restoration cannot undo an author deletion', async () => {
  const f = await fixture(); await f.post({image})
  for (const actor of [f.owner, f.janitor, f.bob]) await f.write(actor, f.board, 'deletePost', [1n], 0n, {error: 'NotYourPost'})
  await f.write(f.alice, f.board, 'deletePost', [2n], 0n, {error: 'NotYourPost'})
  await f.write(f.alice, f.board, 'deletePost', [1n])
  await f.write(f.alice, f.board, 'deletePost', [1n])
  await f.write(f.janitor, f.board, 'remove', [1n, true])
  await f.write(f.janitor, f.board, 'remove', [1n, false])
  assert.equal(await f.read(f.board, 'deleted', [1n]), true)
  assert.equal(await f.read(f.board, 'removed', [1n]), false)
  await f.post({thread: 1n, body: 'Still closed', image: '0x', error: 'ThreadRemoved'})
})

test('deleting or removing a reply leaves its original thread open', async () => {
  const f = await fixture(); await f.post({image})
  await f.post({from: f.bob, thread: 1n, body: 'Reply', image: '0x'})
  await f.write(f.bob, f.board, 'deletePost', [2n])
  await f.write(f.janitor, f.board, 'remove', [2n, true])
  assert.equal((await f.post({thread: 1n, body: 'Thread remains open', image: '0x'})).id, 3n)
})

test('ownership transfer preserves the packed post counter and fees while revoking prior authority', async () => {
  const f = await fixture(); await f.post({image})
  await f.write(f.alice, f.board, 'register', ['Fixture_A'], FEE)
  for (const [name, args] of [['setOwner', [f.heir]], ['setJanitor', [f.carol, true]], ['withdraw', [f.recipient, 0n]]]) {
    await f.write(f.janitor, f.board, name, args, 0n, {error: 'NotOwner'})
  }
  await f.write(f.owner, f.board, 'setOwner', [f.heir])
  assert.equal(await f.read(f.board, 'owner'), f.heir)
  assert.equal(await f.read(f.board, 'posts'), 1n)
  assert.equal(await f.balance(f.board), FEE)
  await f.write(f.owner, f.board, 'setJanitor', [f.carol, true], 0n, {error: 'NotOwner'})
  await f.write(f.heir, f.board, 'setJanitor', [f.carol, true])
  assert.equal((await f.post({image})).id, 2n)
})

test('renouncing ownership leaves existing janitors and posting active but removes administration', async () => {
  const f = await fixture(); await f.post({image})
  await f.write(f.owner, f.board, 'setOwner', [ZERO])
  for (const actor of [f.owner, f.heir, f.janitor]) await f.write(actor, f.board, 'setOwner', [f.owner], 0n, {error: 'NotOwner'})
  await f.write(f.janitor, f.board, 'remove', [1n, true])
  assert.equal((await f.post({image})).id, 2n)
  assert.equal(await f.read(f.board, 'owner'), ZERO)
})

test('partial, full and empty withdrawals transfer the exact known fee balance', async () => {
  const f = await fixture()
  await f.write(f.alice, f.board, 'register', ['Fixture_A'], FEE)
  await f.write(f.bob, f.board, 'register', ['Fixture_B'], FEE)
  const before = await f.balance(f.recipient)
  await f.write(f.bob, f.board, 'withdraw', [f.recipient, FEE], 0n, {error: 'NotOwner'})
  await f.write(f.owner, f.board, 'withdraw', [f.recipient, 2n * FEE + 1n], 0n, {error: 'TransferFailed'})
  const partial = await f.write(f.owner, f.board, 'withdraw', [f.recipient, FEE / 2n])
  assert.deepEqual(first(f, partial, 'Withdrawn'), {to: f.recipient, amount: FEE / 2n})
  assert.equal(await f.balance(f.board), 3n * FEE / 2n)
  await f.write(f.owner, f.board, 'withdraw', [f.recipient, 0n])
  await f.write(f.owner, f.board, 'withdraw', [f.recipient, 0n])
  assert.equal(await f.balance(f.recipient), before + 2n * FEE)
  assert.equal(await f.balance(f.board), 0n)
  await f.conserved()
})

test('rejected withdrawals restore fees and logs, then succeed after recipient recovery', async () => {
  const f = await fixture(), receiver = await f.deploy(fixtureArtifacts.NativeReceiver)
  await f.write(f.alice, f.board, 'register', ['Fixture_A'], FEE)
  await f.write(f.owner, f.board, 'withdraw', [receiver, 0n], 0n, {error: 'TransferFailed'})
  assert.equal(await f.balance(f.board), FEE)
  await f.write(f.owner, receiver, 'setReject', [false])
  await f.write(f.owner, f.board, 'withdraw', [receiver, 0n])
  assert.equal(await f.balance(receiver), FEE)
  assert.equal(await f.balance(f.board), 0n)
  await f.conserved()
})

test('nonpayable calls and insufficient execution gas retain neither value nor partial posts', async () => {
  const f = await fixture()
  await f.write(f.alice, f.board, 'post', [0n, 0, '', 'Text', image], 1n, {error: null})
  await f.frame({from: f.alice, to: f.board, value: 1n, error: null})
  await f.post({image, gas: 30_000n, error: null})
  assert.equal(await f.read(f.board, 'posts'), 0n)
  assert.equal(await f.read(f.board, 'isThread', [1n]), false)
  assert.equal(await f.balance(f.board), 0n)
})

test('seeded real-call histories agree with an independent business model and decoded-log replay', async (t) => {
  for (const seed of [1, 42, 0x13579bdf, 0xdeadbeef]) await t.test('seed ' + seed, async () => {
    const f = await fixture(), next = random(seed), model = replayState(), logs = replayState()
    model.owner = f.owner; model.janitors.add(f.janitor)
    replay(logs, f.events(f.deploymentResult))
    const people = [f.alice, f.bob, f.carol], names = ['Fixture_A', 'Fixture_B', 'Fixture_C']
    async function step(name, from, args, {value = 0n, error, update} = {}) {
      const result = await f.write(from, f.board, name, args, value, error ? {error} : {})
      if (!error) update?.(result)
      replay(logs, f.events(result))
      assert.equal(await f.read(f.board, 'posts'), BigInt(model.posts.size))
      assert.equal(await f.read(f.board, 'owner'), model.owner)
      assert.equal(await f.balance(f.board), model.fees)
      assert.equal(logs.fees, model.fees)
      return result
    }
    async function register(from, name, amount) {
      const held = model.holders.get(name.toLowerCase()), fresh = !held
      const error = held && held !== from ? 'HandleTaken' : amount !== (fresh ? FEE : 0n) ? 'WrongFee' : undefined
      await step('register', from, [name], {value: amount, error, update() {
        model.handles.set(from, name); model.holders.set(name.toLowerCase(), from)
        if (fresh) model.fees += FEE
      }})
    }
    await register(f.alice, names[0], FEE); await register(f.bob, names[1], FEE)
    for (let i = 0; i < 64; i++) {
      const op = next() % 8, from = people[next() % people.length], ids = [...model.posts.keys()]
      if (op <= 1) {
        const thread = !ids.length || next() % 3 === 0 ? 0n : ids[next() % ids.length]
        const flags = next() % 4, body = 'Fixture step ' + i, data = thread === 0n ? image : '0x'
        const expectedId = BigInt(model.posts.size) + 1n
        const error = thread && !model.posts.get(thread)?.isThread ? 'NoSuchThread' :
          thread && (model.removed.has(thread) || model.deleted.has(thread)) ? 'ThreadRemoved' :
          flags & NAMED && !model.handles.has(from) ? 'NoHandle' : undefined
        await step('post', from, [thread, flags, '', body, data], {error, update(result) {
          const actual = first(f, result, 'Posted'), target = thread || expectedId
          const expected = {id: expectedId, thread: target, poster: poster(from, target, Boolean(flags & NAMED)), sage: Boolean(thread && flags & SAGE),
            imageBytes: (data.length - 2) / 2, name: flags & NAMED ? model.handles.get(from) : '', subject: '', body}
          assert.deepEqual(actual, expected)
          model.posts.set(expectedId, {...expected, author: from, isThread: thread === 0n})
          if (data !== '0x') model.images.set(expectedId, data)
        }})
      } else if (op === 2) {
        const actor = next() % 2 ? [...model.janitors][0] ?? f.janitor : f.alice
        const id = ids.length && next() % 3 ? ids[next() % ids.length] : BigInt(model.posts.size) + 1n, gone = Boolean(next() % 2)
        const error = !model.janitors.has(actor) ? 'NotJanitor' : !model.posts.has(id) ? 'NoSuchPost' : undefined
        await step('remove', actor, [id, gone], {error, update() { if (gone) model.removed.add(id); else model.removed.delete(id) }})
      } else if (op === 3) {
        const id = ids.length ? ids[next() % ids.length] : 1n, actor = next() % 2 ? model.posts.get(id)?.author ?? from : from
        const error = model.posts.get(id)?.author !== actor ? 'NotYourPost' : undefined
        await step('deletePost', actor, [id], {error, update() { model.deleted.add(id) }})
      } else if (op === 4) await register(from, next() % 2 ? names[next() % names.length] : names[next() % names.length].toUpperCase(), next() % 2 ? FEE : 0n)
      else if (op === 5) {
        const actor = next() % 2 ? model.owner : f.bob, who = next() % 2 ? f.janitor : f.carol, active = Boolean(next() % 2)
        await step('setJanitor', actor, [who, active], {error: actor !== model.owner ? 'NotOwner' : undefined,
          update() { if (active) model.janitors.add(who); else model.janitors.delete(who) }})
      } else if (op === 6) {
        const actor = next() % 2 ? model.owner : f.deployer, who = next() % 2 ? f.owner : f.heir
        await step('setOwner', actor, [who], {error: actor !== model.owner ? 'NotOwner' : undefined, update() { model.owner = who }})
      } else {
        const actor = next() % 2 ? model.owner : f.bob, amount = [0n, model.fees / 2n, model.fees + 1n][next() % 3]
        const actual = amount || model.fees, error = actor !== model.owner ? 'NotOwner' : actual > model.fees ? 'TransferFailed' : undefined
        await step('withdraw', actor, [f.recipient, amount], {error, update() { model.fees -= actual }})
      }
      if (i % 8 === 7) {
        assert.equal(logs.owner, model.owner)
        assert.deepEqual(logs.janitors, model.janitors)
        assert.deepEqual(logs.removed, model.removed); assert.deepEqual(logs.deleted, model.deleted)
        assert.deepEqual(logs.handles, model.handles); assert.deepEqual(logs.holders, model.holders); assert.deepEqual(logs.images, model.images)
        for (const [id, p] of model.posts) {
          const {author, isThread, ...publicFields} = p
          assert.deepEqual(logs.posts.get(id), publicFields)
          assert.equal(await f.read(f.board, 'isThread', [id]), isThread)
          assert.equal(await f.read(f.board, 'removed', [id]), model.removed.has(id))
          assert.equal(await f.read(f.board, 'deleted', [id]), model.deleted.has(id))
          assert.equal(visible(logs, id), !model.removed.has(id) && !model.deleted.has(id) && !model.removed.has(p.thread) && !model.deleted.has(p.thread))
        }
        for (const actor of [...people, f.janitor]) {
          assert.equal(await f.read(f.board, 'janitors', [actor]), model.janitors.has(actor))
          assert.equal(await f.read(f.board, 'handleOf', [actor]), model.handles.get(actor) ?? '')
        }
        for (const name of names) assert.equal(await f.read(f.board, 'holder', [name]), model.holders.get(name.toLowerCase()) ?? ZERO)
      }
    }
    await f.conserved()
  })
})
