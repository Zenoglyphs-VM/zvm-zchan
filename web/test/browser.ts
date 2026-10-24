// Actual browser APIs and production modules; RPC is a separate loopback model.
import {toHex, type Address, type Hex} from 'viem'
import * as board from '../src/board'
import {getLogs} from '../src/chain'
import * as view from '../src/view'

const base = new URL('../', location.href).pathname.replace(/\/$/, '')
const results: {name: string; passed: boolean; error?: string}[] = []
const a = '0x2222222222222222222222222222222222222222' as Address
const b = '0x3333333333333333333333333333333333333333' as Address
type Event = {name: string; block: number; args: Record<string, any>; tx?: number; index?: number}
const event = (name: string, block: number, args: Record<string, any>): Event => ({name, block, args})
const posted = (id: number, block: number, body = '', thread = id, imageBytes = 0): Event => event('Posted', block,
  {id, thread, poster: '0x1234567890abcdef', sage: false, imageBytes, name: '', subject: `Thread ${id}`, body})
const control = async (body: object): Promise<any> => {
  const r = await fetch(base + '/control', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
  if (!r.ok) throw new Error('Fixture control refused.')
  return r.json()
}
const equal = (actual: unknown, expected: unknown, why = 'Unexpected result') => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(why + ': ' + JSON.stringify({actual, expected}))
}
const ok = (value: unknown, why: string) => {if (!value) throw new Error(why)}
async function rejects(fn: () => Promise<unknown>) {let rejected = false;try {await fn()} catch {rejected = true}ok(rejected, 'The read must fail visibly.')}
async function until(fn: () => boolean | Promise<boolean>, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {if (await fn()) return;await new Promise(resolve => setTimeout(resolve, 20))}
  throw new Error('Browser condition timed out.')
}
async function test(name: string, fn: () => Promise<void>) {
  const row: typeof results[number] = {name, passed: false}
  try {await fn();row.passed = true} catch (err: any) {row.error = String(err?.message ?? err)}
  results.push(row)
  const li = document.createElement('li');li.textContent = `${row.passed ? 'PASS' : 'FAIL'} ${name}${row.error ? ': ' + row.error : ''}`
  document.querySelector('#results')!.append(li)
}
const state = () => ({head: board.head.toString(), loaded: board.loaded,
  posts: [...board.posts.values()].map(p => [p.id,p.thread,p.body,p.block.toString(),p.blockHash,p.time,p.tx,p.arrived]),
  removed: [...board.removed], deleted: [...board.deleted], backlinks: [...board.backlinks], janitors: [...board.janitors], owner: board.owner})
async function reset(logs: Event[], head = Math.max(1, ...logs.map(l => l.block)), flags: object = {}) {
  await control({fork: 0, head, logs, flags});await board.scan()
}
const ctx = (): view.Ctx => ({me: null, janitorView: false, thread: 0, remove() {}, deletePost() {}})

await test('Initial failure preserves the empty unloaded view; retry loads it', async () => {
  await control({fork: 0, head: 2, logs: [posted(1,1),posted(2,2)], flags: {corruptBlock: 2}})
  const before = state();await rejects(board.scan);equal(state(), before)
  await control({flags: {}});await board.scan();equal([...board.posts.keys()], [1,2]);ok(board.loaded, 'The board must finish loading.')
})
await test('Canonical append updates posts, quotes and moderation once', async () => {
  const logs = [posted(1,1),posted(2,2,'>>1',1),event('OwnerChanged',2,{owner:a}),event('JanitorSet',2,{janitor:b,active:true})]
  await reset(logs,3)
  logs.push(event('Removed',4,{id:2,removed:true}))
  await control({head:4,logs,clearCounts:true});await board.scan()
  equal([...board.backlinks],[[1,[2]]]);ok(board.gone(2),'Removal must apply.');equal(board.owner?.toLowerCase(),a)
  const before=state();await board.scan();equal(state(),before)
  equal((await control({stats:true})).counts.eth_getLogs,1,'An unchanged head must not reread log pages.')
})
await test('Deep replacement removes orphan posts, deletion, removal, staff and backlinks', async () => {
  await reset([posted(1,1),posted(2,3,'>>1',1),event('Removed',4,{id:1,removed:true}),event('Deleted',5,{id:2}),
    event('JanitorSet',6,{janitor:b,active:true}),event('OwnerChanged',7,{owner:a})],12)
  await control({fork:2,head:14,logs:[posted(1,1),posted(2,4,'replacement'),event('OwnerChanged',8,{owner:b})]})
  await board.scan()
  equal([...board.posts.keys()],[1,2]);equal(board.posts.get(2)?.body,'replacement');equal([...board.removed],[]);equal([...board.deleted],[])
  equal([...board.backlinks],[]);equal([...board.janitors],[]);equal(board.owner?.toLowerCase(),b)
  ok([...board.posts.values()].every(p=>p.arrived===undefined),'Rebuilds must not announce historical posts as new.')
})
await test('A shorter head and a rollback below deployment rebuild to the canonical view', async () => {
  await reset([posted(1,1),posted(2,8)],10)
  await control({fork:5,head:4,logs:[posted(1,1)]});await board.scan();equal([...board.posts.keys()],[1]);equal(board.head.toString(),'4')
})
await test('A head before deployment clears every former record', async () => {
  await reset([posted(1,1),event('OwnerChanged',1,{owner:a})],2)
  await control({fork:0,head:0,logs:[]});await board.scan()
  equal(board.posts.size,0);equal(board.owner,null);equal(board.head.toString(),'0')
})
await test('A malformed later log never commits an earlier valid post', async () => {
  await reset([posted(1,1)],2);const before=state()
  await control({head:4,logs:[posted(1,1),posted(2,3),posted(3,4)],flags:{corruptBlock:4}})
  await rejects(board.scan);equal(state(),before)
  await control({flags:{}});await board.scan();equal([...board.posts.keys()],[1,2,3])
})
await test('A refused fallback timestamp is retryable without partial state or a poisoned cache', async () => {
  await reset([posted(1,1)],2);const before=state()
  await control({head:4,logs:[posted(1,1),posted(2,3),posted(3,4)],flags:{omitTimes:true,failTimeBlock:4}})
  await rejects(board.scan);equal(state(),before)
  await control({flags:{omitTimes:true}});await board.scan();equal([...board.posts.keys()],[1,2,3])
})
await test('A replacement block at one height has its own fallback timestamp', async () => {
  await reset([posted(1,1)],2,{omitTimes:true});const old=board.posts.get(1)!.time
  await control({fork:1,head:2,logs:[posted(1,1,'changed')],flags:{omitTimes:true}});await board.scan()
  ok(board.posts.get(1)!.time!==old,'A height-keyed timestamp must not survive replacement.')
})
await test('A branch change during log delivery leaves the prior accepted view', async () => {
  await reset([posted(1,1)],2);const before=state()
  await control({head:3,logs:[posted(1,1),posted(2,3)],flags:{reorgAfterLogs:{fork:2,head:3,logs:[posted(1,1),posted(2,3,'new branch')]}}})
  await rejects(board.scan);equal(state(),before);await board.scan();equal(board.posts.get(2)?.body,'new branch')
})
await test('Removed or hash-inconsistent logs are refused atomically', async () => {
  await reset([posted(1,1)],2);const before=state()
  for (const flags of [{removedBlock:3},{wrongHashBlock:3}]) {
    await control({head:3,logs:[posted(1,1),posted(2,3)],flags});await rejects(board.scan);equal(state(),before)
  }
})
await test('A multi-page refusal keeps the old cursor; the same range can recover', async () => {
  await reset([posted(1,1)],1);const before=state()
  const logs=[posted(1,1),posted(2,30000),posted(3,75000),posted(4,100002)]
  await control({head:100005,logs,flags:{failFrom:50002}});await rejects(board.scan);equal(state(),before)
  await control({flags:{}});await board.scan();equal([...board.posts.keys()],[1,2,3,4])
})
await test('Explicit range refusals split successfully; generic outages do not fan out', async () => {
  await reset([posted(1,1)],3)
  await control({flags:{maxRange:2},clearCounts:true});equal((await getLogs(1n,8n,[])).length,1)
  equal((await control({stats:true})).counts.eth_getLogs,7)
  await control({flags:{unavailable:true},clearCounts:true});await rejects(()=>getLogs(1n,50000n,[]))
  equal((await control({stats:true})).counts.eth_getLogs,1)
})
await test('Range splitting has a hard 128 provider-request budget', async () => {
  await control({flags:{maxRange:100},clearCounts:true});await rejects(()=>getLogs(1n,50000n,[]))
  equal((await control({stats:true})).counts.eth_getLogs,128)
})
await test('Concurrent scans share one complete read', async () => {
  await reset([posted(1,1)],1)
  await control({head:2,logs:[posted(1,1),posted(2,2)],flags:{},clearCounts:true})
  const first=board.scan(),second=board.scan();ok(first===second,'A scan must be shared.');await Promise.all([first,second])
  equal((await control({stats:true})).counts.eth_getLogs,1);equal([...board.posts.keys()],[1,2])
})

async function png(color:string):Promise<Hex> {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1
  canvas.getContext('2d')!.fillStyle=color;canvas.getContext('2d')!.fillRect(0,0,1,1)
  const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png'))
  return toHex(new Uint8Array(await blob.arrayBuffer()))
}
const red=await png('red'),blue=await png('blue')
const imageLogs=(data:Hex)=>[ {...posted(1,1,'',1,(data.length-2)/2),tx:1}, {...event('Image',1,{id:1,data}),tx:1} ]
await test('Images use native blob decoding and are cached only for the accepted branch', async () => {
  await reset(imageLogs(red),2)
  const result=await board.image(1);ok('url' in result,'A matching image must load.')
  if (!('url' in result)) return
  const bitmap=await createImageBitmap(await (await fetch(result.url)).blob());equal([bitmap.width,bitmap.height],[1,1]);bitmap.close()
  await control({fork:1,head:2,logs:imageLogs(blue)});await board.scan();equal(board.imageNow(1),undefined)
  await rejects(async()=>{await fetch(result.url)})
  const replacement=await board.image(1);ok('url' in replacement&&replacement.url!==result.url,'A replacement must receive its own blob.')
})
await test('An in-flight orphan image cannot populate a replacement post or cache', async () => {
  await reset(imageLogs(red),2,{holdImages:true})
  const old=board.image(1);await until(async()=>(await control({stats:true})).heldImages===1)
  await control({fork:1,head:2,logs:imageLogs(blue),flags:{}});await board.scan();await control({releaseImages:true})
  ok('error' in await old,'The orphan image must resolve as stale.');equal(board.imageNow(1),undefined)
  ok('url' in await board.image(1),'The replacement image remains loadable.')
})
await test('An image with another transaction or block identity is not attached', async () => {
  const logs=imageLogs(red);logs[1].tx=99;await reset(logs,2)
  ok('error' in await board.image(1),'An unrelated log must not become this post image.')
})
await test('Hostile text remains text and index pagination uses the rebuilt board', async () => {
  const payload='<img src=x onerror="globalThis.__zchanExecuted=1"><script>globalThis.__zchanExecuted=1</script>'
  await reset(Array.from({length:12},(_,i)=>posted(i+1,i+1,i===0?payload:'')),12)
  const target=document.querySelector('#render')!;target.replaceChildren(view.post(board.posts.get(1)!,ctx()),view.index(1,ctx()))
  ok(target.textContent!.includes(payload),'Hostile markup must remain literal.');equal(target.querySelectorAll('script,img').length,0)
  equal((globalThis as any).__zchanExecuted,undefined);ok(target.querySelector('a[href="#/page/2"]'),'The second page must be reachable.')
  target.replaceChildren(view.index(2,ctx()));equal(target.querySelectorAll('article.post').length,2)
})
await test('Four seeded histories compare 128 append/reorg operations with retained canonical snapshots', async () => {
  for (const seed of [7,29,101,313]) {
    let random=seed,nextId=1
    const rand=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random}
    let history: {logs:Event[];ids:number[];removed:number[];owner:Address|null}[]=[{logs:[],ids:[],removed:[],owner:null}]
    await reset([],0)
    for (let step=0;step<32;step++) {
      let fork:number|undefined
      if (history.length>2&&rand()%4===0) {const keep=1+rand()%(history.length-1);history=history.slice(0,keep);fork=keep}
      const previous=history[history.length-1],n=history.length
      const next={logs:[...previous.logs],ids:[...previous.ids],removed:[...previous.removed],owner:previous.owner}
      const choice=rand()%3
      if (choice===0||!next.ids.length) {const id=nextId++;next.ids.push(id);next.logs.push(posted(id,n,'seeded'))}
      else if (choice===1) {const id=next.ids[rand()%next.ids.length];const active=!next.removed.includes(id)
        next.removed=active?[...next.removed,id]:next.removed.filter(v=>v!==id);next.logs.push(event('Removed',n,{id,removed:active}))}
      else {next.owner=rand()%2?a:b;next.logs.push(event('OwnerChanged',n,{owner:next.owner}))}
      history.push(next)
      await control({head:n,logs:next.logs,flags:{},...(fork!==undefined?{fork}:{})});await board.scan()
      equal([...board.posts.keys()],next.ids);equal([...board.removed].sort((x,y)=>x-y),[...next.removed].sort((x,y)=>x-y))
      equal(board.owner?.toLowerCase()??null,next.owner);equal(board.head.toString(),String(n))
    }
  }
})
await test('The original production entry renders, routes and refreshes after a deep reorg', async () => {
  await reset([posted(1,1,'original production text'),posted(2,2,'>>1',1)],5)
  const frame=document.createElement('iframe');frame.width='800';frame.height='500';frame.src=base+'/'
  document.querySelector('#render')!.replaceChildren(frame)
  await until(()=>!!frame.contentDocument?.querySelector('article.post'),15000)
  ok(frame.contentDocument!.body.textContent!.includes('original production text'),'The original boot/main entry must render.')
  frame.contentWindow!.location.hash='#/catalog'
  await until(()=>!!frame.contentDocument?.querySelector('a[href="#/thread/1"]'))
  frame.contentWindow!.location.hash='#/thread/1'
  await until(()=>!!frame.contentDocument?.querySelector('article.post'))
  await control({fork:1,head:6,logs:[posted(1,1,'replacement production text')]})
  await until(()=>!!frame.contentDocument?.body.textContent?.includes('replacement production text'),15000)
  ok(!frame.contentDocument!.body.textContent!.includes('original production text'),'An orphan must leave the actual rendered page.')
  frame.remove()
})

const proof={passed:results.every(r=>r.passed),fixtureOnly:true,tests:results,seededHistorySteps:128,
  productionEntryRendered:results.at(-1)!.passed,realWalletOrKeysUsed:false,evmExecution:false,publicRpcRequests:0}
const summary=document.createElement('p');summary.id='summary';summary.textContent=JSON.stringify(proof)
document.body.append(summary)
await fetch(base+'/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(proof)})
