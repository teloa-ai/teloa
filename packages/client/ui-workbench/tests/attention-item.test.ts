import assert from 'node:assert/strict'
import test from 'node:test'
import type {WorkTask} from '@teloa/contract'
import {aggregateAttentionItems,attentionReasonText,formalAttentionCount,openAttentionItem} from '../src/client/attention-item.ts'
import {attentionKinds,emptyTaskPreview,withTaskExamples} from '../src/client/task-preview.ts'
import {withBusinessExamples} from '../src/client/business-work-preview.ts'
import {withContinuousExamples} from '../src/client/continuous-work.ts'
import {describeTaskProgress} from '../src/client/task-detail-presentation.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import type {BindingFailure} from '../src/client/capability-work.ts'

const now='2026-09-13T08:00:00.000Z'
const taskId='12345678-1234-4234-8234-123456789012'
const roleId='87654321-1234-4234-8234-123456789012'
const savedTask:WorkTask={id:taskId,ownerId:'owner',title:'核对真实任务',goal:'处理执行失败',scope:'general',groupId:null,skills:[],version:2,state:'blocked',assigneeRoleId:roleId,assigneeRoleVersion:1,createdAt:'2026-09-13T07:00:00.000Z',updatedAt:'2026-09-13T07:30:00.000Z'}
const binding:BindingFailure={id:'binding-failure',bindingId:'binding-1',version:3,title:'资料连接',scope:'general',target:'通用工作',message:'连接不可用',at:'2026-09-13T07:40:00.000Z',active:true}

function snapshot(){
  let preview=withTaskExamples(emptyTaskPreview(),now)
  preview=withBusinessExamples(preview,now)
  preview=withContinuousExamples(preview,now)
  preview={...preview,continuous:{...preview.continuous,plans:preview.continuous.plans.map((plan,index)=>index?plan:{...plan,handoff:{fromId:roleId,reason:'原岗位退役'},history:[...plan.history,{text:'等待交接',at:'2026-09-13T07:35:00.000Z'}]})}}
  return {
    tasks:preview.tasks,
    taskAttention:[{task:savedTask,attention:{kind:'error' as const,reason:'execution-failed' as const}}],
    handoffs:[{id:'handoff-1',taskId,fromRoleId:roleId,ownerId:'owner',roleVersion:1,taskVersion:2,reason:'原岗位退役',createdAt:'2026-09-13T07:45:00.000Z',status:'pending' as const}],
    business:preview.business,
    continuous:preview.continuous,
    savedPlanIds:new Set<string>(),
    bindings:[binding],
  }
}

test('统一映射当前已接入的五类快照来源并携带可由既有 action 打开的目标',()=>{
  const items=aggregateAttentionItems(snapshot())
  const bySource=new Map(items.map(item=>[item.source,item]))
  assert.deepEqual(items.find(item=>item.source==='task'&&item.persistence==='saved')?.target,{kind:'task',id:taskId})
  assert.deepEqual(aggregateAttentionItems({...snapshot(),taskAttention:[]}).find(item=>item.source==='handoff'&&item.persistence==='saved')?.target,{kind:'task',id:taskId})
  assert.deepEqual(bySource.get('business')?.target.kind,'business')
  assert.ok(['plan','run'].includes(String(bySource.get('plan')?.target.kind)))
  assert.deepEqual(bySource.get('binding')?.target,{kind:'binding',id:'binding-1',version:3})
  assert.equal(bySource.has('installation'),false)
  assert.ok(items.every(item=>item.title&&attentionReasonText(item.reason,key=>key)&&item.scope&&Number.isFinite(Date.parse(item.occurredAt))))
})

test('固定任务原因和业务操作状态只保存国际化键',()=>{
  const items=aggregateAttentionItems(snapshot())
  assert.deepEqual(items.find(item=>item.source==='task'&&item.persistence==='saved')?.reason,{kind:'message',key:'task.attention.reason.executionFailed'})
  assert.deepEqual(items.find(item=>item.source==='business'&&item.kind==='approval')?.reason,{kind:'message',key:'task.detail.operation.pending'})
})

test('任务服务待办与待交接按真实任务目标去重并保持稳定身份',()=>{
  const input=snapshot(),first=aggregateAttentionItems(input),second=aggregateAttentionItems(structuredClone(input))
  const taskItems=first.filter(item=>item.target.kind==='task'&&item.target.id===taskId)
  assert.equal(taskItems.length,1)
  assert.equal(taskItems[0]?.id,'task:'+taskId)
  assert.equal(taskItems[0]?.source,'task')
  assert.deepEqual(second.map(item=>item.id),first.map(item=>item.id))
})

test('正式角标只计已保存和本机恢复项，界面示例留在目录但不计数',()=>{
  const items=aggregateAttentionItems(snapshot())
  assert.ok(items.some(item=>item.persistence==='example'))
  assert.equal(formalAttentionCount(items),1)
  assert.equal(formalAttentionCount([...items,{...items[0]!,id:'recovery:task',persistence:'local-recovery'}]),2)
})

test('本机恢复项只聚合带稳定目标的 journal，并在恢复清空后自动消失',()=>{
  const localRecoveries=[
    {id:'recovery:task-material:'+taskId,kind:'materials' as const,source:'local-recovery' as const,target:{kind:'task' as const,id:taskId},title:'核对真实任务',reason:{kind:'message' as const,key:'attention.recovery.taskMaterial' as const},scope:'general',occurredAt:now},
    {id:'recovery:artifact:artifact-1',kind:'review' as const,source:'local-recovery' as const,target:{kind:'artifact' as const,source:{kind:'task' as const,id:taskId},artifactId:'artifact-1',version:1},title:'周报',reason:{kind:'message' as const,key:'attention.recovery.artifact' as const},scope:'general',occurredAt:now},
    {id:'recovery:group:group-1',kind:'review' as const,source:'local-recovery' as const,target:{kind:'group' as const,id:'group-1'},title:'值守群',reason:{kind:'message' as const,key:'attention.recovery.group' as const},scope:'general',occurredAt:now},
    {id:'recovery:industry-load:market-1',kind:'review' as const,source:'local-recovery' as const,target:{kind:'market' as const,itemId:'market-1'},title:'安全行业包',reason:{kind:'message' as const,key:'attention.recovery.industryLoad' as const},scope:'general',occurredAt:now},
    {id:'recovery:skill-install:market-2',kind:'review' as const,source:'local-recovery' as const,target:{kind:'market' as const,itemId:'market-2'},title:'取证 Skill',reason:{kind:'message' as const,key:'attention.recovery.skillInstall' as const},scope:'general',occurredAt:now},
  ]
  const items=aggregateAttentionItems({...snapshot(),localRecoveries})
  assert.deepEqual(items.filter(item=>item.persistence==='local-recovery').map(item=>[item.id,item.target]),localRecoveries.map(item=>[item.id,item.target]))
  assert.equal(formalAttentionCount(items),6)
  assert.equal(aggregateAttentionItems({...snapshot(),localRecoveries:[]}).some(item=>item.persistence==='local-recovery'),false)
})

test('待办先按原因优先级，再按发生时间倒序，完全并列时按稳定身份排序',()=>{
  const base=aggregateAttentionItems(snapshot())
  const sorted=aggregateAttentionItems({...snapshot(),bindings:[binding,{...binding,id:'binding-a',bindingId:'binding-a'},{...binding,id:'binding-z',bindingId:'binding-z'}]})
  const priorities={approval:0,materials:1,connection:2,error:3,review:4,handoff:5,dispatch:6,execution:7}
  assert.deepEqual(base.map(item=>priorities[item.kind]),[...base].map(item=>priorities[item.kind]).sort((a,b)=>a-b))
  assert.deepEqual(sorted.filter(item=>item.occurredAt===binding.at).map(item=>item.id),['binding:binding-1:v3','binding:binding-a:v3','binding:binding-z:v3'])
})

test('同任务异常与两个外部动作独立保留，打开精确动作；缺任务仍保留入口',()=>{
 const base=snapshot(),first='aaaaaaaa-1111-4111-8111-111111111111',second='bbbbbbbb-1111-4111-8111-111111111111'
 const items=aggregateAttentionItems({...base,handoffs:[],securityAttention:[{taskId,actionId:first,kind:'security-action',reason:'execution-required'},{taskId,actionId:second,kind:'security-action',reason:'execution-failed'}]})
 assert.equal(items.filter(row=>row.id==='task:'+taskId||row.source==='security-action').length,3)
 const selected=items.find(row=>row.id==='security-action:'+second)!
 assert.deepEqual(selected.target,{kind:'security-action',taskId,actionId:second})
 const calls:unknown[]=[]
 openAttentionItem(selected,{openTask:id=>{calls.push(id)},openSecurityAction:(taskId,actionId)=>{calls.push({taskId,actionId})},openArtifact:()=>{},openGroup:()=>{},openMarket:()=>{},openIndustrySkill:()=>{},openBusiness:()=>{},openPlans:()=>{},openBinding:()=>{},openInstallation:()=>{}})
 assert.deepEqual(calls,[{taskId,actionId:second}])
 const missing=aggregateAttentionItems({...base,securityAttention:[{taskId:'missing',actionId:first,kind:'security-action',reason:'external-accepted'}]}).find(row=>row.source==='security-action')
 assert.equal(missing?.title,'missing')
})


test('已批准外部动作投影为待执行，任务目录与详情不能误称尚未交办',()=>{
 const row=aggregateAttentionItems({...snapshot(),securityAttention:[{taskId,actionId:'aaaaaaaa-1111-4111-8111-111111111111',kind:'security-action',reason:'execution-required'}]}).find(item=>item.source==='security-action')!
 assert.equal(row.kind,'execution')
 assert.equal(translateMessage('zh-CN',attentionKinds[row.kind]),'待执行')
 assert.deepEqual(describeTaskProgress('ready',[row.kind]),{title:'待执行',description:'执行已批准动作'})
 assert.deepEqual(describeTaskProgress('ready',[row.kind],(key,params)=>translateMessage('en',key,params)),{title:'Ready to run',description:'Execute approved action'})
 for(const locale of ['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt']){
  const t=(key:Parameters<typeof translateMessage>[1],params?:Parameters<typeof translateMessage>[2])=>translateMessage(locale,key,params)
  const progress=describeTaskProgress('ready',[row.kind],t)
  assert.equal(progress.title,t('plan.run.prepared'));assert.equal(progress.description,t('security.attention.execution-required'))
  const mixed=describeTaskProgress('ready',[row.kind,'dispatch'],t)
  assert.ok(mixed.description.includes(t('plan.run.prepared')));assert.ok(mixed.description.includes(t('attention.dispatch')))
 }
 assert.equal(describeTaskProgress('ready',['dispatch']).title,'需要安排后续负责人')
 assert.equal(translateMessage('zh-CN',attentionKinds.dispatch),'待交办')
})

test('执行适配器未连接单独投影为待连接执行面，不能误称执行失败',()=>{
 const row=aggregateAttentionItems({...snapshot(),securityAttention:[{taskId,actionId:'cccccccc-1111-4111-8111-111111111111',kind:'security-action',reason:'adapter-unavailable'}]}).find(item=>item.source==='security-action')!
 assert.equal(row.kind,'connection')
 assert.equal(translateMessage('zh-CN',attentionKinds[row.kind]),'待连接')
 assert.deepEqual(describeTaskProgress('ready',[row.kind]),{title:'待连接执行面',description:'执行器尚未连接。连接并核对执行面后，再执行已批准动作。'})
 assert.deepEqual(describeTaskProgress('ready',[row.kind],(key,params)=>translateMessage('en',key,params)),{title:'Action tool connection required',description:'The action tool is not connected. Connect and verify it before running the approved action.'})
})
