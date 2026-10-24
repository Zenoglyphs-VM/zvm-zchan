// Serve the actual browser modules with a bounded loopback RPC fixture.
// --serve waits for the test page's result so an existing browser can run it.
import {createServer} from 'node:http'
import {randomBytes} from 'node:crypto'
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {build as buildVite} from 'vite'
import {contract, fixture} from '../test/fixture.mjs'

const sourceWeb = fileURLToPath(new URL('..', import.meta.url))
const scratch = process.env.ZCHAN_TEST_SCRATCH ?? mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'zchan-browser-'))
if (!path.isAbsolute(scratch)) throw new Error('An absolute test scratch directory is required.')
// Stage only the explicit browser source, never node_modules, keys, .env or
// a real deployment record. Repeated runs cannot overwrite a user's files.
const web = path.join(scratch,'site/web')
if (existsSync(web)) throw new Error('Preserve an existing test site.')
mkdirSync(web,{recursive:true})
for (const name of ['src','test','index.html']) cpSync(path.join(sourceWeb,name),path.join(web,name),{recursive:true,errorOnExist:true,force:false})
const deployments = path.join(web, '../deployments')
mkdirSync(deployments, {recursive: true})
const record = path.join(deployments, 'browser-fixture.json')
if (existsSync(record)) throw new Error('Preserve an existing browser fixture deployment.')
writeFileSync(record, JSON.stringify({chainId: 31337, zchan: contract, startBlock: 1}), {flag: 'wx'})
const prefix = '/zchan-fixture-' + randomBytes(12).toString('hex')
const model = fixture()
let ready = false, requests = 0, finish
const completion = new Promise(resolve => {finish = resolve})
const server = createServer(async (req, res) => {
  try {
    if (++requests > 16000) throw new Error('Fixture request budget exceeded.')
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(prefix + '/')) {res.writeHead(404);res.end();return}
    const route = url.pathname.slice(prefix.length)
    if (!['/rpc','/control','/result'].includes(route)) {
      if (!ready) {res.writeHead(503);res.end();return}
      const relative=route==='/'?'index.html':decodeURIComponent(route.slice(1))
      if (!relative||relative.split('/').some(part=>part==='..'||part==='.'||part==='')) throw new Error('Invalid static path.')
      const file=path.join(scratch,'dist',relative)
      if (!existsSync(file)) {res.writeHead(404);res.end();return}
      const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]??'application/octet-stream'
      res.writeHead(200,{'content-type':mime,'cache-control':'no-store'});res.end(readFileSync(file));return
    }
    let body = Buffer.alloc(0)
    for await (const chunk of req) {body = Buffer.concat([body,chunk]);if (body.length > 2*1024**2) throw new Error('Fixture body cap exceeded.')}
    const data = body.length ? JSON.parse(body) : {}
    let result
    if (route === '/rpc') result = Array.isArray(data) ? await Promise.all(data.map(model.rpc)) : await model.rpc(data)
    else if (route === '/control') {
      if (data.releaseImages) model.release()
      result = data.stats ? model.stats() : model.set(data)
    } else {
      if (typeof data.passed !== 'boolean' || !Array.isArray(data.tests) || data.tests.length < 15) throw new Error('Incomplete browser result.')
      result = {accepted: true}
      finish(data)
    }
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result))
  } catch {res.writeHead(400);res.end('Fixture request refused.')}
})
server.maxConnections=32;server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=1000
let browser, timer
try {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  process.env.VITE_ZVM_NODE=origin+prefix;process.env.VITE_GATEWAY=origin+prefix;process.env.VITE_DEPLOYMENT='browser-fixture'
  function packageRoot(name) {
    let directory=path.dirname(fileURLToPath(import.meta.resolve(name)))
    for (;;) {
      const file=path.join(directory,'package.json')
      if (existsSync(file)&&JSON.parse(readFileSync(file,'utf8')).name===name) return directory
      const parent=path.dirname(directory)
      if (parent===directory) throw new Error('Installed browser dependency is missing: '+name)
      directory=parent
    }
  }
  const aliases={...Object.fromEntries(['viem','@fontsource-variable/space-grotesk','@fontsource-variable/jetbrains-mono'].map(name=>[name,packageRoot(name)])),
    ...JSON.parse(process.env.ZCHAN_TEST_DEPENDENCY_ALIASES ?? '{}')}
  await buildVite({root:web,configFile:false,envDir:scratch,base:prefix+'/',cacheDir:path.join(scratch,'vite-cache'),
    resolve:{alias:aliases},build:{outDir:path.join(scratch,'dist'),emptyOutDir:false,
      rollupOptions:{input:[path.join(web,'index.html'),path.join(web,'test/index.html')]}}})
  ready=true
  const url=origin+prefix+'/test/index.html'
  if (process.env.ZCHAN_TEST_READY_FILE) writeFileSync(process.env.ZCHAN_TEST_READY_FILE,JSON.stringify({url,fixtureOnly:true}))
  console.log(JSON.stringify({event:'browser-fixture-ready',url,fixtureOnly:true}))
  timer=setTimeout(()=>finish({passed:false,tests:[],error:'Browser qualification timed out.'}),180000)
  if (!process.argv.includes('--serve')) {
    const executablePath=process.env.CHROME_BIN ?? ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
    if (!executablePath) throw new Error('Set CHROME_BIN to an installed Chrome/Chromium; no browser is downloaded.')
    const {default:puppeteer}=await import('puppeteer-core')
    browser=await puppeteer.launch({executablePath,headless:true,userDataDir:path.join(scratch,'browser-profile'),
      args:['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']})
    const page=await browser.newPage()
    await page.goto(url,{waitUntil:'domcontentloaded'})
  }
  const result=await completion
  if (process.env.ZCHAN_TEST_RESULT_FILE) writeFileSync(process.env.ZCHAN_TEST_RESULT_FILE,JSON.stringify(result))
  console.log(JSON.stringify({event:'browser-fixture-result',...result}))
  if (!result.passed) process.exitCode=1
} finally {
  clearTimeout(timer);model.release()
  await browser?.close()
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
