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
let scanned = START_BLOCK - 1n

export interface Scan {
  fresh: number[] // ids of posts first seen in this scan
  changed: boolean // whether anything on screen may differ
}
const listeners = new Set<(s: Scan) => void>()
export const onChange = (fn: (s: Scan) => void) => listeners.add(fn)

export const QUOTE = />>(\d{1,12})/g

// A scan reports the posts that are new, and whether anything else (a
// removal, a janitor, the owner) changed.
let changed = false

async function apply(logs: RawLog[]): Promise<number[]> {
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(a.logIndex) - Number(b.logIndex))
  const fresh: number[] = []
  for (const l of logs) {
    if (l.removed) continue
    const ev = decodeEventLog({abi: zchanAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]]})
    if (ev.eventName === 'Posted') {
      const a = ev.args
      const id = Number(a.id)
      if (posts.has(id)) continue
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
        time: await logTime(l),
        tx: l.transactionHash,
        arrived: loaded ? Date.now() : undefined,
      }
      posts.set(id, p)
      fresh.push(id)
      for (const q of new Set([...p.body.matchAll(QUOTE)].map((m) => Number(m[1])))) {
        if (q >= id) continue
        const list = backlinks.get(q) ?? []
        list.push(id)
        backlinks.set(q, list)
      }
    } else if (ev.eventName === 'Removed') {
      if (ev.args.removed) removed.add(Number(ev.args.id))
      else removed.delete(Number(ev.args.id))
      changed = true
    } else if (ev.eventName === 'Deleted') {
      deleted.add(Number(ev.args.id))
      changed = true
    } else if (ev.eventName === 'JanitorSet') {
      if (ev.args.active) janitors.add(ev.args.janitor.toLowerCase())
      else janitors.delete(ev.args.janitor.toLowerCase())
      changed = true
    } else if (ev.eventName === 'OwnerChanged') {
      owner = ev.args.owner
      changed = true
    }
  }
  return fresh
}

// scan reads everything since the last scan, re-reading the last two blocks
// in case the head moved under the previous read. Re-reading is harmless:
// posts are keyed by id, and a removal is a state, not a toggle.
let scanning: Promise<void> | null = null
export function scan(): Promise<void> {
  scanning ??= (async () => {
    try {
      const tip = await reader.getBlockNumber()
      head = tip
      const from = scanned - 1n > START_BLOCK ? scanned - 1n : START_BLOCK
      if (tip < from) return
      const logs: RawLog[] = []
      for (let a = from; a <= tip; a += 50_000n) {
        const b = a + 49_999n < tip ? a + 49_999n : tip
        logs.push(...(await getLogs(a, b, [[T.posted, T.removed, T.deleted, T.janitor, T.owner]])))
      }
      changed = false
      const fresh = await apply(logs)
      scanned = tip
      const first = !loaded
      loaded = true
      // Called on every scan, new posts or not, so the head shown moves.
      listeners.forEach((fn) => fn({fresh, changed: changed || first || fresh.length > 0}))
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

// image resolves to a post's image as a blob URL. Requests made together are
// fetched together: one eth_getLogs for up to 24 images, filtered by id.
export function image(id: number): Promise<Loaded> {
  let p = images.get(id)
  if (!p) {
    p = new Promise<Loaded>((resolve) => queue.push({id, resolve}))
    images.set(id, p)
    p.then((l) => done.set(id, l))
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
  const blocks = batch.map((b) => posts.get(b.id)?.block ?? START_BLOCK)
  const from = blocks.reduce((a, b) => (b < a ? b : a))
  const to = blocks.reduce((a, b) => (b > a ? b : a))
  const found = new Map<number, Hex>()
  try {
    const logs = await getLogs(from, to, [T.image, batch.map((b) => pad(toHex(b.id)))])
    for (const l of logs) {
      const ev = decodeEventLog({abi: zchanAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]]})
      if (ev.eventName === 'Image') found.set(Number(ev.args.id), ev.args.data)
    }
  } catch (err: any) {
    for (const b of batch) {
      images.delete(b.id)
      b.resolve({error: err?.shortMessage ?? 'the node did not answer'})
    }
    return
  }
  for (const b of batch) {
    const data = found.get(b.id)
    if (!data) {
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
