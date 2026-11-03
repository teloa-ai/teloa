import test,{before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type BusinessObjectWorkLink,type BusinessWorkResultVersion,type BusinessWorkPage,type BusinessWorkCursor,type BusinessResultCursor} from '@teloa/contract'
import * as api from '../../backend/src/index.ts'
import {Pool,stopTestContainer} from '../../backend/tests/postgres-test-lifecycle.ts'
import {BusinessDefinitionSourceReader} from '../../backend/src/work/business-definition-source.ts'
import {registerBusinessWorkTools} from '../src/business-work-tools.ts'
import {createBusinessWorkHandler} from '../src/business-work-results.ts'
import {authorizeBusinessConversation,type BusinessConversationAuthorizationPorts} from '../src/business-conversation-authorization.ts'
import {readConversationInstructionIdentity} from '../src/conversation-instruction-identity.ts'

let pool:Pool,container:StartedPostgreSqlContainer|undefined
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 for(const init of [api.initializeBusinessSpaces,api.initializeBusinessDefinitions,api.initializeBusinessConfigurations,api.initializeBusinessRuntime,api.initializeBusinessData,api.initializeBusinessWarehouse,api.initializeBusinessSnapshotReferences,api.initializeBusinessRecords,api.initializeBusinessSync,api.initializeBusinessChangeSets,api.initializeBusinessObjectWork])await init(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})

async function fixture(t:TestContext){
 // 沿用 business-change-sets.pg 的真实本地业务配置与记录初始化，不伪造工作/结果查询。
 const unavailable=async():Promise<never>=>{throw Error('本用例不访问外部来源')}
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const configuration=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new api.BusinessRuntimeService(pool,identity),spaces:new api.BusinessSpaceService(pool,identity)})
 const preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity),actor={ownerId:randomUUID(),scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'对象工作接线验收'})
 const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'state',label:'状态',from:'状态',type:'text',required:true}]}
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[{id:'home',title:'客户',kind:'records',objectType:'customer',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await configuration.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 actor.scopeIds=[draft.scope]
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)})
 const record=(await records.batch(actor,{requestId:randomUUID(),scope:draft.scope,operations:[{operation:'create',type:'customer',title:'合成客户',summary:'',fields:[{name:'state',value:'待联系'}]}]})).items[0]!
 const reference={scope:record.scope,type:record.type,id:record.id,version:record.version,snapshotHash:record.snapshotHash}
 const ctx=new Context();for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]});t.after(()=>ctx.fiber.dispose())
 const {agent}=await ctx.agents.create({sessionId:SessionId('work-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 const {agent:other}=await ctx.agents.create({sessionId:SessionId('other-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 const contexts=new Map([agent,other].map(item=>[item.id,{sessionId:item.id,scopeId:draft.scope,roleId:null,version:1,locked:false}]))
 const owners=new Map<SessionId,string>([agent,other].map(item=>[item.id,actor.ownerId]))
 const ports:BusinessConversationAuthorizationPorts={
  owner:actor.ownerId,conversation:async sessionId=>({ownerId:owners.get(SessionId(sessionId))??'foreign-owner',sessionId,status:'ready'}),
  readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,
  context:async sessionId=>contexts.get(SessionId(sessionId))??null,scopes:async()=>actor.scopeIds.map(scope=>({scope,title:'合成业务'})),
 }
 const authorizeSession=async(scope:string,sessionId:string,signal:AbortSignal)=>{
  const resolved=ctx.agents.get(SessionId(sessionId));if(!resolved)throw new WorkError('teloa/session-unavailable','原会话不可读取')
  const current=await authorizeBusinessConversation(ports,{agent:resolved,signal},'对象工作')
  if(current.scope!==scope)throw new WorkError('teloa/forbidden','原会话不属于当前业务')
 }
 const objectWork=new api.BusinessObjectWorkLinkService(pool,identity,{authorizeSession:async(_db,caller,scope,sessionId)=>{
  if(caller.ownerId!==actor.ownerId)throw new WorkError('teloa/forbidden','本人身份不一致')
  await authorizeSession(scope,sessionId,new AbortController().signal)
 }})
 const changes=new api.BusinessChangeSetService(pool,identity,records)
 const handler=createBusinessWorkHandler(actor.ownerId,async()=>actor.scopeIds,async()=>({objectWork,changes}),authorizeSession)
 t.after(registerBusinessWorkTools(ctx,{...ports,objectWork}))
 let turnNumber=0
 const turn=(target=agent,text='核对原对象并保存分析结果')=>{
  target.session.append('turn/start',{turn:turnNumber++} as never)
  target.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'})
  return readConversationInstructionIdentity(target)
 }
 turn();turn(other)
 const call=(name:string,args:Record<string,unknown>={},target=agent)=>ctx.tools.execute({name,arguments:args,callId:ToolCallId(randomUUID()),agent:target,signal:new AbortController().signal})
 const read=async<T>(args:Record<string,unknown>={},target=agent):Promise<T>=>{const result=await call('teloa_business_work_read',args,target);assert.equal(result.isError,false,JSON.stringify(result));return JSON.parse(result.value as string) as T}
 const link=async(target=agent,title='固定对象工作')=>await handler('business-work/link',{requestId:randomUUID(),reference,sessionId:target.id,title}) as BusinessObjectWorkLink
 const counts=async()=>(await pool.query('select (select count(*)::int from teloa_business_work_results where owner_id=$1) results,(select count(*)::int from teloa_business_work_requests where owner_id=$1) requests',[actor.ownerId])).rows[0]
 return {actor,ctx,agent,other,contexts,owners,ports,records,reference,objectWork,handler,turn,call,read,link,counts}
}
const publishArgs=(workLinkId:string,extra:Record<string,unknown>={})=>({workLinkId,expectedRevision:0,summary:'已核对固定客户来源，待本人决定后续动作。',state:'completed',...extra})
type ResultPage=BusinessWorkPage<BusinessWorkResultVersion,BusinessResultCursor>
type DirectoryPage=BusinessWorkPage<{work:BusinessObjectWorkLink;results:ResultPage},BusinessWorkCursor>

test('真实 ToolRuntime + PG：当前会话读取与发布版本接通，他会话 workLinkId 拒绝且业务记录不变',{timeout:60000},async t=>{
 const f=await fixture(t),own=await f.link(),other=await f.link(f.other,'另一会话私有工作')
 const directory=await f.read<DirectoryPage>()
 assert.deepEqual(directory.items.map(item=>item.work.id),[own.id]);assert.deepEqual(directory.items[0]!.results,{items:[]})
 const source=readConversationInstructionIdentity(f.agent),reply=await f.call('teloa_business_work_result',publishArgs(own.id))
 assert.equal(reply.isError,false,JSON.stringify(reply))
 const saved=JSON.parse(reply.value as string) as BusinessWorkResultVersion
 assert.equal(saved.slot,'summary');assert.equal(saved.revision,1);assert.deepEqual(saved.source,source)
 assert.deepEqual((await f.read<ResultPage>({workLinkId:own.id})).items,[saved])
 assert.deepEqual((await f.handler('business-work/results',{workLinkId:own.id}) as ResultPage).items,[saved])
 const counts=await f.counts()
 const retry=await f.call('teloa_business_work_result',publishArgs(own.id));assert.equal(retry.isError,false);assert.deepEqual(JSON.parse(retry.value as string),saved)
 assert.deepEqual(await f.counts(),counts,'同一指令重试不制造结果版本或请求回执')
 for(const name of ['teloa_business_work_read','teloa_business_work_result']){
  const rejected=await f.call(name,name.endsWith('_read')?{workLinkId:other.id}:publishArgs(other.id))
  assert.equal(rejected.isError,true,JSON.stringify(rejected));assert.ok(!JSON.stringify(rejected).includes(other.title))
 }
 assert.deepEqual(await f.counts(),counts,'他会话读写拒绝不产生任何结果/请求写入')
 f.turn();const stale=await f.call('teloa_business_work_result',publishArgs(own.id))
 assert.equal(stale.isError,true,'新指令仍必须使用最新成果版本')
 const next=await f.call('teloa_business_work_result',publishArgs(own.id,{expectedRevision:1,summary:'第二次核对结果'}))
 assert.equal(next.isError,false,JSON.stringify(next));assert.equal(JSON.parse(next.value as string).revision,2)
 assert.equal((await f.records.get(f.actor,{scope:f.reference.scope,type:f.reference.type,id:f.reference.id})).version,1,'发布工作进展不修改业务事实')
})

test('真实 ToolRuntime + PG：原生 pre-execute 后业务授权或对象版本变化拒绝零写',{timeout:60000},async t=>{
 for(const scenario of ['read-context','result-context','result-object'] as const)await t.test(scenario,async child=>{
  const f=await fixture(child),link=await f.link(),before=await f.counts()
  let approvals=0
  f.ctx.on('tools/pre-execute',async()=>({kind:'ask' as const,reason:'验收已有上游原生许可'}))
  f.ctx.provide('approval',{request:async()=>{
   approvals++
   if(scenario==='result-object')await f.records.edit(f.actor,{scope:f.reference.scope,type:f.reference.type,id:f.reference.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'人工已更新'}]})
   else f.contexts.get(f.agent.id)!.version++
   return 'allowed-once' as const
  }})
  const result=await f.call(scenario==='read-context'?'teloa_business_work_read':'teloa_business_work_result',scenario==='read-context'?{workLinkId:link.id}:publishArgs(link.id))
  assert.equal(approvals,1,'真正经过官方 pre-execute/approval/execute 流程')
  assert.equal(result.isError,true,JSON.stringify(result));assert.deepEqual(await f.counts(),before)
  assert.deepEqual(await f.objectWork.results(f.actor,{workLinkId:link.id}),[])
 })
})

test('真实 ToolRuntime + PG：pre-execute 后本人指令换代不能把旧成果参数归给新指令',{timeout:60000},async t=>{
 const f=await fixture(t),link=await f.link(),before=await f.counts(),original=readConversationInstructionIdentity(f.agent)
 let approvals=0
 f.ctx.on('tools/pre-execute',async()=>({kind:'ask' as const,reason:'验收已有上游原生许可'}))
 f.ctx.provide('approval',{request:async()=>{approvals++;f.turn(f.agent,'停止原来的分析，开始新的工作');return 'allowed-once' as const}})
 const result=await f.call('teloa_business_work_result',publishArgs(link.id))
 const current=readConversationInstructionIdentity(f.agent),stored=await f.objectWork.results(f.actor,{workLinkId:link.id})
 assert.equal(approvals,1);assert.notEqual(current.messageId,original.messageId)
 t.diagnostic(JSON.stringify({originalSource:original,currentSource:current,storedSources:stored.map(row=>row.source)}))
 assert.deepEqual({isError:result.isError,counts:await f.counts()},{isError:true,counts:before},'旧参数必须被拒绝，不能写入结果或幂等回执并归到新本人指令')
})

test('真实 ToolRuntime + PG：工作目录和结果目录续读越过第一页，summary 不被其他 slot 历史挤出',{timeout:60000},async t=>{
 const f=await fixture(t),target=await f.link(f.agent,'最早的目标工作'),ids=[target.id]
 for(let n=0;n<20;n++)ids.push((await f.link(f.agent,'分页工作 '+n)).id)
 const foreign=await f.link(f.other,'同业务另一会话工作')
 for(let n=0;n<21;n++){
  f.turn();const result=await f.call('teloa_business_work_result',publishArgs(target.id,{slot:'aaa',expectedRevision:n,summary:'历次核对 '+n,state:'working'}))
  assert.equal(result.isError,false,JSON.stringify(result))
 }
 f.turn();assert.equal((await f.call('teloa_business_work_result',publishArgs(target.id))).isError,false)
 const first=await f.read<DirectoryPage>();assert.equal(first.items.length,20);assert.ok(first.nextCursor)
 const second=await f.read<DirectoryPage>({cursor:first.nextCursor});assert.equal(second.items.length,1);assert.equal(second.nextCursor,undefined)
 assert.deepEqual([...first.items,...second.items].map(item=>item.work.id).sort(),ids.sort())
 assert.ok(![...first.items,...second.items].some(item=>item.work.id===foreign.id))
 const nested=[...first.items,...second.items].find(item=>item.work.id===target.id)!.results
 assert.equal(nested.items.length,20);assert.ok(nested.nextCursor);assert.ok(nested.items.every(item=>item.slot==='aaa'))
 const rest=await f.read<ResultPage>({workLinkId:target.id,cursor:nested.nextCursor})
 assert.equal(rest.nextCursor,undefined);assert.deepEqual(rest.items.map(item=>[item.slot,item.revision]),[['aaa',1],['summary',1]])
 assert.deepEqual([...nested.items,...rest.items].filter(item=>item.slot==='aaa').map(item=>item.revision),Array.from({length:21},(_,i)=>21-i))
 const rpcFirst=await f.handler('business-work/results',{workLinkId:target.id}) as ResultPage
 assert.deepEqual(rpcFirst,nested);assert.deepEqual(await f.handler('business-work/results',{workLinkId:target.id,cursor:rpcFirst.nextCursor}),rest)
 const listFirst=await f.handler('business-work/list',{scope:f.reference.scope,type:f.reference.type,id:f.reference.id}) as BusinessWorkPage<BusinessObjectWorkLink,BusinessWorkCursor>&{taskResults:unknown[]}
 assert.equal(listFirst.items.length,20);assert.ok(listFirst.nextCursor);assert.deepEqual(listFirst.taskResults,[])
 const listRest=await f.handler('business-work/list',{scope:f.reference.scope,type:f.reference.type,id:f.reference.id,cursor:listFirst.nextCursor}) as typeof listFirst
 assert.deepEqual([...listFirst.items,...listRest.items].map(item=>item.id).sort(),[...ids,foreign.id].sort(),'本人对象页可见其全部工作，模型目录仍限原会话')
})

test('真实 handler + PG：open 只返回获准原会话，跨本人或范围拒绝，不创建消息、工作或会话',{timeout:60000},async t=>{
 const f=await fixture(t),link=await f.link(),counts=await f.counts(),events=f.agent.session.snapshotEvents()
 assert.deepEqual(await f.handler('business-work/open',{scope:f.reference.scope,sessionId:link.sessionId}),{sessionId:f.agent.id})
 assert.deepEqual(f.agent.session.snapshotEvents(),events);assert.deepEqual(await f.counts(),counts)
 assert.equal(f.ctx.agents.get(f.agent.id),f.agent,'返回原 Agent，不另建工作会话')
 await assert.rejects(f.handler('business-work/open',{scope:'forbidden',sessionId:f.agent.id}),{code:'teloa/forbidden'})
 f.owners.set(f.other.id,'foreign-owner')
 await assert.rejects(f.handler('business-work/open',{scope:f.reference.scope,sessionId:f.other.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.handler('business-work/open',{scope:f.reference.scope,sessionId:'unknown-session'}),{code:'teloa/session-unavailable'})
 await assert.rejects(f.handler('business-work/open',{scope:f.reference.scope,sessionId:f.agent.id,ownerId:'override'}),{code:'teloa/invalid-input'})
 f.actor.scopeIds=[]
 await assert.rejects(f.handler('business-work/results',{workLinkId:link.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.handler('business-work/open',{scope:f.reference.scope,sessionId:f.agent.id}),{code:'teloa/forbidden'})
 assert.deepEqual(await f.counts(),counts);assert.deepEqual(f.agent.session.snapshotEvents(),events)
})
