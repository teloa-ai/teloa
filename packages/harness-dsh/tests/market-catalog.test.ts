import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {OfficialCatalogService} from '@teloa/backend'
import {createMarketCatalogHandler} from '../src/market-catalog.ts'
import {encodeReceipt} from '../src/market-content.ts'

const content={id:'22222222-2222-4222-8222-222222222222',ownerId:'local:owner',kind:'atomic-skill',files:[{path:'internal-comms/SKILL.md',hash:'a'.repeat(64),bytes:new TextEncoder().encode('x')}]}
const added={receipt:{requestId:'11111111-1111-4111-8111-111111111111',contentId:content.id,source:{kind:'catalog'},createdAt:'2026-09-25T00:00:00.000Z'},content}
const realList=(_actor?:unknown,request?:Record<string,unknown>)=>new OfficialCatalogService({import:async()=>{throw Error('unused')},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()}).list({ownerId:'local:owner',kind:'human'},request as never)
const noRole=async()=>{throw Error('unused')}

test('目录列表逐条复核后返回，添加只收请求身份与条目标识',async()=>{
 const calls:unknown[]=[]
 const handle=createMarketCatalogHandler('local:owner',async()=>({list:realList,add:async(actor,input)=>{calls.push([actor,input]);return added},addRole:noRole}),encodeReceipt)
 const listed=await handle('market-catalog/list',{}) as {catalogVersion:string;items:{entry:{id:string;kind:string}}[]}
 // 期望值取自同步进来的镜像版本文件，快照版本须与 tests/fixtures/public-market/ 镜像一致
 assert.equal(listed.catalogVersion,(await readFile(new URL('../../../tests/fixtures/public-market/catalog-version.txt',import.meta.url),'utf8')).trim())
 // 十五个技能 + 十八个行业方案 + 十四个 AI 同事 + 十八个模型（全量超过一页 50 条，按 kind 各取一页核对）
 const kindCount=async(kind:string)=>(await handle('market-catalog/list',{kind}) as {items:unknown[]}).items.length
 assert.equal(await kindCount('skill'),15);assert.equal(await kindCount('solution'),18);assert.equal(await kindCount('role'),14);assert.equal(await kindCount('model'),18)
 const result=await handle('market-catalog/add',{requestId:added.receipt.requestId,entryId:'anthropic.internal-comms'}) as {content:{files:{base64:string}[]}}
 assert.deepEqual(calls,[[{ownerId:'local:owner',kind:'human'},{requestId:added.receipt.requestId,entryId:'anthropic.internal-comms'}]])
 assert.equal(result.content.files[0]!.base64,'eA==')
})

test('请求多字段、带信任声明或文件在打开服务前拒绝；宿主回包异常按宿主错误拒绝',async()=>{
 let opened=0
 const handle=createMarketCatalogHandler('local:owner',async()=>{opened++;throw Error('不应打开')},encodeReceipt)
 await assert.rejects(handle('market-catalog/list',{sort:'invalid-sort-value'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-catalog/add',{requestId:added.receipt.requestId,entryId:'a.b',trust:{}}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-catalog/add',{requestId:'x',entryId:'a.b'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-catalog/remove',{}),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 const listed=await realList()
 for(const broken of [
  {...listed,extra:true},
  {...listed,items:listed.items.map(item=>({...item,addedContentId:'not-uuid'}))},
  {...listed,items:listed.items.map(({addedRoleId:_,...rest})=>rest)},
  // 共享密钥组键必须在；未分组条目不能带组（规格 2026-09-28 D18）
  {...listed,items:listed.items.map(({secretGroup:_,...rest})=>rest)},
  {...listed,items:listed.items.map(item=>({...item,secretGroup:{id:'fake-group',members:[{entryId:item.entry.id,title:{'zh-CN':'x',en:'x'}}]}}))},
  {...listed,items:listed.items.map(item=>({...item,addedRoleId:'not-uuid'}))},
  // 非 role 条目不能带已建岗位
  {...listed,items:listed.items.map(item=>({...item,addedRoleId:content.id}))},
  {...listed,items:listed.items.map(({artifact:_,...rest})=>({...rest,artifact:{files:[],treeHash:'0'.repeat(64)}}))},
  {...listed,items:listed.items.map(item=>({...item,entry:{...item.entry,review:{...item.entry.review,status:'pending'}}}))},
 ]){
  const bad=createMarketCatalogHandler('local:owner',async()=>({list:async()=>broken,add:async()=>added,addRole:noRole}),encodeReceipt)
  await assert.rejects(bad('market-catalog/list',{}),{code:'teloa/invalid-host-response'})
 }
})

test('宿主入口注册目录接口，写命令进入可恢复请求表',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/\.\.\.marketCatalogEndpoints/)
 assert.match(source,/marketCatalogEndpoints as readonly string\[\]\)\.includes\(endpoint\)\?await marketCatalogHandler/)
 // AI 同事建岗不带 requestId（后端派生幂等身份），不能被待恢复命令的请求身份检查挡住
 assert.match(source,/const catalogRoleAdd=\(endpoint:string,payload:unknown\)=>endpoint==='market-catalog\/add'&&isRecord\(payload\)&&payload\.kind==='role'/)
 assert.match(source,/if\(!isPendingRequestEndpoint\(endpoint\)\|\|catalogRoleAdd\(endpoint,payload\)\)return dispatchTeloaEndpoint/)
 assert.match(source,/isPendingRequestEndpoint\(endpoint\)&&!catalogRoleAdd\(endpoint,payload\)\?\{receipt:/)
 const pending=await readFile(new URL('../../contract/src/pending-requests.ts',import.meta.url),'utf8')
 assert.match(pending,/'market-catalog\/add'/);assert.match(pending,/'market-content\/import-github-skill'/)
})

test('添加接受 2 键或带 64 hex expectedTreeHash 的 3 键；4 键或非 64 hex 拒绝且不打开服务',async()=>{
 const calls:unknown[]=[],treeHash='b'.repeat(64)
 const handle=createMarketCatalogHandler('local:owner',async()=>({list:realList,add:async(_actor,input)=>{calls.push(input);return added},addRole:noRole}),encodeReceipt)
 await handle('market-catalog/add',{requestId:added.receipt.requestId,entryId:'anthropic.internal-comms'})
 await handle('market-catalog/add',{requestId:added.receipt.requestId,entryId:'anthropic.internal-comms',expectedTreeHash:treeHash})
 assert.deepEqual(calls,[{requestId:added.receipt.requestId,entryId:'anthropic.internal-comms'},{requestId:added.receipt.requestId,entryId:'anthropic.internal-comms',expectedTreeHash:treeHash}])
 let opened=0
 const closed=createMarketCatalogHandler('local:owner',async()=>{opened++;throw Error('不应打开')},encodeReceipt)
 await assert.rejects(closed('market-catalog/add',{requestId:added.receipt.requestId,entryId:'a.b',expectedTreeHash:treeHash,extra:1}),{code:'teloa/invalid-input'})
 await assert.rejects(closed('market-catalog/add',{requestId:added.receipt.requestId,entryId:'a.b',expectedTreeHash:'B'.repeat(64)}),{code:'teloa/invalid-input'})
 await assert.rejects(closed('market-catalog/add',{requestId:added.receipt.requestId,entryId:'a.b',expectedTreeHash:'abc'}),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
})

test('add kind=role：恰好三键（无 requestId）转 addRole，回包只透传 roleId/status/skills；六类 kind 可筛，counts/skipped 复核',async()=>{
 const calls:unknown[]=[]
 const receipt={roleId:'44444444-4444-4444-8444-444444444444',status:'created',skills:['a','b']}
 const handle=createMarketCatalogHandler('local:owner',async()=>({list:realList,add:async()=>added,addRole:async(actor,input)=>{calls.push([actor,input]);return {...receipt,extra:true}}}),encodeReceipt)
 const result=await handle('market-catalog/add',{entryId:'teloa.role.x',version:'1.0.0',kind:'role'})
 assert.deepEqual(calls,[[{ownerId:'local:owner',kind:'human'},{entryId:'teloa.role.x',version:'1.0.0'}]])
 assert.deepEqual(result,receipt)
 await assert.rejects(handle('market-catalog/add',{entryId:'teloa.role.x',kind:'role'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-catalog/add',{requestId:added.receipt.requestId,entryId:'teloa.role.x',version:'1.0.0',kind:'role'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-catalog/add',{entryId:'teloa.role.x',version:'1.0.0',kind:'model'}),{code:'teloa/invalid-input'})
 const badReceipt=createMarketCatalogHandler('local:owner',async()=>({list:realList,add:async()=>added,addRole:async()=>({roleId:'not-uuid',status:'created',skills:[]})}),encodeReceipt)
 await assert.rejects(badReceipt('market-catalog/add',{entryId:'teloa.role.x',version:'1.0.0',kind:'role'}),{code:'teloa/invalid-host-response'})
 for(const [kind,count] of [['role',14],['model',18]] as const)assert.equal((await handle('market-catalog/list',{kind}) as {items:unknown[]}).items.length,count)
 const listed=await handle('market-catalog/list',{}) as {counts:Record<string,number>;skipped:{unknownKind:number;newerApp:number}}
 assert.deepEqual(Object.keys(listed.counts).sort(),['connector','dashboard','model','role','skill','solution']);assert.deepEqual(listed.skipped,{unknownKind:0,newerApp:0})
 const broken=createMarketCatalogHandler('local:owner',async()=>({list:async()=>({...(await realList()),counts:{skill:1}}),add:async()=>added,addRole:async()=>receipt}),encodeReceipt)
 await assert.rejects(broken('market-catalog/list',{}),{code:'teloa/invalid-host-response'})
})

const modelEntry={format:'teloa.market-catalog-entry/v1',id:'teloa.model.deepseek',kind:'model',delivery:'reference',version:'1.0.0',upstream:null,
 taxonomy:{functions:['other'],industries:['general']},
 model:{modelId:'deepseek',title:{'zh-CN':'DeepSeek',en:'DeepSeek'},summary:{'zh-CN':'国内直连。',en:'Direct in China.'},form:'cloud',usage:['chat'],
  capabilities:{tools:true,vision:false,reasoning:true,structured:true},contextWindow:128000,
  license:{spdx:'custom',name:'DeepSeek 服务条款',url:'https://platform.deepseek.com/terms',tier:'commercial',restrictions:[]},
  cnReachable:'direct',support:'supported',notes:[],
  cloud:{provider:{kind:'pi-ai',id:'deepseek'},models:[{id:'deepseek-chat',name:'DeepSeek V3',contextWindow:128000,maxTokens:8192,input:['text']}],priceBand:'low',credentialLabel:{'zh-CN':'DeepSeek API 密钥',en:'DeepSeek API key'},signupUrl:'https://platform.deepseek.com'},local:null,variants:null},
 modifications:[],license:{spdx:'custom',files:[],url:'https://platform.deepseek.com/terms'},
 compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}}

test('model 条目无工件：artifact 为 null 时照常列出，带工件视为宿主回包异常',async()=>{
 const base=await realList(),withModel=(artifact:unknown)=>({...base,items:[...base.items,{entry:modelEntry,artifact,addedContentId:null,addedRoleId:null,secretGroup:null}]})
 const ok=createMarketCatalogHandler('local:owner',async()=>({list:async()=>withModel(null),add:async()=>added,addRole:noRole}),encodeReceipt)
 const listed=await ok('market-catalog/list',{}) as {items:{entry:{id:string};artifact:unknown}[]}
 assert.equal(listed.items.find(item=>item.entry.id==='teloa.model.deepseek')!.artifact,null)
 const bad=createMarketCatalogHandler('local:owner',async()=>({list:async()=>withModel({files:[],treeHash:'0'.repeat(64)}),add:async()=>added,addRole:noRole}),encodeReceipt)
 await assert.rejects(bad('market-catalog/list',{}),{code:'teloa/invalid-host-response'})
})

// 官方方案产品页（2026-09-28）：七行从随发行固定的方案包清单算出，宿主只按条目标识回清单与只读接入源。
const realSolution=(_actor:unknown,input:{entryId:string})=>new OfficialCatalogService({import:async()=>{throw Error('unused')},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()}).solutionPackage(input.entryId)
test('market-catalog/solution：只收一个条目标识；回包清单与只读接入源逐项复核，不透传多余字段',async()=>{
 const handle=createMarketCatalogHandler('local:owner',async()=>({list:realList,add:async()=>added,addRole:noRole,solutionPackage:async(actor,input)=>({...realSolution(actor,input),extra:true})}),encodeReceipt)
 const value=await handle('market-catalog/solution',{entryId:'teloa.cn-workspace'}) as Record<string,unknown>
 assert.deepEqual(Object.keys(value).sort(),['entryId','manifest','readOnlyResources','version'])
 assert.equal(value.entryId,'teloa.cn-workspace');assert.deepEqual(value.readOnlyResources,['lark-read','yuque-read'])
 assert.equal((value.manifest as {id:string}).id,'cn-workspace')
 let opened=0
 const closed=createMarketCatalogHandler('local:owner',async()=>{opened++;throw Error('不应打开')},encodeReceipt)
 for(const payload of [{},{entryId:''},{entryId:1},{entryId:'teloa.soc',extra:1},null,{entryId:'x'.repeat(121)}])await assert.rejects(closed('market-catalog/solution',payload),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 const good=realSolution(null,{entryId:'teloa.cn-workspace'})
 for(const broken of [
  {...good,entryId:'teloa.soc'},
  {...good,version:'1.0'},
  {...good,manifest:null},
  {...good,manifest:{...(good.manifest as object),resources:'x'}},
  {...good,readOnlyResources:['workplace-collaborator']},
  {...good,readOnlyResources:['lark-read','lark-read']},
  {entryId:good.entryId,version:good.version,manifest:good.manifest},
 ]){
  const bad=createMarketCatalogHandler('local:owner',async()=>({list:realList,add:async()=>added,addRole:noRole,solutionPackage:async()=>broken}),encodeReceipt)
  await assert.rejects(bad('market-catalog/solution',{entryId:'teloa.cn-workspace'}),{code:'teloa/invalid-host-response'})
 }
})

test('目录列表：方案条目的包含计数可选、严格复核后透传；非方案带计数或计数不合法按宿主回包异常',async()=>{
 const handle=createMarketCatalogHandler('local:owner',async()=>({list:realList,add:async()=>added,addRole:noRole}),encodeReceipt)
 const listed=await handle('market-catalog/list',{kind:'solution'}) as {items:{entry:{id:string};contents?:Record<string,number>}[]}
 assert.deepEqual(listed.items.find(item=>item.entry.id==='teloa.soc')!.contents,{role:2,knowledge:1,skill:7,'work-template':4,plan:1})
 // 旧宿主不带 contents 仍然照常读
 const old=await realList(undefined,{kind:'solution'})
 const legacy=createMarketCatalogHandler('local:owner',async()=>({list:async()=>({...old,items:old.items.map(({contents:_,...rest})=>rest)}),add:async()=>added,addRole:noRole}),encodeReceipt)
 assert.ok((await legacy('market-catalog/list',{}) as {items:object[]}).items.every(item=>!Object.hasOwn(item,'contents')))
 const skills=await realList(undefined,{kind:'skill'})
 for(const broken of [
  {...old,items:old.items.map(item=>({...item,contents:{skill:0}}))},
  {...old,items:old.items.map(item=>({...item,contents:{unknown:1}}))},
  {...skills,items:skills.items.map(item=>({...item,contents:{skill:1}}))},
 ]){
  const bad=createMarketCatalogHandler('local:owner',async()=>({list:async()=>broken,add:async()=>added,addRole:noRole}),encodeReceipt)
  await assert.rejects(bad('market-catalog/list',{}),{code:'teloa/invalid-host-response'})
 }
})
