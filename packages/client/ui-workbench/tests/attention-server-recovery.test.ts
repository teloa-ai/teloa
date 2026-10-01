import assert from 'node:assert/strict'
import test from 'node:test'
import {aggregateAttentionItems,formalAttentionCount,openAttentionItem} from '../src/client/attention-item.ts'
import {serverRecoveryItems} from '../src/client/attention-server-recovery.ts'
import {emptyTaskPreview} from '../src/client/task-preview.ts'

const requestId='61a2a1d4-0d7b-4c1a-8c39-2a1d63a52b18'
const rows=[{requestId,endpoint:'security-actions/execute',createdAt:'2026-09-18T00:00:00.000Z',updatedAt:'2026-09-18T00:01:00.000Z'}]
const preview=emptyTaskPreview()
const base={tasks:preview.tasks,taskAttention:[],handoffs:[],business:preview.business,continuous:preview.continuous,savedPlanIds:new Set<string>(),bindings:[]}

test('服务端待恢复请求只投影为通用核对事项，界面不携带命令或载荷',()=>{
 const recoveries=serverRecoveryItems(rows,'已保存的工作请求')
 assert.deepEqual(recoveries,[{id:'recovery:server:'+requestId,kind:'review',source:'server-recovery',target:{kind:'pending-request',requestId},title:'已保存的工作请求',reason:{kind:'message',key:'attention.recovery.serverRequest'},scope:'general',occurredAt:'2026-09-18T00:01:00.000Z'}])
 const items=aggregateAttentionItems({...base,serverRecoveries:recoveries})
 assert.equal(formalAttentionCount(items),1)
 assert.deepEqual(items[0]?.target,{kind:'pending-request',requestId})
})

test('待恢复事项只能交给显式恢复入口，点击目录不重放原请求',()=>{
 const item=aggregateAttentionItems({...base,serverRecoveries:serverRecoveryItems(rows,'已保存的工作请求')})[0]!
 const calls:string[]=[]
 openAttentionItem(item,{openTask:()=>{},openArtifact:()=>{},openGroup:()=>{},openMarket:()=>{},openIndustrySkill:()=>{},openBusiness:()=>{},openPlans:()=>{},openBinding:()=>{},openInstallation:()=>{},openPendingRequest:id=>calls.push(id)})
 assert.deepEqual(calls,[requestId])
})
