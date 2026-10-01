import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkError,isRecord} from '@teloa/contract'
import type {BusinessLedger} from '@teloa/contract'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,IndustryLoadService,IndustryDataSourceService,initializeIndustryLoads,initializeIndustryDataSources,type IndustryLoadSource,type BusinessLedgerService,type BusinessLedgerActor} from '@teloa/backend'
import {businessDefinitionEndpoints,createBusinessDefinitionHandler,readBusinessLedger,activeSourceIds} from '../src/business-definitions.ts'

test('台账来源名词往返保留，非法显式值不降级成缺省',()=>{
 const value=ledgerSample()
 Object.assign(value.blocks[0]!.source,{sourceNoun:'告警源'})
 assert.equal(readBusinessLedger(value,'SOC').blocks[0]!.source.sourceNoun,'告警源')
 assert.equal(Object.hasOwn(readBusinessLedger(ledgerSample(),'SOC').blocks[0]!.source,'sourceNoun'),false)
 for(const sourceNoun of [null,undefined,'','字'.repeat(13),'告警\n来源','告警\r来源','告警\t来源','告警\u0000来源']){
  Object.assign(value.blocks[0]!.source,{sourceNoun})
  assert.throws(()=>readBusinessLedger(value,'SOC'),{code:'teloa/invalid-host-response'})
 }
})

test('台账进度摘要按对象类型声明往返，缺失或越界均拒绝',()=>{
 const value:any=ledgerSample()
 value.blocks[0].objectType.definition.progress={stageField:'severity',unfinished:['高','中'],waitingForYou:['高']}
 value.blocks[0].progress={unfinished:2,waitingForYou:1,latestChangedAt:null}
 assert.deepEqual(readBusinessLedger(value,'SOC').blocks[0]!.progress,{unfinished:2,waitingForYou:1,latestChangedAt:null})

 delete value.blocks[0].progress
 assert.throws(()=>readBusinessLedger(value,'SOC'),{code:'teloa/invalid-host-response'})
 value.blocks[0].progress={unfinished:1,waitingForYou:2,latestChangedAt:null}
 assert.throws(()=>readBusinessLedger(value,'SOC'),{code:'teloa/invalid-host-response'})
})

const NOW='2026-09-16T12:00:00.000Z'
const H=(byte:string)=>byte.repeat(64)

/** 与 `business-definitions.ts` 的 `ledgerObject` 同规矩重算：`objects[]` 段的 `snapshotHash` 必须是真摘要，不能瞎编（复审 MEDIUM-5）。 */
const ledgerObjectHash=(value:{id:string;title:string;source:string;observedAt:string;receivedAt:string;quality:string;summary:string;fields:Array<{label:string;value:string}>})=>
 createHash('sha256').update(JSON.stringify({scope:'SOC',type:'alert-ticket',id:value.id,version:1,title:value.title,source:value.source,observedAt:value.observedAt,receivedAt:value.receivedAt,quality:value.quality,summary:value.summary,fields:value.fields})).digest('hex')

/** 一份最小但形状完整的台账样例：一个块（对象类型 + 一个 list 视图，两行两个对象）+ 一条动作。 */
function ledgerSample():BusinessLedger{
 const source=(localId:string)=>({loadId:'load-alert',scope:'SOC',localId,version:'1.0.0',contentHash:H('a'),fileHash:H('b'),definitionHash:H('c'),origin:'template' as const})
 const object1={id:'soc-alert-1',title:'告警 1',source:'EDR',observedAt:NOW,receivedAt:NOW,quality:'complete' as const,summary:'说明。',fields:[{label:'严重度',value:'高'}]}
 const object2={id:'soc-alert-2',title:'告警 2',source:'EDR',observedAt:NOW,receivedAt:NOW,quality:'complete' as const,summary:'说明。',fields:[{label:'严重度',value:'中'}]}
 return {
  schema:'teloa.business-ledger/v1',scope:'SOC',computedAt:NOW,
  blocks:[{
   objectType:{
    source:source('alert-ticket'),
    definition:{format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警工单',unit:'条',lead:'来自告警平台的记录。',sourceId:'security-alert-http',
     fields:[{name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','中']}]},
   },
   objects:2,
   source:{sourceId:'security-alert-http',connected:true},
   defaultAction:{actionId:'assign-alert-review',title:'交给同事核对',targetKind:'work-template',available:true},
   coverage:{objects:2,latestReceivedAt:NOW,truncated:false},
   missingFields:[],
   views:[{
    schema:'teloa.business-view-result/v1',viewId:'soc-alert-list',viewVersion:'1.0.0',definitionHash:H('d'),origin:'template',
    kind:'list',chart:'table',title:'告警清单',
    scope:'SOC',objectType:'alert-ticket',computedAt:NOW,
    measures:[{id:'accounts',label:'涉及账号数',fieldType:'number'}],
    rows:[{dimension:'soc-alert-1',label:'告警 1',values:[1]},{dimension:'soc-alert-2',label:'告警 2',values:[2]}],
    dimensionValues:2,
    coverage:{objects:2,latestReceivedAt:NOW,truncated:false},
    missingFields:[],
    objects:[
     {...object1,version:1,snapshotHash:ledgerObjectHash(object1)},
     {...object2,version:1,snapshotHash:ledgerObjectHash(object2)},
    ],
   }],
  }],
  actions:[{
   source:source('assign-alert-review'),
   definition:{format:'teloa.business-action/v1',id:'assign-alert-review',version:'1.0.0',domain:'SOC',title:'交给同事核对',objectType:'alert-ticket',
    target:{kind:'work-template',localId:'alert-triage-review'},inputs:[{from:'object',part:'title'}]},
  }],
 }
}

/**
 * 桩服务：贴合真实 `BusinessLedgerService.read` 的最外层规矩（范围闸 + 入参白名单），其余直接回样例。
 * 「多字段拒绝」这条断言因此证明的是这个桩的行为，不是 `createBusinessDefinitionHandler` 自身的判据——
 * handler 只做 `typeof payload.scope==='string'` 前置，深层白名单校验留给 `.read()`，与
 * `createBusinessDataHandler` 同风格（复审 LOW-5，记录即可，不改风格）。
 */
function stubService(ledger:()=>BusinessLedger){
 return {read:async(actor:BusinessLedgerActor,payload:unknown)=>{
  if(!isRecord(payload)||Object.keys(payload).some(key=>key!=='scope'&&key!=='objectType'))throw new WorkError('teloa/invalid-input','业务台账请求参数不正确。')
  if(typeof payload.scope!=='string')throw new WorkError('teloa/invalid-input','需要明确的业务范围。')
  if(!actor.scopeIds.includes(payload.scope))throw new WorkError('teloa/forbidden','当前主体未获准读取此业务范围。')
  return ledger()
 }} as unknown as BusinessLedgerService
}

test('端点集合包含台账与四个定制端点',()=>{
 assert.deepEqual(businessDefinitionEndpoints,['business-definitions/ledger','business-definitions/customization','business-definitions/preview','business-definitions/apply','business-definitions/revert'])
})

test('未知端点拒绝，台账请求仍按既定输入判据收窄',async()=>{
 const handler=createBusinessDefinitionHandler('owner',async()=>['SOC'],async()=>stubService(ledgerSample))
 await assert.rejects(handler('business-definitions/unknown',{scope:'SOC'}),{code:'teloa/not-found'})
 await assert.rejects(handler('business-definitions/ledger',{}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('business-definitions/ledger',{scope:'SOC',extra:1}),{code:'teloa/invalid-input'})
})

test('台账端点键集收可选 match：原样透给台账服务，其余未知键照旧拒',async()=>{
 const seen:unknown[]=[]
 const service={read:async(_actor:BusinessLedgerActor,payload:unknown)=>{seen.push(payload);return ledgerSample()}} as unknown as BusinessLedgerService
 const handler=createBusinessDefinitionHandler('owner',async()=>['SOC'],async()=>service)
 const payload={scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'}}
 await handler('business-definitions/ledger',payload)
 assert.deepEqual(seen,[payload])
 await assert.rejects(handler('business-definitions/ledger',{...payload,filter:{field:'severity'}}),{code:'teloa/invalid-input'})
 assert.equal(seen.length,1,'未知键在宿主入口就拒，不进台账服务')
})

test('回包逐条核对：多键、缺键、坏摘要、rows 与 objects 不同序都判 invalid-host-response',async()=>{
 for(const mutate of [
  (value:any)=>{value.extra=true},
  (value:any)=>{delete value.computedAt},
  (value:any)=>{value.blocks[0].views[0].definitionHash='短'},
  (value:any)=>{value.blocks[0].views[0].objects=[...value.blocks[0].views[0].objects].reverse()},
  (value:any)=>{value.blocks[0].views[0].rows[0].values=[1,2]},
  (value:any)=>{value.scope='AppSec'},
  (value:any)=>{value.blocks.push(value.blocks[0])},
  // 形态位：kind 不在白名单、kind×chart 不是允许组合、list 之外的形态带 objects 段，都判回包被拼过。
  (value:any)=>{value.blocks[0].views[0].kind='heatmap'},
  (value:any)=>{value.blocks[0].views[0].chart='pie'},
  (value:any)=>{value.blocks[0].views[0].kind='distribution';value.blocks[0].views[0].chart='table'},
  (value:any)=>{delete value.blocks[0].views[0].title},
  (value:any)=>{value.blocks[0].views[0].measures[0].fieldType='timestamp'},
  // 截断前的组数不能少于画出来的行数。
  (value:any)=>{value.blocks[0].views[0].dimensionValues=1},
  // 块级覆盖面：与块的对象数、与视图那份都必须对得上；缺失字段名必须真在声明里。
  (value:any)=>{delete value.blocks[0].coverage},
  (value:any)=>{value.blocks[0].coverage={objects:3,latestReceivedAt:NOW,truncated:false}},
  (value:any)=>{value.blocks[0].views[0].coverage={objects:2,latestReceivedAt:NOW,truncated:true}},
  (value:any)=>{value.blocks[0].missingFields=['not-declared']},
  (value:any)=>{value.blocks[0].missingFields=['severity','severity']},
  // 全批 computedAt 必须一致：视图那份换成别的时刻即判两处不是同一次计算。
  (value:any)=>{value.blocks[0].views[0].computedAt='2020-01-01T00:00:00.000Z'},
  // 块级来源必须就是对象类型声明绑定的那一个。
  (value:any)=>{value.blocks[0].source.sourceId='other-source'},
  // 块内视图标识不得重复。
  (value:any)=>{value.blocks[0].views.push(value.blocks[0].views[0])},
  // 同一视图内的度量标识不得重复。
  (value:any)=>{value.blocks[0].views[0].measures.push(value.blocks[0].views[0].measures[0]);value.blocks[0].views[0].rows[0].values.push(1);value.blocks[0].views[0].rows[1].values.push(2)},
  // exact() 要求白名单里的键必须真的存在，不只是「没有多余键」。
  (value:any)=>{delete value.blocks[0].source.connected},
  // origin 缺位或不是 'template'/'local' 两值之一，块级来源与视图各判一次。
  (value:any)=>{delete value.blocks[0].objectType.source.origin},
  (value:any)=>{value.blocks[0].views[0].origin='draft'},
 ]){
  const value=ledgerSample();mutate(value)
  assert.throws(()=>readBusinessLedger(value,'SOC'),{code:'teloa/invalid-host-response'})
 }
})

/**
 * M2⑤ 否定用例加固：`exact()` 要的是「白名单里的键必须是这个对象自身的属性」，不只是「没有多余键」。
 * 上面那条 `delete ...source.connected` 区分不出这一层——把 `exact()` 里的
 * `||keys.some(key=>!Object.hasOwn(value,key))` 删掉，那一整批否定用例仍然全绿：键一丢，下游
 * `typeof src.connected!=='boolean'` 照样拦住。逐条试过整份样例里 `exact()` 覆盖的每一个键
 * （顶层五项、块级来源与覆盖面、声明来源七项、默认动作四项、视图度量与行、对象与字段），
 * 单纯少一个键在这两份实现下的结果逐字相同，只有 `measures[].fieldType` 两边都合法（它本就可选）。
 *
 * 这一条只缺 `connected` 这一个自身键，其它逐字合法：值放在原型上——`Object.keys` 看不见它
 * （不触发多键判据），`src.connected` 读出来又是合法布尔。台账不是 JSON 文本，而是同进程
 * `BusinessLedgerService.read` 直接给的对象，带 getter 的类实例、被 `__proto__` 污染过的对象正好长这样，
 * 只有存在性判据拦得住。mutation 验证：删掉上面那半条判据后这一条不再抛错，整份回包被读成"已连接"（用例转红）。
 */
test('回包白名单里的键必须是自身属性：值借自原型也判 invalid-host-response',()=>{
 const value:any=ledgerSample()
 value.blocks[0].source=Object.assign(Object.create({connected:true}),{sourceId:'security-alert-http'})
 assert.throws(()=>readBusinessLedger(value,'SOC'),{code:'teloa/invalid-host-response'})
})

test('主体范围闸在适配层也成立：请求的范围不在本人范围集合里就不下发',async()=>{
 const handler=createBusinessDefinitionHandler('owner',async()=>['SOC'],async()=>stubService(ledgerSample))
 await assert.rejects(handler('business-definitions/ledger',{scope:'AppSec'}),{code:'teloa/forbidden'})
})

test('真形状用例：合法回包原样透过白名单投影',async()=>{
 const handler=createBusinessDefinitionHandler('owner',async()=>['SOC','AppSec'],async()=>stubService(ledgerSample))
 const ledger=await handler('business-definitions/ledger',{scope:'SOC'}) as BusinessLedger
 assert.equal(ledger.scope,'SOC')
 assert.equal(ledger.blocks.length,1)
 assert.equal(ledger.blocks[0]!.objectType.definition.id,'alert-ticket')
 assert.equal(ledger.blocks[0]!.views[0]!.objects?.length,2)
 const view=ledger.blocks[0]!.views[0]!
 assert.deepEqual([view.kind,view.chart,view.title,view.dimensionValues],['list','table','告警清单',2])
 assert.deepEqual(view.measures,[{id:'accounts',label:'涉及账号数',fieldType:'number'}])
 assert.deepEqual(ledger.blocks[0]!.coverage,{objects:2,latestReceivedAt:NOW,truncated:false})
 assert.deepEqual(ledger.blocks[0]!.missingFields,[])
 assert.deepEqual(ledger.actions.map(row=>row.definition.id),['assign-alert-review'])
})

/**
 * `activeSourceIds` 的真形状用例（复审 HIGH-1）：装配处曾经拿 `teloa_industry_data_source_instances.item_local_id`
 * 冒充数据源的 `sourceId`，两者是不同的命名空间，模板作者一旦让资源本地标识与 `sourceId` 不同名，
 * 已经授权成功的数据源就会被判"还没接上来源"。这里用真实 `IndustryLoadService`/`IndustryDataSourceService`
 * 把一个实例走到 `active`，资源的 localId（`soc-alert-feed`）故意与声明的 `sourceId`（`security-alert-http`）不同名，
 * 不再像旧夹具那样自我印证。
 */
let container:StartedPostgreSqlContainer,pool:IndustryLoadService['pool'],temporary:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').withDatabase('teloa').start()
 temporary=await mkdtemp(join(tmpdir(),'teloa-business-definitions-'));const config=join(temporary,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})).pool
 await initializeIndustryLoads(pool);await initializeIndustryDataSources(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop();if(temporary)await rm(temporary,{recursive:true,force:true})})

const fixedDefinition={format:'teloa.data-source/v1' as const,sourceId:'security-alert-http',scopes:['SOC']}
/** 清单资源的本地标识与声明的 sourceId 故意不同名，逼出 HIGH-1 那条判据。 */
const snapshot={templateId:'security',templateVersion:'1.0.0',title:'安全工作',domain:'SOC',description:'安全行业模板',
 resources:[{localId:'soc-alert-feed',kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,available:true}],
 relations:[],entrypoints:[]}
const industrySource:IndustryLoadSource={read:async()=>structuredClone(snapshot)}
const ready={ready:async()=>({ready:true as const,probedAt:NOW})}

async function setupInstance(owner:string){
 const identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,industrySource)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'a'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'安全空间'}})
 const sourceReader={read:async(db:Parameters<IndustryLoadService['getInTransaction']>[0],ownerId:string,input:{loadId:string;itemInstanceId:string})=>{
  const loaded=await loads.getInTransaction(db,ownerId,{loadId:input.loadId}),item=loaded.items.find(candidate=>candidate.instanceId===input.itemInstanceId)!
  return {loadId:loaded.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:loaded.contentId,contentHash:loaded.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition:fixedDefinition}
 }}
 const service=new IndustryDataSourceService(pool,identity,loads,sourceReader,ready)
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 return {load,loads,service,created}
}

test('activeSourceIds 按 binding.sourceId 判定已连接，资源本地标识与 sourceId 不同名也不受影响',async()=>{
 const owner=randomUUID(),{load,service,created}=await setupInstance(owner)
 await service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 const client=await pool.connect()
 try{
  const connected=await activeSourceIds(client,owner,load.id)
  assert.deepEqual([...connected],['security-alert-http'],'localId 是 soc-alert-feed，取的必须是 binding 里的 sourceId')
 }finally{client.release()}
})

test('activeSourceIds 只认 state=active，未授权（needs_authorization）实例不计入已连接集合',async()=>{
 const owner=randomUUID(),{load}=await setupInstance(owner)
 const client=await pool.connect()
 try{
  const connected=await activeSourceIds(client,owner,load.id)
  assert.equal(connected.size,0)
 }finally{client.release()}
})

test('activeSourceIds 沿升级继任加载的 carried_from 认领仍在服役的已连接数据源',async()=>{
 const owner=randomUUID(),{load,loads,service,created}=await setupInstance(owner)
 await service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 // 用另一份固定内容建立继任加载，再按升级写入的同一份血缘形状挂回旧实例。
 const successor=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'b'.repeat(64),target:{kind:'existing',spaceId:load.space.id,expectedVersion:load.space.version}})
 const oldItem=load.items[0]!,successorItem=successor.items[0]!
 await pool.query('update teloa_industry_load_items set carried_from=$1 where load_id=$2 and instance_id=$3',[oldItem.instanceId,successor.id,successorItem.instanceId])
 await pool.query("update teloa_industry_loads set status='superseded' where id=$1",[load.id])
 const client=await pool.connect()
 try{
  const connected=await activeSourceIds(client,owner,successor.id)
  assert.deepEqual([...connected],['security-alert-http'],'继任加载应继续展示旧实例已经完成的连接')
 }finally{client.release()}
})
