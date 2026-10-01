/**
 * 市场资源安装上报（市场二期）
 * 运行：cd packages/harness-dsh && node --test tests/market-installs.test.ts
 */
import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {access,mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
// @ts-ignore - metrics-worker has no TypeScript declarations; cross-validated at runtime
import {parseEvent} from '../../../metrics-worker/src/protocol.mjs'
import {createResourceInstallReporter} from '../src/usage-stats.ts'
import {createSolutionRoleResolver,resourceInstallOf,withResourceInstallReport,withSolutionRoleReport} from '../src/market-install-report.ts'

let status=200
const received:Record<string,unknown>[]=[]
const server=createServer((req,res)=>{
 let body=''
 req.on('data',chunk=>{body+=chunk})
 req.on('end',()=>{
  try{received.push(JSON.parse(body) as Record<string,unknown>)}catch{/* 非 JSON 忽略 */}
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({accepted:status<400}))
 })
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()))
process.env.TELOA_USAGE_STATS_ENDPOINT=`http://127.0.0.1:${(server.address() as {port:number}).port}`
test.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))

const ON:NodeJS.ProcessEnv={TELOA_USAGE_STATS:'on'}
const settle=(ms=300)=>new Promise(resolve=>setTimeout(resolve,ms))
const dayOf=(offset:number)=>new Date(Date.now()-offset*86_400_000).toISOString().slice(0,10)
const soc=()=>({id:'teloa.soc',version:'1.0.0',kind:'solution' as const,day:dayOf(0)})
async function tmp(t:TestContext){const dir=await mkdtemp(join(tmpdir(),'teloa-market-installs-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
const catalogReceipt=(contentKind:string,source:Record<string,unknown>={},createdAt='2026-09-25T23:50:00.000Z')=>({receipt:{requestId:'r',contentId:'c',source:{kind:'catalog',catalog:'teloa-official',catalogVersion:'2026.9.26.2',entryId:'teloa.soc',entryVersion:'1.2.0',treeHash:'a'.repeat(64),...source},createdAt},content:{id:'c',kind:contentKind}})
const noConnector=()=>undefined

test('未开启与排除环境：零请求，不建安装标识',async t=>{
 const dir=await tmp(t)
 for(const env of [{},{TELOA_USAGE_STATS:'off'},{TELOA_USAGE_STATS:'on',CI:'true'},{TELOA_USAGE_STATS:'on',TELOA_BROWSER_ACCEPTANCE:'1'},{TELOA_USAGE_STATS:'on',NODE_ENV:'development'}] as NodeJS.ProcessEnv[]){
  received.length=0
  createResourceInstallReporter(dir,()=>env)(soc())
  await settle()
  assert.equal(received.length,0,JSON.stringify(env))
 }
 await assert.rejects(access(join(dir,'usage-stats','installation-id.json')))
})

test('开启后发送通过 Worker 协议校验的 resource-install；同一原始日同条目只发一次；换条目或换原始日再发',async t=>{
 const dir=await tmp(t);received.length=0;status=200
 const report=createResourceInstallReporter(dir,()=>ON)
 report(soc());report(soc())
 await settle()
 assert.equal(received.length,1)
 const event=received[0]!
 assert.deepEqual(Object.keys(event).sort(),['appVersion','day','edition','entryId','entryVersion','event','installationId','kind','schemaVersion'])
 assert.equal(event.event,'resource-install');assert.equal(event.entryId,'teloa.soc');assert.equal(event.day,dayOf(0))
 const parsed=parseEvent(event,Date.now()) as Record<string,unknown>
 assert.ok(!('error' in parsed),JSON.stringify(parsed))
 report({id:'anthropic.internal-comms',version:'1.0.0',kind:'skill',day:dayOf(0)})
 report({...soc(),day:dayOf(1)})
 await settle()
 assert.equal(received.length,3)
 assert.equal(received[2]!.day,dayOf(1),'重放携带原始日期')
 assert.deepEqual(JSON.parse(await readFile(join(dir,'usage-stats','resource-installs.json'),'utf8')),{entries:[`${dayOf(0)}|teloa.soc`,`${dayOf(0)}|anthropic.internal-comms`,`${dayOf(1)}|teloa.soc`]})
})

test('原始日期早于前天或晚于今天：不发送',async t=>{
 const dir=await tmp(t);received.length=0;status=200
 const report=createResourceInstallReporter(dir,()=>ON)
 report({...soc(),day:dayOf(3)});report({...soc(),day:dayOf(-1)})
 await settle()
 assert.equal(received.length,0)
})

test('其他 4xx 为终态：记入已发送、不重试；429 可重试：退避 3 次后不记录，下次再发',async t=>{
 const dir=await tmp(t);received.length=0;status=400
 const report=createResourceInstallReporter(dir,()=>ON)
 report(soc());await settle();report(soc());await settle()
 assert.equal(received.length,1)
 const other=await tmp(t);received.length=0;status=429
 const retrying=createResourceInstallReporter(other,()=>ON)
 retrying(soc());await settle(5600)
 assert.equal(received.length,3,'429 按 0、1、4 秒退避重试 3 次')
 status=200
 retrying(soc());await settle()
 assert.equal(received.length,4,'429 未记入已发送，下次仍会发送')
})

test('resourceInstallOf：官方目录内容回执带原始日期，新建岗位用当日，目录连接器用记录日期；其他一律不报',()=>{
 const today='2026-09-26'
 assert.deepEqual(resourceInstallOf('market-catalog/add',{requestId:'r',entryId:'teloa.soc'},catalogReceipt('industry-template'),noConnector,today),{id:'teloa.soc',version:'1.2.0',kind:'solution',day:'2026-09-25'})
 assert.deepEqual(resourceInstallOf('market-catalog/add',{requestId:'r',entryId:'anthropic.internal-comms'},catalogReceipt('atomic-skill',{entryId:'anthropic.internal-comms',entryVersion:'1.0.0'}),noConnector,today),{id:'anthropic.internal-comms',version:'1.0.0',kind:'skill',day:'2026-09-25'})
 assert.equal(resourceInstallOf('market-catalog/add',{},catalogReceipt('atomic-skill',{kind:'github'}),noConnector,today),undefined)
 assert.equal(resourceInstallOf('market-catalog/add',{},catalogReceipt('atomic-skill',{catalog:'other'}),noConnector,today),undefined)
 assert.equal(resourceInstallOf('market-catalog/add',{},catalogReceipt('unknown-kind'),noConnector,today),undefined)
 assert.equal(resourceInstallOf('market-catalog/add',{},catalogReceipt('atomic-skill',{},'yesterday'),noConnector,today),undefined)
 // AI 同事版本取本地目录快照，载荷里的版本号不采信；快照里没有该条目则不报
 const role={entryId:'teloa.role.soc-analyst',version:'9.9.9',kind:'role'}
 const roleVersion=(kind:'connector'|'role',id:string)=>kind==='role'&&id==='teloa.role.soc-analyst'?'1.0.0':undefined
 assert.deepEqual(resourceInstallOf('market-catalog/add',role,{roleId:'x',status:'created',skills:[]},roleVersion,today),{id:'teloa.role.soc-analyst',version:'1.0.0',kind:'role',day:today})
 assert.equal(resourceInstallOf('market-catalog/add',role,{roleId:'x',status:'created',skills:[]},noConnector,today),undefined)
 assert.equal(resourceInstallOf('market-catalog/add',role,{roleId:'x',status:'existing',skills:[]},roleVersion,today),undefined)
 const record={id:'x',catalogId:'teloa.github',serverName:'github',status:'saved',createdAt:'2026-09-26T01:00:00.000Z',updatedAt:'2026-09-26T01:00:00.000Z'}
 assert.deepEqual(resourceInstallOf('mcp-connections/add',{catalogId:'teloa.github'},record,(kind,id)=>kind==='connector'&&id==='teloa.github'?'2.0.0':undefined,today),{id:'teloa.github',version:'2.0.0',kind:'connector',day:'2026-09-26'})
 assert.equal(resourceInstallOf('mcp-connections/add',{catalogId:'teloa.github'},record,noConnector,today),undefined)
 for(const endpoint of ['market-content/import-github-skill','skill-installations/install','market-catalog/list','mcp-connections/connect'])
  assert.equal(resourceInstallOf(endpoint,{},catalogReceipt('atomic-skill'),()=>'1.0.0',today),undefined,endpoint)
})

test('withResourceInstallReport：成功后上报一次并原样返回；失败不上报、原样抛出',async()=>{
 const reported:unknown[]=[]
 const receipt=catalogReceipt('industry-template')
 const ok=withResourceInstallReport(async(_endpoint:string,_payload:unknown)=>receipt,entry=>{reported.push(entry)},noConnector)
 assert.equal(await ok('market-catalog/add',{requestId:'r',entryId:'teloa.soc'}),receipt)
 assert.deepEqual(reported,[{id:'teloa.soc',version:'1.2.0',kind:'solution',day:'2026-09-25'}])
 const failing=withResourceInstallReport(async(_endpoint:string,_payload:unknown):Promise<unknown>=>{throw Object.assign(Error('拒绝'),{code:'teloa/invalid-input'})},entry=>{reported.push(entry)},noConnector)
 await assert.rejects(failing('market-catalog/add',{}),{code:'teloa/invalid-input'})
 assert.equal(reported.length,1)
})

test('withSolutionRoleReport：只在建岗成功后后台查证；未建成、其他方法、查证失败都不上报；原样返回',async()=>{
 const reported:unknown[]=[],asked:unknown[]=[]
 const instance={id:'i',loadId:'l',itemLocalId:'soc-analyst',createdAt:'2026-09-25T08:00:00.000Z',role:{id:'r'},state:'paused'}
 const wrapped=withSolutionRoleReport(async(_method:string,_payload:unknown)=>instance,entry=>{reported.push(entry)},async(loadId,roleId,day)=>{asked.push([loadId,roleId,day]);return {id:'teloa.role.'+roleId,version:'1.0.0',kind:'role',day}},()=>true)
 assert.equal(await wrapped('industry-roles/instantiate',{}),instance)
 await wrapped('industry-roles/get',{})
 await settle()
 assert.deepEqual(asked,[['l','soc-analyst','2026-09-25']])
 assert.deepEqual(reported,[{id:'teloa.role.soc-analyst',version:'1.0.0',kind:'role',day:'2026-09-25'}])
 await withSolutionRoleReport(async(_method:string,_payload:unknown)=>({...instance,role:null,state:'pending'}),entry=>{reported.push(entry)},async()=>{throw Error('不应查证')},()=>true)('industry-roles/instantiate',{})
 await withSolutionRoleReport(async(_method:string,_payload:unknown)=>instance,entry=>{reported.push(entry)},async()=>{throw Error('查证失败')},()=>true)('industry-roles/instantiate',{})
 await settle()
 assert.equal(reported.length,1)
})

test('兜底：推导或上报抛错不影响已成功的安装结果；排除环境下方案岗位直接短路，不查库也不读方案包',async()=>{
 const receipt=catalogReceipt('industry-template'),connector={catalogId:'teloa.mcp.github',createdAt:'2026-09-25T00:00:00.000Z'}
 const throwing=()=>{throw Error('上报炸了')}
 assert.equal(await withResourceInstallReport(async(_endpoint:string,_payload:unknown)=>receipt,throwing,noConnector)('market-catalog/add',{}),receipt)
 assert.equal(await withResourceInstallReport(async(_endpoint:string,_payload:unknown)=>connector,entry=>{void entry},()=>{throw Error('版本查询炸了')})('mcp-connections/add',{}),connector)
 const instance={id:'i',loadId:'l',itemLocalId:'soc-analyst',createdAt:'2026-09-25T08:00:00.000Z',role:{id:'r'},state:'paused'}
 let resolved=0
 assert.equal(await withSolutionRoleReport(async(_method:string,_payload:unknown)=>instance,throwing,async()=>{resolved++;return undefined},()=>false)('industry-roles/instantiate',{}),instance)
 assert.equal(await withSolutionRoleReport(async(_method:string,_payload:unknown)=>instance,throwing,async()=>{resolved++;return undefined},()=>{throw Error('判定炸了')})('industry-roles/instantiate',{}),instance)
 assert.equal(resolved,0,'排除环境（或判定出错）不做任何后台查证')
 assert.equal(await withSolutionRoleReport(async(_method:string,_payload:unknown)=>instance,throwing,()=>{throw Error('同步抛错')},()=>true)('industry-roles/instantiate',{}),instance)
 assert.equal(await withSolutionRoleReport(async(_method:string,_payload:unknown)=>instance,throwing,async()=>({id:'teloa.role.soc-analyst',version:'1.0.0',kind:'role' as const,day:'2026-09-25'}),()=>true)('industry-roles/instantiate',{}),instance)
 await settle()
})

test('createSolutionRoleResolver：只认官方目录方案中、与目录 role 条目同名且同方案的岗位',async()=>{
 const role=(packageId='soc-operations')=>({id:'teloa.role.soc-analyst',version:'1.0.0',kind:'role',role:{roleId:'soc-analyst',fromSolution:{packageId,version:'1.0.0',path:'roles/soc-analyst.json'}}})
 const make=(publisher:string,entry:unknown)=>createSolutionRoleResolver({load:async()=>({contentId:'c',templateId:'soc-operations'}),content:async()=>({trust:{publisher}}),roleEntry:()=>entry as never})
 assert.deepEqual(await make('Teloa 官方目录',role())('l','soc-analyst','2026-09-26'),{id:'teloa.role.soc-analyst',version:'1.0.0',kind:'role',day:'2026-09-26'})
 assert.equal(await make('某人上传',role())('l','soc-analyst','2026-09-26'),undefined)
 assert.equal(await make('Teloa 官方目录',role('other-solution'))('l','soc-analyst','2026-09-26'),undefined)
 assert.equal(await make('Teloa 官方目录',undefined)('l','soc-analyst','2026-09-26'),undefined)
 assert.equal(await make('Teloa 官方目录',role())('l','other-role','2026-09-26'),undefined)
})

test('wiring：目录、受管 MCP、行业岗位三个 handler 都经过上报包装',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/const reportResourceInstall=createResourceInstallReporter\(runtimeRoot,\(\)=>\(\{CI:process\.env\.CI,NODE_ENV:process\.env\.NODE_ENV,\.\.\.trusted\}\),\(\)=>trusted\)/)
 assert.match(source,/const catalogEntryVersion=\(kind:'connector'\|'role',id:string\)=>kind==='connector'\?officialCatalogForMcp\.getConnectorEntry\(id\)\?\.version:officialCatalogForMcp\.getRoleEntry\(id\)\?\.version/)
 assert.match(source,/const marketCatalogHandler=withResourceInstallReport\(createMarketCatalogHandler\(owner,/)
 assert.match(source,/\},encodeMarketReceipt(?:,marketRanking)?\),reportResourceInstall,catalogEntryVersion\)/)
 assert.match(source,/handler:managedMcpConnectionBase,/)
 assert.match(source,/const managedMcpConnectionHandler=withResourceInstallReport\(managedMcpConnectionBase,reportResourceInstall,catalogEntryVersion\)/)
 assert.match(source,/const industryRolesBase=createIndustryRolesHandler\(owner,/)
 assert.match(source,/const industryRolesHandler=withSolutionRoleReport\(industryRolesBase,reportResourceInstall,\(loadId,roleId,day\)=>solutionRoleEntry\(loadId,roleId,day\),\(\)=>detectExclusion\(\)===undefined\)/)
 assert.match(source,/const solutionRoleEntry=createSolutionRoleResolver\(\{/)
})
