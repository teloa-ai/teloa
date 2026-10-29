import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,official,defineTool} from '../../../tests/native-auto-review-fixture.mjs'
import {captureOwnerRunOrchestration} from '../src/owner-run-orchestration.ts'
import {taskRunToolRules} from '../src/role-tool-grants.ts'

async function fixture(t){
 const {ctx,create}=await createRuntime(t)
 for(const name of ['dsh-subprocess-local','dsh-sandbox-local','dsh-ptc-runtime-node']){const module=await official(name);await ctx.plugin(module.default??module,{})}
 ctx.tools.register(defineTool({name:'workflow',description:'Synthetic workflow entry.',parameters:{},output:{schema:{type:'string'},render:(_a,value)=>[{type:'text',text:value}]},execute:async()=>'ok'}))
 const standard=await create('owner-standard',{agentPreset:'standard'}),ptc=await create('owner-ptc',{agentPreset:'ptc'});ptc.ctx.tools.presentAs('ptc')
 const scopes={standard,ptc};let acquire=async id=>({key:scopes[id],async [Symbol.asyncDispose](){}})
 ctx.provide('agentPresets',{acquireScope:id=>acquire(id)})
 return {ctx,standard,ptc,setAcquire:value=>acquire=value}
}

test('本人标准Task只声明实际native编排面，PTC才声明run_code；不增加Bash',async t=>{
 const f=await fixture(t),signal=new AbortController().signal
 const standard=await captureOwnerRunOrchestration(f.ctx,f.standard,'standard',signal),ptc=await captureOwnerRunOrchestration(f.ctx,f.ptc,'ptc',signal)
 assert.deepEqual(standard.names,['workflow']);assert.deepEqual(ptc.names,['workflow','run_code'])
 const names=taskRunToolRules([],standard.names).map(rule=>rule.name)
 assert.equal(names.includes('run_code'),false);assert.equal(names.includes('bash'),false);assert.equal(names.includes('Bash'),false)
 assert.equal(taskRunToolRules([],ptc.names).some(rule=>rule.name==='run_code'),true)
 standard.assertCurrent();ptc.assertCurrent()
})

test('预设目录和当前Agent取交集，不把其他预设提供的PTC工具带到标准Task',async t=>{
 const f=await fixture(t);f.setAcquire(async()=>({key:f.ptc,async [Symbol.asyncDispose](){}}))
 const captured=await captureOwnerRunOrchestration(f.ctx,f.standard,'standard',new AbortController().signal)
 assert.deepEqual(captured.names,['workflow']);captured.assertCurrent()
})

test('异步读取中实际工具面变化/读取失败/取消均fail closed，租约仍释放',async t=>{
 const f=await fixture(t);let released=0
 f.setAcquire(async()=>{f.standard.ctx.tools.presentAs('ptc');return {key:f.standard,async [Symbol.asyncDispose](){released++}}})
 await assert.rejects(captureOwnerRunOrchestration(f.ctx,f.standard,'standard',new AbortController().signal),{code:'teloa/version-conflict'});assert.equal(released,1)
 f.setAcquire(async()=>{throw Error('preset catalog unavailable')})
 await assert.rejects(captureOwnerRunOrchestration(f.ctx,f.ptc,'ptc',new AbortController().signal),/preset catalog unavailable/)
 const controller=new AbortController();f.setAcquire(async()=>{controller.abort();return {key:f.ptc,async [Symbol.asyncDispose](){released++}}})
 await assert.rejects(captureOwnerRunOrchestration(f.ctx,f.ptc,'ptc',controller.signal),{name:'AbortError'});assert.equal(released,2)
})

test('后续异步准备期间Agent身份或工具面变化，最终发布前复核拒绝',async t=>{
 const f=await fixture(t),captured=await captureOwnerRunOrchestration(f.ctx,f.standard,'standard',new AbortController().signal)
 f.standard.ctx.tools.presentAs('ptc')
 assert.throws(captured.assertCurrent,{code:'teloa/version-conflict'})
 await assert.rejects(captureOwnerRunOrchestration(f.ctx,f.ptc,'standard',new AbortController().signal),{code:'teloa/version-conflict'})
})
