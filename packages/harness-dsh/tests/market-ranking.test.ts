/**
 * 市场安装量榜单读取（市场二期）
 * 运行：cd packages/harness-dsh && node --test tests/market-ranking.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {createMarketRanking,readMarketRanking} from '../src/market-ranking.ts'
import {createMarketCatalogHandler} from '../src/market-catalog.ts'
import {encodeReceipt} from '../src/market-content.ts'
import {OfficialCatalogService,loadOfficialUpstreamIndex} from '@teloa/backend'
import {createMarketCatalogApi} from '../../client/ui-workbench/src/client/market-catalog-api.ts'

const ok={format:'teloa.market-installs/v1',asOf:'2026-09-26T03:00:00.000Z',recent:{days:7,from:'2026-09-20',to:'2026-09-26'},entries:[{id:'teloa.soc',installs:12,recent:3}]}
let reply={status:200,body:JSON.stringify(ok)}
let requests=0
const server=createServer((req,res)=>{
 requests++
 res.writeHead(req.url==='/v1/market-installs'?reply.status:404,{'Content-Type':'application/json'});res.end(reply.body)
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()))
process.env.TELOA_USAGE_STATS_ENDPOINT=`http://127.0.0.1:${(server.address() as {port:number}).port}`
test.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
const ON:NodeJS.ProcessEnv={TELOA_USAGE_STATS:'on'}
const EMPTY={asOf:null,entries:[]}

test('readMarketRanking：格式、时间、条目 ID、非负整数，任一不符整份拒绝',()=>{
 assert.deepEqual(readMarketRanking(ok),{asOf:ok.asOf,entries:[{id:'teloa.soc',installs:12,recent:3}]})
 for(const bad of [null,{...ok,format:'x'},{...ok,asOf:'yesterday'},{...ok,entries:[{id:'Bad ID',installs:1,recent:0}]},{...ok,entries:[{id:'teloa.soc',installs:1.5,recent:0}]},{...ok,entries:[{id:'teloa.soc',installs:1,recent:-1}]}])
  assert.throws(()=>readMarketRanking(bad),/invalid ranking/)
})

test('排除环境不联网返回空榜；开启后读取并缓存 10 分钟，到期重取',async()=>{
 requests=0;reply={status:200,body:JSON.stringify(ok)}
 assert.deepEqual(await createMarketRanking(()=>({TELOA_USAGE_STATS:'on',CI:'true'}))(),EMPTY)
 assert.deepEqual(await createMarketRanking(()=>({}))(),EMPTY)
 assert.equal(requests,0)
 let clock=0
 const ranking=createMarketRanking(()=>ON,()=>clock)
 assert.equal((await ranking()).entries[0]!.installs,12)
 await ranking()
 assert.equal(requests,1)
 clock=10*60_000
 await ranking()
 assert.equal(requests,2)
})

test('失败或结构不符：返回上次成功结果（没有则空榜），1 分钟内不重试',async()=>{
 requests=0;let clock=0
 const ranking=createMarketRanking(()=>ON,()=>clock)
 reply={status:503,body:'{}'}
 assert.deepEqual(await ranking(),EMPTY)
 await ranking()
 assert.equal(requests,1)
 clock=60_000;reply={status:200,body:JSON.stringify(ok)}
 assert.equal((await ranking()).entries.length,1)
 clock=60_000+10*60_000;reply={status:200,body:JSON.stringify({...ok,format:'bad'})}
 assert.equal((await ranking()).entries.length,1,'结构不符时保留上次成功结果')
 assert.equal(requests,3)
})

test('只保留宿主本地目录快照中存在的条目：已下架或不存在的 ID 从榜单剔除，顺序不变',async()=>{
 requests=0;reply={status:200,body:JSON.stringify({...ok,entries:[{id:'teloa.gone',installs:30,recent:9},{id:'teloa.soc',installs:12,recent:3},{id:'teloa.role.retired',installs:5,recent:0},{id:'teloa.finance',installs:2,recent:1}]})}
 const listed=new Set(['teloa.soc','teloa.finance'])
 const ranking=createMarketRanking(()=>ON,()=>0,id=>listed.has(id))
 assert.deepEqual(await ranking(),{asOf:ok.asOf,entries:[{id:'teloa.soc',installs:12,recent:3},{id:'teloa.finance',installs:2,recent:1}]})
 assert.equal(requests,1)
})

test('真实链路：宿主目录快照与上游索引（不桩 hasEntry）过滤后，ClawHub 条目与 Teloa 条目保留、不存在的剔除',async()=>{
 await loadOfficialUpstreamIndex()
 const catalog=new OfficialCatalogService({findByCatalogSources:async()=>new Map<string,string>()} as never)
 const clawhub=(await catalog.list({ownerId:'local:owner',kind:'human'},{marketplace:'clawhub',limit:1})).items[0]!.entry.id
 assert.match(clawhub,/^clawhub\./)
 requests=0;reply={status:200,body:JSON.stringify({...ok,entries:[{id:clawhub,installs:7,recent:2},{id:'teloa.soc',installs:5,recent:1},{id:'clawhub.nobody.gone',installs:3,recent:3},{id:'teloa.gone',installs:1,recent:0}]})}
 const handle=createMarketCatalogHandler('local:owner',async()=>{throw Error('不应打开')},encodeReceipt,createMarketRanking(()=>ON,()=>0,id=>catalog.hasEntry(id)))
 assert.deepEqual(await handle('market-catalog/ranking',{}),{asOf:ok.asOf,entries:[{id:clawhub,installs:7,recent:2},{id:'teloa.soc',installs:5,recent:1}]})
})

test('真实链路到应用接口（宿主目录快照 + 上游索引 + 榜单过滤 + 目录端点 + 应用 market-catalog-api，不桩 hasEntry）：ClawHub 列表里有安装量>0 的可见条目',async()=>{
 await loadOfficialUpstreamIndex()
 const catalog=new OfficialCatalogService({findByCatalogSources:async()=>new Map<string,string>()} as never)
 const clawhub=(await catalog.list({ownerId:'local:owner',kind:'human'},{marketplace:'clawhub',limit:1})).items[0]!.entry.id
 requests=0;reply={status:200,body:JSON.stringify({...ok,entries:[{id:clawhub,installs:1234,recent:2},{id:'clawhub.nobody.gone',installs:99,recent:9}]})}
 const host=createMarketCatalogHandler('local:owner',async()=>({list:(actor,request)=>catalog.list(actor,request as never),add:async()=>{throw Error('x')},addRole:async()=>{throw Error('x')}}),encodeReceipt,createMarketRanking(()=>ON,()=>0,id=>catalog.hasEntry(id)))
 const api=createMarketCatalogApi(host)
 const [listing,ranking]=await Promise.all([api.list({marketplace:'clawhub',limit:50}),api.ranking()])
 assert.deepEqual([...ranking],[[clawhub,{installs:1234,recent:2}]],'不存在的上游条目被宿主剔除，现存 ClawHub 条目保留')
 const listed=listing.items.find(row=>row.entry.id===clawhub)
 assert.ok(listed,'应用接口读到的 ClawHub 列表含该条目')
 // 与界面 catalogSortVisible 同一判据：非模型条目且安装量>0 → 显示排序行
 assert.ok(listed.entry.kind!=='model'&&(ranking.get(listed.entry.id)?.installs??0)>0)
})

test('响应体按字节限长：超过 256 KiB 整份拒绝；缓存过期时并发调用只发一次请求',async()=>{
 requests=0;reply={status:200,body:JSON.stringify(ok)+' '.repeat(256*1024)}
 assert.deepEqual(await createMarketRanking(()=>ON,()=>0)(),EMPTY)
 // 中文 3 字节：字符数低于上限而字节数超限的一份也要拒绝
 reply={status:200,body:JSON.stringify({...ok,pad:'安'.repeat(100*1024)})}
 assert.deepEqual(await createMarketRanking(()=>ON,()=>0)(),EMPTY)
 requests=0;reply={status:200,body:JSON.stringify(ok)}
 const ranking=createMarketRanking(()=>ON,()=>0)
 const [left,right]=await Promise.all([ranking(),ranking()])
 assert.equal(left.entries.length,1);assert.deepEqual(left,right)
 assert.equal(requests,1)
})

test('market-catalog/ranking：只收空对象，不打开目录服务；未注入时返回空榜',async()=>{
 let opened=0
 const handle=createMarketCatalogHandler('local:owner',async()=>{opened++;throw Error('不应打开')},encodeReceipt,async()=>readMarketRanking(ok))
 assert.deepEqual(await handle('market-catalog/ranking',{}),{asOf:ok.asOf,entries:[{id:'teloa.soc',installs:12,recent:3}]})
 await assert.rejects(handle('market-catalog/ranking',{limit:1}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-catalog/ranking',null),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 assert.deepEqual(await createMarketCatalogHandler('local:owner',async()=>{throw Error('x')},encodeReceipt)('market-catalog/ranking',{}),EMPTY)
})

test('wiring：宿主装配榜单读取（按本地目录快照过滤），并传给目录 handler',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/import \{createMarketRanking\} from '\.\/market-ranking\.ts'/)
 assert.match(source,/const marketRanking=createMarketRanking\(\(\)=>\(\{CI:process\.env\.CI,NODE_ENV:process\.env\.NODE_ENV,\.\.\.trusted\}\),undefined,id=>officialCatalogForMcp\.hasEntry\(id\),\(\)=>trusted\)/)
 assert.match(source,/\},encodeMarketReceipt,marketRanking\),reportResourceInstall,catalogEntryVersion\)/)
})
