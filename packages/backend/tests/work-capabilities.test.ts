import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkAccess,type WorkAccessRequest} from '../src/work/work-access.ts'

test('可信会话能力分别申请，组合租约使高级续作到期失效而基础仍可用',async()=>{
 const access=new WorkAccess(),seen:Readonly<WorkAccessRequest>[]=[],rights={advanced:true}
 access.installPolicy(async request=>{seen.push(request);return {assertCurrent(){if(request.kind==='capability'&&request.capability!=='general-agent'&&!rights.advanced)throw Error('expired')}}})
 assert.equal(typeof Reflect.get(access,'installSessionCapabilities'),'function')
 access.installSessionCapabilities(async sessionId=>({ownerId:'verified-owner',capabilities:sessionId==='general'?['general-agent']:['people','groups']}))
 const general=await access.authorizeSessionCapabilities('general','prompt'),advanced=await access.authorizeSessionCapabilities('employee','prompt')
 assert.deepEqual(seen.map(request=>request.kind==='capability'?[request.capability,request.ownerId,request.sessionId]:request.kind),[['general-agent','verified-owner','general'],['people','verified-owner','employee'],['groups','verified-owner','employee']])
 rights.advanced=false;general.assertContinuationCurrent?.()
 assert.throws(()=>advanced.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
 await assert.rejects(access.authorizeSessionCapabilities('employee','restore'),{code:'teloa/forbidden'})
})

test('受管能力分类缺失或不可信时拒绝；公开Free缺省保持开放',async()=>{
 const free=new WorkAccess()
 assert.equal(typeof Reflect.get(free,'authorizeSessionCapabilities'),'function')
 ;(await free.authorizeSessionCapabilities('free-session','prompt')).assertCurrent()
 const managed=new WorkAccess();managed.requireSessionCapabilities();managed.installPolicy(async()=>({assertCurrent(){}}))
 await assert.rejects(managed.authorizeSessionCapabilities('session','prompt'),{code:'teloa/unavailable'})
 managed.installSessionCapabilities(async()=>({ownerId:'',capabilities:['general-agent']}))
 await assert.rejects(managed.authorizeSessionCapabilities('session','prompt'),{code:'teloa/forbidden'})
 assert.throws(()=>managed.installSessionCapabilities(async()=>({ownerId:'other',capabilities:['general-agent']})),{code:'teloa/forbidden'})
})
