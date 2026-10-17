import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,type WorkTask} from '@teloa/contract'
import {registerTaskConfigurationTools} from '../src/task-configuration-tools.ts'
const owner='owner',id='11111111-1111-4111-8111-111111111111',groupId='22222222-2222-4222-8222-222222222222'
const initial:WorkTask={id,ownerId:owner,version:1,contentVersion:1,title:'证据核对',goal:'只读检查',scope:'general',groupId:null,skills:[],state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'}
async function setup(options:Record<string,unknown>={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('task-origin'),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'给证据核对补充交付标准，并关联证据组'}]}),{surfaceOp:'append'})
 const writes:any[]=[],receipts=new Map<string,any>();let task={...initial}
 const ports={owner,conversation:async(sessionId:string)=>({ownerId:owner,sessionId,status:'ready' as const}),readTaskPolicy:async()=>null,isBuilder:async()=>false,isPendingDaily:async()=>false,
  list:async()=>[task],scopes:async()=>[{scope:'general',title:'通用工作',kind:'builtin' as const}],groups:async()=>[{id:groupId,ownerId:owner,name:'证据组',scope:'general',archived:false}],request:async(requestId:string)=>receipts.get(requestId)??null,
  createRequest:async(requestId:string)=>receipts.get(requestId)??null,
  create:async(input:any,signal:AbortSignal,revalidate:()=>Promise<void>)=>{await revalidate();signal.throwIfAborted();writes.push(input);const saved=receipts.get(input.requestId);if(saved)return saved.task;task={...initial,...input.fields};receipts.set(input.requestId,{...input,task});return task},
  configure:async(input:any,signal:AbortSignal,revalidate:()=>Promise<void>)=>{await revalidate();signal.throwIfAborted();writes.push(input);const receipt=receipts.get(input.requestId);if(receipt)return receipt.task;task={...task,...input.fields,version:task.version+1};receipts.set(input.requestId,{task,fields:input.fields,taskName:input.taskName,...(input.groupName===undefined?{}:{groupName:input.groupName})});return task},...options}
 registerTaskConfigurationTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={},callId='call',signal=AbortSignal.timeout(5000))=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal})
 return {ctx,agent,call,ports,writes,receipts,setTask:(value:WorkTask)=>task=value}
}
const read=(result:any)=>JSON.parse(result.content.filter((block:any)=>block.type==='text').map((block:any)=>block.text).join('\n'))
test('普通目标默认保存通用任务草稿，同调用重放原ID且不交办员工或启动运行',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());const args={title:'写报告',goal:'先整理交付标准'}
 const a=await e.call('teloa_task_configuration_create',args),b=await e.call('teloa_task_configuration_create',args)
 assert.equal(a.isError,false,JSON.stringify(a));assert.equal(b.isError,false,JSON.stringify(b));assert.equal(read(a).task.id,read(b).task.id);assert.equal(read(a).task.state,'ready');assert.equal(read(a).task.scope,'general');assert.equal(read(a).executionStarted,false);assert.equal('assignee' in e.writes[0],false);assert.equal(e.writes[0].requestId,e.writes[1].requestId)
 assert.equal((await e.call('teloa_task_configuration_create',{...args,business:'不存在的业务'})).isError,true)
 assert.equal((await e.call('teloa_task_configuration_create',{...args,scope:'SOC'})).isError,true)
})
test('创建回包丢后群改名归档或任务改名，原调用恢复不可变v1且选择变化拒绝',async t=>{
 let changed=false
 const e=await setup({groups:async()=>[{id:groupId,ownerId:owner,name:changed?'新群':'证据组',scope:'general',archived:changed}]});t.after(()=>e.ctx.fiber.dispose())
 const args={title:'保存草稿',goal:'准备验收',group:'证据组',business:'通用工作'},first=await e.call('teloa_task_configuration_create',args);assert.equal(first.isError,false,JSON.stringify(first));changed=true;e.setTask({...initial,title:'改过的草稿',version:2})
 const replay=await e.call('teloa_task_configuration_create',args);assert.equal(replay.isError,false,JSON.stringify(replay));assert.equal(read(replay).task.title,'保存草稿');assert.equal(read(replay).task.version,1);assert.equal(read(replay).task.groupId,groupId)
 for(const patch of [{group:'新群'},{business:'另一业务'},{title:'另一个草稿'},{goal:'另一个目标'}])assert.equal((await e.call('teloa_task_configuration_create',{...args,...patch})).isError,true)
})
test('同名任务允许模型从可信目录用内部taskId定位，跨本人或错误名称不能借ID改写',async t=>{
 const e=await setup({list:async()=>[initial,{...initial,id:groupId,goal:'另一个同名任务'}]});t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call('teloa_task_configuration_read',{task:'证据核对',taskId:groupId});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(read(result).task.goal,'另一个同名任务')
 const saved=await e.call('teloa_task_configuration_save',{task:'证据核对',taskId:id,goal:'复核原任务'});assert.equal(saved.isError,false,JSON.stringify(saved));assert.equal(read(saved).task.id,id)
 assert.equal((await e.call('teloa_task_configuration_read',{task:'另一个名字',taskId:id})).isError,true)
 assert.equal((await e.call('teloa_task_configuration_read',{task:'证据核对',taskId:'33333333-3333-4333-8333-333333333333'})).isError,true)
})
test('中文任务与群名称解析为原对象，版本和请求身份由工具内部固定，保存不执行',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call('teloa_task_configuration_save',{task:'证据核对',goal:'给出证据和待确认事项',group:'证据组',skills:['证据核对']})
 assert.equal(result.isError,false,JSON.stringify(result));assert.equal(read(result).task.id,id);assert.equal(read(result).sessionId,'task-origin');assert.equal(read(result).executionStarted,false)
 assert.equal(e.writes[0].taskId,id);assert.equal(e.writes[0].expectedVersion,1);assert.equal(e.writes[0].fields.groupId,groupId);assert.deepEqual(e.writes[0].fields.skills,['证据核对']);assert.equal('ownerId' in e.writes[0],false)
})
test('改名后原调用重放找回持久回执，不因重读版本重复修改',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());const args={task:'证据核对',title:'证据复核'}
 assert.equal((await e.call('teloa_task_configuration_save',args)).isError,false)
 assert.equal((await e.call('teloa_task_configuration_save',args)).isError,false)
 assert.equal(e.writes[0].requestId,e.writes[1].requestId);assert.equal(read(await e.call('teloa_task_configuration_read',{task:'证据复核'})).task.version,2)
 assert.equal((await e.call('teloa_task_configuration_save',{...args,title:'改成另一项'})).isError,true)
})
test('已保存群关联回执在群改名或归档后仍恢复原群ID，同调用换群参数不能冒充重放',async t=>{
 for(const state of ['renamed','archived']){
  let changed=false
  const e=await setup({groups:async()=>[{id:groupId,ownerId:owner,name:changed&&state==='renamed'?'新证据组':'证据组',scope:'general',archived:changed&&state==='archived'}]});t.after(()=>e.ctx.fiber.dispose())
  const args={task:'证据核对',group:'证据组'},a=await e.call('teloa_task_configuration_save',args);assert.equal(a.isError,false,JSON.stringify(a));changed=true
  const restored=await e.call('teloa_task_configuration_save',args);assert.equal(restored.isError,false,JSON.stringify(restored));assert.equal(read(restored).task.groupId,groupId);assert.equal(read(restored).task.version,2)
  for(const group of ['新证据组','另一个组',null])assert.equal((await e.call('teloa_task_configuration_save',{...args,group})).isError,true)
  const controller=new AbortController();controller.abort();assert.equal((await e.call('teloa_task_configuration_save',args,'call',controller.signal)).isError,true)
  e.ports.conversation=async sessionId=>({ownerId:'other',sessionId,status:'ready' as const});assert.equal((await e.call('teloa_task_configuration_save',args)).isError,true)
  assert.equal(e.writes.length,2)
 }
})
test('伪造技术身份、重名、混入其他本人记录与受管会话均不写入',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const args of [{task:'证据核对',goal:'改',expectedVersion:1},{task:'证据核对',goal:'改',requestId:id},{task:'证据核对',goal:'改',taskId:'not-an-id'},{task:'证据核对',goal:'改',scope:'SOC'}])assert.equal((await e.call('teloa_task_configuration_save',args)).isError,true)
 for(const options of [{list:async()=>[initial,{...initial,id:groupId}]},{list:async()=>[{...initial,ownerId:'other'}]},{readTaskPolicy:async()=>({allowedTools:[]})},{isBuilder:async()=>true},{isPendingDaily:async()=>true}]){const bad=await setup(options);t.after(()=>bad.ctx.fiber.dispose());assert.equal((await bad.call('teloa_task_configuration_save',{task:'证据核对',goal:'改'})).isError,true);assert.equal(bad.writes.length,0)}
 assert.equal(e.writes.length,0)
})
test('审核等待期间换本人轮次、换任务版本、原生拒绝或取消均不保存',async t=>{
 for(const change of ['instruction','version','deny','cancel']){
  const e=await setup();t.after(()=>e.ctx.fiber.dispose());let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve),controller=new AbortController()
  e.ctx.on('tools/pre-execute',async(_exec,next)=>{entered();await wait;return change==='deny'?{kind:'deny' as const,reason:'原生拒绝'}:next()})
  const pending=e.call('teloa_task_configuration_save',{task:'证据核对',goal:'改'},'call',controller.signal);await started
  if(change==='instruction'){e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'取消'}]}),{surfaceOp:'append'})}
  if(change==='version')e.setTask({...initial,version:2})
  if(change==='cancel')controller.abort()
  release();assert.equal((await pending).isError,true);assert.equal(e.writes.length,0)
 }
})
test('晚到服务回包不能在新轮次冒充本轮保存，后端复核可阻止实际写入',async t=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);let writes=0
 const e=await setup({configure:async(_input:unknown,_signal:AbortSignal,revalidate:()=>Promise<void>)=>{entered();await wait;await revalidate();writes++;return initial}});t.after(()=>e.ctx.fiber.dispose())
 const pending=e.call('teloa_task_configuration_save',{task:'证据核对',goal:'改'});await started;e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'停下'}]}),{surfaceOp:'append'});release();assert.equal((await pending).isError,true);assert.equal(writes,0)
 const failure=await setup({configure:async()=>{throw new WorkError('teloa/version-conflict','原任务已变化')}});t.after(()=>failure.ctx.fiber.dispose());assert.equal((await failure.call('teloa_task_configuration_save',{task:'证据核对',goal:'改'})).isError,true)
})
