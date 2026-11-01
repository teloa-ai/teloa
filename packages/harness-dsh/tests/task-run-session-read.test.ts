import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import {TaskRunService} from '@teloa/backend'
import type {TaskRun} from '@teloa/backend'
import {roleMemoryNotice} from '../../backend/src/work/task-runs.ts'
import {selectTaskRunMemory} from '../../backend/src/work/task-run-memory-selection.ts'
import {createTaskRunHandler} from '../src/task-runs.ts'

const owner='local:teloa-owner',sessionId='task-run-original',requestId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',roleId='33333333-3333-4333-8333-333333333333'
const ids=['44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666'] as const
function fixture(){
 const runs=ids.map((id,index)=>{const version=[1,4,6][index];assert.ok(version!==undefined);return {id,taskId,sessionId,taskVersion:version,roleId,roleVersion:4,agentPresetId:'standard',nativeRequestId:id,state:'ended',evidence:{state:'ended',turn:index+1,messageSeq:index*20+1,endSeq:index*20+10,reason:'completed'},inputText:JSON.stringify({task:{id:taskId,version,title:'原工单核验'}})}})
 const run=(index:number)=>{const value=runs[index];assert.ok(value,'夹具必须包含指定历史Run');return value}
 const conversation={id:requestId,ownerId:owner,sessionId,requestedSessionId:sessionId,status:'ready',purpose:'task-run',requestId,title:'原工单核验',run:{taskId,taskVersion:1,roleId,roleVersion:4,agentPresetId:'standard'}}
 const calls:string[]=[],service={sessionRun:async(who:string,input:{sessionId:string})=>{assert.equal(who,owner);assert.deepEqual(input,{sessionId});calls.push('verified-history');return run(2)},requestForSession:async(who:string,input:{requestId:string;taskId:string;expectedTaskVersion:number;sessionId:string})=>{assert.equal(who,owner);calls.push('original-reservation');if(input.requestId!==requestId||input.taskId!==taskId||input.expectedTaskVersion!==1||input.sessionId!==sessionId)throw new WorkError('teloa/conflict','预约锚点不符');return run(0)},get:async(who:string,input:{runId:string})=>{assert.equal(who,owner);calls.push('selected-run');const value=runs.find(run=>run.id===input.runId);assert.ok(value,'夹具只允许既有Run');return value}}
 const handler=()=>createTaskRunHandler(owner,async()=>service as unknown as TaskRunService,{check:async()=>{throw Error('只读不能装配')},send:async()=>{throw Error('只读不能发送')},stop:async()=>{throw Error('只读不能停止')},events:async()=>[]},undefined,{conversations:{snapshotBySession:async(who,id)=>{assert.equal(who,owner);assert.equal(id,sessionId);calls.push('reservation');return conversation as never},createRun:async()=>{throw Error('不能创建')},runReservation:async()=>{throw Error('不能预约')},failRunReservation:async()=>{throw Error('不能写入')}},links:{change:async()=>{throw Error('不能关联')}}})
 return {runs,run,conversation,calls,service,handler}
}
test('本人只读当前与明确历史Run复用完整后端历史验证，原reservation不改绑',async()=>{
 const f=fixture(),before=structuredClone(f.conversation),read=f.handler(),signal=AbortSignal.timeout(5000)
 const current=await read('task-runs/session',{sessionId},signal)
 assert.equal(current.run.id,ids[2]);assert.equal(current.currentRunId,ids[2]);assert.equal(current.anchor.id,ids[0]);assert.deepEqual(current.conversation,before)
 for(const id of ids){const historical=await read('task-runs/session',{sessionId,runId:id},signal);assert.equal(historical.run.id,id);assert.equal(historical.anchor.taskVersion,1);assert.equal(historical.currentRunId,ids[2])}
 assert.equal(f.calls.filter(call=>call==='verified-history').length,8);assert.deepEqual(f.conversation,before)
})
test('只有单Run时仍沿原预约读取，不需要新会话或来源迁移',async()=>{
 const f=fixture();f.service.sessionRun=async()=>f.run(0)
 const result=await f.handler()('task-runs/session',{sessionId},AbortSignal.timeout(5000));assert.equal(result.run.id,ids[0]);assert.equal(result.anchor.id,ids[0])
})
test('本人单Run授权anchor按身份字段核对，键顺序不同仍兼容',async()=>{
 const f=fixture(),executor={kind:'owner',grantId:requestId,grantVersion:1}
 Object.assign(f.run(0),{roleId:null,roleVersion:null,executor});Object.assign(f.conversation.run,{roleId:null,roleVersion:null,executor:{grantVersion:1,grantId:requestId,kind:'owner'}});f.service.sessionRun=async()=>f.run(0)
 assert.equal((await f.handler()('task-runs/session',{sessionId},AbortSignal.timeout(5000))).run.id,ids[0])
 Object.assign(f.conversation.run,{executor:{...executor,grantVersion:2}})
 await assert.rejects(f.handler()('task-runs/session',{sessionId},AbortSignal.timeout(5000)),{code:'teloa/conflict'})
})
test('错owner、员工、preset、原预约anchor及跨会话Run都拒绝',async()=>{
 for(const change of ['owner','role','preset','anchor','session'] as const){const f=fixture();if(change==='owner')f.conversation.ownerId='other';if(change==='role')f.run(2).roleId=requestId;if(change==='preset')f.run(2).agentPresetId='other';if(change==='anchor')f.conversation.run.taskVersion=4;if(change==='session')f.run(1).sessionId='another-session';await assert.rejects(f.handler()('task-runs/session',{sessionId,...(change==='session'?{runId:ids[1]}:{})},AbortSignal.timeout(5000)),{code:'teloa/conflict'})}
})
test('后端整条历史验证失败不能用客户端最近Run降级；父交办身份不可调用本人读口',async()=>{
 const f=fixture();f.service.sessionRun=async()=>{throw new WorkError('teloa/storage-corrupt','历史边不符')}
 await assert.rejects(f.handler()('task-runs/session',{sessionId},AbortSignal.timeout(5000)),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.handler()('task-runs/session',{sessionId},AbortSignal.timeout(5000),{sessionId:'parent',requestId,roleId}),{code:'teloa/invalid-input'})
})

// 仅持久化端口为内存夹具；正常prepare路由、选择解析和后端冷读均执行产品实现。
function memorySessionFixture(){
 const who='synthetic-owner',requestId=randomUUID(),taskId=randomUUID(),roleId=randomUUID(),sessionId='task-run-'+requestId,title='合成会话回读',preset='standard'
 const markdown='本例合成经验。',item=():TaskRun['memory'][number]=>({id:randomUUID(),version:1,title:'合成经验',markdown,contentHash:createHash('sha256').update(markdown).digest('hex'),source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}})
 let available=[item(),item()],stored:Record<string,unknown>|undefined,sourceReads=0,created=0,prepared=0,modelCalls=0
 const queries:string[]=[],db={query:async(sql:string,values:unknown[]=[])=>{
  queries.push(sql)
  if(!sql.startsWith('select * from teloa_task_runs')||!stored)return {rows:[]}
  if(sql.includes('where session_id=$1'))return {rows:stored.session_id===values[0]?[stored]:[]}
  const field=sql.includes('request_id=$2')?'request_id':sql.includes('session_id=$2')?'session_id':'id'
  return {rows:stored.owner_id===values[0]&&stored[field]===values[1]?[stored]:[]}
 },release(){}}
 const backend=new TaskRunService({connect:async()=>db} as unknown as ConstructorParameters<typeof TaskRunService>[0],{id:randomUUID,now:()=>new Date().toISOString()},async()=>{throw Error('冷读不能打开native')},{allowedTools:[],roleMemory:async()=>{throw Error('冷读不能重新召回')}})
 const target={taskId,taskVersion:1,title,roleId,roleVersion:1,agentPresetId:preset}
 const conversation={id:randomUUID(),ownerId:who,sessionId,requestedSessionId:sessionId,status:'ready',purpose:'task-run',requestId,title,run:{...target}}
 const service=Object.assign(Object.create(backend),{conversationParent:async()=>null,sourceContinuation:async()=>null,preparationTarget:async()=>target,prepare:async(owner:string,payload:Record<string,unknown>)=>{
  prepared++;assert.equal(owner,who)
  const memory=await selectTaskRunMemory(payload.selectedMemoryIds,async ids=>{sourceReads++;return ids?available.filter(row=>ids.includes(row.id)):available})
  stored={id:randomUUID(),owner_id:who,request_id:requestId,request_spec:{...payload},task_id:taskId,role_id:roleId,task_version:1,role_version:1,link_version:1,session_id:sessionId,native_request_id:randomUUID(),state:'prepared',evidence:null,created_at:new Date(),allowed_tools:[],role_memory:memory,agent_preset_id:preset,input_text:JSON.stringify({task:{id:taskId,version:1,title,goal:'核对合成资料',scope:'general'},role:{id:roleId,version:1,name:'合成岗位',duty:'核对',dataScope:'本例',executionScope:'只读',runtimeConfig:{agentPresetId:preset}},...(memory.length?{memory:{notice:roleMemoryNotice,contents:memory}}:{})})}
  return backend.get(who,{runId:stored.id})
 }}) as TaskRunService
 const handler=createTaskRunHandler(who,async()=>service,{check:async()=>{},resolvePreset:async()=>preset,send:async()=>{modelCalls++;throw Error('不能发送模型')},stop:async()=>{throw Error('不能停止')},events:async()=>[]},undefined,{conversations:{runReservation:async()=>null,failRunReservation:async()=>{throw Error('不能写失败')},createRun:async()=>{created++;return conversation as never},snapshotBySession:async()=>conversation as never},links:{change:async()=>({kind:'task',objectId:taskId,objectVersion:1,conversationId:conversation.id,sessionId,version:1,active:true,updatedAt:new Date().toISOString(),scopeId:null})}})
 return {requestId,taskId,sessionId,handler,firstMemoryId:available[0]!.id,dropCurrentMemories(){available=[]},stored:()=>stored!,stats:()=>({sourceReads,created,prepared,modelCalls}),queries}
}
test('省略/空/非空选择经正常prepare路由后，正常session读回同一固定Run且不重新召回',async()=>{
 for(const kind of ['omitted','empty','selected'] as const){
  const f=memorySessionFixture(),selection=kind==='omitted'?{}:{selectedMemoryIds:kind==='empty'?[]:[f.firstMemoryId.toUpperCase()]},payload={requestId:f.requestId,taskId:f.taskId,expectedTaskVersion:1,...selection}
  const run=await f.handler('task-runs/prepare',payload,AbortSignal.timeout(5000)),before=JSON.stringify(f.stored()),stats=f.stats()
  assert.equal(Object.hasOwn(f.stored().request_spec as object,'selectedMemoryIds'),kind!=='omitted')
  assert.deepEqual((f.stored().request_spec as {selectedMemoryIds?:string[]}).selectedMemoryIds,kind==='omitted'?undefined:kind==='empty'?[]:[f.firstMemoryId])
  f.dropCurrentMemories()
  const read=await f.handler('task-runs/session',{sessionId:f.sessionId},AbortSignal.timeout(5000)),historical=await f.handler('task-runs/session',{sessionId:f.sessionId,runId:run.id},AbortSignal.timeout(5000))
  assert.equal(read.run.id,run.id);assert.equal(read.anchor.id,run.id);assert.equal(historical.run.id,run.id);assert.deepEqual(read.run.memory,run.memory)
  assert.equal(run.memory.length,kind==='omitted'?2:kind==='empty'?0:1)
  assert.equal(JSON.stringify(f.stored()),before);assert.deepEqual(f.stats(),stats);assert.equal(stats.modelCalls,0);assert.equal(stats.sourceReads,kind==='empty'?0:1)
  const changed=kind==='empty'?{...payload,selectedMemoryIds:[f.firstMemoryId]}:{...payload,selectedMemoryIds:[]}
  await assert.rejects(f.handler('task-runs/prepare',changed,AbortSignal.timeout(5000)),{code:'teloa/conflict'})
  assert.deepEqual(f.stats(),stats,'不同选择不能借原请求触发late prepare或新会话')
  assert.ok(f.queries.every(sql=>!/^(insert|update|delete)\b/i.test(sql)))
 }
})
