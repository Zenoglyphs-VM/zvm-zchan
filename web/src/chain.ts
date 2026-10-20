// The chain, both ways: reading the board's logs, and the wallet that signs a
// post. Reads never need a wallet; the page is readable with none installed.
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  http,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import {CHAIN_ID, EXPLORER, DEFAULT_RPC, RPC, TIP, ZCHAN} from './config'

export const zvm = defineChain({
  id: CHAIN_ID,
  name: 'ZVM testnet',
  nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18},
  rpcUrls: {default: {http: [RPC]}},
})
export const reader = createPublicClient({chain: zvm, transport: http(RPC)})

export interface RawLog {
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  blockTimestamp?: Hex
  transactionHash: Hex
  logIndex: Hex
  removed?: boolean
}

// getLogs asks for the board's logs in a range, halving the range whenever
// the node refuses it: zvm's node caps a reply at 20,000 logs, and other
// nodes cap the range instead. A single block that still fails is an error.
export async function getLogs(from: bigint, to: bigint, topics: (Hex | Hex[] | null)[]): Promise<RawLog[]> {
  try {
    return (await reader.request({
      method: 'eth_getLogs',
      params: [{address: ZCHAN, fromBlock: toHex(from), toBlock: toHex(to), topics}],
    } as any)) as RawLog[]
  } catch (err) {
    if (to <= from) throw err
    const mid = (from + to) / 2n
    return [...(await getLogs(from, mid, topics)), ...(await getLogs(mid + 1n, to, topics))]
  }
}

// Logs from op-reth carry their block's timestamp; for a node whose logs do
// not, the block is read once and remembered.
const times = new Map<string, Promise<number>>()
export function logTime(l: RawLog): Promise<number> {
  if (l.blockTimestamp) return Promise.resolve(Number(l.blockTimestamp))
  let t = times.get(l.blockNumber)
  if (!t) {
    t = reader.getBlock({blockNumber: BigInt(l.blockNumber)}).then((b) => Number(b.timestamp))
    times.set(l.blockNumber, t)
  }
  return t
}

export const txUrl = (hash: Hex) => `${EXPLORER}/tx/${hash}`
export const addressUrl = (a: Address) => `${EXPLORER}/address/${a}`

// --- the wallet --------------------------------------------------------------

const wallets = new Map<string, any>()
window.addEventListener('eip6963:announceProvider', (e: any) => {
  if (e.detail?.info?.uuid) wallets.set(e.detail.info.uuid, e.detail.provider)
})
window.dispatchEvent(new Event('eip6963:requestProvider'))

let provider: any = null
export let me: Address | null = null
const listeners = new Set<() => void>()
export const onAccount = (fn: () => void) => listeners.add(fn)
const changed = () => listeners.forEach((fn) => fn())

const pickProvider = (): any => [...wallets.values()][0] ?? (window as any).ethereum ?? null

async function onChain(p: any) {
  const hexId = '0x' + CHAIN_ID.toString(16)
  try {
    await p.request({method: 'wallet_switchEthereumChain', params: [{chainId: hexId}]})
  } catch (err: any) {
    const code = err?.code ?? err?.data?.originalError?.code
    if (code !== 4902 && code !== -32603) throw err
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: 'ZVM testnet (Zenon based rollup)',
          nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18},
          rpcUrls: [DEFAULT_RPC],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    })
  }
}

// Disconnecting is remembered, so a reload does not quietly reconnect a
// wallet that still trusts the page. Losing the note costs one extra click.
const DISCONNECTED = 'zchan.disconnected'
function remember(off: boolean) {
  try {
    if (off) localStorage.setItem(DISCONNECTED, '1')
    else localStorage.removeItem(DISCONNECTED)
  } catch {}
}
function chosenOff() {
  try {
    return localStorage.getItem(DISCONNECTED) === '1'
  } catch {
    return false
  }
}

const listening = new WeakSet<object>()

export async function connect(): Promise<Address> {
  if (me && provider) return me
  provider = pickProvider()
  if (!provider) {
    const here = location.href.replace(/^https?:\/\//, '')
    throw new Error(`No wallet in this browser. On a phone, open this page in MetaMask's app: https://metamask.app.link/dapp/${here}`)
  }
  const accounts: string[] = await provider.request({method: 'eth_requestAccounts'})
  if (!accounts?.length) throw new Error('The wallet shared no account.')
  me = getAddress(accounts[0])
  remember(false)
  if (!listening.has(provider)) {
    listening.add(provider)
    provider.on?.('accountsChanged', (a: string[]) => {
      me = a?.length ? getAddress(a[0]) : null
      if (!me) provider = null
      changed()
    })
  }
  changed()
  return me
}

// disconnect asks the wallet to forget the page too, where it can. A wallet
// that cannot is still disconnected here until Connect is pressed again.
export async function disconnect() {
  const p = provider ?? pickProvider()
  me = null
  provider = null
  remember(true)
  changed()
  try {
    await p?.request({method: 'wallet_revokePermissions', params: [{eth_accounts: {}}]})
  } catch {}
}

export function reconnect() {
  if (chosenOff()) return
  pickProvider()
    ?.request({method: 'eth_accounts'})
    .then((a: string[]) => (a?.length ? connect() : null))
    .catch(() => {})
}

export async function fees() {
  const block = await reader.getBlock()
  const base = block.baseFeePerGas ?? 0n
  return {base, maxFeePerGas: base * 2n + TIP, maxPriorityFeePerGas: TIP}
}

// send has the wallet sign one call to the board, with the gas measured here
// and a margin, since a wallet's own estimate of a large post is often short.
export async function send(data: Hex, gas: bigint, value = 0n): Promise<Hex> {
  const from = await connect()
  await onChain(provider)
  const signer = createWalletClient({account: from, chain: zvm, transport: custom(provider)})
  const {maxFeePerGas, maxPriorityFeePerGas} = await fees()
  return signer.sendTransaction({to: ZCHAN, data, gas, value, maxFeePerGas, maxPriorityFeePerGas})
}

// call measures, sends and waits for one call to the board, and throws if it
// reverted. The small calls (a handle, a removal, the owner's) go through here.
export async function call(data: Hex, value = 0n): Promise<Hex> {
  const from = await connect()
  const gas = ((await reader.estimateGas({account: from, to: ZCHAN, data, value})) * 13n) / 10n
  const hash = await send(data, gas, value)
  const r = await reader.waitForTransactionReceipt({hash, pollingInterval: 2_000, timeout: 600_000})
  if (r.status !== 'success') throw new Error('The transaction reverted.')
  return hash
}
