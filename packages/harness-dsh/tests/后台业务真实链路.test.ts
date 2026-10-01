/** 三个业务入口共用生产 Run port；模型为脚本，Jobs/Agent/JSONL/PostgreSQL 均为真实实现。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn,type ChildProcess} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {brandString} from '@deepseek-ai/dsh-brand'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import type {JobId,JobOutcome} from '@deepseek-ai/dsh-jobs'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,type TaskRun} from '@teloa/backend'
import {apply} from '../src/index.ts'
import {compositionEntries,type RpcHandler} from './fixtures/production-host.ts'
import {installNativeHostServices} from './fixtures/native-host-services.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

const owner='local:teloa-owner'
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
async function until(check:()=>boolean|Promise<boolean>,label:string){
 const deadline=Date.now()+10_000
 while(!await check()){assert.ok(Date.now()<deadline,label);await delay(15)}
}
const finalText=(sessionId:string)=>'后台进程已经退出，结果已核对：'+sessionId
class ScriptedJobsModel extends LlmAdapter{
 readonly calls=new Map<string,number>()
 override async resolveModel(provider:string,id:string){return {provider,id,name:id}}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  const sessionId=String(options.sessionId),call=this.calls.get(sessionId)??0
  this.calls.set(sessionId,call+1)
  if(call===0||call===2){
   const id=ToolCallId((call===0?'delayed-':'verify-')+sessionId),name='web_search',args=JSON.stringify({queries:[call===0?'本地受控后台检索':'核对后台状态']})
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args}
   yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
   return
  }
  const text=call===1?'后台仍在处理，请等待完成通知。':finalText(sessionId)
  yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text}
  yield {type:'block-end',index:0,block:{type:'text',text}}
  yield {type:'finish',reason:{kind:'stop'}}
 }
}

test('后台业务真实链路：普通、群和自动化等待原生进程，停止不串 Run，终态交付幂等',{timeout:180_000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-background-business-')),ctx=new Context(),processes:ChildProcess[]=[]
 const previousRoot=process.env.TELOA_PROJECT_ROOT
 process.env.TELOA_PROJECT_ROOT=resolve(process.cwd())
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 t.after(async()=>{for(const child of processes)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ctx.fiber.dispose();if(previousRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousRoot;await rm(root,{recursive:true,force:true})})
 const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 t.after(()=>container.stop())
 const config=join(root,'.runtime/teloa/database.json')
 await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true})
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true})
 await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 ctx.provide('loader',compositionEntries())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 await installNativeHostServices(ctx,join(root,'.runtime/dsh'))
 await ctx.plugin(JobTools,{completionDelivery:'wakeup'})
 const model=new ScriptedJobsModel();ctx.llm.registerAdapter(['scripted-jobs'],model)
 const workspaces=new Map<string,{id:string;path:string}>()
 ctx.provide('workspaceRegistry',{
  create:async(path:string)=>{const prior=[...workspaces.values()].find(item=>item.path===path);if(prior)return prior;const item={id:randomUUID(),path};workspaces.set(item.id,item);return item},
  get:(id:string)=>workspaces.get(id),list:()=>[...workspaces.values()],
 })
 ctx.provide('agentPresets',{serviceFor:()=>undefined,acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??'teloa-standard'})})
 ctx.provide('skills',{list:async()=>[],registerProvider:(factory:(control:{invalidate:()=>void;signal:AbortSignal})=>unknown)=>{factory({invalidate:()=>{},signal:new AbortController().signal});return ()=>{}}})
 ctx.provide('fs',{});ctx.provide('fileReferences',{})
 ctx.provide('sessionController',{
  create:async(input:{sessionId?:string;agentPreset?:string;workspaceId?:string}={})=>{
   const sessionId=SessionId(input.sessionId??randomUUID()),cwd=workspaces.get(input.workspaceId??'')?.path??root
   await ctx.agents.create({sessionId,meta:{cwd,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})},agentOptions:{provider:'scripted-jobs',model:'controlled'}})
   return {sessionId,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})}
  },
  inspect:async(id:string)=>({meta:ctx.agents.get(SessionId(id))!.session.header}),
  resolveAgent:async(id:string)=>({agent:ctx.agents.get(SessionId(id))!}),
  modelCatalog:async()=>({default:{provider:'scripted-jobs',model:'controlled'}}),
  prompt:async(input:{sessionId:string;requestId:string;content:Parameters<typeof createUserMessage>[0]['content']})=>{
   ctx.agents.get(SessionId(input.sessionId))!.followup(createUserMessage({content:input.content,source:{kind:'user',rpcId:brandString<SessionRequestId>(input.requestId)}}))
   return {accepted:true}
  },
  cancel:({sessionId}:{sessionId:string})=>{ctx.agents.get(SessionId(sessionId))!.cancel({kind:'user'},{keepInbox:true});return {accepted:true}},
 })
 let rpc:RpcHandler|undefined
 ctx.provide('connection',{fetch:{register:()=>async()=>{}},rpc:{handle:(_path:string,handler:RpcHandler)=>{rpc=handler;return ()=>{}}}})
 await apply(ctx,{projectRoot:root})
 const database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()}),pool=database.pool
 t.after(()=>pool.end())
 const call=async<T>(endpoint:string,payload:unknown):Promise<T>=>{const reply=await rpc!(endpoint,payload,AbortSignal.timeout(15_000));assert.equal(reply.ok,true,endpoint+': '+JSON.stringify(reply.error));return reply.value as T}
 type ProcessJob={id:JobId;child:ChildProcess;release:string;ready:string;cancelled:string;exited:string}
 const jobs=new Map<string,ProcessJob>(),statusChecks=new Map<string,number>()
 // web_search 保持正式岗位授权路径，仅替换它的外部 provider：受控进程不联网，只写自身临时标记。
 ctx.tools.register(defineTool({name:'web_search',description:'测试用受控后台检索',parameters:{queries:{type:'array',items:{type:'string'},required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async(_args,exec)=>{
  const sessionId=exec.agent!.id
  if(Array.isArray(_args.queries)&&_args.queries[0]==='核对后台状态'){
   const job=jobs.get(sessionId);assert.ok(job)
   statusChecks.set(sessionId,(statusChecks.get(sessionId)??0)+1)
   return ctx.jobs.get(job.id,sessionId).status
  }
  assert.equal(jobs.has(sessionId),false,'同一模型调用不能重复创建进程')
  const directory=join(root,'processes',sessionId);await mkdir(directory,{recursive:true})
  const release=join(directory,'release'),ready=join(directory,'ready'),cancelled=join(directory,'cancelled'),exited=join(directory,'exited')
  let child!:ChildProcess,killed=false
  const id=ctx.jobs.start({kind:'bash',label:'受控延迟进程',owner:sessionId,run:job=>{
   const script=`const fs=require('node:fs');const [release,ready,cancelled,exited]=process.argv.slice(1);let stopping=false;process.on('SIGTERM',()=>{if(stopping)return;stopping=true;fs.writeFileSync(cancelled,'requested');setTimeout(()=>{fs.writeFileSync(exited,'cancelled');process.exit(0)},500)});fs.writeFileSync(ready,'ready');setInterval(()=>{if(!stopping&&fs.existsSync(release)){fs.writeFileSync(exited,'completed');process.stdout.write('controlled result');process.exit(0)}},15);setTimeout(()=>process.exit(7),60000);`
   child=spawn(process.execPath,['-e',script,release,ready,cancelled,exited],{stdio:['ignore','pipe','pipe']});processes.push(child)
   child.stdout!.on('data',(chunk:Buffer)=>job.append(chunk.toString()))
   const done=new Promise<JobOutcome>(resolve=>{child.once('error',()=>resolve({status:'failed'}));child.once('close',code=>resolve({status:killed?'killed':code===0?'completed':'failed',result:'受控进程已经退出'}))})
   return {done,cancel:()=>{if(killed)return;killed=true;child.kill('SIGTERM')}}
  }})
  jobs.set(sessionId,{id,child,release,ready,cancelled,exited});return id
 }}))
 const currentWeb=await call<{version:number}>('web-access/get',{})
 await call('web-access/change',{requestId:randomUUID(),expectedVersion:currentWeb.version,enabled:true,blocked:[]})
 type Role={id:string;version:number}
 let role=await call<Role>('roles/create',{requestId:randomUUID(),fields:{name:'后台验收员',kind:'employee',scopes:['general'],duty:'核对后台结果',dataScope:'自有临时标记',executionScope:'受控检索',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 const reload=async()=>{role=(await call<Role[]>('roles/list',{})).find(item=>item.id===role.id)!}
 await call('roles/lifecycle',{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'配置受控工具'});await reload()
 await call('role-tools/change',{roleId:role.id,expectedRoleVersion:role.version,action:'save',rules:[{name:'web_search',anyArguments:true,allowed:[]}]});await reload()
 await call('roles/lifecycle',{roleId:role.id,expectedVersion:role.version,action:'resume',reason:'开始验收'});await reload()
 const group=await call<{id:string;version:number}>('groups/create',{requestId:randomUUID(),expectedVersion:0,fields:{name:'后台结果群',scope:'general',announcement:'只检查临时进程',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}})
 await call('groups/agent-grants/change',{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:false})
 type Entry='普通交办'|'群交办'|'自动化'
 const entries:Entry[]=['普通交办','群交办','自动化']
 const createRun=async(entry:Entry,label:string):Promise<TaskRun>=>{
  const fields={title:entry+label,goal:'运行受控进程并等待真实退出',scope:'general'}
  let task:{id:string;version:number}
  if(entry==='自动化'){
   let plan=await call<{id:string;version:number;configVersion:number}>('plans/create',{requestId:randomUUID(),fields:{...fields,roleId:role.id,expectedRoleVersion:role.version,dataScope:'自有临时标记',delivery:'已核对结果',trigger:{kind:'schedule',cadence:'weekly',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'silent'},source:{kind:'manual'}})
   plan=await call('plans/change',{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'enable'})
   const triggered=await call<{runId:string;taskId:string}>('plans/trigger',{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:new Date().toISOString()})
   const runs=await call<TaskRun[]>('task-runs/list',{taskId:triggered.taskId}),run=runs.find(item=>item.id===triggered.runId)!
   assert.ok(JSON.parse(run.inputText).planContext,'自动化必须保存计划来源，而非绕过计划直接建普通 Run')
   return run
  }
  if(entry==='群交办'){
   const message=await call<{id:string}>('groups/messages/send',{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:fields.title,references:[]})
   task=(await call<{task:{id:string;version:number}}>('groups/tasks/create',{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:fields.goal,assignee:{roleId:role.id,expectedVersion:role.version}})).task
  }else task=await call('tasks/create',{requestId:randomUUID(),fields,assignee:{roleId:role.id,expectedVersion:role.version}})
  const run=await call<TaskRun>('task-runs/prepare',{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version})
  assert.equal(run.state,'prepared');assert.equal(!!run.groupContext,entry==='群交办')
  return call<TaskRun>('task-runs/start',{runId:run.id})
 }
 const events=(run:TaskRun)=>ctx.agents.get(SessionId(run.sessionId))!.session.snapshotEvents()
 const deliveries=async(run:TaskRun)=>(await pool.query('select id,text from teloa_group_messages where owner_id=$1 and run_id=$2',[owner,run.id])).rows
 const reconcile=(run:TaskRun)=>call<TaskRun>('task-runs/reconcile',{runId:run.id})
 const firstRound=async(run:TaskRun)=>{
  await until(()=>jobs.has(run.sessionId)&&events(run).some(event=>event.type==='turn/end'),'模型初始轮必须结束')
  const job=jobs.get(run.sessionId)!
  await until(()=>existsSync(job.ready),'真实子进程必须进入可取消状态')
  await ctx.agents.get(SessionId(run.sessionId))!.whenIdle()
  assert.equal(ctx.jobs.get(job.id,SessionId(run.sessionId)).status,'running')
  assert.equal((await reconcile(run)).state,'active','初始轮已结束但官方 job 活跃，业务 Run 不得 ended')
  assert.deepEqual(await deliveries(run),[],'占位回复不能提前交付到群')
  const rows=(await pool.query("select run_id,session_id,payload from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and payload->>'record'='job'",[owner,run.id])).rows
  assert.equal(rows.length,1);assert.equal(rows[0].session_id,run.sessionId);assert.equal(rows[0].payload.jobId,job.id);assert.equal(rows[0].payload.status,'running')
  return job
 }
 const completed:Array<{entry:Entry;run:TaskRun;job:ProcessJob}>=[]
 for(const entry of entries){const run=await createRun(entry,'完成');completed.push({entry,run,job:await firstRound(run)})}
 for(const item of completed)await t.test(item.entry+'：真实进程完成后才收口，官方唤醒只交付最终结果一次',async()=>{
  const {run,job}=item
  await writeFile(job.release,'release')
  await until(()=>ctx.jobs.get(job.id,SessionId(run.sessionId)).status==='completed','原生 job 必须实际完成')
  await until(()=>events(run).some(event=>event.type==='user/message'&&event.data.source.kind==='tool-jobs'),'官方完成通知必须唤醒同一 owner')
  await ctx.agents.get(SessionId(run.sessionId))!.whenIdle()
  assert.equal(await readFile(job.exited,'utf8'),'completed');assert.notEqual(job.child.exitCode,null)
  const ended=await reconcile(run);assert.equal(ended.state,'ended');assert.equal(ended.evidence?.state==='ended'&&ended.evidence.reason,'completed')
  const again=await reconcile(run);assert.deepEqual(again.evidence,ended.evidence)
  assert.equal(model.calls.get(run.sessionId),4,'初轮与官方续轮分别执行一次工具并给出结果')
  assert.equal(statusChecks.get(run.sessionId),1,'真实完成续轮仍能使用 Run 的固定授权')
  const messages=await deliveries(run)
  assert.equal(messages.length,item.entry==='群交办'?1:0)
  if(messages[0])assert.equal(messages[0].text,finalText(run.sessionId))
  for(const other of completed.filter(other=>other!==item&&ctx.jobs.get(other.job.id,SessionId(other.run.sessionId)).status==='running'))assert.equal((await reconcile(other.run)).state,'active','另一 Run 的活跃 job 不得随本次结项')
 })
 const stopping:Array<{entry:Entry;run:TaskRun;job:ProcessJob}>=[]
 for(const entry of entries){const run=await createRun(entry,'停止');stopping.push({entry,run,job:await firstRound(run)})}
 for(const item of stopping)await t.test(item.entry+'：停止先记意图，进程实际退出前仍 active，其他 owner 不受影响',async()=>{
  const {run,job}=item,requested=await call<TaskRun>('task-runs/stop',{runId:run.id})
  assert.ok(requested.stopRequestedAt);assert.equal(requested.state,'active');assert.equal(ctx.jobs.get(job.id,SessionId(run.sessionId)).status,'stopping')
  assert.equal(job.child.exitCode,null)
  for(const other of stopping.filter(other=>other!==item&&ctx.jobs.get(other.job.id,SessionId(other.run.sessionId)).status==='running')){assert.equal(existsSync(other.job.cancelled),false);assert.equal((await reconcile(other.run)).state,'active')}
  await until(()=>ctx.jobs.get(job.id,SessionId(run.sessionId)).status==='killed','停止必须等生产者 close 后才能终态')
  await ctx.agents.get(SessionId(run.sessionId))!.whenIdle()
  assert.equal(await readFile(job.exited,'utf8'),'cancelled');assert.notEqual(job.child.exitCode,null)
  const ended=await reconcile(run);assert.equal(ended.state,'ended');assert.equal(ended.evidence?.state==='ended'&&ended.evidence.reason,'aborted')
  assert.deepEqual((await call<TaskRun>('task-runs/stop',{runId:run.id})).evidence,ended.evidence)
  assert.equal(statusChecks.get(run.sessionId),undefined,'停止后的官方续轮也不能调用已撤销的工具')
  assert.deepEqual(await deliveries(run),[],'已停止的群 Run 不得发布成功结果')
 })
 assert.equal(jobs.size,6);assert.equal(processes.length,6)
 const linked=(await pool.query("select run_id,session_id,payload from teloa_task_run_runtime_links where owner_id=$1 and payload->>'record'='job'",[owner])).rows
 assert.equal(linked.length,6)
 for(const {run,job} of [...completed,...stopping]){const rows=linked.filter(row=>row.run_id===run.id);assert.equal(rows.length,1);assert.equal(rows[0].session_id,run.sessionId);assert.equal(rows[0].payload.jobId,job.id);assert.equal(rows[0].payload.status,ctx.jobs.get(job.id,SessionId(run.sessionId)).status)}
})
