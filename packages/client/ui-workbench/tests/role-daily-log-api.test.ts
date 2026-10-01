import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleDailyLogApi} from '../src/client/role-daily-log-api.ts'

const roleId='16057272-ed9d-44a3-abe4-2ab04e056105',logId='26057272-ed9d-44a3-abe4-2ab04e056105',runId='36057272-ed9d-44a3-abe4-2ab04e056105'
const createdAt='2026-09-20T23:30:00.000Z',discardedAt='2026-09-21T09:00:00.000Z',markdown='今天完成了三项工作，均已核对来源。'
const log={id:logId,ownerId:'local:owner',roleId,roleVersion:2,kind:'daily-digest' as const,day:'2026-09-20',state:'kept' as const,runId,title:'今日小结',markdown,scopeIds:[],evidence:[],pruneHints:[],createdAt,discardedAt:null}
const summary={id:logId,kind:'daily-digest' as const,day:'2026-09-20',state:'kept' as const,title:'今日小结',createdAt}

test('list：出参恰为 {roleId} 一键，回包解出 items 数组',async()=>{
 let calls:unknown[]=[]
 const api=createRoleDailyLogApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return {items:[summary]}},{read:()=>null,write:()=>{},clear:()=>{}})
 assert.deepEqual(await api.list(roleId),[summary])
 assert.deepEqual(calls[0],['role-daily-log/list',{roleId}])
})

test('list：回包多一个键或非 isRoleDailyLogSummary 一律抛固定中文',async()=>{
 const wrapped=createRoleDailyLogApi(async()=>({items:[summary],extra:1}),{read:()=>null,write:()=>{},clear:()=>{}})
 await assert.rejects(wrapped.list(roleId),/每日日志请求格式不正确/)
 const badItem=createRoleDailyLogApi(async()=>({items:[{...summary,day:'不是日期'}]}),{read:()=>null,write:()=>{},clear:()=>{}})
 await assert.rejects(badItem.list(roleId),/每日日志目录格式不正确/)
 const dup=createRoleDailyLogApi(async()=>({items:[summary,summary]}),{read:()=>null,write:()=>{},clear:()=>{}})
 await assert.rejects(dup.list(roleId),/重复身份/)
})

test('get：出参恰为 {roleId,logId} 两键，回包身份必须与目标一致',async()=>{
 let calls:unknown[]=[]
 const api=createRoleDailyLogApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return {log}},{read:()=>null,write:()=>{},clear:()=>{}})
 assert.deepEqual(await api.get(roleId,logId),log)
 assert.deepEqual(calls[0],['role-daily-log/get',{roleId,logId}])
 const mismatched=createRoleDailyLogApi(async()=>({log:{...log,id:'46057272-ed9d-44a3-abe4-2ab04e056105'}}),{read:()=>null,write:()=>{},clear:()=>{}})
 await assert.rejects(mismatched.get(roleId,logId),/详情与目标身份不一致/)
 const malformed=createRoleDailyLogApi(async()=>({log:{...log,markdown:''}}),{read:()=>null,write:()=>{},clear:()=>{}})
 await assert.rejects(malformed.get(roleId,logId),/每日日志服务响应格式不正确/)
})

test('discard：出参恰为 requestId/logId/expectedState 三键固定值，丢回包后可用同一 requestId 重放',async()=>{
 let raw:string|null=null,calls:unknown[]=[],fail=true
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createRoleDailyLogApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);if(fail)throw Error('断线');return {log:{...log,state:'discarded',discardedAt}}},journal,()=>'56057272-ed9d-44a3-abe4-2ab04e056105')
 await assert.rejects(api.discard(logId),/断线/)
 assert.equal(api.pending(),true)
 assert.ok(raw)
 fail=false
 const recovered=await api.recover()
 assert.equal(recovered.state,'discarded')
 assert.equal(recovered.discardedAt,discardedAt)
 assert.deepEqual(calls[0],calls[1])
 const [, sent]=calls[1] as [string,Record<string,unknown>]
 assert.deepEqual(sent,{requestId:'56057272-ed9d-44a3-abe4-2ab04e056105',logId,expectedState:'kept'})
 assert.equal(api.pending(),false)
 assert.equal(raw,null)
})

test('discard：确定性错误清空日志，回执与原请求不一致时也报固定中文',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const rejected=createRoleDailyLogApi(async()=>{throw Object.assign(Error('版本已变'),{rejected:true,code:'teloa/version-conflict'})},journal,()=>'66057272-ed9d-44a3-abe4-2ab04e056105')
 await assert.rejects(rejected.discard(logId),/版本已变/)
 assert.equal(rejected.pending(),false)
 assert.equal(raw,null)
 const mismatched=createRoleDailyLogApi(async()=>({log:{...log,id:logId,state:'kept'}}),{read:()=>null,write:()=>{},clear:()=>{}},()=>'76057272-ed9d-44a3-abe4-2ab04e056105')
 await assert.rejects(mismatched.discard(logId),/丢弃响应与原请求不一致/)
})

test('损坏的本地恢复记录不会静默清空，discardPending 显式清',()=>{
 const corrupt=createRoleDailyLogApi(async()=>({log}),{read:()=>'{',write:()=>{},clear:()=>{}})
 assert.ok(corrupt.recoveryMessage())
 corrupt.discardPending()
 assert.equal(corrupt.recoveryMessage(),undefined)
})
