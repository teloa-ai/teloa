import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {readBusinessSourceMappingDefinition,type BusinessObjectTypeDefinition,type BusinessSourceMappingDefinition} from '@teloa/contract'
import {BusinessSyncService,BusinessWarehouseService,currentVersionSubquery,initializeBusinessData,initializeBusinessDefinitions,initializeBusinessSync,initializeBusinessWarehouse,openResourceDatabase} from '@teloa/backend'
import {createMcpSyncSource,type ManagedMcpToolInvoker} from '../src/business-mcp-sync-source.ts'

/** 同步器接真适配器（`createMcpSyncSource`，受管 MCP 连接用桩 invoke）的端到端真库用例：续页标记、水位与分页链计量在两侧的配合。 */

type Pool=Awaited<ReturnType<typeof openResourceDatabase>>['pool']
let container:StartedPostgreSqlContainer,pool:Pool,root:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 root=await mkdtemp(join(tmpdir(),'teloa-mcp-sync-e2e-'))
 const config=join(root,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})).pool
 await initializeBusinessData(pool)
 await initializeBusinessWarehouse(pool)
 await initializeBusinessDefinitions(pool)
 await initializeBusinessSync(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})

const alertType:BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1',id:'soc-alert',version:'1.0.0',domain:'SOC',title:'告警',unit:'条',lead:'告警',sourceId:'security-alert-http',fields:[
 {name:'id',label:'告警编号',type:'text',required:true,from:'告警编号'},
 {name:'updated',label:'更新时间',type:'text',required:false,from:'更新时间'},
]}
function mappingOf(pagination:{cursorArgument:string;nextCursorPath:string},incremental:boolean):BusinessSourceMappingDefinition{
 return readBusinessSourceMappingDefinition({
  format:'teloa.business-source-mapping/v1',id:'soc-mcp',version:incremental?'1.0.0':'2.0.0',domain:'SOC',title:'告警同步',objectType:'soc-alert',
  source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{status:'open'},itemsPath:'$.items',pagination},
  mapping:[{path:'$.id',field:'id'},{path:'$.updated_at',field:'updated'}],primaryKey:['id'],
  ...(incremental?{incrementalCursor:{path:'$.updated_at',kind:'timestamp'}}:{}),
  deletionSemantics:'compare',pageSize:50,schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false,
 })
}
const record=(definition:unknown)=>({source:{loadId:'load-1',scope:'SOC',localId:(definition as {id:string}).id,version:'1.0.0',contentHash:'c',fileHash:'f',definitionHash:'d',origin:'local'},definition})
const at=(n:number)=>'2026-09-25T10:'+String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')+'.000Z'
const rows=Array.from({length:120},(_value,index)=>({id:'m'+index,updated_at:at(index)}))

/** 桩工具：续页参数 `name` 取 p2 / p3 翻页；首页之外的取值（包括残留水位）一律当成非法页码报错。 */
function stubTool(name:string){
 const calls:Array<Record<string,unknown>>=[]
 const invoke:ManagedMcpToolInvoker=async input=>{
  calls.push(input.arguments)
  const token=input.arguments[name]
  const index=token===undefined?0:token==='p2'?1:token==='p3'?2:-1
  if(index<0)throw new Error('invalid page token '+String(token))
  return {items:rows.slice(index*50,index*50+50),next:index<2?'p'+(index+2):null}
 }
 return {calls,invoke}
}

/** `tool.current` 可换：同一主体下模拟映射改版后换一种续页参数的工具。 */
function harness(mappings:BusinessSourceMappingDefinition[],tool:{current:ManagedMcpToolInvoker}){
 const owner='mcp-e2e:'+randomUUID(),actor={ownerId:owner,scopeIds:['SOC']}
 const identity={id:randomUUID,now:()=>new Date().toISOString()}
 const definitions={forScope:async(_db:unknown,_owner:string,scope:string)=>scope!=='SOC'?[]:[{origin:{kind:'market',loadId:'load-1'},scope:'SOC',domain:'SOC',objectTypes:[record(alertType)],views:[],actions:[],mappings:mappings.map(record),widgets:[],dashboards:[],sources:new Map()}] as never}
 const service=new BusinessSyncService(pool,identity,definitions,new BusinessWarehouseService(pool,identity),createMcpSyncSource(input=>tool.current(input),{connected:()=>true,readOnly:()=>true}))
 const run=()=>service.run(actor,{scope:'SOC',mappingId:'soc-mcp',trigger:'manual'})
 const current=async()=>(await pool.query(`select object_id from ${currentVersionSubquery(false)} s`,[owner,'SOC','soc-alert'])).rows.length
 const cursor=async()=>(await pool.query('select cursor from teloa_business_sync_cursors where owner_id=$1',[owner])).rows[0]?.cursor as string|null|undefined
 return {run,current,cursor}
}

test('同步器 + 真适配器：三页共 120 条一次落库；每页都带水位，续页参数按声明透传；第二次同步从水位起翻页',async()=>{
 const tool=stubTool('page'),h=harness([mappingOf({cursorArgument:'page',nextCursorPath:'$.next'},true)],{current:tool.invoke})
 const first=await h.run()
 assert.deepEqual([first.status,first.fetched,first.upserted],['ok',120,120])
 assert.equal(await h.current(),120)
 assert.deepEqual(tool.calls,[{status:'open'},{status:'open',page:'p2'},{status:'open',page:'p3'}])
 assert.equal(await h.cursor(),at(119))
 tool.calls.length=0
 const second=await h.run()
 assert.deepEqual([second.status,second.fetched,second.upserted],['ok',120,0])
 assert.deepEqual(tool.calls,[{status:'open',cursor:at(119)},{status:'open',cursor:at(119),page:'p2'},{status:'open',cursor:at(119),page:'p3'}])
})

test('旧水位 + 无 incrementalCursor + 续页参数名为 cursor：第 1 页不带游标、结果完整，且不会一直带着旧值失败',async()=>{
 // 旧版映射带水位（续页参数叫 page），跑一次留下水位；改版后去掉 incrementalCursor、续页参数改叫 cursor。
 const mappings=[mappingOf({cursorArgument:'page',nextCursorPath:'$.next'},true)]
 const holder={current:stubTool('page').invoke},h=harness(mappings,holder)
 assert.equal((await h.run()).status,'ok')
 assert.equal(await h.cursor(),at(119),'旧版映射留下了水位')
 mappings[0]=mappingOf({cursorArgument:'cursor',nextCursorPath:'$.next'},false)
 const tool=stubTool('cursor')
 holder.current=tool.invoke
 const run=await h.run()
 assert.deepEqual([run.status,run.fetched,run.upserted],['ok',120,0],'旧水位若被当成页码发出，桩工具会报错')
 assert.deepEqual(tool.calls,[{status:'open'},{status:'open',cursor:'p2'},{status:'open',cursor:'p3'}],'第 1 页不带游标，续页才带')
 assert.equal(await h.current(),120)
 assert.equal(await h.cursor(),null,'全量映射成功后不留水位')
})
