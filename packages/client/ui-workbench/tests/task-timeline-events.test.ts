import assert from 'node:assert/strict'
import test from 'node:test'
import type {TaskTimelineFaces,TaskTimelineInput} from '../src/client/task-timeline-events.ts'
import type {PreviewApproval,PreviewTask} from '../src/client/task-preview.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {RunView} from '../src/client/task-run-api.ts'
import type {TaskHandoff} from '../src/client/handoff-api.ts'
import type {TaskMaterial} from '../src/client/task-material-api.ts'
import type {Artifact} from '../src/client/artifact-preview.ts'
import type {AttentionItem} from '../src/client/attention-item.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'

const {taskCompletionVisible,taskTimelineEvents}=await import('../src/client/task-timeline-events.ts')
const {localizedText,newApproval}=await import('../src/client/approval-preview.ts')
const {taskHistoryText}=await import('../src/client/task-preview.ts')

// 本任务只产出事件数据；task.timeline.* 里被本文件引用的 11 个键由 task-details.ts 一并登记，
// 其余（aria/empty/expand/collapse/fold.*）等 T5 接线 TaskDetail 时再加，免得 i18n-orphan-keys 守卫先红。

const taskId='7c1c9e0a-3b1b-4d0e-9c2a-2f4b6f6a1d01'
const roleId='2a7e5c1d-6f3b-4b8a-9d0e-1c2b3a4d5e6f'
const createdAt='2026-09-10T00:00:00.000Z'
const updatedAt='2026-09-12T00:00:00.000Z'
const t=((key:string,params?:Readonly<Record<string,string|number>>)=>key+(params?':'+JSON.stringify(params):'')) as TeloaTranslate
const faces:TaskTimelineFaces={executions:'face:executions',securityAction:'action:security',completion:'face:completion',handoffAction:'action:handoff',knowledge:'face:knowledge',need:'face:need',supplements:'face:supplements',source:'face:source',approval:'face:approval',approvalHistory:'face:approvalHistory'}
const roles:PreviewRole[]=[{id:roleId,name:'调研员',kind:'employee',scopes:['SOC'],state:'active',version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]}]

// 照 task-preview.ts createTask 的形状手写。
function task(patch:Partial<PreviewTask>={}):PreviewTask{
 return {
  storage:'persistent',id:taskId,title:'核对异常访问',goal:'核实异常访问范围并给出结论。',scope:'SOC',object:'通用任务',version:1,state:'ready',need:null,request:'',
  authorId:'self',assigneeId:'self',assigneeHistory:['self'],createdAt,updatedAt,result:'',evidence:[],
  history:[{message:localizedText('task.history.created'),actorId:'self',at:createdAt}],supplements:[],approvalRequired:false,risk:localizedText('task.approval.risk.none'),execution:'not_started',
  ...patch,
 }
}
function run(id:string,createdAt:string,reason?:string,patch:Partial<RunView>={}):RunView{
 return {id,taskId,sessionId:'session-'+id,nativeRequestId:'request-'+id,state:'ended',...(reason?{reason}:{}),stopRequestedAt:null,taskVersion:1,roleVersion:1,goal:'核实异常访问范围',roleName:'调研员',createdAt,skills:[],knowledge:[],...patch}
}
function handoff(id:string,status:TaskHandoff['status'],createdAt:string):TaskHandoff{
 return {id,taskId,fromRoleId:roleId,ownerId:'self',roleVersion:1,taskVersion:1,reason:'岗位暂停',createdAt,status}
}
function material(id:string,createdAt:string):TaskMaterial{
 return {id,taskId,taskVersion:1,resourceId:'resource-'+id,resourceVersion:3,title:'访问日志说明',sourceId:'source-'+id,sourceVersion:'1',scopeIds:['SOC'],available:true,createdAt}
}
function securityItem(id:string,occurredAt:string):AttentionItem{
 return {id,kind:'approval',source:'security-action',persistence:'saved',target:{kind:'security-action',taskId,actionId:'action-'+id},title:'封禁 IP',reason:{kind:'text',text:'等待审批'},scope:'SOC',occurredAt}
}
function artifact(id:string,versions:{number:number;title:string;at:string}[]):Artifact{
 return {storage:'persistent',links:[],id,source:{kind:'task',id:taskId},primary:true,feedback:[],versions:versions.map(version=>({...version,sections:[],note:'',author:'调研员',source:{ref:{kind:'task',id:taskId},title:'核对异常访问',scope:'SOC',version:'1',author:'调研员',evidence:[],private:false}}))}
}
function approval(id:string,now:string,status:PreviewApproval['status']='pending'):PreviewApproval{
 return {...newApproval(id,{subjectVersion:1,subjectLabel:localizedText('task.approval.subject'),title:'核对异常访问',goal:'核实',object:'通用任务',result:'',evidence:[],risk:localizedText('task.approval.risk.none'),effect:localizedText('task.approval.effect')},now),status,taskId}
}
const input=(patch:Partial<TaskTimelineInput>={}):TaskTimelineInput=>({
 task:task(),roles,runs:[],runsLoaded:true,record:null,materials:[],artifacts:[],approvals:[],securityItems:[],handoffs:[],completionVisible:false,faces,t,...patch,
})
const runs=[run('r1','2026-09-11T01:00:00.000Z','completed'),run('r3','2026-09-11T03:00:00.000Z',undefined,{state:'active'}),run('r2','2026-09-11T02:00:00.000Z','aborted')]

test('安全关注项只取当前任务，缺失时间回落到任务更新时间',()=>{
 const own=securityItem('own',''),other=securityItem('other',createdAt)
 other.target={kind:'security-action',taskId:'other-task',actionId:'other-action'}
 const events=taskTimelineEvents(input({securityItems:[other,own]})).filter(event=>event.kind==='approval')
 assert.equal(events.length,1)
 assert.equal(events[0]!.id,'approval:own')
 assert.equal(events[0]!.at,updatedAt)
 assert.equal(events[0]!.actions,faces.securityAction)
})

test('① 三轮运行 → 三条 run 事件，仅历史可折叠，当前内容面身份稳定',()=>{
 const events=taskTimelineEvents(input({runs})).filter(event=>event.kind==='run')
 assert.equal(events.length,3)
 assert.deepEqual(events.map(event=>event.id),['run:current','run:r2','run:r1'])
 assert.equal(events[0]!.foldKey,undefined)
 for(const event of events.slice(1))assert.equal(event.foldKey,'run')
 assert.equal(events[0]!.detail,faces.executions);assert.equal(events[0]!.anchor,'run')
 assert.equal(events[0]!.title,'task.timeline.run:{"role":"调研员","phase":"taskExecution.phase.active"}')
 assert.equal(events[1]!.title,'task.timeline.run:{"role":"调研员","phase":"taskExecution.reason.aborted"}')
 for(const event of events.slice(1)){assert.equal(event.detail,undefined);assert.equal(event.anchor,undefined)}
 assert.equal(events[0]!.id,taskTimelineEvents(input()).find(event=>event.kind==='run')!.id)
})

test('② 持久任务且还没有运行 → 恰一条 run:current，pending 且带详情面',()=>{
 const events=taskTimelineEvents(input()).filter(event=>event.kind==='run')
 assert.equal(events.length,1)
 assert.equal(events[0]!.id,'run:current');assert.equal(events[0]!.pending,true);assert.equal(events[0]!.at,updatedAt)
 assert.equal(events[0]!.title,'task.timeline.runReady');assert.equal(events[0]!.detail,faces.executions);assert.equal(events[0]!.anchor,'run')
 const {storage:_storage,...demo}=task()
 assert.equal(taskTimelineEvents(input({task:demo})).some(event=>event.kind==='run'),false,'沙盒任务没有 run:current')
})

test('已完成或取消任务不再提示准备首次执行，运行读取面仍保留',()=>{
 for(const state of ['completed','cancelled'] as const){
  const event=taskTimelineEvents(input({task:task({state})})).find(event=>event.kind==='run')!
  assert.equal(event.title,'taskExecution.title')
  assert.equal(event.pending,false)
  assert.equal(event.detail,faces.executions)
  assert.equal(event.anchor,'run')
 }
})

test('运行记录尚未读到或读取失败时，不把空数组当成未执行',()=>{
 const event=taskTimelineEvents(input({runsLoaded:false})).find(event=>event.kind==='run')!
 assert.equal(event.title,'taskExecution.title')
 assert.equal(event.pending,false)
 assert.equal(event.detail,faces.executions)
})

test('③ 一条外部动作关注 → approval 事件 pending，仅挂定位按钮',()=>{
 const events=taskTimelineEvents(input({securityItems:[securityItem('s1','2026-09-11T05:00:00.000Z'),securityItem('s2','2026-09-11T06:00:00.000Z')]})).filter(event=>event.kind==='approval')
 assert.equal(events.length,2)
 const first=events.find(event=>event.id==='approval:s1')!
 assert.equal(first.pending,true);assert.equal(first.actions,faces.securityAction);assert.equal(first.anchor,undefined);assert.equal(first.foldKey,'approval')
 assert.equal(first.title,'task.timeline.approval');assert.equal(first.at,'2026-09-11T05:00:00.000Z')
 const second=events.find(event=>event.id==='approval:s2')!
 assert.equal(second.pending,true);assert.equal(second.detail,undefined)
})

test('③b 沙盒审批：最新一条挂 approval 面并按 status 置 pending，历史第一条挂 approvalHistory 面',()=>{
 const approvals=[approval('a1','2026-09-11T01:00:00.000Z','approved'),approval('a2','2026-09-11T02:00:00.000Z','rejected'),approval('a3','2026-09-11T03:00:00.000Z')]
 const events=taskTimelineEvents(input({approvals})).filter(event=>event.kind==='approval')
 assert.deepEqual(events.map(event=>event.id),['approval:a3','approval:a2','approval:a1'])
 const latest=events[0]!
 assert.equal(latest.pending,true);assert.equal(latest.detail,faces.approval);assert.equal(latest.anchor,'approval');assert.equal(latest.foldKey,undefined)
 assert.equal(events[2]!.detail,faces.approvalHistory);assert.equal(events[2]!.foldKey,'approval');assert.equal(events[1]!.detail,undefined)
 const decided=taskTimelineEvents(input({approvals:approvals.slice(0,1)})).find(event=>event.kind==='approval')!
 assert.equal(decided.pending,false)
})

test('④ 已完成且有结项记录 → completion 事件标题带成果版本，at 取记录时刻',()=>{
 const completedAt='2026-09-13T00:00:00.000Z'
 const events=taskTimelineEvents(input({task:task({state:'completed'}),record:{taskId,taskVersion:1,artifactId:'artifact-1',artifactVersion:2,note:'已交付',completedAt},completionVisible:true}))
 const completion=events.find(event=>event.kind==='completion')!
 assert.equal(completion.id,'completion');assert.match(completion.title,/"version":2/);assert.equal(completion.at,completedAt)
 assert.equal(completion.detail,faces.completion);assert.equal(completion.anchor,'completion');assert.equal(completion.pending,undefined)
 assert.equal(events.some(event=>event.id==='completion:pending'),false)
 const withoutRecord=taskTimelineEvents(input({task:task({state:'completed'}),completionVisible:true})).find(event=>event.kind==='completion')!
 assert.equal(withoutRecord.title,'taskCompletion.record');assert.equal(withoutRecord.at,updatedAt)
})

test('④b 待结项 → completion:pending 事件 pending 且挂结项面',()=>{
 const events=taskTimelineEvents(input({task:task({state:'running'}),completionVisible:true}))
 const pending=events.find(event=>event.kind==='completion')!
 assert.equal(pending.id,'completion:pending');assert.equal(pending.pending,true);assert.equal(pending.title,'task.timeline.completionPending')
 assert.equal(pending.detail,faces.completion);assert.equal(pending.anchor,'completion')
 assert.equal(taskTimelineEvents(input({task:task({state:'running'})})).some(event=>event.kind==='completion'),false,'completionVisible 为假不出结项事件')
})

test('⑤ taskCompletionVisible 与 TaskCompletion.tsx 的守卫同判',()=>{
 assert.equal(taskCompletionVisible({storage:'persistent',state:'completed',assigneeId:roleId}),true)
 assert.equal(taskCompletionVisible({storage:'persistent',state:'running',assigneeId:'self'}),true)
 assert.equal(taskCompletionVisible({storage:'persistent',state:'waiting',assigneeId:roleId}),true)
 assert.equal(taskCompletionVisible({storage:'persistent',state:'running',assigneeId:roleId}),false)
 assert.equal(taskCompletionVisible({storage:'persistent',state:'waiting',assigneeId:'self'}),false)
 for(const state of ['completed','running','waiting'] as const)assert.equal(taskCompletionVisible({state,assigneeId:'self'}),false,'沙盒恒假 '+state)
})

test('⑥ 待处理交接单 → handoff 事件 pending 且挂定位按钮；无待处理时不挂',()=>{
 const handoffs=[handoff('h1','pending','2026-09-11T04:00:00.000Z'),handoff('h2','pending','2026-09-11T05:00:00.000Z'),handoff('h0','resolved','2026-09-10T12:00:00.000Z')]
 const events=taskTimelineEvents(input({handoffs})).filter(event=>event.kind==='handoff')
 assert.deepEqual(events.map(event=>event.id),['handoff:h2','handoff:h1','handoff:h0'])
 const first=events.find(event=>event.id==='handoff:h1')!
 assert.equal(first.pending,true);assert.equal(first.actions,faces.handoffAction);assert.equal(first.anchor,undefined)
 assert.equal(first.title,'task.timeline.handoffPending:{"from":"调研员"}')
 const second=events.find(event=>event.id==='handoff:h2')!
 assert.equal(second.pending,true);assert.equal(second.detail,undefined,'时间线不挂交接表单')
 const resolved=events.find(event=>event.id==='handoff:h0')!
 assert.equal(resolved.pending,undefined);assert.equal(resolved.foldKey,'handoff');assert.equal(resolved.title,'task.timeline.handoffResolved:{"from":"调研员"}')
 assert.equal(events.filter(event=>event.actions===faces.handoffAction).length,2)
 const none=taskTimelineEvents(input({handoffs:[handoff('h0','resolved','2026-09-10T12:00:00.000Z')],runs,securityItems:[securityItem('s1','2026-09-11T05:00:00.000Z')]}))
 assert.equal(none.some(event=>event.actions===faces.handoffAction),false)
})

test('⑦ 两条 history → 两条 change 事件，foldKey change，标题走 taskHistoryText，meta 是操作人',()=>{
 const history:PreviewTask['history']=[{message:localizedText('task.history.created'),actorId:'self',at:createdAt},{text:'已切换负责人',actorId:roleId,at:'2026-09-11T00:00:00.000Z'}]
 const events=taskTimelineEvents(input({task:task({history})})).filter(event=>event.kind==='change')
 assert.equal(events.length,2)
 assert.deepEqual(events.map(event=>event.id),['change:1','change:0'])
 for(const event of events)assert.equal(event.foldKey,'change')
 assert.equal(events[1]!.title,taskHistoryText(history[0]!,t));assert.equal(events[1]!.meta,'role.preview.self')
 assert.equal(events[0]!.title,'已切换负责人');assert.equal(events[0]!.meta,'调研员')
})

test('⑦b 补充记录存在 → change:supplements 事件挂 supplements 面',()=>{
 const events=taskTimelineEvents(input({task:task({supplements:[{id:'sup-1',source:'日志',note:'补一份',status:'pending'}]})}))
 const supplements=events.find(event=>event.id==='change:supplements')!
 assert.equal(supplements.kind,'change');assert.equal(supplements.title,'task.detail.supplements');assert.equal(supplements.detail,faces.supplements);assert.equal(supplements.at,updatedAt)
 assert.equal(taskTimelineEvents(input()).some(event=>event.id==='change:supplements'),false)
})

test('⑧ 整体倒序，at 全是 Z 结尾的 UTC ISO',()=>{
 const events=taskTimelineEvents(input({
  task:task({source:{groupId:'g',messageId:'m',rootId:'m',text:'请核对'},state:'completed'}),runs,record:{taskId,taskVersion:1,artifactId:'artifact-1',artifactVersion:2,note:'已交付',completedAt:'2026-09-13T00:00:00.000Z'},completionVisible:true,
  materials:[material('k1','2026-09-11T02:30:00.000Z')],artifacts:[artifact('artifact-1',[{number:1,title:'结论 v1',at:'2026-09-11T02:45:00.000Z'},{number:2,title:'结论 v2',at:'2026-09-12T00:00:00.000Z'}])],
  handoffs:[handoff('h0','resolved','2026-09-10T12:00:00.000Z')],securityItems:[securityItem('s1','2026-09-11T05:00:00.000Z')],
 }))
 assert.ok(events.length>=10)
 for(let index=1;index<events.length;index++)assert.ok(events[index-1]!.at>=events[index]!.at,events[index-1]!.id+' >= '+events[index]!.id)
 for(const event of events)assert.match(event.at,/Z$/)
 const artifacts=events.filter(event=>event.kind==='artifact')
 assert.deepEqual(artifacts.map(event=>event.id),['artifact:artifact-1:2','artifact:artifact-1:1'])
 assert.equal(artifacts[0]!.title,'task.timeline.artifact:{"version":2,"title":"结论 v2"}');assert.equal(artifacts[0]!.foldKey,'artifact');assert.equal(artifacts[0]!.anchor,'artifact')
 const knowledge=events.find(event=>event.kind==='knowledge')!
 assert.equal(knowledge.id,'knowledge:k1');assert.equal(knowledge.foldKey,'knowledge');assert.equal(knowledge.detail,faces.knowledge);assert.equal(knowledge.title,'task.timeline.knowledge:{"title":"访问日志说明","version":3}')
})

test('⑧b 别的任务的成果不进本任务时间线',()=>{
 const other={...artifact('artifact-9',[{number:1,title:'别的',at:'2026-09-11T02:45:00.000Z'}]),source:{kind:'task' as const,id:'other-task'}}
 assert.equal(taskTimelineEvents(input({artifacts:[other]})).some(event=>event.kind==='artifact'),false)
})

test('⑨ 沙盒任务的资料需求 → attention:need 事件挂 need 面；沙盒交接 → attention:handoff 挂定位按钮',()=>{
 const {storage:_storage,...demo}=task({need:'materials',state:'waiting'})
 const events=taskTimelineEvents(input({task:demo}))
 const need=events.find(event=>event.id==='attention:need')!
 assert.equal(need.kind,'attention');assert.equal(need.pending,true);assert.equal(need.detail,faces.need);assert.equal(need.anchor,'attention');assert.equal(need.at,updatedAt)
 assert.equal(need.title,'task.timeline.attention:{"kind":"attention.materials"}')
 assert.equal(taskTimelineEvents(input({task:task({need:'materials',state:'waiting'})})).some(event=>event.kind==='attention'),false,'持久任务的需求走关注项，不出沙盒事件')
 const {storage:_s2,...approvalDemo}=task({need:'approval',state:'waiting'})
 assert.equal(taskTimelineEvents(input({task:approvalDemo})).some(event=>event.id==='attention:need'),false,'审批需求走审批事件')
 const {storage:_s3,...handoffDemo}=task({state:'waiting',handoff:{fromId:roleId,reason:'岗位暂停',at:'2026-09-11T08:00:00.000Z'}})
 const handoffEvent=taskTimelineEvents(input({task:handoffDemo})).find(event=>event.id==='attention:handoff')!
 assert.equal(handoffEvent.pending,true);assert.equal(handoffEvent.actions,faces.handoffAction);assert.equal(handoffEvent.anchor,undefined);assert.equal(handoffEvent.at,'2026-09-11T08:00:00.000Z')
 assert.equal(handoffEvent.title,'task.timeline.attention:{"kind":"attention.handoff"}')
})

test('⑩ 有群来源 → source 事件 at 等于 createdAt 且挂 source 面；无来源不出',()=>{
 const events=taskTimelineEvents(input({task:task({source:{groupId:'g',messageId:'m',rootId:'m',text:'请核对',trigger:'routed'}})}))
 const source=events.find(event=>event.kind==='source')!
 assert.equal(source.id,'source');assert.equal(source.at,createdAt);assert.equal(source.title,'task.timeline.source');assert.equal(source.detail,faces.source)
 assert.equal(taskTimelineEvents(input()).some(event=>event.kind==='source'),false)
})
