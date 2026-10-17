import assert from 'node:assert/strict'
import test from 'node:test'
import {createWorkAttentionApi} from '../src/client/work-attention-api.ts'
import type {WorkAttentionPage} from '@teloa/contract'

const taskId='12345678-1234-4234-8234-123456789012',draftId='87654321-1234-4234-8234-123456789012',digest='a'.repeat(64),occurredAt='2026-10-17T00:00:00.000Z'
const page:WorkAttentionPage={schema:'teloa.work-attention/v1',items:[
 {id:'task:'+taskId,kind:'review',reason:'task-waiting',title:'原任务',scope:'SOC',occurredAt,source:{kind:'task',taskId,version:3},target:{kind:'task',taskId},basisHash:digest},
 {id:'business-change-set:change-1',kind:'approval',reason:'business-change-review',title:'change-1',scope:'SOC',occurredAt,source:{kind:'business-change-set',scope:'SOC',changeSetId:'change-1',revision:2,digest},target:{kind:'business-change-set',scope:'SOC',changeSetId:'change-1'},basisHash:digest},
 {id:'business-sync:SOC:mapping-1',kind:'error',reason:'business-sync-failed',title:'mapping-1',scope:'SOC',occurredAt,source:{kind:'business-sync',scope:'SOC',mappingId:'mapping-1',runId:'run-1'},target:{kind:'business-sync',scope:'SOC',mappingId:'mapping-1'},basisHash:digest},
 {id:'page-create-draft:'+draftId,kind:'review',reason:'page-create-draft-pending',title:'原员工草稿',occurredAt,source:{kind:'page-create-draft',entity:'role',draftId,bodyHash:digest},target:{kind:'page-create-draft',draftId},basisHash:digest},
],nextCursor:'actual-cursor',incomplete:[{source:'business-change-set',scope:'SOC',reason:'page-limit'}]}

test('工作待办API只调用正式只读端点，保留四类真源与部分来源和分页事实',async()=>{
 const calls:unknown[]=[],controller=new AbortController()
 const api=createWorkAttentionApi(async(endpoint,payload,signal)=>{calls.push({endpoint,payload,signal});return structuredClone(page)})
 assert.deepEqual(await api.list({scope:'SOC',cursor:'previous-cursor',limit:50},controller.signal),page)
 assert.deepEqual(calls,[{endpoint:'work-attention',payload:{scope:'SOC',cursor:'previous-cursor',limit:50},signal:controller.signal}])
})

test('非法每页上限与查询键在发请求前拒绝，不派发真源写入',async()=>{
 let calls=0;const api=createWorkAttentionApi(async()=>{calls++;return page})
 await assert.rejects(api.list({limit:51}),/查询格式/)
 await assert.rejects(api.list({scope:'SOC',approve:true} as unknown as Parameters<typeof api.list>[0]),/查询格式/)
 assert.equal(calls,0)
})

test('来源目标错位或读取失败明确拒绝，显式重试仍只读取当前目录',async()=>{
 const mismatch=structuredClone(page);mismatch.items[0]!.target={kind:'task',taskId:draftId}
 let response:unknown=mismatch,calls=0
 const api=createWorkAttentionApi(async()=>{calls++;if(response instanceof Error)throw response;return response})
 await assert.rejects(api.list(),/无效待办或来源/)
 response=Error('当前目录不可用');await assert.rejects(api.list(),/当前目录不可用/)
 response=page;assert.deepEqual(await api.list(),page);assert.equal(calls,3)
})
