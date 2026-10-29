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
import type {WorkTask} from '@teloa/contract'
import {registerTaskMaterialTools} from '../src/task-material-tools.ts'
const owner='owner',id='11111111-1111-4111-8111-111111111111',resourceId='22222222-2222-4222-8222-222222222222',stamp='2026-10-15T00:00:00Z'
const initial:WorkTask={id,ownerId:owner,version:1,contentVersion:1,title:'证据核对',goal:'只读检查',scope:'general',groupId:null,skills:[],state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:stamp,updatedAt:stamp}
const resource={id:resourceId,ownerId:owner,version:1,title:'核对说明',sourceId:'knowledge_note',sourceVersion:'a'.repeat(64),scopeIds:['general'],status:'active' as const,createdAt:stamp,updatedAt:stamp}
async function setup(options:Record<string,unknown>={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('task-material-origin'),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'把核对说明加到原证据核对任务，不执行'}]}),{surfaceOp:'append'})
 let task={...initial},resources=[{...resource}],materials:any[]=[];const writes:any[]=[],receipts=new Map<string,any>()
 const ports={owner,conversation:async(sessionId:string)=>({ownerId:owner,sessionId,status:'ready' as const}),readTaskPolicy:async()=>null,isBuilder:async()=>false,isPendingDaily:async()=>false,list:async()=>[task],resources:async()=>resources,materials:async()=>materials,request:async(requestId:string)=>receipts.get(requestId)??null,checkBudget:async()=>{},
  add:async(input:any,signal:AbortSignal,revalidate:()=>Promise<void>)=>{await revalidate();signal.throwIfAborted();const prior=receipts.get(input.requestId);if(prior)return prior.result;writes.push(input);task={...task,version:task.version+1};const material={id:'33333333-3333-4333-8333-333333333333',taskId:id,taskVersion:task.version,resourceId,resourceVersion:resource.version,title:resource.title,sourceId:resource.sourceId,sourceVersion:resource.sourceVersion,scopeIds:['general'],available:true,createdAt:stamp};materials=[material];const result={task,material};receipts.set(input.requestId,{input,result});return result},...options}
 registerTaskMaterialTools(ctx,ports)
 return {ctx,agent,ports,writes,receipts,call:(name:string,args:Record<string,unknown>,callId='call',signal=AbortSignal.timeout(5000))=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal}),setTask:(value:WorkTask)=>task=value,setResources:(value:typeof resources)=>resources=value}
}
const read=(r:any)=>JSON.parse(r.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n')),args={task:'证据核对',material:'核对说明'}
test('按中文名称把真实资料引用加到同一原任务，版本内部固定，技能和执行状态不变',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());const before=read(await e.call('teloa_task_materials_read',{task:args.task}));assert.equal(before.materials.length,0);assert.equal(before.candidates[0].title,resource.title)
 const r=await e.call('teloa_task_materials_add',args);assert.equal(r.isError,false,JSON.stringify(r));const saved=read(r);assert.equal(saved.task.id,id);assert.equal(saved.task.version,2);assert.deepEqual(saved.task.skills,[]);assert.equal(saved.executionStarted,false);assert.equal(saved.material.resourceId,resourceId);assert.deepEqual(e.writes[0],{requestId:e.writes[0].requestId,taskId:id,expectedTaskVersion:1,resourceId,expectedResourceVersion:1});assert.equal(read(await e.call('teloa_task_materials_read',{task:args.task})).materials[0].resourceId,resourceId)
 assert.match(e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_task_materials_add')!.description,/recordRef 不是资料.*teloa_work_dispatch\.reference/)
})
test('同调用重放从原持久回执恢复；任务改名、资料撤回不改变原引用，也不能换参数',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());const first=await e.call('teloa_task_materials_add',args);assert.equal(first.isError,false,JSON.stringify(first));e.setTask({...initial,title:'已改任务名',version:9});e.setResources([{...resource,title:'已改资料名',status:'withdrawn' as any,version:2}])
 const replay=await e.call('teloa_task_materials_add',args);assert.equal(replay.isError,false,JSON.stringify(replay));assert.equal(read(replay).task.version,2);assert.equal(read(replay).replayed,true);assert.equal(e.writes.length,1)
 assert.equal((await e.call('teloa_task_materials_add',{...args,material:'其他资料'})).isError,true);assert.equal((await e.call('teloa_task_materials_add',{...args,task:'已改任务名'})).isError,true)
})
test('技术参数、重名、他人目录、跨业务资料及受管会话拒绝；不触发写入',async t=>{
 for(const input of [{...args,requestId:id},{...args,expectedVersion:1},{...args,ownerId:'other'},{...args,materialId:'bad-id'}]){const e=await setup();t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_task_materials_add',input)).isError,true);assert.equal(e.writes.length,0)}
 for(const option of [{list:async()=>[initial,{...initial,id:resourceId}]},{list:async()=>[{...initial,ownerId:'other'}]},{resources:async()=>[{...resource,ownerId:'other'}]},{resources:async()=>[{...resource,scopeIds:['business_other']}]},{readTaskPolicy:async()=>({allowedTools:[]})},{isBuilder:async()=>true},{isPendingDaily:async()=>true},{checkBudget:async()=>{throw Error('over-budget')}}]){const e=await setup(option);t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_task_materials_add',args)).isError,true);assert.equal(e.writes.length,0)}
})
test('审批期间任务/资料变化、本人换轮次、拒绝或取消，原任务不写入',async t=>{
 for(const change of ['task','resource','instruction','owner','deny','cancel']){
  const e=await setup();t.after(()=>e.ctx.fiber.dispose());let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r),controller=new AbortController()
  e.ctx.on('tools/pre-execute',async(_exec,next)=>{entered();await wait;return change==='deny'?{kind:'deny' as const,reason:'拒绝'}:next()})
  const pending=e.call('teloa_task_materials_add',args,'call',controller.signal);await started
  if(change==='task')e.setTask({...initial,version:2});if(change==='resource')e.setResources([{...resource,version:2}]);if(change==='owner')e.ports.conversation=async sessionId=>({ownerId:'other',sessionId,status:'ready' as const});if(change==='cancel')controller.abort()
  if(change==='instruction'){e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'取消'}]}),{surfaceOp:'append'})}
  release();assert.equal((await pending).isError,true);assert.equal(e.writes.length,0)
 }
})
test('服务实际写入前等待时换本人轮次，事务提交复核仍拒绝',async t=>{
 let entered!:()=>void,release!:()=>void,writes=0;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r)
 const e=await setup({add:async(_input:unknown,_signal:AbortSignal,revalidate:()=>Promise<void>)=>{entered();await wait;await revalidate();writes++;throw Error('不应执行')}});t.after(()=>e.ctx.fiber.dispose())
 const pending=e.call('teloa_task_materials_add',args);await started;e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'停下'}]}),{surfaceOp:'append'});release();assert.equal((await pending).isError,true);assert.equal(writes,0)
})
