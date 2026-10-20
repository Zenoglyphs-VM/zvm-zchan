// What the deploy, keys and check scripts share: the chain, the artifact, the
// deployment record and the janitor's secrets file.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'

export const root = new URL('../../', import.meta.url)
export const artifact = JSON.parse(readFileSync(new URL('contracts/out/ZChan.json', root), 'utf8'))

export function flag(name, fallback) {
  const i = process.argv.indexOf(`-${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

// The chain is the node's, asked once, so a script signs for whichever ZVM it
// is pointed at rather than always for one chain.
export async function clients(rpc) {
  const id = await createPublicClient({transport: http(rpc)}).getChainId()
  const chain = defineChain({
    id,
    name: `ZVM ${id}`,
    nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18},
    rpcUrls: {default: {http: [rpc]}},
  })
  return {chain, reader: createPublicClient({chain, transport: http(rpc)})}
}

export function signer(chain, rpc, key) {
  return createWalletClient({account: privateKeyToAccount(key), chain, transport: http(rpc)})
}

// zvm's deterministic devnet key, keccak256("zvm-dev-evm-<i>"), the same
// derivation as zvm's devnet.EVMKey. Index 900 is the devnet deployer. It is
// public, so it only ever pays; it never holds a role.
export const devKey = (i) => keccak256(toBytes(`zvm-dev-evm-${i}`))

// The relayer refuses a tip under 50 gwei; zvm's own senders offer 100.
export const TIP = 100_000_000_000n

export async function fees(reader) {
  const block = await reader.getBlock()
  return {maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + TIP, maxPriorityFeePerGas: TIP}
}

export function loadJSON(url) {
  return existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : null
}

export function saveJSON(url, value) {
  mkdirSync(new URL('.', url), {recursive: true})
  const tmp = new URL(url.href + '.tmp')
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, url)
}
