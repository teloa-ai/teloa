import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,defineTool,ToolCallId} from '../../../tests/native-auto-review-fixture.mjs'
import {registerNativeAutoReviewGuard} from '../src/native-auto-review-guard.ts'
import {compositionViolations} from '../src/composition-safety.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

test('本人显式选择官方 Full access 后受管工具可执行，部署默认仍受限',async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('explicit-full')
 let bodies=0
 ctx.tools.register(defineTool({name:'probe',description:'probe',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{bodies++;return 'ok'}}))
 registerNativeAutoReviewGuard(ctx,async()=>({allowedTools:['probe']}))
 assert.equal(ctx.permissionPresets.current(agent.session),'workspace-write')
 ctx.permissionPresets.set(agent.session,'danger-full-access')
 const result=await ctx.tools.execute({agent,name:'probe',arguments:{},callId:ToolCallId('full'),signal:AbortSignal.timeout(5000)})
 assert.equal(result.isError,false);assert.equal(bodies,1)
})

test('Full access 调用等待业务授权时切换权限，旧调用不能执行',async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('switch-full')
 let bodies=0,reads=0
 ctx.tools.register(defineTool({name:'probe',description:'probe',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{bodies++;return 'ok'}}))
 registerNativeAutoReviewGuard(ctx,async()=>({allowedTools:['probe']}))
 registerTaskToolGuard(ctx,async()=>{if(++reads===2){await Promise.resolve();ctx.permissionPresets.set(agent.session,'workspace-write')}return {allowedTools:['probe']}})
 ctx.permissionPresets.set(agent.session,'danger-full-access')
 const result=await ctx.tools.execute({agent,name:'probe',arguments:{},callId:ToolCallId('switch'),signal:AbortSignal.timeout(5000)})
 assert.equal(result.isError,true);assert.equal(bodies,0)
})

test('装配允许精确的官方 Full access，拒绝别名全权限和被篡改的官方预设',()=>{
 const base={permissionPresets:{'workspace-write':{sandbox:'workspace-write',approval:'ask'},'danger-full-access':{sandbox:'danger-full-access',approval:'never'}}}
 assert.equal(compositionViolations(base as never).includes('permission'),false)
 for(const permissionPresets of [
  {'anything':{sandbox:'danger-full-access',approval:'never'}},
  {'danger-full-access':{sandbox:'danger-full-access',approval:'ask'}},
  {'workspace-write':{sandbox:'danger-full-access',approval:'never'}},
 ])assert.equal(compositionViolations({permissionPresets} as never).includes('permission'),true)
})
