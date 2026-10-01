/** 真库、生产装配、原生 Agent/ToolRuntime/JSONL；模型只用本地固定脚本，不访问外部服务。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {brandString} from '@deepseek-ai/dsh-brand'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessDataService,openResourceDatabase,type TaskRun} from '@teloa/backend'
import {encodeResourceReference,type BusinessObjectReference} from '@teloa/contract'
import {apply} from '../src/index.ts'
import {compositionEntries,type RpcHandler} from './fixtures/production-host.ts'
import {installNativeHostServices} from './fixtures/native-host-services.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {ConversationWorkStatus} from '../src/conversation-work-dispatch.ts'
import {publishConversationWorkStatus} from '../src/conversation-work-publisher.ts'
import {createTaskRunApi} from '../../client/ui-workbench/src/client/task-run-api.ts'

const owner='local:teloa-owner',pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))
async function until(check:()=>boolean|Promise<boolean>,label:string){const deadline=Date.now()+15000;while(!await check()){assert.ok(Date.now()<deadline,label);await pause(25)}}
class WorkModel extends LlmAdapter{
 readonly calls=new Map<string,number>();role={id:'',version:0};blockRuns=false;release:undefined|(()=>void)
 readonly instructions=new Map<string,{name:string;arguments:unknown}>()
 readonly repeatDispatch=new Set<string>()
 override async resolveModel(provider:string,id:string){return {provider,id,name:id}}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  const sessionId=String(options.sessionId),count=this.calls.get(sessionId)??0;this.calls.set(sessionId,count+1)
  if(!sessionId.startsWith('task-run-')&&(count===0||count===1&&this.repeatDispatch.has(sessionId))){
   const selected=this.instructions.get(sessionId),id=ToolCallId('dispatch-'+sessionId+'-'+count),name=selected?.name??'teloa_work_dispatch',args=JSON.stringify(selected?.arguments??{scope:'SOC',title:'调查真实事件',goal:'核对已提供的证据并给出未确认事项',roleId:this.role.id,expectedRoleVersion:this.role.version})
   yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}};yield {type:'finish',reason:{kind:'tool-calls'}};return
  }
  if(sessionId.startsWith('task-run-')&&this.blockRuns)await new Promise<void>(resolve=>{this.release=resolve;options.signal?.addEventListener('abort',()=>resolve(),{once:true})})
  const text=sessionId.startsWith('task-run-')?'结论：已核对本次任务。依据：受控验收输入。未确认：没有连接外部告警源。':'已通过工具提交，请查看实际交办状态。'
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}
 }
}
test('统一交办：普通主会话→真实岗位Task/Run→结果回原会话，丢响应不重派、缺源明确失败',{timeout:180000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-conversation-work-')),ctx=new Context(),oldRoot=process.env.TELOA_PROJECT_ROOT
 process.env.TELOA_PROJECT_ROOT=resolve(process.cwd());process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 t.after(async()=>{await ctx.fiber.dispose();await container.stop();if(oldRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=oldRoot;await rm(root,{recursive:true,force:true})})
 const config=join(root,'.runtime/teloa/database.json');await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true});await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true});await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 ctx.provide('loader',compositionEntries());await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]});await installNativeHostServices(ctx,join(root,'.runtime/dsh'))
 const model=new WorkModel();ctx.llm.registerAdapter(['scripted-work'],model)
 const workspaces=new Map<string,{id:string;path:string}>()
 ctx.provide('workspaceRegistry',{create:async(path:string)=>{const prior=[...workspaces.values()].find(x=>x.path===path);if(prior)return prior;const value={id:randomUUID(),path};workspaces.set(value.id,value);return value},get:(id:string)=>workspaces.get(id),list:()=>[...workspaces.values()]})
 ctx.provide('agentPresets',{serviceFor:()=>undefined,acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??'teloa-standard'})})
 ctx.provide('skills',{list:async()=>[],registerProvider:(factory:(control:{invalidate:()=>void;signal:AbortSignal})=>unknown)=>{factory({invalidate:()=>{},signal:new AbortController().signal});return ()=>{}}});ctx.provide('fs',{});ctx.provide('fileReferences',{})
 let loseRunResponse=true
 ctx.provide('sessionController',{
  create:async(input:{sessionId?:string;agentPreset?:string;workspaceId?:string}={})=>{const sessionId=SessionId(input.sessionId??randomUUID()),cwd=workspaces.get(input.workspaceId??'')?.path??root;await ctx.agents.create({sessionId,meta:{cwd,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})},agentOptions:{provider:'scripted-work',model:'fixed'}});return {sessionId,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})}},
  resolveAgent:async(id:string)=>{const agent=ctx.agents.get(SessionId(id));return agent?{agent}:{error:{code:'not-found',message:'missing'}}},
  inspect:async(id:string)=>{const agent=ctx.agents.get(SessionId(id));if(!agent)throw Error('missing');return {sessionId:id,meta:agent.session.header,status:agent.status}},modelCatalog:async()=>({default:{provider:'scripted-work',model:'fixed'}}),
  prompt:async(input:{sessionId:string;requestId:string;content:Parameters<typeof createUserMessage>[0]['content']})=>{ctx.agents.get(SessionId(input.sessionId))!.followup(createUserMessage({content:input.content,source:{kind:'user',rpcId:brandString<SessionRequestId>(input.requestId)}}));if(input.sessionId.startsWith('task-run-')&&loseRunResponse){loseRunResponse=false;throw Error('已受理后回包丢失')}return {accepted:true}},
  cancel:({sessionId}:{sessionId:string})=>{ctx.agents.get(SessionId(sessionId))!.cancel({kind:'user'},{keepInbox:true});return {accepted:true}},
 })
 let rpc:RpcHandler|undefined;ctx.provide('connection',{fetch:{register:()=>async()=>{}},rpc:{handle:(_path:string,handler:RpcHandler)=>{rpc=handler;return ()=>{}}}})
 await apply(ctx,{projectRoot:root})
 // 模拟本人在原生确认通道逐次批准，仅限本用例的交办工具；不绕过生产审批守卫。
 const approvedTools:string[]=[],allowedTools=new Set(['teloa_work_dispatch','teloa_work_collect_reports'])
 ctx.on('approval/request',async request=>{if(!allowedTools.has(request.toolName))return 'rejected';approvedTools.push(request.toolName);return 'allowed-once'})
 const database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()}),pool=database.pool;t.after(()=>pool.end())
 const call=async<T>(endpoint:string,payload:unknown):Promise<T>=>{const result=await rpc!(endpoint,payload,AbortSignal.timeout(15000));assert.equal(result.ok,true,endpoint+': '+JSON.stringify(result.error));return result.value as T}
 model.role=await call('roles/create',{requestId:randomUUID(),fields:{name:'真实调查同事',kind:'employee',scopes:['SOC'],duty:'调查事件',dataScope:'本次输入',executionScope:'只读分析',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 const memory=await call<{id:string;stateVersion:number}>('role-memory/create',{requestId:randomUUID(),roleId:model.role.id,expectedRoleVersion:model.role.version,title:'本岗位固定经验',markdown:'岗位私有验收经验：保留依据与未确认事项。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 await call('role-memory/confirm',{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:memory.stateVersion})
 const conversation=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title:'统一交办验收'})
 model.repeatDispatch.add(conversation.sessionId)
 const context=await call<{version:number}>('work-context/set',{requestId:randomUUID(),sessionId:conversation.sessionId,scopeId:'SOC',roleId:model.role.id,expectedVersion:0});assert.equal(context.version,1)
 await ctx.sessionController.prompt({sessionId:SessionId(conversation.sessionId),requestId:brandString<SessionRequestId>(randomUUID()),mode:'queue',content:[{type:'text',text:'请交给所选同事调查这个事件，给出结论和未确认事项。'}]},new AbortController().signal)
 await until(async()=>Number((await pool.query('select count(*) as n from teloa_task_runs')).rows[0].n)===1,'必须通过生产工具真正创建一个Run')
 assert.equal(approvedTools[0],'teloa_work_dispatch','原生模型交办必须经过本人批准事件')
 const taskRow=(await pool.query('select * from teloa_tasks')).rows[0];assert.equal(taskRow.assignee_role_id,model.role.id);assert.equal(taskRow.definition.scope,'SOC')
 let run=(await call<TaskRun[]>('task-runs/list',{taskId:taskRow.id}))[0]!
 await until(()=>model.calls.has(run.sessionId)&&ctx.agents.get(SessionId(run.sessionId))?.status==='idle','岗位原生执行应真正开始并完成，不能把准备后尚未发送的idle当成完成')
 run=await call<TaskRun>('task-runs/reconcile',{runId:run.id});assert.equal(run.state,'ended');assert.equal(run.evidence?.state==='ended'&&run.evidence.reason,'completed')
 assert.equal(run.memory.length,1,'真实准备必须读取已生效岗位记忆，守住浏览器有记忆岗位这一接缝')
 const clientRunApi=createTaskRunApi(call),clientRuns=await clientRunApi.list(taskRow.id)
 assert.equal(clientRuns.length,1);assert.equal(clientRuns[0]!.state,'ended');assert.equal(clientRuns[0]!.reason,'completed');assert.equal(clientRuns[0]!.roleName,'真实调查同事')
 assert.ok(!JSON.stringify(clientRuns).includes('岗位私有验收经验'));assert.equal(Object.hasOwn(clientRuns[0]!,'memory'),false)
 assert.deepEqual(await clientRunApi.reconcile(clientRuns[0]!),clientRuns[0],'真实列表与核对回包均通过客户端同一严格解析器')
 const work=(await call<ConversationWorkStatus[]>('work-requests/list',{sessionId:conversation.sessionId}))[0]!
 assert.equal(work.members[0]?.run?.id,run.id);assert.equal(work.counts.received,1);assert.match(work.members[0]?.result??'',/依据/)
 const origin=ctx.agents.get(SessionId(conversation.sessionId))!;await origin.whenIdle()
 // 同一原生用户轮的下一 step 再次交办；新 tool call、相同原指令身份，仍只创建原 Task/Run。
 assert.deepEqual(approvedTools,['teloa_work_dispatch','teloa_work_dispatch']);assert.ok((model.calls.get(conversation.sessionId)??0)>=3)
 for(const count of [0,1]){
  const result=origin.session.snapshotEvents().find(event=>event.type==='tool/result'&&event.data.message.toolCallId==='dispatch-'+conversation.sessionId+'-'+count)
  assert.ok(result&&result.type==='tool/result','真实原生轮必须落下每次交办的工具回包')
  assert.equal(result.data.message.isError,false,JSON.stringify(result.data.message))
 }
 assert.equal((await pool.query('select count(*)::int as n from teloa_tasks')).rows[0].n,1);assert.equal((await pool.query('select count(*)::int as n from teloa_task_runs')).rows[0].n,1);assert.equal(model.calls.get(run.sessionId),1)
 await until(()=>origin.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.requestId===work.requestId),'后台观察应自动把结果持久化回原会话')
 const before=origin.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.requestId===work.requestId).length
 const current=await call<ConversationWorkStatus>('work-requests/status',{sessionId:conversation.sessionId,requestId:work.requestId})
 await publishConversationWorkStatus(ctx,current,async()=>{});await publishConversationWorkStatus(ctx,{...current,observedAt:new Date().toISOString()},async()=>{})
 assert.equal(origin.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.requestId===work.requestId).length,before,'同结果与刷新时间不能产生重复结果通知')
 const facts=await ctx.tools.execute({agent:origin,name:'teloa_work_facts',arguments:{scope:'SOC',from:'2026-01-01T00:00:00.000Z',to:'2027-01-01T00:00:00.000Z',timezone:'Asia/Singapore'},callId:ToolCallId('facts'),signal:AbortSignal.timeout(15000)})
 assert.equal(facts.isError,false);assert.equal(model.calls.get(run.sessionId),1,'查看事实不得重新唤醒同事')
 const missing=await ctx.tools.execute({agent:origin,name:'teloa_business_data_query',arguments:{scope:'SOC',observedAfter:'2026-08-26T00:00:00.000Z',limit:100},callId:ToolCallId('missing-source'),signal:AbortSignal.timeout(15000)})
 assert.equal(missing.isError,true);assert.match(JSON.stringify(missing),/来源|未配置|不可/)
 const locked=await rpc!('work-context/set',{requestId:randomUUID(),sessionId:conversation.sessionId,scopeId:'general',roleId:null,expectedVersion:1},AbortSignal.timeout(15000));assert.equal(locked.ok,false)
 await call('work-requests/stop',{sessionId:conversation.sessionId,requestId:work.requestId})
 const stopRetry=await call<ConversationWorkStatus>('work-requests/resume',{sessionId:conversation.sessionId,requestId:work.requestId})
 assert.ok(stopRetry.stoppedAt);assert.equal(model.calls.get(run.sessionId),1)
 assert.equal((await pool.query('select count(*)::int as n from teloa_tasks')).rows[0].n,1);assert.equal((await pool.query('select count(*)::int as n from teloa_task_runs')).rows[0].n,1)
 const links=(await pool.query('select session_id from teloa_object_conversations where object_id=$1',[taskRow.id])).rows.map(row=>row.session_id)
 assert.ok(links.includes(conversation.sessionId));assert.ok(links.includes(run.sessionId))

 const invoke=async(title:string,scope:string,text:string,instruction:{name:string;arguments:unknown})=>{
  const {sessionId}=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title})
  await call('work-context/set',{requestId:randomUUID(),sessionId,scopeId:scope,roleId:null,expectedVersion:0})
  model.instructions.set(sessionId,instruction)
  await ctx.sessionController.prompt({sessionId:SessionId(sessionId),requestId:brandString<SessionRequestId>(randomUUID()),mode:'queue',content:[{type:'text',text}]},new AbortController().signal)
  const agent=ctx.agents.get(SessionId(sessionId))!;await agent.whenIdle()
  const work=(await call<ConversationWorkStatus[]>('work-requests/list',{sessionId}))[0]
  assert.ok(work,'原生工具必须持久化本条真实交办')
  await until(async()=>{
   const current=await call<ConversationWorkStatus>('work-requests/status',{sessionId,requestId:work.requestId})
   for(const member of current.members)if(member.run&&ctx.agents.get(SessionId(member.run.sessionId))?.status==='idle')await call('task-runs/reconcile',{runId:member.run.id})
   return (await call<ConversationWorkStatus>('work-requests/status',{sessionId,requestId:work.requestId})).counts.waiting===0
  },'所有已启动成员均应有真实终态')
  return call<ConversationWorkStatus>('work-requests/status',{sessionId,requestId:work.requestId})
 }
 await t.test('固定事件引用通过真实业务快照与 Task 来源关联进入真实 Run',async()=>{
  const stamp=new Date().toISOString(),source=new BusinessDataService(pool,{id:'fixed-acceptance-source',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'fixed-acceptance-source',scope:'SOC',capturedAt:stamp,items:[{scope:'SOC',type:'alert',id:'acceptance-event-1',version:1,title:'隔离验收固定事件',source:'验收固定来源',observedAt:stamp,receivedAt:stamp,quality:'complete',summary:'只有隔离验收可见的事实',fields:[{label:'证据',value:'固定快照证据'}]}]})})
  const item=(await source.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:1})).items[0]!
  const reference:BusinessObjectReference={scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash}
  const result=await invoke('固定事件调查','SOC','调查固定事件 acceptance-event-1。',{name:'teloa_work_dispatch',arguments:{scope:'SOC',title:'固定事件调查',goal:'核对该固定事件证据',roleId:model.role.id,expectedRoleVersion:model.role.version,reference}})
  assert.equal(result.counts.received,1,JSON.stringify(result))
  const context=await call<{reference:BusinessObjectReference}>('business-tasks/source',{taskId:result.members[0]!.task!.id})
  const saved=(await pool.query('select source_snapshot from teloa_business_task_sources where task_id=$1',[result.members[0]!.task!.id])).rows[0]
  assert.deepEqual(saved.source_snapshot.reference,reference)
  assert.deepEqual(context.reference,reference,'真实 Task 上可读取固定业务来源')
  const eventRun=await call<TaskRun>('task-runs/reconcile',{runId:result.members[0]!.run!.id})
  assert.equal(JSON.parse(eventRun.inputText).task.scope,'SOC');assert.match(eventRun.inputText,/acceptance-event-1/)
 })
 await t.test('原指令中的已授权资料固定版本进入 TaskMaterial 与 Run，不静默丢弃',async()=>{
  const sources=await call<{id:string;version:string}[]>('resources/sources',{});assert.ok(sources[0])
  const draft=await call<{id:string;version:number}>('resources/create',{requestId:randomUUID(),title:'统一交办固定资料',sourceId:sources[0].id,sourceVersion:sources[0].version,scopeIds:['general']})
  const resource=await call<{id:string;version:number}>('resources/apply',{draftId:draft.id,expectedVersion:draft.version})
  const colleague=await call<{id:string;version:number}>('roles/create',{requestId:randomUUID(),fields:{name:'通用资料同事',kind:'employee',scopes:['general'],duty:'按资料核对',dataScope:'已授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
  const reference=encodeResourceReference(resource),result=await invoke('固定资料交办','general','请核对这份资料 '+reference,{name:'teloa_work_dispatch',arguments:{scope:'general',title:'固定资料交办',goal:'读取原指令所选资料',roleId:colleague.id,expectedRoleVersion:colleague.version}})
  assert.equal(result.counts.received,1,JSON.stringify(result))
  const task=result.members[0]!.task!,material=(await pool.query('select resource_id,resource_version from teloa_task_materials where task_id=$1',[task.id])).rows
  assert.deepEqual(material,[{resource_id:resource.id,resource_version:resource.version}])
  const materialRun=await call<TaskRun>('task-runs/reconcile',{runId:result.members[0]!.run!.id})
  assert.ok(materialRun.knowledge.some(item=>item.id===resource.id&&item.version===resource.version));assert.match(materialRun.inputText,new RegExp(resource.id))
 })
 await t.test('SOC语境内明确全业务重新汇报：每位真实在岗同事各建新Task/Run，暂停者明确列出',async()=>{
  const paused=await call<{id:string;version:number}>('roles/create',{requestId:randomUUID(),fields:{name:'已暂停的汇报同事',kind:'employee',scopes:['SOC'],duty:'汇报',dataScope:'本次输入',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
  await pool.query("update teloa_roles set state='paused',version=version+1 where owner_id=$1 and id=$2",[owner,paused.id])
  const beforeTasks=Number((await pool.query('select count(*) n from teloa_tasks')).rows[0].n)
  const report=await invoke('所有业务重新汇报','SOC','请所有业务同事重新核对并汇报当前进展。',{name:'teloa_work_collect_reports',arguments:{scope:'general',allBusinesses:true,title:'本次重新汇报',goal:'各自汇报已完成、进行中、阻塞与下一步'}})
  assert.equal(report.counts.received,2,JSON.stringify(report));assert.equal(report.counts.unavailable,1);assert.equal(report.counts.failed,0)
  assert.equal(report.members.find(member=>member.roleId===paused.id)?.status,'unavailable')
  assert.deepEqual(new Set(report.members.filter(member=>member.task).map(member=>member.task!.scope)),new Set(['SOC','general']))
  assert.equal(Number((await pool.query('select count(*) n from teloa_tasks')).rows[0].n),beforeTasks+2)
  for(const member of report.members.filter(member=>member.run)){assert.equal(model.calls.get(member.run!.sessionId),1);assert.match(member.result??'',/依据/)}
  assert.equal((await call<{scopeId:string}>('work-context/read',{sessionId:report.sessionId})).scopeId,'SOC')
  await until(()=>ctx.agents.get(SessionId(report.sessionId))!.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.requestId===report.requestId),'汇报结果与未收到成员必须自动回原会话')
 })
})
