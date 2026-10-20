// Where the board is, and the limits the page holds a post to before a wallet
// is asked to sign it. The limits are the contract's; the page checks them
// first only so a mistake costs nothing.
import {getAddress} from 'viem'
import {record as deployed} from './deployment'

// boot.ts starts the page only when the record is there.
const record = deployed!

export const ZCHAN = getAddress(record.zchan)
export const START_BLOCK = BigInt(record.startBlock)
export const CHAIN_ID = record.chainId

// The node this board reads, and where the other apps are, come from the
// environment (see .env.example), so no node is written into the source.
// VITE_ZVM_NODE is a ZVM node's base URL, its JSON-RPC at /rpc; a local
// zvm-devnet's is http://localhost:47080/zvm. ?rpc= points one visit at
// another node of the same chain (the live check uses a local one).
const NODE = import.meta.env.VITE_ZVM_NODE.replace(/\/+$/, '')
const GATEWAY = import.meta.env.VITE_GATEWAY.replace(/\/+$/, '')
export const DEFAULT_RPC = `${NODE}/rpc`
export const RPC = new URLSearchParams(location.search).get('rpc') ?? DEFAULT_RPC
export const EXPLORER = `${GATEWAY}/explorer`
export const FAUCET = `${GATEWAY}/glyphswap/faucet`

export const MAX_SUBJECT = 100
export const MAX_BODY = 4000
export const MAX_IMAGE = 65536
// What a re-encoded image aims for. A byte of image costs about 48 gas (the
// calldata floor plus the log), so this is roughly 2.4M gas, and leaves the
// rest of the contract's 64 KiB for a GIF posted as it is.
export const IMAGE_TARGET = 48 * 1024
export const IMAGE_EDGE = 1024

// 4chan's numbers: a thread stops bumping at 300 replies; the index shows ten
// threads a page with their last five replies.
export const BUMP_LIMIT = 300
export const THREADS_PER_PAGE = 10
export const PREVIEW_REPLIES = 5

// The relayer refuses a tip under 50 gwei; zvm's own senders offer 100.
export const TIP = 100_000_000_000n
