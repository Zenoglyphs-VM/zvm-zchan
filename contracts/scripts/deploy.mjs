// Puts zchan on the ZVM: tops the owner's and the janitor's gas up from the
// devnet wallet, deploys the board naming both, and verifies the source on
// the explorer. Each step checks the chain first, so a stopped deploy is finished
// by running it again.
//
//   node scripts/deploy.mjs [-rpc url, default $ZVM_RPC] [-api url, default $ZVM_NODE]
//                           [-keys secrets/zchan.json] [-record deployments/zvm.json]
//                           [-funder 900] [-gas 5]
//
// Paths are relative to the repository root.
import {encodeDeployData, parseEther} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {artifact, clients, devKey, fees, flag, loadJSON, root, saveJSON, signer} from './lib.mjs'

const rpc = flag('rpc', process.env.ZVM_RPC)
if (!rpc) throw new Error('pass -rpc, or set ZVM_RPC')
const api = flag('api', process.env.ZVM_NODE)
const keys = loadJSON(new URL(flag('keys', 'secrets/zchan.json'), root))
const recordUrl = new URL(flag('record', 'deployments/zvm.json'), root)
const funderKey = devKey(Number(flag('funder', '900')))
const roleGas = parseEther(flag('gas', '5'))
if (!keys?.owner || !keys?.janitor) throw new Error('no keys: run `npm run keys` first')

const {chain, reader} = await clients(rpc)
const funder = signer(chain, rpc, funderKey)
const owner = privateKeyToAccount(keys.owner).address
const janitor = privateKeyToAccount(keys.janitor).address
const rec = loadJSON(recordUrl) ?? {chainId: chain.id, txs: {}}
if (rec.chainId !== chain.id) throw new Error(`record is for chain ${rec.chainId}`)
const save = () => saveJSON(recordUrl, rec)

async function send(label, tx) {
  const hash = await funder.sendTransaction({...tx, ...(await fees(reader))})
  console.log(`${label}: ${hash}`)
  const r = await reader.waitForTransactionReceipt({hash, pollingInterval: 2_000, timeout: 600_000})
  if (r.status !== 'success') throw new Error(`${label} reverted`)
  return r
}

// The owner and the janitor pay for their own calls, so each holds a little
// ZNN.
for (const [role, address] of [['owner', owner], ['janitor', janitor]]) {
  const held = await reader.getBalance({address})
  if (held >= roleGas) continue
  const r = await send(`fund ${role}`, {to: address, value: roleGas - held})
  rec.txs[`fund-${role}-${r.blockNumber}`] = r.transactionHash
  save()
}

const deployed = rec.zchan && (await reader.getCode({address: rec.zchan}))?.length > 2
if (!deployed) {
  const r = await send('deploy', {
    data: encodeDeployData({abi: artifact.abi, bytecode: artifact.bytecode, args: [owner, janitor]}),
  })
  Object.assign(rec, {
    zchan: r.contractAddress,
    owner,
    janitor,
    startBlock: Number(r.blockNumber),
    deployedAt: new Date().toISOString(),
  })
  rec.txs.deploy = r.transactionHash
  delete rec.verified
  save()
}

if (api && !rec.verified) {
  rec.verified = await verify(api.replace(/\/$/, ''), rec.zchan)
  save()
}
console.log(`zchan     ${rec.zchan}\nowner     ${rec.owner}\njanitor   ${rec.janitor}\nstart     ${rec.startBlock}\nverified  ${rec.verified ?? 'no'}`)

// verify submits the standard JSON input to the node's verifier and waits
// for its verdict.
async function verify(base, address) {
  const res = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      address,
      compiler: artifact.compilerVersion,
      contract: `${artifact.sourceName}:${artifact.contractName}`,
      input: artifact.standardJsonInput,
    }),
  })
  let job = await res.json().catch(() => ({}))
  if (!job.id) {
    if (/already verified/i.test(`${job.error ?? ''}${job.message ?? ''}`)) return 'already verified'
    throw new Error(`verify: ${res.status} ${job.error ?? ''}${job.message ?? ''}`)
  }
  const end = Date.now() + 600_000
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > end) throw new Error(`verify job ${job.id} still ${job.status} after 10 minutes`)
    await new Promise((r) => setTimeout(r, 3000))
    job = await (await fetch(`${base}/api/verify/${job.id}`)).json()
  }
  if (job.status !== 'verified') throw new Error(`verify: ${job.status}: ${job.message}`)
  return job.match || 'verified'
}
