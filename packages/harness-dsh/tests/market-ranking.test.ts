/**
 * 市场安装量榜单读取（市场二期）
 * 运行：cd packages/harness-dsh && node --test tests/market-ranking.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {createMarketRanking,readMarketRanking} from '../src/market-ranking.ts'
import {createMarketCatalogHandler} from '../src/market-catalog.ts'
import {encodeReceipt} from '../src/market-content.ts'
import {OfficialCatalogService,loadOfficialUpstreamIndex} from '@teloa/backend'
import {readMarketCatalogEntry,type MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import {adoptRemoteUpstreamEntries,listUpstreamEntries} from '../../backend/src/market/official-upstream.ts'
import {createMarketCatalogApi} from '../../client/ui-workbench/src/client/market-catalog-api.ts'

// 当前目录（快照 2026.10.14.5 + 随发行上游索引）的固定条目：快照技能 / 方案，上游索引 claude-code / cursor 来源技能。
// 市场只有一个 Teloa 官方目录（marketplace:'teloa' 同页列出快照与上游条目）；ClawHub 条目已不在当前目录。
const SNAPSHOT_SKILL='anthropic.commit',SNAPSHOT_SOLUTION='teloa.grok-sales-team'
const UPSTREAM_CLAUDE_CODE='anthropic.build-mcpb',UPSTREAM_CURSOR='cursor.pstack-architect'
/** 已下架（MiniMax 模型、GitLab 连接器）、历史 ClawHub 与从未存在的条目：榜单必须剔除。 */
const GONE=['teloa.model.minimax','teloa.mcp-gitlab','clawhub.nobody.gone','teloa.soc']
/** 历史 ClawHub 上游协议的合成夹具：只在用例内经 adoptRemoteUpstreamEntries 临时采用，不混入当前目录。 */
function clawhubFixture():MarketCatalogUpstreamSkillEntry{
 const body='---\nname: ranking-notes\ndescription: Fixture skill for ranking protocol.\n---\nKeep ranking rows only for listed entries.\n',license='MIT License\nCopyright (c) Fixture\n'
 const file=(path:string,text:string)=>({path,sha256:createHash('sha256').update(text).digest('hex'),size:Buffer.byteLength(text)})
 const loc=(text:string)=>({'zh-CN':text,en:text})
 return readMarketCatalogEntry({format:'teloa.market-catalog-entry/v1',id:'clawhub.fixture.ranking-notes',kind:'skill',delivery:'upstream',version:'1.0.0',taxonomy:{functions:['office-docs'],industries:['general']},skill:{name:'ranking-notes',title:loc('榜单协议夹具'),summary:loc('只用于榜单过滤协议的合成 ClawHub 条目')},
  upstream:{kind:'clawhub',owner:'fixture',slug:'ranking-notes',version:'1.0.0',files:[file('SKILL.md',body),file('LICENSE',license)]},
  origin:{marketplace:'clawhub',installs:7,installsLabel:'7',countedAt:'2026-09-27'},alternatives:[],unsupportedComponents:[],modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-27',reviewer:'Isolated test fixture'}}) as MarketCatalogUpstreamSkillEntry
}

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

test('真实链路：宿主目录快照与上游索引（不桩 hasEntry）过滤后，Teloa 唯一市场的快照条目与上游条目保留，已下架、历史 ClawHub 与不存在的剔除',async()=>{
 await loadOfficialUpstreamIndex()
 const catalog=new OfficialCatalogService({findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()} as never)
 const actor={ownerId:'local:owner',kind:'human'} as const
 // 当前目录精确读取：快照 33 条 + 上游索引 82 条 = 115 条，唯一市场 'teloa' 同页列出，ClawHub 来源为空
 const teloa=await catalog.list(actor,{marketplace:'teloa',limit:50})
 assert.deepEqual(teloa.counts,{skill:93,dashboard:3,role:9,solution:3,connector:6,model:1})
 assert.equal((await catalog.list(actor,{marketplace:'clawhub',limit:50})).items.length,0)
 for(const id of [SNAPSHOT_SKILL,SNAPSHOT_SOLUTION,UPSTREAM_CLAUDE_CODE,UPSTREAM_CURSOR])assert.ok(catalog.hasEntry(id),id)
 for(const id of GONE)assert.equal(catalog.hasEntry(id),false,id)
 requests=0;reply={status:200,body:JSON.stringify({...ok,entries:[{id:UPSTREAM_CLAUDE_CODE,installs:7,recent:2},{id:GONE[0],installs:6,recent:6},{id:SNAPSHOT_SKILL,installs:5,recent:1},{id:GONE[1],installs:4,recent:4},{id:UPSTREAM_CURSOR,installs:3,recent:0},{id:GONE[2],installs:3,recent:3},{id:SNAPSHOT_SOLUTION,installs:2,recent:1},{id:GONE[3],installs:1,recent:0}]})}
 const handle=createMarketCatalogHandler('local:owner',async()=>{throw Error('不应打开')},encodeReceipt,createMarketRanking(()=>ON,()=>0,id=>catalog.hasEntry(id)))
 assert.deepEqual(await handle('market-catalog/ranking',{}),{asOf:ok.asOf,entries:[{id:UPSTREAM_CLAUDE_CODE,installs:7,recent:2},{id:SNAPSHOT_SKILL,installs:5,recent:1},{id:UPSTREAM_CURSOR,installs:3,recent:0},{id:SNAPSHOT_SOLUTION,installs:2,recent:1}]})
 assert.equal(requests,1)
})

test('历史 ClawHub 上游协议：合成夹具临时采用时 hasEntry 保留其榜单行，恢复当前索引后剔除，当前目录不含该条目',async()=>{
 await loadOfficialUpstreamIndex()
 const catalog=new OfficialCatalogService({findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()} as never)
 const previous=listUpstreamEntries(),fixture=clawhubFixture()
 assert.equal(catalog.hasEntry(fixture.id),false,'合成条目不在当前目录')
 const rows=[{id:fixture.id,installs:7,recent:2},{id:SNAPSHOT_SKILL,installs:5,recent:1},{id:'clawhub.nobody.gone',installs:3,recent:3}]
 try{
  adoptRemoteUpstreamEntries([...previous,fixture])
  assert.equal(catalog.hasEntry(fixture.id),true)
  requests=0;reply={status:200,body:JSON.stringify({...ok,entries:rows})}
  assert.deepEqual(await createMarketRanking(()=>ON,()=>0,id=>catalog.hasEntry(id))(),{asOf:ok.asOf,entries:rows.slice(0,2)})
 }finally{adoptRemoteUpstreamEntries(previous)}
 assert.equal(catalog.hasEntry(fixture.id),false)
 assert.deepEqual(await createMarketRanking(()=>ON,()=>0,id=>catalog.hasEntry(id))(),{asOf:ok.asOf,entries:rows.slice(1,2)})
 assert.equal(listUpstreamEntries().length,previous.length)
})

test('真实链路到应用接口（宿主目录快照 + 上游索引 + 榜单过滤 + 目录端点 + 应用 market-catalog-api，不桩 hasEntry）：Teloa 目录列表里的上游条目有安装量>0 的可见行',async()=>{
 await loadOfficialUpstreamIndex()
 const catalog=new OfficialCatalogService({findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()} as never)
 requests=0;reply={status:200,body:JSON.stringify({...ok,entries:[{id:UPSTREAM_CLAUDE_CODE,installs:1234,recent:2},{id:'clawhub.nobody.gone',installs:99,recent:9},{id:'teloa.model.minimax',installs:50,recent:5}]})}
 const host=createMarketCatalogHandler('local:owner',async()=>({list:(actor,request)=>catalog.list(actor,request as never),add:async()=>{throw Error('x')},addRole:async()=>{throw Error('x')}}),encodeReceipt,createMarketRanking(()=>ON,()=>0,id=>catalog.hasEntry(id)))
 const api=createMarketCatalogApi(host)
 const [listing,ranking]=await Promise.all([api.list({marketplace:'teloa',kind:'skill',query:'build-mcpb',limit:50}),api.ranking()])
 assert.deepEqual([...ranking],[[UPSTREAM_CLAUDE_CODE,{installs:1234,recent:2}]],'不存在与已下架的条目被宿主剔除，现存上游条目保留')
 assert.deepEqual(listing.counts,{skill:93,dashboard:3,role:9,solution:3,connector:6,model:1},'计数按唯一市场全集（115 条）而非当页')
 const listed=listing.items.find(row=>row.entry.id===UPSTREAM_CLAUDE_CODE)
 assert.ok(listed,'应用接口读到的 Teloa 目录列表含该上游条目')
 assert.equal(listed.entry.kind==='skill'&&listed.entry.delivery==='upstream'?listed.entry.origin.marketplace:null,'claude-code')
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
