import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createMarketCatalogApi} from '../src/client/market-catalog-api.ts'
import {catalogEntry} from './market-catalog-fixture.ts'

const contentId='22222222-2222-4222-8222-222222222222',requestId='11111111-1111-4111-8111-111111111111'
const artifact={files:[{path:'LICENSE.txt',sha256:'a'.repeat(64),size:1},{path:'SKILL.md',sha256:'b'.repeat(64),size:1}],treeHash:'c'.repeat(64)}
const listing=(extra:Record<string,unknown>={})=>({catalogVersion:'2026.9.25',items:[{entry:catalogEntry(),artifact,addedContentId:null,addedRoleId:null,secretGroup:null,...extra}],counts:{solution:0,role:0,skill:1,connector:0,model:0},skipped:{unknownKind:0,newerApp:0}})
const receipt=(id=requestId,entryId='anthropic.internal-comms')=>({receipt:{requestId:id,contentId,source:{kind:'catalog',catalog:'teloa-official',catalogVersion:'2026.9.25',entryId,entryVersion:'1.0.0',treeHash:'c'.repeat(64)},createdAt:'2026-09-25T00:00:00.000Z'},content:{id:contentId}})

test('目录列表逐条复核，异常回包一律拒绝',async()=>{
 const api=createMarketCatalogApi(async(endpoint,payload)=>{assert.equal(endpoint,'market-catalog/list');assert.deepEqual(payload,{});return listing()})
 const value=await api.list()
 assert.equal((value.items[0]!.entry as any).skill.name,'internal-comms')
 for(const broken of [{...listing(),extra:1},listing({addedContentId:'x'}),listing({addedRoleId:'x'}),listing({addedRoleId:contentId}),listing({secretGroup:undefined}),listing({secretGroup:{id:'fake-group',members:[{entryId:'anthropic.internal-comms',title:{'zh-CN':'x',en:'x'}}]}}),listing({artifact:{files:[],treeHash:'c'.repeat(64)}}),{catalogVersion:'2026.9.25',items:[{entry:{...catalogEntry(),review:{status:'pending',reviewedAt:'2026-09-25',reviewer:'x'}},artifact,addedContentId:null}]}])
  await assert.rejects(createMarketCatalogApi(async()=>broken).list(),/官方目录回包格式不正确/)
})

test('分页游标格式错误时拒绝，不能降级为最后一页；旧宿主缺省与 null 兼容',async()=>{
 for(const nextCursor of [3,false,{},'',undefined,'x'.repeat(121)])
  await assert.rejects(createMarketCatalogApi(async()=>({...listing(),nextCursor})).list(),/格式不正确/)
 for(const result of [listing(),{...listing(),nextCursor:null}])
  assert.equal((await createMarketCatalogApi(async()=>result).list()).nextCursor,null)
 assert.equal((await createMarketCatalogApi(async()=>({...listing(),nextCursor:'anthropic.internal-comms'})).list()).nextCursor,'anthropic.internal-comms')
})

test('添加只发请求身份与条目标识；回执须是同一请求与条目；网络失败后以原请求 ID 重试',async()=>{
 const calls:unknown[]=[];let fail=true
 const api=createMarketCatalogApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);if(fail){fail=false;throw Error('断线')}return receipt()},()=>requestId)
 await assert.rejects(api.add('anthropic.internal-comms'),/断线/)
 assert.deepEqual(await api.add('anthropic.internal-comms'),{contentId})
 assert.deepEqual(calls,[['market-catalog/add',{requestId,entryId:'anthropic.internal-comms'}],['market-catalog/add',{requestId,entryId:'anthropic.internal-comms'}]])
 await assert.rejects(createMarketCatalogApi(async()=>receipt('99999999-9999-4999-8999-999999999999'),()=>requestId).add('anthropic.internal-comms'),/回执与原请求不一致/)
 await assert.rejects(createMarketCatalogApi(async()=>receipt(requestId,'other.entry'),()=>requestId).add('anthropic.internal-comms'),/回执与原请求不一致/)
 const ids:string[]=[]
 const rejectedThenNew=createMarketCatalogApi(async(_endpoint,payload)=>{ids.push((payload as {requestId:string}).requestId);throw Object.assign(Error('拒绝'),{rejected:true,code:'teloa/invalid-input'})})
 await assert.rejects(rejectedThenNew.add('a.b'));await assert.rejects(rejectedThenNew.add('a.b'))
 assert.notEqual(ids[0],ids[1],'宿主明确拒绝后不再沿用原请求 ID')
})

test('addRole 只发三键（无 requestId）；回执三键；counts/skipped 缺失时列表拒绝',async()=>{
 const calls:[string,unknown][]=[]
 const receipt={roleId:'44444444-4444-4444-8444-444444444444',status:'created',skills:['x']}
 const api=createMarketCatalogApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return receipt})
 assert.deepEqual(await api.addRole('teloa.role.x','1.0.0'),receipt)
 assert.deepEqual(calls,[['market-catalog/add',{entryId:'teloa.role.x',version:'1.0.0',kind:'role'}]])
 const noCounts=createMarketCatalogApi(async()=>({catalogVersion:'2026.9.25',items:[],nextCursor:null}))
 await assert.rejects(noCounts.list(),/格式不正确/)
 await assert.rejects(createMarketCatalogApi(async()=>({...receipt,extra:1})).addRole('teloa.role.x','1.0.0'),/回执格式不正确/)
 const withModel=createMarketCatalogApi(async()=>({...listing(),items:[{entry:modelEntry,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}]}))
 assert.equal((await withModel.list()).items[0]!.artifact,null)
})

const modelEntry={format:'teloa.market-catalog-entry/v1',id:'teloa.model.deepseek',kind:'model',delivery:'reference',version:'1.0.0',upstream:null,
 taxonomy:{functions:['other'],industries:['general']},
 model:{modelId:'deepseek',title:{'zh-CN':'DeepSeek',en:'DeepSeek'},summary:{'zh-CN':'国内直连。',en:'Direct in China.'},form:'cloud',usage:['chat'],
  capabilities:{tools:true,vision:false,reasoning:true,structured:true},contextWindow:128000,
  license:{spdx:'custom',name:'DeepSeek 服务条款',url:'https://platform.deepseek.com/terms',tier:'commercial',restrictions:[]},
  cnReachable:'direct',support:'supported',notes:[],
  cloud:{provider:{kind:'pi-ai',id:'deepseek'},models:[{id:'deepseek-chat',name:'DeepSeek V3',contextWindow:128000,maxTokens:8192,input:['text']}],priceBand:'low',credentialLabel:{'zh-CN':'DeepSeek API 密钥',en:'DeepSeek API key'},signupUrl:'https://platform.deepseek.com'}},
 modifications:[],license:{spdx:'custom',files:[],url:'https://platform.deepseek.com/terms'},
 compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}}

test('榜单：结构正确才采用；宿主异常或结构不符一律返回空表',async()=>{
 const ok={asOf:'2026-09-26T00:00:00.000Z',entries:[{id:'teloa.soc',installs:3,recent:1}]}
 const api=createMarketCatalogApi(async(endpoint,payload)=>{assert.equal(endpoint,'market-catalog/ranking');assert.deepEqual(payload,{});return ok})
 assert.deepEqual([...(await api.ranking())],[['teloa.soc',{installs:3,recent:1}]])
 for(const broken of [{...ok,extra:1},{...ok,entries:[{id:'teloa.soc',installs:-1,recent:0}]},{...ok,entries:[{id:'teloa.soc',installs:1,recent:0,x:1}]},{...ok,asOf:5},{entries:ok.entries,extra:null},null])
  assert.equal((await createMarketCatalogApi(async()=>broken).ranking()).size,0,JSON.stringify(broken))
 assert.equal((await createMarketCatalogApi(async()=>{throw Error('断线')}).ranking()).size,0)
})

// 官方方案产品页：七行取自方案包清单，宿主按条目标识回清单原文与只读接入源；浏览器端再按清单格式完整复核。
const read=(path:string)=>JSON.parse(readFileSync(new URL('../../../../tests/fixtures/public-market/'+path,import.meta.url),'utf8'))
const cnWorkspace=read('artifacts/solutions/teloa.cn-workspace/1.0.0/teloa.json')
const solutionPackage=(extra:Record<string,unknown>={})=>({entryId:'teloa.cn-workspace',version:'1.0.0',manifest:structuredClone(cnWorkspace),readOnlyResources:['lark-read','yuque-read'],...extra})

test('方案包：只发条目标识；回包清单按格式复核，只读接入源必须指向清单里的连接',async()=>{
 const calls:unknown[]=[]
 const api=createMarketCatalogApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return solutionPackage()})
 const value=await api.solutionPackage('teloa.cn-workspace')
 assert.deepEqual(calls,[['market-catalog/solution',{entryId:'teloa.cn-workspace'}]])
 assert.equal(value.manifest.id,cnWorkspace.id)
 assert.equal(value.manifest.resources.filter(resource=>resource.kind==='mcp').length,2)
 assert.deepEqual(value.readOnlyResources,['lark-read','yuque-read'])
 for(const broken of [
  {...solutionPackage(),extra:1},
  solutionPackage({entryId:'teloa.soc'}),
  solutionPackage({version:'9.9.9'}),
  solutionPackage({manifest:{...cnWorkspace,resources:[]}}),
  solutionPackage({manifest:{...cnWorkspace,format:'teloa.business-package/v1'}}),
  solutionPackage({readOnlyResources:['workplace-collaborator']}),
  solutionPackage({readOnlyResources:['no-such']}),
  solutionPackage({readOnlyResources:['lark-read','lark-read']}),
  solutionPackage({readOnlyResources:'lark-read'}),
  null,
 ])await assert.rejects(createMarketCatalogApi(async()=>broken).solutionPackage('teloa.cn-workspace'),/方案内容回包格式不正确/,JSON.stringify(broken)?.slice(0,80))
})

test('目录列表：方案条目可带包含计数（严格复核），旧回包不带也照常读；非方案条目带计数拒绝',async()=>{
 const solution=read('catalog/solutions/teloa.soc.json')
 const art={files:[{path:'teloa.json',sha256:'a'.repeat(64),size:1}],treeHash:'c'.repeat(64)}
 const page=(extra:Record<string,unknown>={})=>({catalogVersion:'2026.9.25',items:[{entry:solution,artifact:art,addedContentId:null,addedRoleId:null,secretGroup:null,...extra}],counts:{solution:1,role:0,skill:0,connector:0,model:0},skipped:{unknownKind:0,newerApp:0}})
 assert.deepEqual((await createMarketCatalogApi(async()=>page({contents:{skill:7,role:2}})).list()).items[0]!.contents,{role:2,skill:7})
 assert.equal(Object.hasOwn((await createMarketCatalogApi(async()=>page()).list()).items[0]!,'contents'),false)
 for(const contents of [{skill:0},{nope:1},null])await assert.rejects(createMarketCatalogApi(async()=>page({contents})).list(),/官方目录回包格式不正确/)
 await assert.rejects(createMarketCatalogApi(async()=>listing({contents:{skill:1}})).list(),/官方目录回包格式不正确/)
})
