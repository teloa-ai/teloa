import test from 'node:test'
import assert from 'node:assert/strict'
import {createHandoffApi} from '../src/client/handoff-api.ts'
const id='16057272-ed9d-44a3-abe4-2ab04e056105',target='26057272-ed9d-44a3-abe4-2ab04e056105',at='2026-09-11T00:00:00Z'
const request={handoffId:id,expectedTaskVersion:1,toRoleId:target,expectedRoleVersion:2,note:'接续'},task={id,title:'调查',goal:'核验',scope:'general',groupId:null,skills:[],ownerId:'owner',version:2,state:'ready',assigneeRoleId:target,assigneeRoleVersion:2,createdAt:at,updatedAt:at}
const selfRequest={handoffId:id,expectedTaskVersion:1,target:{kind:'self' as const},note:'由本人接管'},selfTask={...task,assigneeRoleId:null,assigneeRoleVersion:null}
test('接任丢回包后刷新固定原请求，并校验任务身份',async()=>{
 let raw:string|null=null;const calls:unknown[]=[],journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 await assert.rejects(createHandoffApi(async(_m,p)=>{calls.push(p);throw Error('断线')},journal).resolve(id,request),/断线/)
 const api=createHandoffApi(async(m,p)=>{assert.equal(m,'handoffs/resolve');calls.push(p);return {task,handoffId:id,appliedVersion:2}},journal)
 await assert.rejects(api.resolve(id,{...request,note:'换安排'}),/原请求/)
 assert.deepEqual((await api.recover()).task,task);assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
})
test('损坏目录与错配接任结果不能用于更新页面',async()=>{
 await assert.rejects(createHandoffApi(async()=>[{id}]).list())
 for(const value of [{task:{...task,id:target},handoffId:id,appliedVersion:2},{task:{...task,assigneeRoleId:id},handoffId:id,appliedVersion:2},{task,handoffId:id,appliedVersion:4}]){
  const api=createHandoffApi(async()=>value);await assert.rejects(api.resolve(id,request),/响应/);assert.ok(api.pending())
 }
})
test('本人接管校验负责人为空，并固定恢复原请求',async()=>{
 let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const api=createHandoffApi(async()=>({task:selfTask,handoffId:id,appliedVersion:2}),journal)
 const result=await api.resolve(id,selfRequest)
 assert.equal(result.task.assigneeRoleId,null);assert.equal(raw,null)
 const wrong=createHandoffApi(async()=>({task,handoffId:id,appliedVersion:2}))
 await assert.rejects(wrong.resolve(id,selfRequest),/响应/)
})

const activeTask={...task,id,version:3,assigneeRoleId:target,assigneeRoleVersion:2}
const activeResult=(requestId:string,overrides:Record<string,unknown>={})=>({
 task:activeTask,
 change:{requestId,taskId:id,baseVersion:2,appliedVersion:3,from:{kind:'self'},to:{kind:'role',roleId:target,roleVersion:2},note:'接续调查',createdAt:at},
 ...overrides,
})

test('主动改派保存独立请求并在成功后清理',async()=>{
 let passiveRaw:string|null='passive-stays',changeRaw:string|null=null,captured:any
 const passive={read:()=>passiveRaw,write:(v:string)=>{passiveRaw=v},clear:()=>{passiveRaw=null}}
 const changeJournal={read:()=>changeRaw,write:(v:string)=>{changeRaw=v},clear:()=>{changeRaw=null}}
 const api=createHandoffApi(async(method,payload)=>{assert.equal(method,'handoffs/change');captured=payload;return activeResult((payload as any).requestId)},passive,changeJournal)
 const result=await api.change(id,2,{kind:'role',roleId:target,expectedRoleVersion:2},'  接续调查  ')
 assert.equal(result.task.version,3)
 assert.match(captured.requestId,/^[a-f0-9-]{36}$/i)
 assert.deepEqual(captured,{requestId:captured.requestId,taskId:id,expectedTaskVersion:2,target:{kind:'role',roleId:target,expectedRoleVersion:2},note:'接续调查'})
 assert.equal(changeRaw,null)
 assert.equal(passiveRaw,'passive-stays')
 assert.equal(api.pendingChange(),undefined)
})

test('主动改派丢回包后刷新复用同一 requestId 和完整参数',async()=>{
 let raw:string|null=null,first:any,second:any
 const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const failed=createHandoffApi(async(_method,payload)=>{first=payload;throw Error('断线')},undefined,journal)
 await assert.rejects(failed.change(id,2,{kind:'self'},'交给本人'),/断线/)
 assert.ok(failed.pendingChange())
 const recovered=createHandoffApi(async(method,payload)=>{assert.equal(method,'handoffs/change');second=payload;return {task:{...activeTask,assigneeRoleId:null,assigneeRoleVersion:null},change:{requestId:(payload as any).requestId,taskId:id,baseVersion:2,appliedVersion:3,from:{kind:'role',roleId:target,roleVersion:2},to:{kind:'self'},note:'交给本人',createdAt:at}}},undefined,journal)
 await assert.rejects(recovered.change(id,2,{kind:'role',roleId:target,expectedRoleVersion:2},'另一安排'),/原改派请求/)
 await recovered.recoverChange()
 assert.deepEqual(second,first)
 assert.equal(raw,null)
})

test('主动改派确定性错误清理记录，未知错误保留记录',async()=>{
 for(const code of ['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict']){
  let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
  const api=createHandoffApi(async()=>{throw Object.assign(Error(code),{rejected:true,code})},undefined,journal)
  await assert.rejects(api.change(id,2,{kind:'self'},'交给本人'))
  assert.equal(raw,null,code);assert.equal(api.pendingChange(),undefined,code)
 }
 let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const api=createHandoffApi(async()=>{throw Object.assign(Error('存储状态未知'),{rejected:true,code:'teloa/storage-corrupt'})},undefined,journal)
 await assert.rejects(api.change(id,2,{kind:'self'},'交给本人'))
 assert.ok(raw);assert.ok(api.pendingChange())
})

test('旧改派回执可返回较新任务且不会要求较新负责人与旧目标一致',async()=>{
 const api=createHandoffApi(async(_method,payload)=>activeResult((payload as any).requestId,{task:{...activeTask,version:5,assigneeRoleId:null,assigneeRoleVersion:null}}))
 const result=await api.change(id,2,{kind:'role',roleId:target,expectedRoleVersion:2},'接续调查')
 assert.equal(result.task.version,5)
 assert.equal(result.task.assigneeRoleId,null)
})

test('主动改派损坏恢复记录会暂停新改派且不影响被动接任目录',async()=>{
 const changeJournal={read:()=>'{bad',write:(_v:string)=>{},clear:()=>{}}
 const api=createHandoffApi(async method=>method==='handoffs/list'?[]:null,undefined,changeJournal)
 assert.equal(api.changeRecoveryMessage()?.code,'teloa/storage-corrupt')
 await assert.rejects(api.change(id,2,{kind:'self'},'交给本人'),error=>(error as {code?:unknown}).code==='teloa/storage-corrupt')
 assert.deepEqual(await api.list(),[])
})

test('被动接任与主动改派各自保留恢复记录，任一成功不清理另一条',async()=>{
 let passiveRaw:string|null=null,changeRaw:string|null=null
 const passive={read:()=>passiveRaw,write:(v:string)=>{passiveRaw=v},clear:()=>{passiveRaw=null}}
 const changeJournal={read:()=>changeRaw,write:(v:string)=>{changeRaw=v},clear:()=>{changeRaw=null}}
 const api=createHandoffApi(async(method,payload)=>{
  if(method==='handoffs/resolve')throw Error('被动接任断线')
  return activeResult((payload as any).requestId)
 },passive,changeJournal)
 await assert.rejects(api.resolve(id,request),/断线/)
 assert.ok(passiveRaw);assert.ok(api.pending())
 await api.change(id,2,{kind:'role',roleId:target,expectedRoleVersion:2},'接续调查')
 assert.ok(passiveRaw);assert.ok(api.pending());assert.equal(changeRaw,null)
})

test('主动改派未知回包保留原请求等待核对',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const api=createHandoffApi(async()=>({task:activeTask,change:{}}),undefined,journal)
 await assert.rejects(api.change(id,2,{kind:'role',roleId:target,expectedRoleVersion:2},'接续调查'),/响应不一致/)
 assert.ok(raw);assert.ok(api.pendingChange())
})
