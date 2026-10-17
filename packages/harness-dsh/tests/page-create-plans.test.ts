import test from 'node:test'
import assert from 'node:assert/strict'
import {createConfirmedPlanDraftHandler,planDraftRequestId} from '../src/page-create-plans.ts'
import type {PageCreateDraft} from '@teloa/contract'

const owner='local:plan-draft',id='10000000-0000-4000-8000-000000000001',planId='20000000-0000-4000-8000-000000000001'
const source={artifactId:'30000000-0000-4000-8000-000000000001',version:1,basisHash:'a'.repeat(64)}
const schedule={kind:'schedule',cadence:'daily',weekday:1,time:'11:00',timezone:'Asia/Singapore'}
const work={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:4,maxTokens:10000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:1,stagnationRounds:2,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
const definition={executor:{kind:'owner'},roleId:null,title:'客户摘要',goal:'整理提供的反馈',scope:'general',dataScope:'本人提供资料',delivery:'摘要与待办',trigger:schedule,notificationPolicy:'attention'}
const body={definition,work,intent:'save-paused',source}
function setup(value:unknown=body){
 const calls:Array<{operation:string;input:any}>=[]
 const draft:PageCreateDraft={id,ownerId:owner,requestId:id,entity:'plan',body:JSON.stringify(value),bodyHash:'b'.repeat(64),title:'客户摘要',status:'draft',createdAt:'2026-10-17T00:00:00.000Z',updatedAt:'2026-10-17T00:00:00.000Z'}
 let authority:any={source,target:'plan',intent:'save-paused',acceptedSource:{sessionId:'original-chat',messageId:id,messageSeq:1,requestId:id}}
 const op=(operation:string)=>async(_owner:string,input:any)=>{calls.push({operation,input});return {id:planId,ownerId:owner,version:operation==='enable'?3:operation==='configure'?2:1,configVersion:operation==='create'?1:2,state:operation==='enable'?'active':'paused'}}
 let recordedPlanId:string|null=planId
 const handler=createConfirmedPlanDraftHandler(owner,{draft:async()=>({...draft}),method:async()=>authority,operationPlanId:async()=>recordedPlanId,plans:async()=>({get:op('get'),createOwnerConfirmed:op('create'),createConfirmed:op('create-role'),configureWorkConfirmed:op('configure'),changeConfirmed:op('enable')}) as never})
 const openedHash=draft.bodyHash
 const confirm=()=>handler('page-create-plans/confirm',{draftId:id,expectedBodyHash:openedHash})
 return {confirm,calls,draft,setAuthority:(value:unknown)=>authority=value,setRecordedPlanId:(value:string|null)=>recordedPlanId=value}
}
test('计划草稿确认复用固定创建请求，默认暂停且不把草稿或版本落定提前算成功',async()=>{
 const f=setup();const result=await f.confirm();await f.confirm()
 assert.equal(result.planId,planId);assert.equal(result.state,'paused')
 assert.deepEqual(f.calls.map(row=>row.operation),['create','create'])
 assert.equal(f.calls[0]!.input.requestId,planDraftRequestId(f.draft,'create'))
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.draft.status,'draft')
})
test('固定原计划观察配置按本人确认采用，只有明确启用意图才调用原启用链',async()=>{
 const f=setup({kind:'configure-work',planId,expectedVersion:1,expectedConfigVersion:1,work,intent:'create-and-enable'})
 f.setAuthority(null);const result=await f.confirm()
 assert.equal(result.state,'active');assert.deepEqual(f.calls.map(row=>row.operation),['configure','enable'])
 assert.equal(f.calls[0]!.input.expectedConfigVersion,1);assert.equal(f.calls[1]!.input.expectedVersion,2)
})
test('来源缺失、草稿摘要变更或跨本人，在实际计划写入之前拒绝',async()=>{
 const missing=setup();missing.setAuthority(null);await assert.rejects(missing.confirm(),{code:'teloa/forbidden'});assert.deepEqual(missing.calls,[])
 const changed=setup();changed.draft.bodyHash='c'.repeat(64)
 // confirm固定使用打开时的摘要，不能把后来摘要再绑定到原确认。
 await assert.rejects(changed.confirm(),{code:'teloa/version-conflict'});assert.deepEqual(changed.calls,[])
 const foreign=setup();foreign.draft.ownerId='foreign';await assert.rejects(foreign.confirm(),{code:'teloa/version-conflict'});assert.deepEqual(foreign.calls,[])
})

test('正式人工认可的固定方法可以保存暂停，不伪造本人原消息来源',async()=>{
 const taskId='40000000-0000-4000-8000-000000000001',manualSource={...source,taskId}
 const f=setup({...body,source:manualSource})
 f.setAuthority({source:manualSource,target:'plan',intent:'save-paused'})
 assert.equal((await f.confirm()).state,'paused')
 assert.deepEqual(f.calls[0]!.input.source,{kind:'method-reuse',...manualSource})
 assert.equal(Object.hasOwn(f.calls[0]!.input.source,'acceptedSource'),false)
})

test('已采用草案恢复必须回读原创建请求，另一项本人计划或缺失回执都不冒完成',async()=>{
 const f=setup();f.draft.status='applied';f.draft.appliedRef=planId
 assert.equal((await f.confirm()).planId,planId);assert.deepEqual(f.calls.map(row=>row.operation),['get'])
 for(const different of ['50000000-0000-4000-8000-000000000001',null]){
  const broken=setup();broken.draft.status='applied';broken.draft.appliedRef=planId;broken.setRecordedPlanId(different)
  await assert.rejects(broken.confirm(),{code:'teloa/storage-corrupt'});assert.deepEqual(broken.calls,[])
 }
})
