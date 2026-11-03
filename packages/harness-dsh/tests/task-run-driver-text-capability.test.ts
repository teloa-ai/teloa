import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import type {TaskExecutionScope,TaskRun} from '@teloa/backend'
import {readRunTextCapability} from '@teloa/contract'
import {assertRunTextContext} from '../../backend/src/work/group-delivery-recovery.ts'
import {TaskRunDriver} from '../src/task-run-driver.ts'

const ids={task:'1aa5eec2-bfc9-491a-9dc5-5a638bbdd2df',role:'4c8cded1-d1fc-44c8-bf70-4d0e8d526be6',group:'2631d354-1ec8-42c9-a682-e065ce0d6825',message:'7be7fc5b-58be-451f-811e-181b0af08bc8',approval:'99059211-da1c-419f-bb1e-9d7347239b14',run:'49272313-19fc-49cf-9282-343da648e742',request:'33823dfc-5743-40da-961f-be81c4daf88f',control:'7268e41a-a18a-439c-b9a3-5365b7bf0258',budget:'62728e9a-dc65-46f7-bd7f-8cb9b917c82a'}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
function fixture(options:{capability?:boolean;control?:'active'|'paused';bindingChangedAtClaim?:boolean}={}){
 const owner='synthetic-owner',sessionId='task-run-'+ids.request,goal='只按本人固定文字资料给出摘要'
 const context:NonNullable<TaskRun['groupContext']>={taskId:ids.task,groupId:ids.group,groupVersion:1,roleId:ids.role,roleVersion:1,grantVersion:1,source:{messageId:ids.message,rootId:ids.message,createdAt:'2026-10-26T00:00:00.000Z',text:goal},materials:[],files:[],ownerRequest:{messageId:ids.message,text:goal,sha256:digest(goal)}}
 const capability=readRunTextCapability({schema:'teloa.run-text-capability/v1',kind:'text',approvalId:ids.approval,ownerId:owner,taskId:ids.task,taskVersion:1,roleId:ids.role,roleVersion:1,groupId:ids.group,groupVersion:1,sourceMessageId:ids.message,sourceDigest:digest('固定来源'),materials:[],confirmedAt:'2026-10-26T00:00:00.000Z'})
 const lineage:NonNullable<TaskRun['lineage']>={schema:'teloa.work-lineage/v1',ownerId:owner,rootTaskId:ids.task,definition:null,parentRunId:null,definitionControlId:null,roundControlId:ids.control,controlGeneration:1,budgetAccountId:ids.budget}
 let run:TaskRun={id:ids.run,taskId:ids.task,roleId:ids.role,taskVersion:1,roleVersion:1,linkVersion:1,sessionId,nativeRequestId:ids.request,state:'prepared',evidence:null,stopRequestedAt:null,allowedTools:[],argumentRules:[],skills:[],knowledge:[],memory:[],groupContext:context,lineage,agentPresetId:'teloa-standard',inputText:'固定且不重建的原准备输入',createdAt:'2026-10-26T00:00:00.000Z',...(options.capability===false?{}:{textCapability:capability})}
 const order:string[]=[],calls={scope:0,check:0,claim:0,send:0,record:0},target:TaskExecutionScope={taskId:ids.task,taskVersion:1,sessionId,linkVersion:1,scope:'general'}
 const driver=new TaskRunDriver({
  get:async()=>{order.push('get');return run},
  executionScope:async()=>{order.push('executionScope');calls.scope++;return target},
  claim:async()=>{
   order.push('claim')
   calls.claim++
   if(run.textCapability){
    // 复用真实后端纯校验器，不把失效绑定的伪服务成功当作放行证明；无SQL或实例。
    assertRunTextContext(run.textCapability,owner,{id:ids.task,version:1},{id:ids.role,version:1,skills:[],knowledge:[]},options.bindingChangedAtClaim?{...context,groupVersion:2}:context)
   }
   if(run.state!=='prepared')return {run,dispatch:false}
   run={...run,state:'submitting'};return {run,dispatch:true,target}
  },
  record:async()=>{order.push('record');calls.record++;run={...run,state:'accepted',evidence:{state:'accepted'}};return run},
  requestStop:async()=>run,
 },{
  controlState:async()=>{order.push('controlState');return options.control??'active'},
  check:async(current,_signal,checked)=>{order.push('check');calls.check++;assert.equal(current.id,ids.run);assert.equal(current.sessionId,sessionId);assert.deepEqual(checked,target)},
  send:async(current,_signal,checked)=>{order.push('send');calls.send++;assert.equal(current.id,ids.run);assert.equal(current.nativeRequestId,ids.request);assert.equal(current.inputText,'固定且不重建的原准备输入');assert.deepEqual(current.lineage,lineage);assert.deepEqual(current.allowedTools,[]);assert.deepEqual(current.skills,[]);assert.deepEqual(current.memory,[]);assert.deepEqual(checked,target)},
  stop:async()=>{throw Error('本例不允许停止或重置原Run')},events:async()=>[],
 })
 return {driver,calls,order,run:()=>run,owner}
}

test('受限文本原Run：真实start空工具通过原claim/send且二次读取不重发',async()=>{
 const f=fixture(),result=await f.driver.start(f.owner,{runId:ids.run},new AbortController().signal)
 assert.equal(result.id,ids.run);assert.equal(result.state,'accepted')
 assert.deepEqual(f.calls,{scope:1,check:1,claim:1,send:1,record:1})
 assert.deepEqual(f.order,['get','controlState','executionScope','check','claim','send','record'])
 await f.driver.start(f.owner,{runId:ids.run},new AbortController().signal)
 assert.deepEqual(f.calls,{scope:1,check:1,claim:1,send:1,record:1})
})

test('受限文本原Run：无正式cap的普通群work空工具仍在claim/send前拒绝',async()=>{
 const f=fixture({capability:false})
 await assert.rejects(f.driver.start(f.owner,{runId:ids.run},new AbortController().signal),error=>error instanceof Error&&'details' in error&&(error.details as {reason?:string})?.reason==='role-run-no-execution-tools')
 assert.deepEqual(f.calls,{scope:0,check:0,claim:0,send:0,record:0});assert.equal(f.run().state,'prepared')
})

test('受限文本原Run：暂停控制仍拒绝，不因cap跳过真实start后续控制闸',async()=>{
 const f=fixture({control:'paused'})
 await assert.rejects(f.driver.start(f.owner,{runId:ids.run},new AbortController().signal),{code:'teloa/forbidden'})
 assert.deepEqual(f.calls,{scope:0,check:0,claim:0,send:0,record:0});assert.equal(f.run().state,'prepared')
})

test('受限文本原Run：检查后绑定变化仍由真实后端校验器在claim拒绝，零send',async()=>{
 const f=fixture({bindingChangedAtClaim:true})
 await assert.rejects(f.driver.start(f.owner,{runId:ids.run},new AbortController().signal),error=>error instanceof Error&&'code' in error&&error.code==='teloa/conflict'&&/固定群资料/.test(error.message))
 assert.deepEqual(f.calls,{scope:1,check:1,claim:1,send:0,record:0});assert.equal(f.run().state,'prepared')
})
