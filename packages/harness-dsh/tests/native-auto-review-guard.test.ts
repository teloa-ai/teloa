import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,defineTool,ToolCallId,SessionId} from '../../../tests/native-auto-review-fixture.mjs'
import {registerNativeAutoReviewGuard} from '../src/native-auto-review-guard.ts'

test('受管执行允许存活 Auto 与本人选择的官方 Full access，仍拒绝自定义全权限',async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('managed')
 const removeAuto=ctx.permissionPresets.registerAuto(()=>{})
 let managed=true,bodies=0,seq=0
 ctx.tools.register(defineTool({name:'probe',description:'test',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerNativeAutoReviewGuard(ctx,async()=>managed?{allowedTools:['probe']}:null)
 const call=()=>ctx.tools.execute({agent,name:'probe',arguments:{},callId:ToolCallId('call-'+ ++seq),signal:AbortSignal.timeout(5000)})
 assert.equal((await call()).isError,false)
 ctx.permissionPresets.set(agent.session,'auto')
 assert.equal((await call()).isError,false)
 ctx.permissionPresets.set(agent.session,'danger-full-access')
 assert.equal((await call()).isError,false)
 agent.session.append('approval/policy',{policy:'ask'})
 assert.equal(ctx.permissionPresets.current(agent.session),'custom')
 assert.equal((await call()).isError,true)
 managed=false
 assert.equal((await call()).isError,false,'普通会话保留官方选择')
 managed=true
 ctx.permissionPresets.set(agent.session,'workspace-write')
 assert.equal((await call()).isError,false)
 assert.equal(bodies,5)
 await removeAuto()
})

test('Auto 未登记或卸载后转为全权限，受管任务不能继续',async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('removed-auto')
 let bodies=0
 ctx.tools.register(defineTool({name:'probe',description:'test',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerNativeAutoReviewGuard(ctx,async()=>({allowedTools:['probe']}))
 const removeAuto=ctx.permissionPresets.registerAuto(()=>{})
 ctx.permissionPresets.set(agent.session,'auto')
 await removeAuto()
 assert.notEqual(ctx.permissionPresets.current(agent.session),'auto')
 assert.equal((await ctx.tools.execute({agent,name:'probe',arguments:{},callId:ToolCallId('removed'),signal:AbortSignal.timeout(5000)})).isError,true)
 assert.equal(bodies,0)
})

test('受管子级逐层核对权限；根、祖先或调用方自定义全权限都不能借谱系绕过',async t=>{
 const {ctx,create}=await createRuntime(t),root=await create('root'),parent=await create('parent',{origin:'subagent',parentSession:root.session.id,delegationDepth:1}),child=await create('child',{origin:'subagent',parentSession:parent.session.id,delegationDepth:2})
 let bodies=0,seq=0
 const ids:string[]=[]
 ctx.tools.register(defineTool({name:'probe',description:'test',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerNativeAutoReviewGuard(ctx,async id=>{ids.push(id);return {allowedTools:['probe']}})
 const call=()=>ctx.tools.execute({agent:child,name:'probe',arguments:{},callId:ToolCallId('child-'+ ++seq),signal:AbortSignal.timeout(5000)})
 for(const agent of [root,parent,child]){
  ctx.permissionPresets.set(agent.session,'danger-full-access')
  agent.session.append('approval/policy',{policy:'ask'})
  assert.equal((await call()).isError,true)
  ctx.permissionPresets.set(agent.session,'workspace-write')
 }
 assert.equal((await call()).isError,false)
 assert.equal(bodies,1);assert.deepEqual(ids,['root','root','root','root'])
})

test('策略读失败、取消与缺失祖先均 fail-closed，原生下游拒绝保持',async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('error-case'),orphan=await create('orphan',{origin:'subagent',parentSession:SessionId('missing'),delegationDepth:1})
 let fails=true,bodies=0,seq=0
 ctx.tools.register(defineTool({name:'probe',description:'test',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerNativeAutoReviewGuard(ctx,async()=>{if(fails)throw Error('private database secret');return {allowedTools:['probe']}})
 ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'原生下游拒绝'}))
 const call=(who=agent,signal=AbortSignal.timeout(5000))=>ctx.tools.execute({agent:who,name:'probe',arguments:{},callId:ToolCallId('failed-'+ ++seq),signal})
 const failed=JSON.stringify(await call())
 assert.match(failed,/无法核对任务执行权限/);assert.doesNotMatch(failed,/private database/)
 fails=false
 assert.match(JSON.stringify(await call()),/原生下游拒绝/)
 assert.match(JSON.stringify(await call(orphan)),/无法核对任务执行权限/)
 const abort=new AbortController();abort.abort()
 assert.equal((await call(agent,abort.signal)).isError,true)
 assert.equal(bodies,0)
})
