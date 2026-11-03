import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import * as api from '@teloa/backend'
import {BusinessDefinitionSourceReader} from '../../backend/src/work/business-definition-source.ts'
import {registerBusinessChangeSetTools} from '../src/business-change-set-tools.ts'
import type {BusinessChangeSet,BusinessObjectTypeDefinitionV2} from '@teloa/contract'

const connectionString=process.env.TELOA_TYPED_RECORD_TEST_PG_URL
test('真实PG和官方工具：typed采购准备零写、本人拒绝/批准、JSONB原类型、旧串摘要与CAS', {skip:!connectionString},async t=>{
 const url=new URL(connectionString!)
 assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/quality_typed_[a-z0-9_]+$/)
 const pool=new Pool({connectionString});t.after(()=>pool.end())
 for(const init of [api.initializeBusinessSpaces,api.initializeBusinessDefinitions,api.initializeBusinessConfigurations,api.initializeBusinessRuntime,api.initializeBusinessData,api.initializeBusinessWarehouse,api.initializeBusinessSnapshotReferences,api.initializeBusinessRecords,api.initializeBusinessSync,api.initializeBusinessChangeSets])await init(pool)
 const identity={id:randomUUID,now:()=>new Date().toISOString()},unavailable=async():Promise<never>=>{throw Error('不能读取外部业务来源')}
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const configuration=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const actor={ownerId:'typed:'+randomUUID(),scopeIds:[] as string[]}
 let setup=await drafts.begin(actor,{requestId:randomUUID(),title:'合成采购',format:'teloa.business-configuration/v2'})
 const definition:BusinessObjectTypeDefinitionV2={format:'teloa.business-object-type/v2',id:'purchase',version:'1.0.0',domain:setup.scope,title:'采购',unit:'条',lead:'本轮独立合成数据',sourceId:setup.candidate.sources[0]!.sourceId,fields:[
  {name:'code',label:'编号',from:'编号',type:'text',required:true},
  {name:'quantity',label:'数量',from:'数量',type:'number',required:true,integer:true,minimum:0},
  {name:'unit_price',label:'单价',from:'单价',type:'number',required:true,decimalScale:2},
  {name:'accepted',label:'已验收',from:'已验收',type:'boolean',required:true},
  {name:'supplier',label:'供应商',from:'供应商',type:'text',required:false},
 ],constraints:{uniqueFields:['code']}}
 setup=await drafts.revise(actor,{requestId:randomUUID(),draftId:setup.id,expectedRevision:setup.revision,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[{id:'records',title:'采购',kind:'records',objectType:'purchase',fields:definition.fields.map(f=>f.name),allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'records'}})
 const checked=await preview.preview(actor,{draftId:setup.id,expectedRevision:setup.revision})
 await configuration.apply(actor,{requestId:randomUUID(),draftId:setup.id,expectedRevision:setup.revision,expectedBaseVersion:0,previewReceipt:checked.receipt});actor.scopeIds=[setup.scope]
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)})
 const changes=new api.BusinessChangeSetService(pool,identity,records)
 const ctx=new Context()
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]});t.after(()=>ctx.fiber.dispose())
 let modelCalls=0;ctx.on('llm/stream',async function*(){modelCalls++;throw Error('本定向集成禁止发模型')})
 const {agent}=await ctx.agents.create({sessionId:SessionId('typed-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 const turn=(text:string)=>{agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'})}
 turn('保存本条合成采购P-17，数量0，单价12.50，已验收=false，不增设未知供应商。')
 registerBusinessChangeSetTools(ctx,{owner:actor.ownerId,conversation:async sessionId=>({ownerId:actor.ownerId,sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async sessionId=>({sessionId,scopeId:setup.scope,roleId:null,version:1,locked:false}),scopes:async()=>[{scope:setup.scope,title:'合成采购'}],changes})
 // 合成 owner 只通过官方 ToolRuntime 的批准接口回答；后台 apply 与授权复核不替换。
 let approve=false;const reasons:string[]=[]
 ctx.provide('approval',{request:async(request:{reason:string})=>{reasons.push(request.reason);return approve?'allowed-once':'rejected'}})
 const call=(name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(10000)})
 const body=(r:Awaited<ReturnType<typeof call>>)=>JSON.parse(r.content.flatMap(c=>c.type==='text'?[c.text]:[]).join('')) as BusinessChangeSet
 const fields=[{name:'code',value:'P-17'},{name:'quantity',value:0},{name:'unit_price',value:12.5},{name:'accepted',value:false}]
 const prepared=await call('teloa_business_change_prepare',{operations:[{operation:'create',type:'purchase',title:'P-17',summary:'',fields}]})
 assert.equal(prepared.isError,false,JSON.stringify(prepared));const draft=body(prepared)
 assert.equal((await records.list(actor,{scope:setup.scope,type:'purchase',limit:10})).items.length,0)
 assert.equal(reasons.length,0);assert.equal(draft.preview.operations[0]!.fields!.find(f=>f.name==='accepted')!.value,false)
 const adoption={changeSetId:draft.id,expectedRevision:draft.revision,expectedDigest:draft.digest}
 assert.equal((await call('teloa_business_change_apply',adoption)).isError,true)
 assert.equal((await records.list(actor,{scope:setup.scope,type:'purchase',limit:10})).items.length,0)
 assert.match(reasons.at(-1)!,/"值":false/);assert.match(reasons.at(-1)!,/"值":0/)
 approve=true;const applied=await call('teloa_business_change_apply',adoption)
 assert.equal(applied.isError,false,JSON.stringify(applied));const result=body(applied),saved=result.receipt!.items[0]!
 assert.deepEqual((await records.get(actor,{scope:setup.scope,type:'purchase',id:saved.id})),saved)
 assert.equal(saved.fields.find(f=>f.label==='数量')!.value,0);assert.equal(saved.fields.find(f=>f.label==='已验收')!.value,false)
 assert.equal(saved.fields.some(f=>f.label==='供应商'),false)
 const raw=(await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 and object_id=$2',[actor.ownerId,saved.id])).rows[0].snapshot
 const rawFields=new Map(raw.fields.map((f:{label:string;value:unknown})=>[f.label,f.value]))
 assert.equal(typeof rawFields.get('数量'),'number');assert.equal(typeof rawFields.get('单价'),'number');assert.equal(typeof rawFields.get('已验收'),'boolean')
 assert.deepEqual(body(await call('teloa_business_change_apply',adoption)),result)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_record_receipts where owner_id=$1',[actor.ownerId])).rows[0].n,1)
 const legacyInput={scope:setup.scope,type:'purchase',requestId:randomUUID(),title:'legacy',summary:'',fields:[{name:'code',value:'LEGACY'},{name:'quantity',value:'3'},{name:'unit_price',value:'12.50'},{name:'accepted',value:'false'}]}
 const legacy=await records.create(actor,legacyInput),legacyBefore=JSON.stringify(legacy)
 assert.deepEqual(await records.create(actor,legacyInput),legacy)
 assert.equal(JSON.stringify(await records.get(actor,{scope:setup.scope,type:'purchase',id:legacy.id})),legacyBefore)
 assert.equal(legacy.fields.find(f=>f.label==='已验收')!.value,'false')
 await assert.rejects(records.create(actor,{...legacyInput,fields:legacyInput.fields.map(f=>f.name==='accepted'?{...f,value:false}:f)}),{code:'teloa/conflict'})
 const count=async()=>(await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[actor.ownerId])).rows[0].n
 const before=await count()
 await assert.rejects(records.create(actor,{...legacyInput,requestId:randomUUID(),fields:fields.map(f=>f.name==='unit_price'?{...f,value:12.501}:f)}),{code:'teloa/invalid-input'})
 assert.equal(await count(),before)
 turn('将P-17数量改成3，依据版本1。')
 const editFields=fields.map(f=>f.name==='quantity'?{...f,value:3}:f)
 const editing=body(await call('teloa_business_change_prepare',{operations:[{operation:'edit',type:'purchase',id:saved.id,expectedVersion:1,fields:editFields}]}))
 await records.edit(actor,{scope:setup.scope,type:'purchase',id:saved.id,expectedVersion:1,requestId:randomUUID(),fields:fields.map(f=>f.name==='quantity'?{...f,value:5}:f)})
 assert.equal((await call('teloa_business_change_apply',{changeSetId:editing.id,expectedRevision:editing.revision,expectedDigest:editing.digest})).isError,true)
 assert.equal((await records.get(actor,{scope:setup.scope,type:'purchase',id:saved.id})).fields.find(f=>f.label==='数量')!.value,5)
 assert.equal(JSON.stringify(await records.get(actor,{scope:setup.scope,type:'purchase',id:legacy.id})),legacyBefore)
 assert.equal(modelCalls,0)
 t.diagnostic(JSON.stringify({sourceIntegrationOnly:true,prepareFormalWrites:0,rejectionFormalWrites:0,nativeApprovalRequests:reasons.length,storedOriginal:{quantity:rawFields.get('数量'),quantityType:typeof rawFields.get('数量'),unitPrice:rawFields.get('单价'),unitPriceType:typeof rawFields.get('单价'),accepted:rawFields.get('已验收'),acceptedType:typeof rawFields.get('已验收')},supplierAbsent:true,repeatApplyOneReceipt:true,legacyStringAndDigestUnchanged:true,decimalScaleRejectedWithoutWrite:true,lateVersionConflictNoOverwrite:true,models:modelCalls}))
})
