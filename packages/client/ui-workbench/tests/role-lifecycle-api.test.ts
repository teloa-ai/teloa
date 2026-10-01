import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleLifecycleApi} from '../src/client/role-lifecycle-api.ts'
const id='16057272-ed9d-44a3-abe4-2ab04e056105'
const role={id,ownerId:'local:owner',name:'调查岗',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],version:2,state:'active',createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-11T00:00:00.000Z'}
test('岗位状态丢回包刷新后恢复相同版本和原因，后续当前状态不被旧操作覆盖',async()=>{
 let raw:string|null=null;const calls:unknown[]=[],journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 await assert.rejects(createRoleLifecycleApi(async(_m,p)=>{calls.push(p);throw Error('断线')},journal).change(id,1,'resume','恢复新工作'),/断线/)
 const api=createRoleLifecycleApi(async(m,p)=>{assert.equal(m,'roles/lifecycle');calls.push(p);return {role:{...role,version:4,state:'retired'},appliedVersion:2,handoffTaskIds:[]}},journal)
 await assert.rejects(api.change(id,1,'retire','退役'),/原请求/)
 const result=await api.recover();assert.equal(result.role.state,'retired');assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
})
test('回执目标、应用版本、当前状态与交接身份必须有效，失败保留请求',async()=>{
 for(const result of [{role:{...role,id:'26057272-ed9d-44a3-abe4-2ab04e056105'},appliedVersion:2,handoffTaskIds:[]},{role,appliedVersion:3,handoffTaskIds:[]},{role:{...role,state:'paused'},appliedVersion:2,handoffTaskIds:[]},{role,appliedVersion:2,handoffTaskIds:[id,id]}]){
  const api=createRoleLifecycleApi(async()=>result)
  await assert.rejects(api.change(id,1,'resume','恢复'),/响应/);assert.ok(api.pending())
 }
})
test('日志损坏或写入失败阻止发送，明确拒绝释放请求',async()=>{
 let calls=0;const call=async()=>{calls++;throw Object.assign(Error('版本变化'),{rejected:true,code:'teloa/version-conflict'})}
 const corrupt=createRoleLifecycleApi(call,{read:()=>'{',write:()=>{},clear:()=>{}})
 await assert.rejects(corrupt.change(id,1,'resume','恢复'),error=>(error as {code?:unknown}).code==='teloa/storage-corrupt')
 const unwritable=createRoleLifecycleApi(call,{read:()=>null,write:()=>{throw Error('不可写')},clear:()=>{}})
 await assert.rejects(unwritable.change(id,1,'resume','恢复'),/不可写/);assert.equal(calls,0)
 const api=createRoleLifecycleApi(call);await assert.rejects(api.change(id,1,'resume','恢复'),/版本变化/);assert.equal(api.pending(),undefined)
})
