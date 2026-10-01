import test from 'node:test'
import assert from 'node:assert/strict'
import {createPendingRequestApi} from '../src/client/pending-request-api.ts'

const requestId='61a2a1d4-0d7b-4c1a-8c39-2a1d63a52b18'
const row={requestId,endpoint:'tasks/create',createdAt:'2026-09-18T00:00:00.000Z',updatedAt:'2026-09-18T00:01:00.000Z'}

test('服务端待核对目录只读取元数据，恢复只发送请求身份',async()=>{
 const calls:unknown[][]=[]
 const api=createPendingRequestApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='requests/pending/list'?[row]:endpoint==='requests/pending/ack'?{requestId}:{ok:true}})
 assert.deepEqual(await api.list(),[row])
 assert.deepEqual(await api.recover(requestId),{value:{ok:true},acknowledged:true})
 assert.deepEqual(calls,[['requests/pending/list',{}],['requests/pending/recover',{requestId}],['requests/pending/ack',{requestId}]])
})

test('目录的载荷、无效身份和重复项不会进入界面',async()=>{
 const api=createPendingRequestApi(async()=>[{...row,payload:{token:'must-not-be-exposed'}}])
 await assert.rejects(api.list(),/目录格式/)
 await assert.rejects(createPendingRequestApi(async()=>[]).recover('not-a-uuid'),/身份不正确/)
 await assert.rejects(createPendingRequestApi(async()=>[row,row]).list(),/重复身份/)
})

test('确认提交后丢回包仍返回已取得的结果，重读目录反映真实终态',async()=>{
 let pending=true
 const result={id:'saved-task',version:1}
 const api=createPendingRequestApi(async endpoint=>{
  if(endpoint==='requests/pending/list')return pending?[row]:[]
  if(endpoint==='requests/pending/recover')return result
  if(endpoint==='requests/pending/ack'){pending=false;throw Error('确认已提交，回包丢失')}
  throw Error('unexpected endpoint')
 })
 assert.deepEqual(await api.recover(requestId),{value:result,acknowledged:false})
 assert.deepEqual(await api.list(),[])
})

test('确认未到达服务端时，结果已知但目录继续保留供核对',async()=>{
 const result={id:'saved-task',version:1}
 const api=createPendingRequestApi(async endpoint=>{
  if(endpoint==='requests/pending/list')return [row]
  if(endpoint==='requests/pending/recover')return result
  throw Error('确认网络中断')
 })
 assert.deepEqual(await api.recover(requestId),{value:result,acknowledged:false})
 assert.deepEqual(await api.list(),[row])
})

test('不接受错误身份或多余字段的确认回执',async()=>{
 for(const receipt of [{requestId:'other'},{requestId,payload:{unexpected:true}},null]){
  const api=createPendingRequestApi(async endpoint=>endpoint==='requests/pending/ack'?receipt:{id:'saved-task'})
  assert.deepEqual(await api.recover(requestId),{value:{id:'saved-task'},acknowledged:false})
 }
})

test('业务恢复本身被拒绝时不会发送确认，重新读取目录可观察拒绝后的移除',async()=>{
 let pending=true
 const calls:string[]=[]
 const api=createPendingRequestApi(async endpoint=>{
  calls.push(endpoint)
  if(endpoint==='requests/pending/list')return pending?[row]:[]
  if(endpoint==='requests/pending/recover'){pending=false;throw Object.assign(Error('版本已变化'),{code:'teloa/version-conflict'})}
  throw Error('不应发送确认')
 })
 await assert.rejects(api.recover(requestId),{code:'teloa/version-conflict'})
 assert.deepEqual(await api.list(),[])
 assert.deepEqual(calls,['requests/pending/recover','requests/pending/list'])
})
