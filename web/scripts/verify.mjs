// Drives the real page against the ZVM, in headless Chrome, and posts for real.
//
//   node scripts/verify.mjs [rpc, default $ZVM_RPC] [http://localhost:47621/]
//
// A stand-in EIP-6963 wallet signs with a throwaway key the node's faucet
// funds, exactly as MetaMask would. Nothing under the wallet is mocked: the
// relayer posts the transaction to NoM, the deriver derives it, op-reth runs
// it, and the page reads it back from the logs. It opens a thread with an
// image, quotes it from a quick reply, registers a handle and posts once with
// it and once without, watches another wallet's reply arrive, and checks what
// a reader then sees: the image off the chain, the quote link, the backlink,
// "(You)", the handle, "+1 new", the catalog card, the light theme, no
// sideways scroll at 400px, and a janitor's removal. It also loads the
// page once against the public node, which is what GitHub Pages will do.
// Set ZCHAN_SHOTS to a directory to keep screenshots.

import {existsSync, mkdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import puppeteer from 'puppeteer-core'
import {createPublicClient, createWalletClient, defineChain, http, parseAbiItem} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'

const rpc = process.argv[2] ?? process.env.ZVM_RPC
if (!rpc) throw new Error("pass the node's JSON-RPC, or set ZVM_RPC")
const app = process.argv[3] ?? 'http://localhost:47621/'
const apiBase = rpc.replace(/\/rpc$/, '')
const shots = process.env.ZCHAN_SHOTS
if (shots) mkdirSync(shots, {recursive: true})
const record = JSON.parse(readFileSync(new URL('../../deployments/zvm.json', import.meta.url), 'utf8'))
const imagePath = fileURLToPath(new URL('./fixtures/rain.png', import.meta.url))

const started = Date.now()
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${msg}`)

const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p))
if (!chromePath) throw new Error('no Chrome found')

const chain = defineChain({
  id: record.chainId,
  name: 'ZVM',
  nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18},
  rpcUrls: {default: {http: [rpc]}},
})
const client = createPublicClient({chain, transport: http(rpc)})
const account = privateKeyToAccount(generatePrivateKey())
const signer = createWalletClient({account, chain, transport: http(rpc)})
log(`posting as ${account.address}`)

async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const res = await fetch(`${apiBase}/api/faucet`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({address: account.address}),
})
if (!res.ok) throw new Error(`faucet: ${await res.text()}`)
await until(async () => (await client.getBalance({address: account.address})) > 0n, 180_000, 'faucet ZNN')
log(`funded with ${Number(await client.getBalance({address: account.address})) / 1e18} ZNN`)

// --- the stand-in wallet ----------------------------------------------------

async function evmRequest(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [account.address]
    case 'eth_chainId':
      return `0x${chain.id.toString(16)}`
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
    case 'wallet_revokePermissions':
      return null
    case 'eth_sendTransaction': {
      const [tx] = params
      return signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
        maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
      })
    }
    default:
      return client.request({method, params})
  }
}

// A post waits on NoM, which can take minutes on a busy devnet, longer than
// puppeteer's default three-minute protocol timeout.
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
  protocolTimeout: 900_000,
})
const page = await browser.newPage()
await page.setViewport({width: 1280, height: 1000, deviceScaleFactor: 1})

const problems = []
page.on('pageerror', (err) => problems.push(`page error: ${err.message}`))
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))

await page.exposeFunction('__evm', evmRequest)
await page.evaluateOnNewDocument(() => {
  const provider = {request: ({method, params}) => window.__evm(method, params ?? []), on() {}, removeListener() {}}
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({info: {uuid: 'zchan-verify', name: 'Test wallet', icon: '', rdns: 'test.zchan'}, provider}),
      }),
    )
  window.addEventListener('eip6963:requestProvider', announce)
})

const shot = async (name) => shots && page.screenshot({path: join(shots, `${name}.png`), fullPage: true})

/** Waits for the newest step of a form to settle, and fails if it did not
 *  post. A new thread's form leaves the page when its thread opens, so for
 *  that one the thread opening is success. */
async function settle(scope) {
  const sel = `${scope} .tx-steps li`
  const from = await page.evaluate(() => location.hash)
  await page.waitForFunction(
    (sel, from) => {
      const li = document.querySelector(sel)
      if (!li && location.hash !== from && location.hash.startsWith('#/thread/')) return true
      return li && (li.dataset.state === 'done' || li.dataset.state === 'failed')
    },
    {timeout: 400_000, polling: 1000},
    sel,
    from,
  )
  if (!(await page.$(sel))) {
    const id = Number(/^#\/thread\/(\d+)/.exec(await page.evaluate(() => location.hash))[1])
    log(`   ok   the thread opened: ${await page.evaluate(() => location.hash)}`)
    return id
  }
  const step = await page.$eval(sel, (li) => ({state: li.dataset.state, text: li.textContent.replace(/\s+/g, ' ').trim()}))
  log(`   ${step.state === 'done' ? 'ok  ' : 'FAIL'} ${step.text}`)
  if (step.state !== 'done') {
    const note = await page.$eval(`${scope} .form-note`, (el) => el.textContent)
    throw new Error(`posting failed: ${step.text} ${note}`)
  }
  return Number(/posted No\.(\d+)/.exec(step.text)?.[1])
}

function check(ok, what) {
  if (!ok) throw new Error(`not so: ${what}`)
  log(`ok   ${what}`)
}

const loadedBoard = () => page.waitForFunction(() => !document.querySelector('.loading-board'), {timeout: 60_000})

let failed = false
try {
  // --- reading through the public node, as GitHub Pages will ---------------
  await page.goto(app, {waitUntil: 'networkidle2', timeout: 60_000})
  await loadedBoard()
  const head = await page.$eval('#live-text', (el) => el.textContent)
  check(/^block [\d,]+$/.test(head), `reads the board through the public node (${head})`)

  // --- the frame -------------------------------------------------------------
  check((await page.$eval('.brand', (el) => el.textContent.trim())) === '/z/', 'the mark is /z/')
  await page.click('#about-link')
  await page.waitForSelector('.about', {timeout: 10_000})
  const aboutText = (await page.$eval('.about', (el) => el.textContent)).toLowerCase()
  check(aboutText.includes('every post is a transaction') && aboutText.includes(record.zchan.toLowerCase()), 'the about page holds the notes and the contract')

  // --- a new thread ----------------------------------------------------------
  const url = `${app}?rpc=${encodeURIComponent(rpc)}`
  await page.goto(url, {waitUntil: 'networkidle2', timeout: 60_000})
  await loadedBoard()
  await page.click('#connect')
  await page.waitForFunction(() => document.querySelector('#connect').classList.contains('is-connected'), {timeout: 20_000})
  log('wallet connected')

  const scope = '.post-form-wrap.thread'
  await page.click(`${scope} .open-form`)
  const subject = `verify ${new Date().toISOString().slice(0, 19)}`
  await page.type(`${scope} input[aria-label="Subject"]`, subject)
  await page.type(`${scope} textarea`, 'first post on the ZVM\n>implying this is not on chain')
  const input = await page.$(`${scope} input[type=file]`)
  await input.uploadFile(imagePath)
  await page.waitForSelector(`${scope} .preview img`, {timeout: 20_000})
  const prep = await page.$eval(`${scope} .preview .mono`, (el) => el.textContent)
  log(`image prepared: ${prep}`)
  await page.waitForFunction((s) => /ZNN/.test(document.querySelector(`${s} .fee`).textContent), {timeout: 20_000}, scope)
  log(`fee shown: ${await page.$eval(`${scope} .fee`, (el) => el.textContent)}`)
  await shot('01-new-thread-form')
  await page.click(`${scope} button[type=submit]`)
  const op = await settle(scope)
  check(op > 0, `thread opened as No.${op}`)

  await page.waitForFunction((op) => location.hash.startsWith(`#/thread/${op}`), {timeout: 30_000}, op)
  await page.waitForSelector(`#p${op} .thumb img`, {timeout: 60_000})
  await page.waitForFunction((op) => document.querySelector(`#p${op} .thumb img`).naturalWidth > 0, {timeout: 30_000}, op)
  const info = await page.$eval(`#p${op} .file-info`, (el) => el.textContent)
  check(/^File: \d+\.(webp|jpg)/.test(info), `image read back off the chain (${info})`)
  check((await page.$eval(`#p${op} .subject`, (el) => el.textContent)) === subject, 'subject shown')
  check((await page.$eval(`#p${op} .green`, (el) => el.textContent)) === '>implying this is not on chain', 'greentext')
  check((await page.$eval(`#p${op} .you`, (el) => el.textContent)) === '(You)', '(You) on our own post')

  // --- a quick reply, by quoting ------------------------------------------
  await page.click(`#p${op} a.quote-no`)
  await page.waitForSelector('.post-form-wrap.reply .form-body.quick:not([hidden])', {timeout: 10_000})
  const quoted = await page.$eval('.post-form-wrap.reply textarea', (el) => el.value)
  check(quoted === `>>${op}\n`, 'clicking the number quotes it into the quick reply')
  await page.type('.post-form-wrap.reply textarea', 'replying from the quick reply')
  await shot('02-quick-reply')
  await page.click('.post-form-wrap.reply button[type=submit]')
  const reply = await settle('.post-form-wrap.reply')
  await page.waitForSelector(`#p${reply}`, {timeout: 60_000})
  const link = await page.$eval(`#p${reply} a.quotelink`, (el) => el.textContent)
  check(link.startsWith(`>>${op}`) && link.includes('(OP)') && link.includes('(You)'), `reply quotes the OP (${link})`)
  check(!!(await page.$(`#p${op} .backlinks a[data-id="${reply}"]`)), 'the OP shows a backlink to the reply')
  check(!!(await page.$('.post-form-wrap.reply .form-body[hidden]')), 'the quick reply closes after posting')

  // Hovering the quote shows the quoted post.
  await page.hover(`#p${reply} a.quotelink`)
  await page.waitForSelector('.hover-preview .post', {timeout: 5_000})
  check(true, 'hovering a quote previews the post')
  await shot('03-thread')

  // --- a handle ------------------------------------------------------------
  const name = `v_${Math.random().toString(36).slice(2, 10)}`
  await page.goto(`${url}#/handle`, {waitUntil: 'networkidle2'})
  await page.type('.handle-form input', name)
  await page.waitForFunction(() => /is free/.test(document.querySelector('.avail').textContent), {timeout: 20_000})
  check(true, `${name} reads as free`)
  await page.click('.handle-form button[type=submit]')
  await page.waitForFunction(
    () => /^Done\./.test(document.querySelector('.handle-form .form-note').textContent) || document.querySelector('.handle-form .form-note.bad'),
    {timeout: 400_000, polling: 1000},
  )
  const regNote = await page.$eval('.handle-form .form-note', (el) => el.textContent)
  check(regNote.startsWith('Done.'), `registered for 1 ZNN (${regNote})`)
  check((await page.$eval('.account .current .name.handle', (el) => el.textContent)) === name, 'the page shows the handle as ours')
  await shot('04-handle')

  // Posting with it, and then without it: the choice is per post.
  await page.goto(`${url}#/thread/${op}`, {waitUntil: 'networkidle2'})
  await loadedBoard()
  // The quick reply closed after the last post; open it again.
  await page.click('.post-form-wrap.reply .open-form')
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.post-form-wrap.reply .post-as option')].some((o) => o.value === n),
    {timeout: 20_000},
    name,
  )
  check((await page.$eval('.post-form-wrap.reply .post-as select', (el) => el.value)) === '', '"Post as" starts at Anonymous')
  await page.select('.post-form-wrap.reply .post-as select', name)
  await page.type('.post-form-wrap.reply textarea', 'signed with a handle')
  await page.click('.post-form-wrap.reply button[type=submit]')
  const named = await settle('.post-form-wrap.reply')
  await page.waitForSelector(`#p${named}`, {timeout: 60_000})
  check(
    (await page.$eval(`#p${named} .name`, (el) => el.textContent)) === name && !!(await page.$(`#p${named} .name.handle`)),
    'the named post shows the handle, styled apart',
  )
  const pid = (id) => page.$eval(`#p${id} .pid`, (el) => el.textContent)
  check(!!(await page.$(`#p${named} .you`)), '"(You)" finds our signed post too')
  check((await pid(named)) !== (await pid(op)), `the signed post has its own code (${await pid(named)}, not ${await pid(op)})`)
  await page.click('.post-form-wrap.reply .open-form')
  await page.select('.post-form-wrap.reply .post-as select', '')
  await page.type('.post-form-wrap.reply textarea', 'and anonymous again')
  await page.click('.post-form-wrap.reply button[type=submit]')
  const anon = await settle('.post-form-wrap.reply')
  await page.waitForSelector(`#p${anon}`, {timeout: 60_000})
  check((await page.$eval(`#p${anon} .name`, (el) => el.textContent)) === 'Anonymous', 'a wallet with a handle can still post as Anonymous')
  check((await pid(anon)) === (await pid(op)), `and back to Anonymous, its anonymous code again (${await pid(anon)})`)

  // --- deleting our own post -----------------------------------------------
  await page.click(`#p${anon} .jan.mine`)
  check((await page.$eval(`#p${anon} .jan.mine`, (el) => el.textContent)) === 'delete it for good?', 'delete asks a second time')
  await page.click(`#p${anon} .jan.mine`)
  await page.waitForFunction((id) => !document.getElementById(`p${id}`), {timeout: 400_000, polling: 1000}, anon)
  const isDeleted = await client.readContract({
    address: record.zchan,
    abi: [parseAbiItem('function deleted(uint64) view returns (bool)')],
    functionName: 'deleted',
    args: [BigInt(anon)],
  })
  check(isDeleted, `our own No.${anon} is deleted, on the chain and from the page`)

  // --- someone else's post arrives ------------------------------------------
  const secrets = new URL('../../secrets/zchan.json', import.meta.url)
  const keys = existsSync(secrets) ? JSON.parse(readFileSync(secrets, 'utf8')) : null
  const abi = [
    parseAbiItem('function post(uint64 thread, uint8 flags, string subject, string body, bytes image) returns (uint64)'),
    parseAbiItem('function remove(uint64 id, bool gone)'),
    parseAbiItem('function register(string name) payable'),
    parseAbiItem('function handleOf(address) view returns (string)'),
    parseAbiItem('function holder(string name) view returns (address)'),
  ]
  const janitor = keys && createWalletClient({account: privateKeyToAccount(keys.janitor), chain, transport: http(rpc)})
  if (janitor) {
    // The janitor signs as staff: its handle "janitor" is registered once,
    // for 1 ZNN of its own gas money, and chosen again for free after that.
    const jan = janitor.account.address
    if ((await client.readContract({address: record.zchan, abi, functionName: 'handleOf', args: [jan]})) !== 'janitor') {
      const held = await client.readContract({address: record.zchan, abi, functionName: 'holder', args: ['janitor']})
      const value = held.toLowerCase() === jan.toLowerCase() ? 0n : 10n ** 18n
      const h = await janitor.writeContract({address: record.zchan, abi, functionName: 'register', args: ['janitor'], value, maxPriorityFeePerGas: 100_000_000_000n})
      await client.waitForTransactionReceipt({hash: h, pollingInterval: 2000, timeout: 600_000})
      log('the janitor registered its handle')
    }
    const hash = await janitor.writeContract({
      address: record.zchan,
      abi,
      functionName: 'post',
      args: [BigInt(op), 2, '', `>>${reply}\nfrom another wallet`, '0x'],
      maxPriorityFeePerGas: 100_000_000_000n,
    })
    await client.waitForTransactionReceipt({hash, pollingInterval: 2000, timeout: 600_000})
    await page.waitForFunction(
      () => {
        const el = document.getElementById('new-posts')
        return el && !el.hidden && /^\+1 new$/.test(el.textContent)
      },
      {timeout: 60_000, polling: 500},
    )
    check(true, 'another wallet’s reply raises "+1 new" within a refresh')
    check(!!(await page.$('.post.reply.fresh')), 'and lands with the settling animation')
    const staffPost = await page.$$eval('.post.reply', (ps) => {
      const p = ps.find((x) => x.querySelector('.capcode'))
      return p && {name: p.querySelector('.name').textContent, cap: p.querySelector('.capcode').textContent, color: getComputedStyle(p.querySelector('.name')).color}
    })
    check(
      staffPost?.name === 'janitor' && staffPost.cap === '## Janitor' && staffPost.color === 'rgb(247, 147, 26)',
      `a janitor signing as one reads in orange (${JSON.stringify(staffPost)})`,
    )
    const pinkBg = await page.$eval(`#p${named} .name.handle`, (el) => getComputedStyle(el).backgroundImage)
    check(pinkBg.includes('249, 22, 144'), 'a handle reads in plasma pink')
    await shot('05-new-post')
  } else log('skip another wallet: no secrets/zchan.json here')

  // --- what the chain holds ------------------------------------------------
  const logs = await client.getLogs({
    address: record.zchan,
    event: parseAbiItem('event Posted(uint64 indexed id, uint64 indexed thread, bytes8 indexed poster, bool sage, uint32 imageBytes, string name, string subject, string body)'),
    args: {thread: BigInt(op)},
    fromBlock: BigInt(record.startBlock),
  })
  check(logs.length >= 4 && logs[0].args.subject === subject && logs[1].args.body.startsWith(`>>${op}`), 'the posts are in the contract’s logs')
  check(logs[0].args.poster === logs[1].args.poster, 'one wallet reads as one ID within a thread')
  check(logs[2].args.name === name && logs[3].args.name === '', 'the chain names the signed post and not the other')
  check(logs[2].args.poster !== logs[0].args.poster && logs[3].args.poster === logs[0].args.poster, 'on the chain too, signed and anonymous IDs differ')

  // --- the catalog, the index, light theme, a phone ------------------------
  await page.goto(`${url}#/catalog`, {waitUntil: 'networkidle2'})
  await page.waitForSelector(`.card-thread[data-id="${op}"]`, {timeout: 30_000})
  const meta = await page.$eval(`.card-thread[data-id="${op}"] .meta`, (el) => el.textContent)
  check(/R: [1-9]/.test(meta), `catalog card counts the reply (${meta})`)
  await shot('06-catalog')

  await page.goto(`${url}#/`, {waitUntil: 'networkidle2'})
  await page.waitForSelector(`#p${op}`, {timeout: 30_000})
  check(true, 'the new thread is on the index')
  await page.click('#theme')
  check((await page.$eval('html', (el) => el.dataset.theme)) === 'light', 'the theme switches to light')
  await shot('07-index-light')

  await page.setViewport({width: 400, height: 860, deviceScaleFactor: 1})
  for (const hash of ['#/', '#/catalog', `#/thread/${op}`]) {
    await page.goto(`${url}${hash}`, {waitUntil: 'networkidle2'})
    await loadedBoard()
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    check(wide <= 0, `no sideways scroll at 400px on ${hash}`)
  }
  await shot('08-thread-phone')

  // --- a janitor removes the test thread -----------------------------------
  // Which also keeps the public board free of test posts.
  if (janitor) {
    const hash = await janitor.writeContract({address: record.zchan, abi, functionName: 'remove', args: [BigInt(op), true], maxPriorityFeePerGas: 100_000_000_000n})
    const r = await client.waitForTransactionReceipt({hash, pollingInterval: 2000, timeout: 600_000})
    check(r.status === 'success', `the janitor removed No.${op}`)
    await page.setViewport({width: 1280, height: 1000, deviceScaleFactor: 1})
    await page.goto(`${url}#/`, {waitUntil: 'networkidle2'})
    await loadedBoard()
    await page.waitForFunction((op) => !document.getElementById(`p${op}`), {timeout: 60_000}, op)
    check(true, 'a removed thread is gone from the index')
    await page.goto(`${url}#/thread/${op}`, {waitUntil: 'networkidle2'})
    await loadedBoard()
    check(!(await page.$(`#p${reply}`)), 'and its replies with it')
  }

  check(problems.length === 0, `no page errors${problems.length ? `: ${problems.join('; ')}` : ''}`)
} catch (err) {
  failed = true
  console.error(err)
  await shot('failure')
} finally {
  await browser.close()
}
log(failed ? 'FAILED' : 'passed')
process.exit(failed ? 1 : 0)
