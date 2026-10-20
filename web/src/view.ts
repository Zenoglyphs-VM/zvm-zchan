// The three pages a chan has: the index (threads by bump, each with its last
// few replies), the catalog (every thread as a card), and a thread. Each is
// drawn whole from the board's state; what must survive a redraw (an expanded
// image, a loaded one) is kept outside the elements.
import {type Address, type Hex} from 'viem'
import {
  backlinks,
  deleted,
  gone,
  janitors,
  owner,
  image,
  imageNow,
  posterId,
  posts,
  QUOTE,
  removed,
  threads,
  visible,
  type Loaded,
  type Post,
  type Thread,
} from './board'
import {txUrl} from './chain'
import {PREVIEW_REPLIES, THREADS_PER_PAGE} from './config'
import {h} from './dom'
import {size} from './image'

export interface Ctx {
  me: Address | null
  janitorView: boolean
  thread: number // the thread on screen, 0 on the index and catalog
  remove(id: number, gone: boolean): void
  deletePost(id: number): void
}

// --- a post ------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number) => String(n).padStart(2, '0')
function when(t: number) {
  const d = new Date(t * 1000)
  return `${two(d.getMonth() + 1)}/${two(d.getDate())}/${two(d.getFullYear() % 100)}(${DAYS[d.getDay()]})${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
function ago(t: number) {
  const s = Math.max(0, Date.now() / 1000 - t)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

// A poster ID reads as 4chan's do: eight characters of base64, on a colour
// taken from the same bytes so the eye can follow one poster down a thread.
function idTag(poster: Hex) {
  const bytes = poster.slice(2).match(/../g)!.map((b) => parseInt(b, 16))
  const text = btoa(String.fromCharCode(...bytes.slice(0, 6))).replace(/\+/g, '-').replace(/\//g, '_')
  const hue = ((bytes[6] << 8) | bytes[7]) % 360
  return h('span', {class: 'pid', style: `--hue:${hue}`, title: 'Poster ID, the same for one wallet within one thread'}, text)
}

// staff is the capcode a signed post carries when its wallet is the owner or
// a janitor, as 4chan marks a moderator who chooses to post as one. Only a
// signed post is checked: staff who post as Anonymous stay anonymous here,
// even though anyone could match their public addresses against the chain.
function staff(p: Post): 'admin' | 'janitor' | null {
  if (!p.name) return null
  if (owner && posterId(owner, p.thread, true) === p.poster) return 'admin'
  for (const j of janitors) if (posterId(j as Address, p.thread, true) === p.poster) return 'janitor'
  return null
}

const mine = (p: Post, ctx: Ctx) => ctx.me !== null && posterId(ctx.me, p.thread, p.name !== '') === p.poster
export const postHref = (p: Post) => (p.id === p.thread ? `#/thread/${p.id}` : `#/thread/${p.thread}/p${p.id}`)

function quoteLink(id: number, ctx: Ctx) {
  const q = posts.get(id)
  if (!q || !visible(q, ctx.janitorView)) return h('span', {class: 'deadlink'}, `>>${id}`)
  return h(
    'a',
    {class: 'quotelink', href: postHref(q), 'data-id': id},
    `>>${id}`,
    mine(q, ctx) ? ' (You)' : '',
    ctx.thread && q.thread !== ctx.thread ? ' →' : '',
    q.id === q.thread && ctx.thread === q.id ? ' (OP)' : '',
  )
}

function inline(text: string, ctx: Ctx): (Node | string)[] {
  const out: (Node | string)[] = []
  let last = 0
  for (const m of text.matchAll(QUOTE)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    out.push(quoteLink(Number(m[1]), ctx))
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// A line that opens with ">" (and is not a quote link) is greentext.
function body(p: Post, ctx: Ctx) {
  const bq = h('blockquote', {class: 'body'})
  p.body.split('\n').forEach((line, i) => {
    if (i) bq.append(h('br'))
    if (line.startsWith('>') && !/^>>\d/.test(line)) bq.append(h('span', {class: 'green'}, inline(line, ctx)))
    else bq.append(...inline(line, ctx))
  })
  return bq
}

export const expanded = new Set<number>()
const lazy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      lazy.unobserve(e.target)
      const el = e.target as HTMLElement
      const id = Number(el.dataset.id)
      void image(id).then((l) => fill(el, l, true))
    }
  },
  {rootMargin: '600px 0px'},
)

// fill puts a loaded image in place. `arriving` is true when it has just come
// off the chain, and only then does it fade in: a redraw that finds it
// already loaded shows it as it was.
function fill(fileEl: HTMLElement, l: Loaded, arriving = false) {
  const thumb = fileEl.querySelector<HTMLAnchorElement>('.thumb')!
  const info = fileEl.querySelector<HTMLElement>('.file-info')!
  const id = Number(fileEl.dataset.id)
  if ('error' in l) {
    thumb.replaceChildren(h('span', {class: 'thumb-missing'}, l.error))
    thumb.classList.remove('loading')
    return
  }
  const img = h('img', {src: l.url, alt: '', decoding: 'async', class: arriving ? 'appear' : null}) as HTMLImageElement
  const name = `${id}.${l.kind.ext}`
  const setInfo = () =>
    info.replaceChildren(
      'File: ',
      h('a', {href: l.url, download: name}, name),
      ` (${size(l.bytes)}${img.naturalWidth ? `, ${img.naturalWidth}x${img.naturalHeight}` : ''})`,
    )
  img.addEventListener('load', () => {
    thumb.classList.remove('loading')
    setInfo()
  })
  setInfo()
  if (!thumb.dataset.link) thumb.href = l.url
  thumb.replaceChildren(img)
}

// file is a post's image. A thumbnail expands in place when clicked, except
// where `link` is given (the catalog), where it opens that link instead.
function file(p: Post, link?: string) {
  const el: HTMLElement = h(
    'div',
    {class: `file${expanded.has(p.id) ? ' expanded' : ''}`, 'data-id': p.id},
    h('div', {class: 'file-info'}, `File: ${size(p.imageBytes)}`),
    link
      ? h('a', {class: 'thumb loading', href: link, 'data-link': 1})
      : h('a', {
          class: 'thumb loading',
          href: '#',
          title: 'Click to expand',
          onclick: ((e: Event) => {
            e.preventDefault()
            if (expanded.has(p.id)) expanded.delete(p.id)
            else expanded.add(p.id)
            el.classList.toggle('expanded', expanded.has(p.id))
          }) as EventListener,
        }),
  )
  const now = imageNow(p.id)
  if (now) fill(el, now)
  else lazy.observe(el)
  return el
}

// copyLink copies the post's full address, page and route together, so the
// link opens the same post wherever this build is hosted (Pages, a domain
// root, the gateway path).
function copyLink(p: Post) {
  let timer = 0
  const b: HTMLButtonElement = h(
    'button',
    {
      class: 'copy-link',
      type: 'button',
      title: 'Copy a link to this post',
      onclick: (async () => {
        const url = location.href.replace(/#.*$/, '') + postHref(p)
        const ok = await copy(url)
        b.textContent = ok ? 'copied' : 'copy failed'
        b.classList.toggle('done', ok)
        clearTimeout(timer)
        timer = window.setTimeout(() => {
          b.textContent = 'link'
          b.classList.remove('done')
        }, 1600)
      }) as EventListener,
    },
    'link',
  )
  return b
}

// The clipboard API needs a secure context; a page opened over plain http
// falls back to the old selection copy.
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const t = h('textarea', {readonly: true, style: 'position:fixed;opacity:0'}) as HTMLTextAreaElement
    t.value = text
    document.body.append(t)
    t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return ok
  }
}

// confirmButton asks twice: the first click arms it for a few seconds, the
// second acts. No browser dialog, which would stop the page.
const BIN =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>'

function confirmButton(label: string, armed: string, act: () => void) {
  let timer = 0
  const text = h('span', {}, label)
  const b: HTMLButtonElement = h(
    'button',
    {
      class: 'jan mine',
      type: 'button',
      title: 'Delete your post from the board',
      onclick: (() => {
        if (b.classList.contains('armed')) {
          clearTimeout(timer)
          b.classList.remove('armed')
          text.textContent = label
          act()
          return
        }
        b.classList.add('armed')
        text.textContent = armed
        timer = window.setTimeout(() => {
          b.classList.remove('armed')
          text.textContent = label
        }, 4000)
      }) as EventListener,
    },
  )
  b.innerHTML = BIN // a constant, never poster text
  b.append(text)
  return b
}

// Posts first drawn within a few seconds of arriving land with a little
// motion, once: a redraw does not replay it.
const landed = new Set<number>()

export function post(p: Post, ctx: Ctx, opts: {preview?: boolean} = {}) {
  const op = p.id === p.thread
  const isGone = gone(p.id) || gone(p.thread)
  const fresh = !opts.preview && p.arrived !== undefined && Date.now() - p.arrived < 8000 && !landed.has(p.id)
  if (fresh) landed.add(p.id)
  const links = (backlinks.get(p.id) ?? []).map((id) => posts.get(id)!).filter((q) => visible(q, ctx.janitorView))

  const info = h(
    'div',
    {class: 'post-info'},
    op && p.subject ? h('span', {class: 'subject'}, p.subject) : null,
    ...(() => {
      if (!p.name) return [h('span', {class: 'name'}, 'Anonymous')]
      const role = staff(p)
      return [
        h(
          'span',
          {class: `name handle${role ? ' staff' : ''}`, title: 'A registered handle: only one wallet can post under it'},
          p.name,
          h('i', {'aria-hidden': 'true'}),
        ),
        role ? h('span', {class: 'capcode', title: role === 'admin' ? 'The board’s owner' : 'One of the board’s janitors'}, role === 'admin' ? '## Admin' : '## Janitor') : null,
      ]
    })(),
    mine(p, ctx) ? h('span', {class: 'you'}, '(You)') : null,
    idTag(p.poster),
    h('time', {title: ago(p.time), datetime: new Date(p.time * 1000).toISOString()}, when(p.time)),
    // One link, "No." and the number together, that quotes the post into the
    // quick reply; a link to share the post is the copy button's job.
    h(
      'span',
      {class: 'no'},
      h('a', {href: postHref(p), class: 'quote-no', 'data-quote': p.id, 'data-thread': p.thread, title: 'Reply to this post'}, `No.${p.id}`),
    ),
    // Thread opens it to read; Reply opens it with the quick reply up.
    op && !ctx.thread && !opts.preview
      ? [h('a', {class: 'thread-link', href: `#/thread/${p.id}`}, 'Thread'), h('a', {class: 'reply-link', href: `#/thread/${p.id}`}, 'Reply')]
      : null,
    h('a', {class: 'tx', href: txUrl(p.tx), target: '_blank', rel: 'noopener', title: 'This post on the explorer'}, 'tx'),
    opts.preview ? null : copyLink(p),
    // Your own post can be deleted, with a second click to be sure, since
    // nobody can undo it.
    mine(p, ctx) && !deleted.has(p.id) && !opts.preview ? confirmButton('delete', 'delete it for good?', () => ctx.deletePost(p.id)) : null,
    deleted.has(p.id) && ctx.janitorView ? h('span', {class: 'jan-note'}, 'deleted by its poster') : null,
    ctx.janitorView && !opts.preview && !deleted.has(p.id)
      ? h(
          'button',
          {
            class: 'jan',
            type: 'button',
            title: removed.has(p.id) ? 'Put this post back on the board' : 'Take this post off the board',
            onclick: (() => ctx.remove(p.id, !removed.has(p.id))) as EventListener,
          },
          removed.has(p.id) ? 'restore' : 'remove',
        )
      : null,
    links.length ? h('span', {class: 'backlinks'}, links.map((q) => quoteLink(q.id, ctx))) : null,
  )

  return h(
    'article',
    {
      class: ['post', op ? 'op' : 'reply', isGone ? 'is-removed' : '', fresh ? 'fresh' : '', opts.preview ? 'preview' : ''].join(' ').trim(),
      id: opts.preview ? null : `p${p.id}`,
      'data-id': p.id,
    },
    info,
    p.imageBytes ? file(p) : null,
    p.body ? body(p, ctx) : null,
  )
}

// --- the index ---------------------------------------------------------------

function omitted(t: Thread, shown: Post[]) {
  const replies = t.replies.length - shown.length
  if (replies <= 0) return null
  const images = t.images - shown.filter((r) => r.imageBytes).length
  return h(
    'p',
    {class: 'omitted'},
    `${replies} ${replies === 1 ? 'reply' : 'replies'}${images ? ` and ${images} ${images === 1 ? 'image' : 'images'}` : ''} omitted. `,
    h('a', {href: `#/thread/${t.op.id}`}, 'View the thread'),
  )
}

export function index(page: number, ctx: Ctx) {
  const all = threads(ctx.janitorView)
  const pages = Math.max(1, Math.ceil(all.length / THREADS_PER_PAGE))
  const at = Math.min(Math.max(1, page), pages)
  const list = all.slice((at - 1) * THREADS_PER_PAGE, at * THREADS_PER_PAGE)
  const out = h('div', {class: 'index'})
  if (!all.length) out.append(h('p', {class: 'empty'}, 'No threads yet. Start one.'))
  for (const t of list) {
    const shown = t.replies.slice(-PREVIEW_REPLIES)
    out.append(h('section', {class: 'thread'}, post(t.op, ctx), omitted(t, shown), shown.map((r) => post(r, ctx))), h('hr'))
  }
  if (pages > 1) {
    out.append(
      h(
        'nav',
        {class: 'pages'},
        Array.from({length: pages}, (_, i) =>
          i + 1 === at ? h('strong', {}, i + 1) : h('a', {href: i ? `#/page/${i + 1}` : '#/'}, i + 1),
        ),
      ),
    )
  }
  return out
}

// --- the catalog -------------------------------------------------------------

export type Sort = 'bump' | 'new' | 'replies'

export function catalog(sort: Sort, search: string, ctx: Ctx) {
  let all = threads(ctx.janitorView)
  if (sort === 'new') all = all.sort((a, b) => b.op.id - a.op.id)
  if (sort === 'replies') all = all.sort((a, b) => b.replies.length - a.replies.length || b.bump - a.bump)
  const q = search.trim().toLowerCase()
  if (q) all = all.filter((t) => `${t.op.subject}\n${t.op.body}`.toLowerCase().includes(q))
  const grid = h('div', {class: 'catalog'})
  if (!all.length) grid.append(h('p', {class: 'empty'}, q ? 'No thread matches.' : 'No threads yet. Start one.'))
  for (const t of all) {
    const href = `#/thread/${t.op.id}`
    grid.append(
      h(
        'div',
        {class: `card-thread${gone(t.op.id) ? ' is-removed' : ''}`, 'data-id': t.op.id},
        file(t.op, href),
        h('div', {class: 'meta'}, 'R: ', h('b', {}, t.replies.length), ' / I: ', h('b', {}, t.images)),
        h(
          'a',
          {class: 'teaser', href},
          t.op.subject ? h('b', {}, t.op.subject, t.op.body ? ': ' : '') : null,
          t.op.body.length > 160 ? t.op.body.slice(0, 160) + '…' : t.op.body,
        ),
      ),
    )
  }
  return grid
}

// --- a thread ----------------------------------------------------------------

export function thread(id: number, ctx: Ctx) {
  const t = threads(ctx.janitorView).find((x) => x.op.id === id)
  if (!t) {
    const p = posts.get(id)
    if (p && p.id !== p.thread) return {el: null, redirect: `#/thread/${p.thread}/p${p.id}`}
    return {el: h('p', {class: 'empty'}, posts.size ? `There is no thread ${id} on this board.` : 'Reading the board…'), redirect: null}
  }
  return {
    el: h(
      'div',
      {class: 'thread-view'},
      h(
        'p',
        {class: 'stats'},
        `${t.replies.length} ${t.replies.length === 1 ? 'reply' : 'replies'} / ${t.images + 1} ${t.images ? 'images' : 'image'} / ${t.posters} ${t.posters === 1 ? 'poster' : 'posters'}`,
      ),
      h('section', {class: 'thread'}, post(t.op, ctx), t.replies.map((r) => post(r, ctx))),
    ),
    redirect: null,
  }
}
