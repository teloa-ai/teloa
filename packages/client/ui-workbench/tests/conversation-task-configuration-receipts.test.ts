import test from 'node:test'
import assert from 'node:assert/strict'
import {conversationTaskConfigurationReceipt} from '../src/client/conversation-task-configuration-receipts.ts'
const id='11111111-1111-4111-8111-111111111111'
const receipt={schema:'teloa.task-configuration-result/v1',operation:'created',taskId:id,taskName:'证据核对',sessionId:'origin',executionStarted:false,task:{id,ownerId:'local:teloa-owner',title:'证据核对',goal:'核对证据',scope:'general',groupId:null,skills:[],version:1,state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'}}
test('原会话真实任务保存回执提供原任务入口，以名称展示并保留固定版本',async()=>{
 assert.deepEqual(conversationTaskConfigurationReceipt(receipt,'origin'),{kind:'task',id,title:'证据核对',scope:'general',revision:'1:2026-10-12T00:00:00Z:ready'})
 for(const bad of [{...receipt,sessionId:'other'},{...receipt,taskId:'bad'},{...receipt,taskName:'其他任务'},{...receipt,executionStarted:true},{...receipt,task:{...receipt.task,ownerId:'other'}},{...receipt,task:{...receipt.task,version:0}},{...receipt,task:{...receipt.task,goal:''}}])assert.equal(conversationTaskConfigurationReceipt(bad,'origin'),undefined)
})
