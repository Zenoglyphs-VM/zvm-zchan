// zchan: one anonymous board, kept in a contract on the ZVM. This file is the
// page's frame: the routes (in the hash, so any static host serves them), the
// header, the live head, and the glue between the board, its views and the
// forms.
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/jetbrains-mono'
import './style.css'
import {encodeFunctionData, type Address} from 'viem'
import {zchanAbi} from './abi'
import {AccountPanel, handle, onHandle, refreshHandle} from './account'
import * as board from './board'
import {addressUrl, call, connect, disconnect, me, onAccount, reconnect} from './chain'
import {ZCHAN} from './config'
import {$, h} from './dom'
import {PostForm} from './form'
import * as view from './view'

// --- routes ------------------------------------------------------------------

type Route = {name: 'index'; page: number} | {name: 'catalog'} | {name: 'handle'} | {name: 'about'} | {name: 'thread'; id: number; post: number}

function route(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'catalog') return {name: 'catalog'}
  if (parts[0] === 'handle') return {name: 'handle'}
  if (parts[0] === 'about') return {name: 'about'}
  if (parts[0] === 'thread' && /^\d+$/.test(parts[1] ?? '')) {
    return {name: 'thread', id: Number(parts[1]), post: Number(/^p(\d+)$/.exec(parts[2] ?? '')?.[1] ?? 0)}
  }
  if (parts[0] === 'page' && /^\d+$/.test(parts[1] ?? '')) return {name: 'index', page: Number(parts[1])}
  return {name: 'index', page: 1}
}

let current: Route = {name: 'index', page: 1}
// The quoted post shown while a quote link is hovered.
let preview: HTMLElement | null = null
let scrollTo = 0 // a post to bring into view once it is drawn
let pendingQuote = 0 // a post to quote once its thread is on screen

// --- the frame ---------------------------------------------------------------

const threadForm = new PostForm('thread', (id) => void landed(id))
const replyForm = new PostForm('reply', (id) => void landed(id))
let sort: view.Sort = 'bump'
let search = ''

const janitorView = () => board.isJanitor(me)

function ctx(): view.Ctx {
  return {me, janitorView: janitorView(), thread: current.name === 'thread' ? current.id : 0, remove, deletePost}
}

function toast(text: string, bad = false) {
  const t = h('div', {class: `toast${bad ? ' bad' : ''}`, role: 'status'}, text)
  document.body.append(t)
  setTimeout(() => t.classList.add('gone'), 5000)
  setTimeout(() => t.remove(), 5600)
}

// remove is a janitor's button: take a post off the board, or put it back.
async function remove(id: number, gone: boolean) {
  try {
    toast(`${gone ? 'Removing' : 'Restoring'} No.${id}: waiting for your wallet…`)
    await call(encodeFunctionData({abi: zchanAbi, functionName: 'remove', args: [BigInt(id), gone]}))
    await board.scan()
    toast(`No.${id} ${gone ? 'removed' : 'restored'}.`)
  } catch (err: any) {
    toast(err?.shortMessage ?? err?.message ?? String(err), true)
  }
}

// deletePost is a poster's own button: take their post off the board, for good.
async function deletePost(id: number) {
  try {
    toast(`Deleting No.${id}: waiting for your wallet…`)
    await call(encodeFunctionData({abi: zchanAbi, functionName: 'deletePost', args: [BigInt(id)]}))
    await board.scan()
    toast(`No.${id} deleted.`)
  } catch (err: any) {
    toast(err?.shortMessage ?? err?.message ?? String(err), true)
  }
}

const account = new AccountPanel(toast)

async function landed(id: number) {
  await board.scan()
  const p = board.posts.get(id)
  if (!p) return
  const target = p.id === p.thread ? `#/thread/${p.id}` : `#/thread/${p.thread}/p${p.id}`
  scrollTo = id
  if (location.hash === target) draw()
  else location.hash = target
}

// The bar under the form: the catalog's sort and search, or a thread's way
// back. Drawn on a route change only, so typing in the search box is never
// interrupted by a redraw.
function bar() {
  const slot = $('#bar')
  if (current.name === 'catalog') {
    const select = h(
      'select',
      {class: 'input', 'aria-label': 'Sort', onchange: ((e: Event) => ((sort = (e.target as HTMLSelectElement).value as view.Sort), draw())) as EventListener},
      h('option', {value: 'bump', selected: sort === 'bump'}, 'Bump order'),
      h('option', {value: 'new', selected: sort === 'new'}, 'Newest threads'),
      h('option', {value: 'replies', selected: sort === 'replies'}, 'Most replies'),
    )
    const input = h('input', {class: 'input', type: 'search', placeholder: 'Search', 'aria-label': 'Search threads', value: search})
    input.addEventListener('input', () => {
      search = (input as HTMLInputElement).value
      draw()
    })
    slot.replaceChildren(h('div', {class: 'bar'}, h('a', {href: '#/'}, 'Index'), select, input))
  } else if (current.name === 'thread') {
    slot.replaceChildren(
      h(
        'div',
        {class: 'bar'},
        h('a', {href: '#/'}, 'Return'),
        h('a', {href: '#bottom', onclick: ((e: Event) => (e.preventDefault(), scrollTo_(document.body.scrollHeight))) as EventListener}, 'Bottom'),
      ),
    )
  } else if (current.name === 'handle' || current.name === 'about') slot.replaceChildren(h('div', {class: 'bar'}, h('a', {href: '#/'}, 'Return')))
  else slot.replaceChildren() // the index: the catalog is in the header
}
const scrollTo_ = (y: number) => window.scrollTo({top: y, behavior: 'smooth'})

function forms() {
  const slot = $('#form-slot')
  if (current.name === 'about') slot.replaceChildren()
  else if (current.name === 'handle') {
    if (slot.firstChild !== account.el) slot.replaceChildren(account.el)
    account.refresh()
  } else if (current.name === 'thread') {
    replyForm.setThread(current.id)
    if (slot.firstChild !== replyForm.el) slot.replaceChildren(replyForm.el)
  } else if (slot.firstChild !== threadForm.el) slot.replaceChildren(threadForm.el)
}

// draw redraws the page's content from the board. It runs on every change
// to the board, the route, or the connected wallet.
function draw() {
  const out = $('#view')
  const c = ctx()
  document.body.classList.toggle('janitor', c.janitorView)
  document.body.dataset.route = current.name
  if (!board.loaded) {
    out.replaceChildren(h('div', {class: 'loading-board'}, h('span', {class: 'spinner'}), 'Reading the board from the chain…'))
    return
  }
  if (current.name === 'handle') out.replaceChildren()
  else if (current.name === 'about') out.replaceChildren(about())
  else if (current.name === 'index') out.replaceChildren(view.index(current.page, c))
  else if (current.name === 'catalog') out.replaceChildren(view.catalog(sort, search, c))
  else {
    const t = view.thread(current.id, c)
    if (t.redirect) {
      location.replace(t.redirect)
      return
    }
    out.replaceChildren(t.el!)
    const op = board.posts.get(current.id)
    if (op) document.title = `/z/ - ${(op.subject || op.body || `No.${op.id}`).slice(0, 60)} - zchan`
  }
  if (current.name === 'handle') document.title = 'Handle - zchan'
  else if (current.name === 'about') document.title = 'About - zchan'
  else if (current.name !== 'thread') document.title = '/z/ - zchan'
  titleCount()
  titleCount()

  if (scrollTo) {
    const el = document.getElementById(`p${scrollTo}`)
    if (el) {
      scrollTo = 0
      el.scrollIntoView({block: 'center'})
      el.classList.remove('highlight')
      void el.offsetWidth // restart the animation
      el.classList.add('highlight')
    }
  }
  if (pendingQuote && current.name === 'thread' && board.posts.get(pendingQuote)?.thread === current.id) {
    replyForm.quote(pendingQuote)
    pendingQuote = 0
  }
}

// focusReply is set by a thread's Reply link, so the thread opens with the
// cursor already in the comment, as 4chan's [Reply] does.
let focusReply = false

function onRoute() {
  preview?.remove()
  preview = null
  const v = $('#view')
  v.classList.add('entering')
  setTimeout(() => v.classList.remove('entering'), 700)
  const was = current
  current = route()
  scrollTo = current.name === 'thread' ? current.post || scrollTo : 0
  forms()
  // A thread opens to read: the quick reply comes up only from its Reply
  // link, its Post a Reply button, or a post number. Entering a thread puts
  // it away, keeping what was typed; moving within one thread leaves it.
  if (current.name === 'thread' && !(was.name === 'thread' && was.id === current.id)) replyForm.close()
  bar()
  draw()
  if (!scrollTo) window.scrollTo({top: 0})
  if (focusReply && current.name === 'thread') replyForm.focus()
  focusReply = false
}
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('a.reply-link')) focusReply = true
})
window.addEventListener('hashchange', onRoute)

// On the index, a click in a post's text opens its thread at that post. A
// link or button in it, a selection being made, or a modified click (a new
// tab, say) is left alone.
document.addEventListener('click', (e) => {
  if (current.name !== 'index' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const t = e.target as HTMLElement
  const bq = t.closest('article.post:not(.preview) blockquote.body')
  if (!bq || t.closest('a, button') || getSelection()?.toString()) return
  const p = board.posts.get(Number(bq.closest<HTMLElement>('article.post')!.dataset.id))
  if (p) location.hash = view.postHref(p)
})

// The about page: what a visitor should know before posting, and where the
// board lives.
function about() {
  return h(
    'section',
    {class: 'about panel'},
    h('h2', {}, 'About'),
    h(
      'ul',
      {},
      h('li', {}, 'Every post is a transaction on the ZVM. A janitor can take a post off the board, but not out of the chain’s history.'),
      h('li', {}, 'Anonymous here, not on the chain: your wallet sends the post. Use one you use for nothing else. A handle signs only the posts you choose.'),
      h('li', {}, 'Images are re-encoded in your browser before posting, which strips their metadata, to at most 48 KiB.'),
    ),
    h(
      'p',
      {class: 'contract'},
      'Board contract ',
      h('a', {class: 'mono', href: `${addressUrl(ZCHAN as Address)}?tab=contract`, target: '_blank', rel: 'noopener'}, ZCHAN),
    ),
  )
}

// --- the header --------------------------------------------------------------

function header() {
  const btn = $<HTMLButtonElement>('#connect')
  const off = $<HTMLButtonElement>('#disconnect')
  if (me) {
    btn.textContent = `${me.slice(0, 6)}…${me.slice(-4)}`
    btn.classList.add('is-connected')
    btn.title = janitorView() ? 'Connected as the janitor' : 'Connected'
    off.hidden = false
  } else {
    btn.textContent = 'Connect'
    btn.classList.remove('is-connected')
    btn.title = ''
    off.hidden = true
  }
  $('#jan-badge').hidden = !janitorView()
}

$('#connect').addEventListener('click', () => {
  if (!me) connect().catch((e) => toast(e.message, true))
})
$('#disconnect').addEventListener('click', () => void disconnect())
onAccount(() => {
  header()
  draw()
  account.refresh()
  offerHandle()
  void refreshHandle()
})
// The "Post as" choice names a staff wallet's capcode, so it follows the
// handle, the wallet, and the owner and janitors the board's logs name.
function offerHandle() {
  const capcode = board.isOwner(me) ? 'Admin' : board.isJanitor(me) ? 'Janitor' : ''
  threadForm.setHandle(handle, capcode)
  replyForm.setHandle(handle, capcode)
}
onHandle(() => {
  offerHandle()
  account.refresh()
})

// The theme key is the explorer's, so a visitor's choice follows them across
// zvm's pages.
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', next)
  try {
    localStorage.setItem('zvm.theme', next)
  } catch {}
})

// The live head: the block the board was last read at, and a beat each time
// it moves, which is how the page shows the chain is running.
let lastHead = 0n
function live(ok: boolean) {
  const el = $('#live')
  el.classList.toggle('down', !ok)
  if (!ok) {
    $('#live-text').textContent = 'node unreachable'
    return
  }
  $('#live-text').textContent = `block ${board.head.toLocaleString('en-US')}`
  if (board.head !== lastHead) {
    lastHead = board.head
    el.classList.remove('beat')
    void el.offsetWidth
    el.classList.add('beat')
  }
}

// --- quoting and previews ----------------------------------------------------

// Clicking a post's number quotes it: into the open thread's quick reply, or
// by opening its thread first.
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.quote-no')
  if (!a) return
  e.preventDefault()
  const id = Number(a.dataset.quote)
  const thread = Number(a.dataset.thread)
  if (current.name === 'thread' && current.id === thread) replyForm.quote(id)
  else {
    pendingQuote = id
    location.hash = `#/thread/${thread}/p${id}`
  }
})

// Hovering a quote link shows the post it quotes, and marks it where it is
// already on screen.
document.addEventListener('mouseover', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.quotelink')
  if (!a) return
  const p = board.posts.get(Number(a.dataset.id))
  if (!p) return
  preview?.remove()
  preview = h('div', {class: 'hover-preview'}, view.post(p, ctx(), {preview: true}))
  document.body.append(preview)
  const r = a.getBoundingClientRect()
  const w = Math.min(560, window.innerWidth - 24)
  preview.style.width = `${w}px`
  preview.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`
  const below = r.bottom + 8
  const height = preview.offsetHeight
  preview.style.top = `${below + height < window.innerHeight ? below : Math.max(8, r.top - height - 8)}px`
  document.getElementById(`p${p.id}`)?.classList.add('quoted')
})
document.addEventListener('mouseout', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.quotelink')
  if (!a) return
  preview?.remove()
  preview = null
  document.getElementById(`p${a.dataset.id}`)?.classList.remove('quoted')
})

// --- start -------------------------------------------------------------------


// New posts from other people, since the visitor last looked: a small "+N new"
// that rises in beside the head and fades after a while, and a count in the
// tab's title while the tab is in the background, as 4chan does. Clicking it
// goes to the newest.
let unseen: number[] = []
let fadeTimer = 0
function announce(fresh: number[]) {
  const others = fresh.filter((id) => {
    const p = board.posts.get(id)
    return p && p.arrived !== undefined && board.visible(p, janitorView()) && !(me && board.posterId(me, p.thread, p.name !== '') === p.poster)
  })
  if (!others.length) return
  unseen.push(...others)
  const el = $<HTMLAnchorElement>('#new-posts')
  const newest = board.posts.get(unseen[unseen.length - 1])!
  el.href = view.postHref(newest)
  el.textContent = `+${unseen.length} new`
  el.hidden = false
  el.classList.remove('arrive', 'fade')
  void el.offsetWidth // restart the animation
  el.classList.add('arrive')
  clearTimeout(fadeTimer)
  fadeTimer = window.setTimeout(seen, 20_000)
  titleCount()
}
function seen() {
  unseen = []
  const el = $('#new-posts')
  el.classList.add('fade')
  setTimeout(() => {
    if (!unseen.length) el.hidden = true
  }, 600)
  titleCount()
}
function titleCount() {
  const base = document.title.replace(/^\(\d+\) /, '')
  document.title = document.hidden && unseen.length ? `(${unseen.length}) ${base}` : base
}
$('#new-posts').addEventListener('click', () => {
  const id = unseen[unseen.length - 1]
  if (id) scrollTo = id
  seen()
})
document.addEventListener('visibilitychange', titleCount)

// Redrawn when something changed, and once after the first read even if the
// board is empty, to replace the loading line.
board.onChange(({fresh, changed, reset}) => {
  live(true)
  if (!changed) return
  if (reset) seen()
  header()
  offerHandle()
  draw()
  // The handle page lists the janitors, which the board's logs name.
  if (current.name === 'handle') account.refresh()
  announce(fresh)
})

// The board is read again every ten seconds. Only the board is re-read, not
// the page, so a half-written post and the scroll position stay put.
const REFRESH = 10_000
async function poll() {
  try {
    await board.scan()
  } catch {
    live(false)
  }
  setTimeout(poll, REFRESH)
}

onRoute()
header()
reconnect()
offerHandle()
void poll()
