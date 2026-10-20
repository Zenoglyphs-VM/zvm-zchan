// The post form: "Start a New Thread" on the index and catalog, "Post a
// Reply" in a thread. A post is one transaction; the form measures its gas,
// checks the wallet can pay for it, has the wallet sign, and waits for the
// Posted event that gives the post its number.
//
// Both forms open as a box in the page's bottom right, 4chan's quick reply,
// so a long thread need not be scrolled back up to answer it; the button
// that opens one stays at the top of the page.
//
// A wallet with a handle chooses, per post, whether to sign with it; the
// choice starts at Anonymous every time the page loads.
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  toHex,
  type Hex,
} from 'viem'
import {zchanAbi} from './abi'
import {connect, fees, me, reader, send, txUrl} from './chain'
import {FAUCET, MAX_BODY, MAX_SUBJECT, TIP, ZCHAN} from './config'
import {h} from './dom'
import {prepare, size, type Prepared} from './image'

const utf8 = (s: string) => new TextEncoder().encode(s).length

const REASONS: Record<string, string> = {
  ThreadNeedsImage: 'A thread starts with an image.',
  EmptyReply: 'Write a comment or add an image.',
  SubjectTooLong: `The subject is over ${MAX_SUBJECT} bytes.`,
  BodyTooLong: `The comment is over ${MAX_BODY} bytes.`,
  ImageTooLarge: 'The image is over 64 KiB.',
  NoSuchThread: 'That thread does not exist.',
  ThreadRemoved: 'That thread is off the board; it takes no more replies.',
  NoHandle: 'This wallet has no handle to post as.',
  ReplyHasSubject: 'A reply has no subject.',
}

// reason turns a failure into a sentence. A revert reached through
// estimateGas carries only its data, so the error is decoded here.
function reason(err: any): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    let name = revert?.data?.errorName
    if (!name) {
      const raw = err.walk((e: any) => typeof e?.data === 'string' && /^0x[0-9a-f]{8}/i.test(e.data)) as any
      try {
        if (raw) name = decodeErrorResult({abi: zchanAbi, data: raw.data}).errorName
      } catch {}
    }
    return (name && REASONS[name]) || err.shortMessage
  }
  return err?.message ?? String(err)
}

export class PostForm {
  readonly el: HTMLElement
  thread = 0
  private image: Prepared | null = null
  private subject?: HTMLInputElement
  private comment: HTMLTextAreaElement
  private sage?: HTMLInputElement
  private postAs: HTMLSelectElement
  private postAsLabel: HTMLElement
  private fileInput: HTMLInputElement
  private preview: HTMLElement
  private counter: HTMLElement
  private feeLine: HTMLElement
  private note: HTMLElement
  private steps: HTMLOListElement
  private button: HTMLButtonElement
  private body: HTMLElement
  private toggle: HTMLButtonElement
  private busy = false
  private estimateTimer = 0

  constructor(
    readonly kind: 'thread' | 'reply',
    private posted: (id: number, thread: number) => void,
  ) {
    const reply = kind === 'reply'
    this.toggle = h(
      'button',
      {class: 'open-form', type: 'button', onclick: (() => this.open()) as EventListener},
      reply ? 'Post a Reply' : 'Start a New Thread',
    )
    this.comment = h('textarea', {rows: 5, placeholder: 'Comment', 'aria-label': 'Comment', spellcheck: 'true'}) as HTMLTextAreaElement
    this.fileInput = h('input', {type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', 'aria-label': 'Image'}) as HTMLInputElement
    this.preview = h('div', {class: 'preview', hidden: true})
    this.counter = h('span', {class: 'counter'})
    this.feeLine = h('span', {class: 'fee'})
    this.note = h('p', {class: 'form-note'})
    this.steps = h('ol', {class: 'tx-steps'}) as HTMLOListElement
    this.button = h('button', {class: 'btn btn-plasma', type: 'submit'}, 'Post') as HTMLButtonElement
    if (!reply) this.subject = h('input', {class: 'input', placeholder: 'Subject', 'aria-label': 'Subject', maxlength: MAX_SUBJECT}) as HTMLInputElement
    if (reply) this.sage = h('input', {type: 'checkbox'}) as HTMLInputElement
    this.postAs = h('select', {class: 'input', 'aria-label': 'Post as'}) as HTMLSelectElement
    this.postAsLabel = h('label', {class: 'post-as', hidden: true}, 'Post as', this.postAs)
    this.postAs.addEventListener('change', () => this.estimateSoon())

    const form = h(
      'form',
      {class: 'post-form', novalidate: true},
      h(
        'div',
        {class: 'form-head'},
        h('span', {}, reply ? 'Reply' : 'New thread'),
        h('button', {class: 'close', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: (() => this.close()) as EventListener}, '×'),
      ),
      this.postAsLabel,
      this.subject ?? null,
      this.comment,
      h(
        'div',
        {class: 'form-row'},
        h('label', {class: 'file-pick'}, this.fileInput, h('span', {}, reply ? 'Image (optional)' : 'Image')),
        this.sage ? h('label', {class: 'check', title: 'Reply without bumping the thread'}, this.sage, ' sage') : null,
        this.counter,
      ),
      this.preview,
      h('div', {class: 'form-row'}, this.button, this.feeLine),
      this.note,
      this.steps,
    )
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.submit()
    })
    this.body = h('div', {class: 'form-body quick', hidden: true}, form)
    this.body.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close()
    })
    this.el = h('div', {class: `post-form-wrap ${kind}`}, this.toggle, this.body)

    const changed = () => {
      this.count()
      this.estimateSoon()
    }
    this.comment.addEventListener('input', changed)
    this.subject?.addEventListener('input', changed)
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0]
      if (f) void this.attach(f)
    })
    // An image pasted or dropped onto the comment is attached, as 4chan's
    // quick reply allows.
    this.comment.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'))
      if (f) {
        e.preventDefault()
        void this.attach(f)
      }
    })
    this.el.addEventListener('dragover', (e) => e.preventDefault())
    this.el.addEventListener('drop', (e) => {
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'))
      if (f) {
        e.preventDefault()
        this.open()
        void this.attach(f)
      }
    })
    this.count()
  }

  // setHandle offers the wallet's handle beside Anonymous, keeping the
  // choice if the handle is the same one. For the owner or a janitor the
  // handle is named with its capcode, because a staff wallet's signed post is
  // shown as a staff post: that option is how the owner posts as Admin.
  setHandle(name: string, capcode: '' | 'Admin' | 'Janitor' = '') {
    const was = this.postAs.value
    const label = capcode ? `${name} ## ${capcode}` : name
    this.postAs.replaceChildren(h('option', {value: ''}, 'Anonymous'), ...(name ? [h('option', {value: name}, label)] : []))
    this.postAs.value = name && was === name ? name : ''
    this.postAsLabel.hidden = !name
  }

  // focus puts the cursor in the comment, opening the form if need be.
  focus() {
    this.open()
    this.comment.focus()
  }

  setThread(id: number) {
    if (this.thread !== id) {
      this.thread = id
      this.estimateSoon()
    }
  }

  open() {
    this.body.hidden = false
  }

  close() {
    this.body.hidden = true
  }

  quote(id: number) {
    this.open()
    const c = this.comment
    const at = c.selectionStart ?? c.value.length
    const before = c.value.slice(0, at)
    const add = `${before && !before.endsWith('\n') ? '\n' : ''}>>${id}\n`
    c.value = before + add + c.value.slice(at)
    c.focus()
    c.selectionStart = c.selectionEnd = at + add.length
    this.count()
    this.estimateSoon()
  }

  private say(text: string | (Node | string)[], bad = false) {
    this.note.replaceChildren(...(typeof text === 'string' ? [text] : text))
    this.note.classList.toggle('bad', bad)
  }

  private count() {
    const n = utf8(this.comment.value)
    this.counter.textContent = `${n} / ${MAX_BODY}`
    this.counter.classList.toggle('over', n > MAX_BODY)
  }

  private async attach(f: File) {
    this.say('Preparing the image…')
    try {
      const img = await prepare(f)
      if (this.image) URL.revokeObjectURL(this.image.url)
      this.image = img
      this.preview.hidden = false
      this.preview.replaceChildren(
        h('img', {src: img.url, alt: ''}),
        h(
          'div',
          {},
          h('div', {class: 'mono'}, `${size(img.bytes.length)} ${img.kind.ext.toUpperCase()}, ${img.width}x${img.height}`),
          h('div', {class: 'dim'}, img.kept ? 'Posted as it is.' : `Re-encoded from ${size(img.from)}, without its metadata.`),
          h('button', {class: 'link-button', type: 'button', onclick: (() => this.detach()) as EventListener}, 'Remove'),
        ),
      )
      this.say('')
    } catch (err: any) {
      this.detach()
      this.say(err.message, true)
    }
    this.estimateSoon()
  }

  private detach() {
    if (this.image) URL.revokeObjectURL(this.image.url)
    this.image = null
    this.fileInput.value = ''
    this.preview.hidden = true
    this.preview.replaceChildren()
    this.estimateSoon()
  }

  private data(): Hex {
    return encodeFunctionData({
      abi: zchanAbi,
      functionName: 'post',
      args: [
        BigInt(this.kind === 'reply' ? this.thread : 0),
        (this.sage?.checked ? 1 : 0) | (this.postAs.value ? 2 : 0),
        this.subject?.value.trim() ?? '',
        this.comment.value.replace(/\s+$/, ''),
        this.image ? toHex(this.image.bytes) : '0x',
      ],
    })
  }

  // The fee shown is what the post will likely cost: its gas at this block's
  // base fee plus the tip. The wallet is asked to allow up to twice the base
  // fee, which it keeps if unspent.
  private estimateSoon() {
    clearTimeout(this.estimateTimer)
    this.estimateTimer = window.setTimeout(() => void this.estimate(), 350)
  }

  private async estimate(): Promise<bigint | null> {
    const empty = !this.image && !this.comment.value.trim()
    if (empty) {
      this.feeLine.textContent = ''
      return null
    }
    try {
      const gas = await reader.estimateGas({account: me ?? ZCHAN, to: ZCHAN, data: this.data()})
      const {base} = await fees()
      this.feeLine.textContent = `about ${Number(formatEther(gas * (base + TIP))).toFixed(4)} ZNN`
      return gas
    } catch {
      this.feeLine.textContent = ''
      return null
    }
  }

  private step(label: string) {
    const name = h('span', {}, label)
    const state = h('span', {class: 'state'})
    const li = h('li', {'data-state': 'busy'}, name, state)
    this.steps.prepend(li)
    while (this.steps.children.length > 3) this.steps.lastElementChild!.remove()
    return (text: string, kind: 'busy' | 'done' | 'failed', hash?: Hex) => {
      li.dataset.state = kind
      state.className = `state ${kind}`
      state.replaceChildren(hash ? h('a', {href: txUrl(hash), target: '_blank', rel: 'noopener'}, `${text} ${hash.slice(0, 10)}…`) : text)
    }
  }

  private validate(): string | null {
    const subject = utf8(this.subject?.value.trim() ?? '')
    const body = utf8(this.comment.value.replace(/\s+$/, ''))
    if (subject > MAX_SUBJECT) return REASONS.SubjectTooLong
    if (body > MAX_BODY) return REASONS.BodyTooLong
    if (this.kind === 'thread' && !this.image) return REASONS.ThreadNeedsImage
    if (this.kind === 'reply' && !this.image && !body) return REASONS.EmptyReply
    return null
  }

  private async submit() {
    if (this.busy) return
    const invalid = this.validate()
    if (invalid) return this.say(invalid, true)
    this.busy = true
    this.button.disabled = true
    this.say('')
    const set = this.step(this.kind === 'reply' ? `Reply to No.${this.thread}` : 'New thread')
    try {
      set('connecting your wallet', 'busy')
      const from = await connect()
      const data = this.data()
      set('measuring', 'busy')
      const gas = await reader.estimateGas({account: from, to: ZCHAN, data})
      const limit = (gas * 13n) / 10n
      const {maxFeePerGas} = await fees()
      const need = limit * maxFeePerGas
      const held = await reader.getBalance({address: from})
      if (held < need) {
        throw new Error(
          `This wallet holds ${Number(formatEther(held)).toFixed(4)} ZNN and the post may cost up to ${Number(formatEther(need)).toFixed(4)}.`,
        )
      }
      set('waiting for your wallet', 'busy')
      const hash = await send(data, limit)
      set('landing', 'busy', hash)
      const r = await reader.waitForTransactionReceipt({hash, pollingInterval: 2_000, timeout: 600_000})
      if (r.status !== 'success') throw new Error('The transaction reverted.')
      let id = 0
      let thread = 0
      for (const l of r.logs) {
        if (l.address.toLowerCase() !== ZCHAN.toLowerCase()) continue
        try {
          const ev = decodeEventLog({abi: zchanAbi, data: l.data, topics: l.topics})
          if (ev.eventName === 'Posted') {
            id = Number(ev.args.id)
            thread = Number(ev.args.thread)
          }
        } catch {}
      }
      set(`posted No.${id}`, 'done', hash)
      this.comment.value = ''
      if (this.subject) this.subject.value = ''
      if (this.sage) this.sage.checked = false
      this.detach()
      this.count()
      // The box goes away once its post is in, as 4chan's quick reply does;
      // the new post is scrolled to and marked.
      this.close()
      this.posted(id, thread)
    } catch (err: any) {
      const text = reason(err)
      set(text.length > 90 ? 'failed' : text, 'failed')
      if (/holds .* ZNN/.test(text)) this.say([text, ' ', h('a', {href: FAUCET, target: '_blank', rel: 'noopener'}, 'Get ZNN from the faucet.')], true)
      else this.say(text, true)
    } finally {
      this.busy = false
      this.button.disabled = false
    }
  }
}
