// The handle page: registering a name to sign posts with, 4chan's tripcode as
// a name a wallet holds, and the owner's tools, shown only to the owner.
//
// A name is held by one wallet for good, so a name on a post always means the
// same poster. Holding one unmasks nothing by itself: each post chooses
// between the name and Anonymous, and Anonymous is the default.
import {formatEther, encodeFunctionData, getAddress, isAddress, type Address} from 'viem'
import {zchanAbi} from './abi'
import * as board from './board'
import {addressUrl, call, connect, me, reader} from './chain'
import {ZCHAN} from './config'
import {h, infoTip} from './dom'

const NAME = /^[A-Za-z0-9_]{2,16}$/

// --- the connected wallet's handle -----------------------------------------

export let handle = ''
const listeners = new Set<() => void>()
export const onHandle = (fn: () => void) => listeners.add(fn)

export async function refreshHandle() {
  const next = me ? await reader.readContract({address: ZCHAN, abi: zchanAbi, functionName: 'handleOf', args: [me]}).catch(() => '') : ''
  if (next !== handle) {
    handle = next
    listeners.forEach((fn) => fn())
  }
}

async function holderOf(name: string): Promise<Address> {
  return reader.readContract({address: ZCHAN, abi: zchanAbi, functionName: 'holder', args: [name]})
}

const errorText = (err: any) => err?.shortMessage ?? err?.message ?? String(err)

// --- the page ----------------------------------------------------------------

export class AccountPanel {
  readonly el: HTMLElement
  private current = h('p', {class: 'current'})
  private input = h('input', {class: 'input mono', placeholder: 'name', maxlength: 16, 'aria-label': 'Handle', autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement
  private status = h('span', {class: 'avail'})
  private button = h('button', {class: 'btn btn-plasma', type: 'submit'}, 'Register for 1 ZNN') as HTMLButtonElement
  private note = h('p', {class: 'form-note'})
  private ownerBox = h('section', {class: 'panel', hidden: true})
  private janitorList = h('ul', {class: 'janitors'})
  private checkTimer = 0
  private busy = false

  constructor(private toast: (text: string, bad?: boolean) => void) {
    const form = h(
      'form',
      {class: 'handle-form'},
      h('div', {class: 'handle-row'}, this.input, this.button),
      this.status,
      this.note,
    )
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.register()
    })
    this.input.addEventListener('input', () => {
      clearTimeout(this.checkTimer)
      this.checkTimer = window.setTimeout(() => void this.check(), 300)
    })

    this.el = h(
      'div',
      {class: 'account'},
      h(
        'section',
        {class: 'panel'},
        h('h2', {}, 'Handle', infoTip('A name only your wallet can post with.')),
        this.current,
        form,
      ),
      h('section', {class: 'panel'}, h('h2', {}, 'Janitors', infoTip('They can take a post off the board. The owner appoints them.')), this.janitorList),
      this.ownerBox,
    )
    this.refresh()
  }

  // refresh redraws what depends on the wallet and the board, and never the
  // name being typed.
  refresh() {
    this.current.replaceChildren(
      !me
        ? h('span', {}, h('button', {class: 'link-button', type: 'button', onclick: (() => void connect().catch((e) => this.toast(e.message, true))) as EventListener}, 'Connect a wallet'), ' to register one.')
        : handle
          ? h('span', {}, 'You post as ', h('span', {class: 'name handle'}, handle, h('i')), ' when you choose to.')
          : h('span', {}, 'This wallet has no handle yet.'),
    )
    this.janitorList.replaceChildren(
      ...[...board.janitors].map((j) =>
        h(
          'li',
          {},
          h('a', {class: 'mono', href: addressUrl(j as Address), target: '_blank', rel: 'noopener'}, getAddress(j)),
          me && j === me.toLowerCase() ? h('span', {class: 'dim'}, ' (you)') : null,
          board.isOwner(me)
            ? h('button', {class: 'jan', type: 'button', onclick: (() => void this.setJanitor(j as Address, false)) as EventListener}, 'dismiss')
            : null,
        ),
      ),
    )
    if (!board.janitors.size) this.janitorList.append(h('li', {class: 'dim'}, 'None.'))
    this.ownerBox.hidden = !board.isOwner(me)
    if (board.isOwner(me)) void this.drawOwner()
  }

  private async check(): Promise<'free' | 'yours' | 'taken' | 'bad'> {
    const name = this.input.value.trim()
    this.note.textContent = ''
    if (!name) {
      this.status.textContent = ''
      this.button.textContent = 'Register for 1 ZNN'
      return 'bad'
    }
    if (!NAME.test(name)) {
      this.status.textContent = '2 to 16 letters, digits or _'
      this.status.className = 'avail bad'
      return 'bad'
    }
    const holder = await holderOf(name).catch(() => null)
    if (name !== this.input.value.trim()) return 'bad' // typed on since
    if (!holder) {
      this.status.textContent = 'could not reach the node'
      this.status.className = 'avail bad'
      return 'bad'
    }
    if (/^0x0+$/.test(holder)) {
      this.status.textContent = `${name} is free`
      this.status.className = 'avail ok'
      this.button.textContent = 'Register for 1 ZNN'
      return 'free'
    }
    if (me && holder.toLowerCase() === me.toLowerCase()) {
      this.status.textContent = handle === name ? 'your current handle' : 'yours already: switching to it is free'
      this.status.className = 'avail ok'
      this.button.textContent = 'Use this name'
      return 'yours'
    }
    this.status.textContent = `${name} is taken`
    this.status.className = 'avail bad'
    return 'taken'
  }

  private async register() {
    if (this.busy) return
    this.busy = true
    this.button.disabled = true
    try {
      await connect()
      const state = await this.check()
      if (state === 'bad' || state === 'taken') return
      const name = this.input.value.trim()
      const value = state === 'free' ? await reader.readContract({address: ZCHAN, abi: zchanAbi, functionName: 'HANDLE_FEE'}) : 0n
      if (value) {
        const held = await reader.getBalance({address: me!})
        if (held < value) throw new Error(`A handle costs 1 ZNN and this wallet holds ${Number(formatEther(held)).toFixed(4)}.`)
      }
      this.note.textContent = 'Waiting for your wallet, then for the chain…'
      this.note.className = 'form-note'
      await call(encodeFunctionData({abi: zchanAbi, functionName: 'register', args: [name]}), value)
      await refreshHandle()
      this.input.value = ''
      this.status.textContent = ''
      this.note.textContent = `Done. Choose ${name} under "Post as" when you post.`
      this.refresh()
    } catch (err) {
      this.note.textContent = errorText(err)
      this.note.className = 'form-note bad'
    } finally {
      this.busy = false
      this.button.disabled = false
    }
  }

  // --- the owner's tools -----------------------------------------------------

  private async drawOwner() {
    const balance = await reader.getBalance({address: ZCHAN}).catch(() => null)
    const add = h('input', {class: 'input mono', placeholder: '0x… a new janitor', 'aria-label': 'New janitor', autocomplete: 'off'}) as HTMLInputElement
    this.ownerBox.replaceChildren(
      h('h2', {}, 'Owner'),
      h(
        'div',
        {class: 'handle-row'},
        h('span', {}, 'Fees held: ', h('b', {class: 'mono'}, balance === null ? '?' : `${formatEther(balance)} ZNN`)),
        h(
          'button',
          {
            class: 'btn btn-small',
            type: 'button',
            disabled: !balance,
            onclick: (() => void this.run('Withdrawn to your wallet.', encodeFunctionData({abi: zchanAbi, functionName: 'withdraw', args: [me!, 0n]}))) as EventListener,
          },
          'Withdraw all',
        ),
      ),
      // The contract lets only janitors take posts down, and owning the board
      // does not make one a janitor. One call does.
      ...(board.isJanitor(me)
        ? []
        : [h(
            'div',
            {class: 'handle-row'},
            h(
              'button',
              {
                class: 'btn btn-small',
                type: 'button',
                title: 'Lets this wallet remove and restore posts, as janitors do',
                onclick: (() => void this.setJanitor(me!, true)) as EventListener,
              },
              'Appoint yourself janitor',
            ),
          )]),
      h(
        'form',
        {
          class: 'handle-row',
          onsubmit: ((e: Event) => {
            e.preventDefault()
            const a = add.value.trim()
            if (!isAddress(a)) return this.toast('Not an address.', true)
            void this.setJanitor(getAddress(a), true)
          }) as EventListener,
        },
        add,
        h('button', {class: 'btn btn-small', type: 'submit'}, 'Appoint janitor'),
      ),
    )
  }

  private setJanitor(who: Address, active: boolean) {
    return this.run(active ? 'Janitor appointed.' : 'Janitor dismissed.', encodeFunctionData({abi: zchanAbi, functionName: 'setJanitor', args: [who, active]}))
  }

  private async run(done: string, data: `0x${string}`) {
    try {
      this.toast('Waiting for your wallet…')
      await call(data)
      await board.scan()
      this.toast(done)
      this.refresh()
    } catch (err) {
      this.toast(errorText(err), true)
    }
  }
}
