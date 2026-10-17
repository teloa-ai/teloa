import test from 'node:test'
import assert from 'node:assert/strict'
// 复用已有声明的真实 DSH 工具运行时验收夹具。
import {createRuntime,defineTool,ToolCallId} from '../../../tests/native-auto-review-fixture.mjs'
import * as implementation from '../src/hardware-input-policy.ts'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'

test('硬件来源不能用 Full access 绕过本人审批，后续普通 Web 轮次不被永久收窄',async t=>{
 assert.equal(typeof implementation.registerHardwareToolGuard,'function')
 const {ctx,create}=await createRuntime(t),agent=await create('hardware-policy')
 let hardware=true,allowed=false,bodies=0,approvals=0,sequence=0
 ctx.permissionPresets.set(agent.session,'danger-full-access')
 agent.session.append('turn/start',{turn:0})
 ctx.on('approval/request',async()=>{approvals++;return allowed?'allowed-once':'rejected'})
 ctx.tools.register(defineTool({name:'test_write',description:'测试写操作',parameters:{},output:{schema:{type:'string'},render:(_a:unknown,value:string)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'written'}}))
 t.after(implementation.registerHardwareToolGuard(ctx,{hasSource:async()=>hardware}))
 const call=()=>ctx.tools.execute({agent,name:'test_write',arguments:{},callId:ToolCallId('hardware-'+ ++sequence),signal:AbortSignal.timeout(5000)})
 const first=await call();assert.equal(first.isError,true);assert.equal(bodies,0);assert.equal(approvals,0,JSON.stringify(first))
 allowed=true
 ctx.permissionPresets.set(agent.session,'workspace-write')
 assert.equal((await call()).isError,false);assert.equal(bodies,1);assert.equal(approvals,1)
 hardware=false
 agent.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 ctx.permissionPresets.set(agent.session,'danger-full-access')
 agent.session.append('turn/start',{turn:1})
 assert.equal((await call()).isError,false);assert.equal(bodies,2);assert.equal(approvals,1)
})

test('原守卫拒绝和来源查询失败不能退成普通本人权限',async t=>{
 assert.equal(typeof implementation.registerHardwareToolGuard,'function')
 const {ctx,create}=await createRuntime(t),agent=await create('hardware-deny')
 let unavailable=false,bodies=0
 ctx.permissionPresets.set(agent.session,'danger-full-access')
 ctx.tools.register(defineTool({name:'probe',description:'测试工具',parameters:{},output:{schema:{type:'string'},render:(_a:unknown,value:string)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 t.after(implementation.registerHardwareToolGuard(ctx,{hasSource:async()=>{if(unavailable)throw Error('private source unavailable');return true}}))
 const remove=ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'原执行范围拒绝'}))
 const call=(id:string)=>ctx.tools.execute({agent,name:'probe',arguments:{},callId:ToolCallId(id),signal:AbortSignal.timeout(5000)})
 assert.match(JSON.stringify(await call('denied')),/原执行范围拒绝/)
 remove();unavailable=true
 const failed=JSON.stringify(await call('unavailable'));assert.ok(!failed.includes('private source unavailable'));assert.equal(bodies,0)
})

test('来源跟随当前真实输入根，新 Web 轮次不会继承此前硬件权限',()=>{
 assert.equal(typeof implementation.hardwareInputRequests,'function')
 const session=Session.create(SessionId('origin-scope'))
 session.append('turn/start',{turn:0})
 session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'hardware-request'},content:[{type:'text',text:'硬件任务'}]}),{surfaceOp:'append'})
 assert.deepEqual(implementation.hardwareInputRequests(session.snapshotEvents()),['hardware-request'])
 session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 session.append('turn/start',{turn:1})
 session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'web-request'},content:[{type:'text',text:'Web 新任务'}]}),{surfaceOp:'append'})
 assert.deepEqual(implementation.hardwareInputRequests(session.snapshotEvents()),['web-request'])
})

test('派生任务按固定来源消息追溯，原主聊后来的 Web 输入不覆盖该来源',async()=>{
 assert.equal(typeof implementation.createHardwareSourceReader,'function')
 const session=Session.create(SessionId('assistant-origin'))
 const hardware=createUserMessage({source:{kind:'user',rpcId:'hardware-request'},content:[{type:'text',text:'硬件交办'}]})
 session.append('turn/start',{turn:0});session.append('user/message',hardware,{surfaceOp:'append'});session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 session.append('turn/start',{turn:1});session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'web-request'},content:[{type:'text',text:'后来 Web 输入'}]}),{surfaceOp:'append'})
 const read=implementation.createHardwareSourceReader({known:(id:string)=>id==='hardware-request',readEvents:async()=>session.snapshotEvents(),parent:async(id:string)=>id==='task-session'?{sessionId:'assistant-origin',messageId:hardware.id}:null})
 assert.equal(await read('task-session',[]),true)
 assert.equal(await read('assistant-origin',session.snapshotEvents()),false)
})

test('混合输入之后无新输入的续轮保留全部来源，仍需要硬件审批约束',async()=>{
 const session=Session.create(SessionId('mixed-origin'))
 session.append('turn/start',{turn:0})
 session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'hardware-request'},content:[{type:'text',text:'硬件任务'}]}),{surfaceOp:'append'})
 session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'web-request'},content:[{type:'text',text:'追加说明'}]}),{surfaceOp:'append'})
 session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 session.append('turn/start',{turn:1})
 assert.deepEqual(implementation.hardwareInputRequests(session.snapshotEvents()),['hardware-request','web-request'])
 const read=implementation.createHardwareSourceReader({known:id=>id==='hardware-request',readEvents:async()=>[],parent:async()=>null})
 assert.equal(await read('mixed-origin',session.snapshotEvents()),true)
})
