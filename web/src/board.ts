// The board as the page knows it, rebuilt from the contract's logs. There is
// no server: the first visit reads every `Posted`, `Removed`, `Deleted`,
// `JanitorSet` and `OwnerChanged` since the contract was deployed, and after that only new
// blocks. Images are separate `Image` logs, fetched only for posts on screen.
import {
  decodeEventLog,
  encodeAbiParameters,
  getAbiItem,
  hexToBytes,
  keccak256,
  pad,
  slice,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import {zchanAbi} from './abi'
import {getLogs, logTime, reader, type RawLog} from './chain'
import {BUMP_LIMIT, START_BLOCK} from './config'
import {sniff, type ImageKind} from './image'

export interface Post {
  id: number
  thread: number
  poster: Hex
  name: string // the poster's handle, or "" for Anonymous
  sage: boolean
  imageBytes: number
  subject: string
  body: string
  block: bigint
  blockHash: Hex
  time: number
  tx: Hex
  // When this page first saw it, if that was after the first load: new posts
  // land with a little motion, old ones do not.
  arrived?: number
}

export interface Thread {
  op: Post
  replies: Post[]
  bump: number
  images: number
  posters: number
}

const topic = (name: 'Posted' | 'Image' | 'Removed' | 'Deleted' | 'JanitorSet' | 'OwnerChanged') =>
  toEventSelector(getAbiItem({abi: zchanAbi, name}) as any)
const T = {
  posted: topic('Posted'),
  image: topic('Image'),
  removed: topic('Removed'),
  deleted: topic('Deleted'),
  janitor: topic('JanitorSet'),
  owner: topic('OwnerChanged'),
}

export const posts = new Map<number, Post>()
export const removed = new Set<number>()
// Posts their poster deleted. Unlike a removal, this is never undone.
export const deleted = new Set<number>()
// For each post, the later posts that quote it: 4chan's backlinks.
export const backlinks = new Map<number, number[]>()
export const janitors = new Set<string>() // lowercase
export let owner: Address | null = null
export let head = 0n
export let loaded = false
let checkpoint: {number: bigint; hash: Hex} | null = null

export interface Scan {
  fresh: number[] // ids of posts first seen in this scan
  changed: boolean // whether anything on screen may differ
  reset: boolean // a first load or a complete canonical-branch rebuild
}
const listeners = new Set<(s: Scan) => void>()
export const onChange = (fn: (s: Scan) => void) => listeners.add(fn)

export const QUOTE = />>(\d{1,12})/g

interface State {
  posts: Map<number, Post>
  removed: Set<number>
  deleted: Set<number>
  backlinks: Map<number, number[]>
  janitors: Set<string>
  owner: Address | null
}
const empty = (): State => ({posts: new Map(), removed: new Set(), deleted: new Set(), backlinks: new Map(), janitors: new Set(), owner: null})
function copy(): State {
  return {posts: new Map(posts), removed: new Set(removed), deleted: new Set(deleted),
    backlinks: new Map([...backlinks].map(([id, refs]) => [id, [...refs]])), janitors: new Set(janitors), owner}
}

async function apply(state: State, logs: RawLog[], reset: boolean): Promise<Scan> {
  logs.sort((a, b) => {
    const block = BigInt(a.blockNumber) - BigInt(b.blockNumber)
    const index = BigInt(a.logIndex) - BigInt(b.logIndex)
    return block < 0n ? -1 : block > 0n ? 1 : index < 0n ? -1 : index > 0n ? 1 : 0
  })
  const fresh: number[] = []
  let changed = reset
  for (const l of logs) {
    const ev = decodeEventLog({abi: zchanAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]]})
    if (ev.eventName === 'Posted') {
      const a = ev.args
      const id = Number(a.id)
      if (!Number.isSafeInteger(id)) throw new Error('The post ID is too large for this page.')
      if (state.posts.has(id)) continue
      const p: Post = {
        id,
        thread: Number(a.thread),
        poster: a.poster,
        name: a.name,
        sage: a.sage,
        imageBytes: a.imageBytes,
        subject: a.subject,
        body: a.body,
        block: BigInt(l.blockNumber),
        blockHash: l.blockHash,
        time: await logTime(l),
        tx: l.transactionHash,
        arrived: loaded && !reset ? Date.now() : undefined,
      }
      state.posts.set(id, p)
      fresh.push(id)
      for (const q of new Set([...p.body.matchAll(QUOTE)].map((m) => Number(m[1])))) {
        if (q >= id) continue
        const list = state.backlinks.get(q) ?? []
        list.push(id)
        state.backlinks.set(q, list)
      }
    } else if (ev.eventName === 'Removed') {
      if (ev.args.removed) state.removed.add(Number(ev.args.id))
      else state.removed.delete(Number(ev.args.id))
      changed = true
    } else if (ev.eventName === 'Deleted') {
      state.deleted.add(Number(ev.args.id))
      changed = true
    } else if (ev.eventName === 'JanitorSet') {
      if (ev.args.active) state.janitors.add(ev.args.janitor.toLowerCase())
      else state.janitors.delete(ev.args.janitor.toLowerCase())
      changed = true
    } else if (ev.eventName === 'OwnerChanged') {
      state.owner = ev.args.owner
      changed = true
    }
  }
  return {fresh, changed: changed || fresh.length > 0, reset}
}

// Keep an accepted block hash, not an overlap window. If that block is no
// longer canonical (including a shorter head), rebuild from deployment.
// All reads/reduction finish and their block hashes are checked before any
// exported state changes. A failed/branch-changing read leaves the last view.
let scanning: Promise<void> | null = null
export function scan(): Promise<void> {
  scanning ??= (async () => {
    try {
      const tip = await reader.getBlockNumber({cacheTime: 0})
      const anchor = await reader.getBlock({blockNumber: tip})
      if (!anchor.hash || anchor.number !== tip) throw new Error('The node did not identify the head block.')
      const reset = !checkpoint || tip < checkpoint.number ||
        (await reader.getBlock({blockNumber: checkpoint.number})).hash !== checkpoint.hash
      const from = reset ? START_BLOCK : checkpoint!.number + 1n
      const logs: RawLog[] = []
      const blocks = new Map<bigint, Hex>()
      for (let a = from; a <= tip; a += 50_000n) {
        const b = a + 49_999n < tip ? a + 49_999n : tip
        for (const l of await getLogs(a, b, [[T.posted, T.removed, T.deleted, T.janitor, T.owner]])) {
          const n = BigInt(l.blockNumber)
          if (n < a || n > b || l.removed || !/^0x[\da-f]{64}$/i.test(l.blockHash) ||
            (blocks.has(n) && blocks.get(n) !== l.blockHash)) throw new Error('The node returned inconsistent board logs.')
          blocks.set(n, l.blockHash)
          logs.push(l)
        }
      }
      // Most polls contain no events: retain the existing maps rather than
      // copying and rebuilding the entire board just to advance its head.
      const candidate = reset ? empty() : logs.length ? copy() : null
      const update = candidate ? await apply(candidate, logs, reset) : {fresh: [], changed: false, reset: false}
      for (const [number, hash] of blocks) {
        if ((await reader.getBlock({blockNumber: number})).hash !== hash) throw new Error('The board changed while it was being read. Try again.')
      }
      if ((await reader.getBlock({blockNumber: tip})).hash !== anchor.hash ||
        (!reset && (await reader.getBlock({blockNumber: checkpoint!.number})).hash !== checkpoint!.hash)) {
        throw new Error('The board changed while it was being read. Try again.')
      }
      if (reset) invalidateImages()
      if (candidate) {
        // Keep exported map/set identities so views retain live references.
        for (const key of ['posts', 'backlinks'] as const) {
          const target = key === 'posts' ? posts : backlinks
          target.clear()
          for (const [id, value] of candidate[key]) (target as Map<number, Post | number[]>).set(id, value)
        }
        for (const key of ['removed', 'deleted', 'janitors'] as const) {
          const target = key === 'removed' ? removed : key === 'deleted' ? deleted : janitors
          target.clear()
          for (const value of candidate[key]) (target as Set<number | string>).add(value)
        }
        owner = candidate.owner
      }
      head = tip
      checkpoint = {number: tip, hash: anchor.hash}
      loaded = true
      // Called on every scan, new posts or not, so the head shown moves.
      listeners.forEach((fn) => fn(update))
    } finally {
      scanning = null
    }
  })()
  return scanning
}

// --- derived views -----------------------------------------------------------

// gone is whether a post is off the board, removed by a janitor or deleted
// by its poster.
export const gone = (id: number) => removed.has(id) || deleted.has(id)

// visible is what a visitor sees: a post that is gone is gone, and a first
// post takes its thread with it. A janitor sees everything, marked.
export function visible(p: Post, janitorView: boolean) {
  return janitorView || (!gone(p.id) && !gone(p.thread))
}

export const isJanitor = (a: Address | null) => !!a && janitors.has(a.toLowerCase())
export const isOwner = (a: Address | null) => !!a && !!owner && owner.toLowerCase() === a.toLowerCase()

// threads lists the board by bump order. A reply bumps its thread unless it
// is sage, gone, or past the bump limit; a thread with no bumping reply
// sits where it was opened.
export function threads(janitorView: boolean): Thread[] {
  const byThread = new Map<number, Thread>()
  const ordered = [...posts.values()].sort((a, b) => a.id - b.id)
  for (const p of ordered) {
    if (p.id === p.thread) byThread.set(p.id, {op: p, replies: [], bump: p.id, images: 0, posters: 0})
  }
  for (const p of ordered) {
    if (p.id === p.thread) continue
    const t = byThread.get(p.thread)
    if (!t || !visible(p, janitorView)) continue
    t.replies.push(p)
    if (p.imageBytes) t.images++
    if (!p.sage && !gone(p.id) && t.replies.length <= BUMP_LIMIT) t.bump = p.id
  }
  const out = [...byThread.values()].filter((t) => visible(t.op, janitorView))
  for (const t of out) t.posters = new Set([t.op.poster, ...t.replies.map((r) => r.poster)]).size
  // Post ids are the board's clock: a later id was ordered later by NoM.
  return out.sort((a, b) => b.bump - a.bump)
}

// posterId is the ID `post` derives for an address in a thread, signed or
// not, so the page can mark the connected wallet's posts "(You)" without the
// chain naming it. A wallet's signed and anonymous posts in one thread have
// different IDs, on purpose.
const mine = new Map<string, Hex>()
export function posterId(address: Address, thread: number, named: boolean): Hex {
  const k = `${address}:${thread}:${named}`
  let v = mine.get(k)
  if (!v) {
    v = slice(
      keccak256(encodeAbiParameters([{type: 'address'}, {type: 'uint64'}, {type: 'bool'}], [address, BigInt(thread), named])),
      0,
      8,
    )
    mine.set(k, v)
  }
  return v
}

// --- images ------------------------------------------------------------------

export type Loaded = {url: string; kind: ImageKind; bytes: number} | {error: string}

const images = new Map<number, Promise<Loaded>>()
const done = new Map<number, Loaded>()
let queue: {id: number; resolve: (l: Loaded) => void}[] = []
let timer = 0
let imageEpoch = 0

function invalidateImages() {
  imageEpoch++
  clearTimeout(timer)
  timer = 0
  for (const result of done.values()) if ('url' in result) URL.revokeObjectURL(result.url)
  images.clear()
  done.clear()
  for (const item of queue) item.resolve({error: 'The board changed. Load the image again.'})
  queue = []
}

// image resolves to a post's image as a blob URL. Requests made together are
// fetched together: one eth_getLogs for up to 24 images, filtered by id.
export function image(id: number): Promise<Loaded> {
  let p = images.get(id)
  if (!p) {
    p = new Promise<Loaded>((resolve) => queue.push({id, resolve}))
    images.set(id, p)
    p.then((l) => {if (images.get(id) === p) done.set(id, l)})
    if (!timer) timer = window.setTimeout(flush, 25)
  }
  return p
}
export const imageNow = (id: number) => done.get(id)

async function flush() {
  timer = 0
  const batch = queue.splice(0, 24)
  if (queue.length) timer = window.setTimeout(flush, 0)
  if (!batch.length) return
  const epoch = imageEpoch
  const original = new Map(batch.map((b) => [b.id, posts.get(b.id)]))
  const blocks = batch.map((b) => posts.get(b.id)?.block ?? START_BLOCK)
  const from = blocks.reduce((a, b) => (b < a ? b : a))
  const to = blocks.reduce((a, b) => (b > a ? b : a))
  const found = new Map<number, Hex>()
  try {
    const logs = await getLogs(from, to, [T.image, batch.map((b) => pad(toHex(b.id)))])
    for (const l of logs) {
      const ev = decodeEventLog({abi: zchanAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]]})
      if (ev.eventName === 'Image') {
        const id = Number(ev.args.id), post = original.get(id)
        if (post && !l.removed && l.blockHash === post.blockHash && l.transactionHash === post.tx &&
          BigInt(l.blockNumber) === post.block && ev.args.data.length === 2 + post.imageBytes * 2) found.set(id, ev.args.data)
      }
    }
  } catch (err: any) {
    for (const b of batch) {
      if (epoch === imageEpoch) images.delete(b.id)
      b.resolve({error: err?.shortMessage ?? 'the node did not answer'})
    }
    return
  }
  if (epoch !== imageEpoch) {
    for (const b of batch) b.resolve({error: 'The board changed. Load the image again.'})
    return
  }
  for (const b of batch) {
    const data = found.get(b.id)
    if (!data) {
      images.delete(b.id)
      b.resolve({error: 'image not found'})
      continue
    }
    const bytes = hexToBytes(data)
    const kind = sniff(bytes)
    // Only the four raster formats are shown, by their bytes, never by what
    // a poster claims: an SVG or an HTML file could carry script.
    if (!kind) b.resolve({error: 'not an image this page shows'})
    else b.resolve({url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], {type: kind.mime})), kind, bytes: bytes.length})
  }
}
