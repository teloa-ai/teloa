import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createEmployeeApiWorkApi,type EmployeeWorkView} from '../src/client/employee-api-work-api.ts'
const taskId=randomUUID(),workId=randomUUID(),view:EmployeeWorkView={taskId,currentTaskId:taskId,sessionId:null,canContinue:true,work:{id:workId,title:'API核对',version:3,round:1,state:'failed',error:'execution_tools_required'}}
test('续办未知响应跨刷新恢复同一请求，不接受新正文替换或重复创建',async()=>{
 let saved:string|null=null,fail=true;const calls:unknown[]=[]
 const journal={read:()=>saved,write:(value:string)=>{saved=value},clear:()=>{saved=null}}
 const call=async(method:string,payload:unknown)=>{calls.push(payload);assert.equal(method,'employee-integrations/continue-work');if(fail)throw Error('connection lost');return {...view,currentTaskId:randomUUID(),canContinue:false,work:{...view.work,round:2,version:4,state:'queued',error:null}}}
 const first=createEmployeeApiWorkApi(call,journal)
 await assert.rejects(first.continue(view,'继续第一项'))
 assert.ok(saved);await assert.rejects(first.continue(view,'换一个正文'))
 fail=false;const restored=createEmployeeApiWorkApi(call,journal);const result=await restored.recover()
 assert.deepEqual(calls[0],calls[1]);assert.equal(result.work.id,workId);assert.equal(result.work.round,2);assert.equal(saved,null)
})
test('拒绝错误任务回包，损坏恢复记录阻止新续办，明确业务拒绝清理原请求',async()=>{
 const api=createEmployeeApiWorkApi(async()=>({...view,taskId:randomUUID()}))
 await assert.rejects(api.read(taskId))
 const damaged=createEmployeeApiWorkApi(async()=>{throw Error('must not send')},{read:()=>'{bad',write:()=>{},clear:()=>{}})
 assert.equal(damaged.fault(),true);await assert.rejects(damaged.continue(view,'继续'))
 let cleared=false
 const denied=createEmployeeApiWorkApi(async()=>{throw Object.assign(Error('denied'),{code:'teloa/forbidden',rejected:true})},{read:()=>null,write:()=>{},clear:()=>{cleared=true}})
 await assert.rejects(denied.continue(view,'继续'));assert.equal(cleared,true);assert.equal(denied.pending(),undefined)
})

test('旧轮次或旧版本的续办回包不能清理恢复记录，核对的轮次不进入端点参数',async()=>{
 for(const stale of ['round','version']){
  const original={...view,work:{...view.work,round:3,version:9}},calls:Record<string,unknown>[]=[],journalState:{value:string|null}={value:null}
  let restored=false
  const api=createEmployeeApiWorkApi(async(_method,input)=>{calls.push(structuredClone(input as Record<string,unknown>));return {...original,currentTaskId:randomUUID(),canContinue:false,work:{...original.work,round:restored?4:stale==='round'?3:4,version:restored?10:stale==='version'?9:10,state:'queued',error:null}}},{read:()=>journalState.value,write:value=>{journalState.value=value},clear:()=>{journalState.value=null}})
  await assert.rejects(()=>api.continue(original,'核对这一轮'))
  assert.ok(journalState.value);assert.equal(api.pending()?.expectedRound,3)
  assert.equal('expectedRound' in calls[0]!,false,'本地核对事实不是服务端新增参数')
  const pending=api.pending()!;pending.requestId=randomUUID();pending.input='不得替换原请求'
  restored=true;const current=await api.recover()
  assert.equal(current.work.round,4);assert.deepEqual(calls[0],calls[1]);assert.equal(journalState.value,null)
 }
})

test('续办双击与恢复并发只发送一次，运行态不创建新请求，跨面板通知待核对状态',async()=>{
 let release:()=>void=()=>{},writes=0,notifications=0
 const held=new Promise<void>(resolve=>{release=resolve}),api=createEmployeeApiWorkApi(async()=>{writes++;await held;return {...view,work:{...view.work,round:2,version:4,state:'queued'},canContinue:false}})
 const unsubscribe=api.subscribe(()=>notifications++)
 const first=api.continue(view,'第一条输入')
 await assert.rejects(()=>api.continue(view,'第二条输入'));await assert.rejects(()=>api.recover());assert.equal(writes,1);assert.equal(notifications,1)
 release();await first;assert.equal(notifications,2);unsubscribe()
 await assert.rejects(()=>api.continue({...view,work:{...view.work,state:'running'},canContinue:false},'运行中输入'))
 assert.equal(writes,1);assert.equal(api.pending(),undefined)
})
