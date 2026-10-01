import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskTransitionApi} from '../src/client/task-transition-api.ts'
const id='12345678-1234-4234-8234-123456789012',at='2026-09-11T00:00:00Z'
const result={id,title:'任务',goal:'核对',scope:'general',groupId:null,skills:[],ownerId:'owner',version:2,state:'running',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:at,updatedAt:at}
test('状态请求丢回包后刷新核对原请求，未核对前不允许换动作',async()=>{
 let raw:string|null=null,first=true;const calls:unknown[]=[]
 const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const call=async(method:string,payload:unknown)=>{assert.equal(method,'tasks/transition');calls.push(payload);if(first){first=false;throw Error('回包丢失')}return result}
 await assert.rejects(createTaskTransitionApi(call,journal).change(id,1,'start'),/回包丢失/)
 const api=createTaskTransitionApi(call,journal)
 assert.equal(api.pending()?.taskId,id)
 await assert.rejects(api.change(id,1,'cancel'),/原请求/)
 assert.deepEqual(await api.recover(),result);assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
})
test('损坏恢复记录与持久化失败均阻止发送，错误版本响应保留待核对请求',async()=>{
 let calls=0
 const call=async()=>{calls++;return {...result,version:99}}
 const broken=createTaskTransitionApi(call,{read:()=>'{',write:()=>{},clear:()=>{}})
 await assert.rejects(broken.change(id,1,'start'),error=>(error as {code?:unknown}).code==='teloa/storage-corrupt');assert.equal(calls,0)
 const unavailable=createTaskTransitionApi(call,{read:()=>null,write:()=>{throw Error('不可写')},clear:()=>{}})
 await assert.rejects(unavailable.change(id,1,'start'),/不可写/);assert.equal(calls,0)
 const api=createTaskTransitionApi(call)
 await assert.rejects(api.change(id,1,'start'),/不一致/);assert.ok(api.pending())
})
test('服务明确拒绝会释放待核对请求，网络失败仍保留',async()=>{
 const api=createTaskTransitionApi(async()=>{throw Object.assign(Error('版本变化'),{rejected:true,code:'teloa/version-conflict'})})
 await assert.rejects(api.change(id,1,'start'),/版本变化/);assert.equal(api.pending(),undefined)
})
test('结项恢复固定成果版本与说明，未核对请求不能替换交付物',async()=>{
 let raw:string|null=null,first=true;const calls:unknown[]=[]
 const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}},delivery={artifact:{id,version:1},note:'确认交付'}
 const call=async(_method:string,payload:unknown)=>{calls.push(payload);if(first){first=false;throw Error('回包丢失')}return {...result,state:'completed'}}
 await assert.rejects(createTaskTransitionApi(call,journal).change(id,1,'complete',delivery),/回包丢失/)
 const api=createTaskTransitionApi(call,journal)
 await assert.rejects(api.change(id,1,'complete',{...delivery,artifact:{id,version:2}}),/原请求/)
 await api.recover();assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
})
