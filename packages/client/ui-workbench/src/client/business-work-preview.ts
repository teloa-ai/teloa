import { decideApproval, localizedText, newApproval, type ApprovalDecision, type LocalizedText } from './approval-preview.ts'
import { businessExamples, currentObject, inputsCurrent, objectRef, objectKey, sameObject, type BusinessOperation, type BusinessTarget, type BusinessWorkEntry, type ObjectRef } from './business-preview.ts'
import { changeTaskPreview, type TaskPreview } from './task-preview.ts'
import { canReceiveTask, withRoleExamples } from './role-preview.ts'
import type {TeloaTranslate} from './i18n/index.ts'

export type BusinessChange=(
  |{type:'object-task';ref:ObjectRef;id:string;title:string;goal:string;assigneeId:string}
  |{type:'dispatch-run';runId:string;id:string;assigneeId:string}
  |{type:'flow';flowId:string;paused:boolean}
  |{type:'batch';flowId:string;batchId:string;id:string}
  |{type:'refresh-object';ref:ObjectRef}
  |{type:'retry-analysis';runId:string;succeeded:boolean}
  |({type:'decide-operation';operationId:string}&Omit<ApprovalDecision,'now'>)
  |{type:'propose-operation';id:string;refs:ObjectRef[];title:string;goal:string;parameters:string;targets:string[];risk:string;taskId?:string}
  |{type:'link-operation';operationId:string;expectedVersion:number;taskId:string}
  |{type:'execute'|'reconcile';operationId:string;expectedVersion:number}
  |{type:'receipt';operationId:string;expectedVersion:number;unknown:boolean}
)&{now:string}
type WorkErrorCode='teloa/invalid-input'|'teloa/not-found'|'teloa/conflict'|'teloa/version-conflict'|'teloa/source-unavailable'
const failure=(code:WorkErrorCode,message:string)=>Object.assign(Error(message),{code})
const required=(value:string,label:string,max=4000)=>{const clean=value.trim();if(!clean||clean.length>max)throw failure('teloa/invalid-input',label+'不能为空且不能超过 '+max+' 字。');return clean}
const legacyBusinessWorkMessages:Readonly<Record<string,Parameters<TeloaTranslate>[0]>>={
  '本人代拟操作提议，等待单独审批。':'business.work.history.proposed',
  '来源版本更新；原审批快照保留，旧提议不能执行。':'business.work.history.sourceChanged',
  '提交演示执行，等待效果核验。':'business.work.history.execute',
  '仅提交已确认未应用的目标；保留成功目标。':'business.work.history.retryTargets',
  '查询原操作回执，不增加执行尝试。':'business.work.history.reconcile',
  '接收演示效果回执。':'business.work.history.receipt',
  '演示下游已受理固定目标与参数，效果待核验。':'business.work.receipt.accepted',
  '效果回执中断，不能确认是否生效。':'business.work.receipt.interrupted',
  '查询原操作确认：目标未应用，可以单独重试。':'business.work.receipt.unapplied',
  '查询原操作确认：目标已达到期望状态。':'business.work.receipt.verified',
  '提出固定目标与参数，等待本人审批。':'business.work.legacy.proposed',
  '示例下游已受理，效果回执中断。':'business.work.legacy.acceptedInterrupted',
  '示例历史：本人批准后下游受理，当前效果未知。':'business.work.legacy.approvedUnknown',
  '演示标记已写入并核对，未创建任务。':'business.work.legacy.autoReceipt',
  '演示判据匹配；在固定范围内完成低影响标记。':'business.work.legacy.autoHistory',
}
export function businessWorkText(entry:BusinessWorkEntry,t:TeloaTranslate):string{
  if(entry.message)return t(entry.message.key,entry.message.params)
  const exact=legacyBusinessWorkMessages[entry.text]
  if(exact)return t(exact)
  const dynamic:[prefix:string,key:Parameters<TeloaTranslate>[0],param:string][]=[
    ['本人批准：','business.work.history.approved','note'],
    ['本人驳回：','business.work.history.rejected','note'],
    ['本人退回修改：','business.work.history.changes','note'],
    ['关联调查任务：','business.work.history.linkedTask','title'],
  ]
  for(const [prefix,key,param] of dynamic)if(entry.text.startsWith(prefix)){
    const suffix=entry.text.slice(prefix.length)
    const value=key==='business.work.history.linkedTask'&&suffix.endsWith('；调查进展与执行状态分别记录。')?suffix.slice(0,-'；调查进展与执行状态分别记录。'.length):suffix
    return t(key,{[param]:value})
  }
  return entry.text
}
export function withBusinessExamples(state:TaskPreview,now:string):TaskPreview{
  if(state.business.loaded)return state
  return {...state,roles:withRoleExamples(state.roles,now),business:{...businessExamples(now),spaces:state.business.spaces}}
}
function followObjects(state:TaskPreview,refs:ObjectRef[],source:BusinessTarget,id:string,title:string,goal:string,assigneeId:string,now:string):TaskPreview{
  if(!inputsCurrent(state.business,refs))throw failure('teloa/version-conflict','来源对象不存在或版本已变化，请重新核对。')
  if(!canReceiveTask(state.roles.find(role=>role.id===assigneeId),source.scope))throw failure('teloa/invalid-input','请选择在岗且支持该业务的员工；分身先代拟。')
  const next=changeTaskPreview(state,{type:'create',id,title,goal,scope:source.scope,now})
  return {...next,tasks:next.tasks.map(task=>task.id===id?{...task,assigneeId,assigneeHistory:[assigneeId],object:refs.map(ref=>ref.title).join('、'),objectRefs:refs.map(objectRef),businessSource:source,evidence:refs.map(ref=>ref.title+' · '+ref.id+' v'+ref.version)}:task)}
}
export function changeBusinessWork(state:TaskPreview,change:BusinessChange):TaskPreview{
  if(!Number.isFinite(Date.parse(change.now)))throw failure('teloa/invalid-input','时间无效。')
  const business=state.business
  if(change.type==='object-task')return followObjects(state,[change.ref],{scope:change.ref.scope,section:'data',id:change.ref.id,objectType:change.ref.type},change.id,change.title,change.goal,change.assigneeId,change.now)
  if(change.type==='dispatch-run'){
    const run=business.runs.find(item=>item.id===change.runId)
    if(!run)throw failure('teloa/not-found','分析记录不存在。')
    if(run.taskId)return state
    if(run.state==='stale'||!inputsCurrent(business,run.inputs))throw failure('teloa/version-conflict','分析依据已过时，不能交办旧结论。')
    if(run.state!=='completed'||run.findings===0)throw failure('teloa/conflict','当前没有可交办的调查线索。')
    const next=followObjects(state,run.inputs,{scope:run.scope,section:'analysis',id:run.id},change.id,run.title,'核实这次分析的线索与来源，不直接采用分析结果作最终结论。\n'+run.result,change.assigneeId,change.now)
    return {...next,business:{...business,runs:business.runs.map(item=>item.id===run.id?{...item,taskId:change.id}:item)}}
  }
  if(change.type==='flow'){
    if(!business.flows.some(item=>item.id===change.flowId))throw failure('teloa/not-found','系统流程不存在。')
    return {...state,business:{...business,flows:business.flows.map(item=>item.id===change.flowId?{...item,paused:change.paused}:item)}}
  }
  if(change.type==='batch'){
    const flow=business.flows.find(item=>item.id===change.flowId)
    if(!flow)throw failure('teloa/not-found','系统流程不存在。')
    if(business.runs.some(item=>item.flowId===flow.id&&item.batchId===change.batchId))return state
    if(flow.paused)throw failure('teloa/conflict','流程已暂停新批次。')
    if(business.runs.some(item=>item.id===change.id))throw failure('teloa/conflict','分析编号冲突。')
    const inputs=business.objects.filter(item=>item.scope===flow.scope&&item.quality==='complete').slice(0,2).map(objectRef)
    if(!inputs.length)throw failure('teloa/source-unavailable','没有完整的分析输入。')
    return {...state,business:{...business,runs:[...business.runs,{id:change.id,flowId:flow.id,batchId:change.batchId,scope:flow.scope,title:'新批次关联分析',inputs,state:'completed',findings:1,result:'演示发现需复核的关联线索，等待交办。',method:'告警关联判据 v3',createdAt:change.now}]}}
  }
  if(change.type==='refresh-object'){
    const object=currentObject(business,change.ref)
    if(!object||object.version!==change.ref.version)throw failure('teloa/version-conflict','对象版本已变化。')
    const uses=(refs:ObjectRef[])=>refs.some(ref=>sameObject(ref,object))
    return {...state,business:{...business,objects:business.objects.map(item=>sameObject(item,object)?{...item,version:item.version+1,receivedAt:change.now,summary:item.summary+'\n新资料已到达，请重新分析当前版本。'}:item),runs:business.runs.map(run=>uses(run.inputs)?{...run,state:'stale'}:run),operations:business.operations.map(op=>uses(op.inputs)&&['pending','approved','changes','rejected'].includes(op.state)?{...op,state:'stale',version:op.version+1,...(op.approval?{approval:{...op.approval,status:'stale' as const,version:op.approval.version+1}}:{}),history:[...op.history,{message:localizedText('business.work.history.sourceChanged'),at:change.now}]}:op)}}
  }
  if(change.type==='retry-analysis'){
    const run=business.runs.find(item=>item.id===change.runId)
    if(!run||run.state!=='failed')throw failure('teloa/not-found','没有等待重试的分析异常。')
    if(!inputsCurrent(business,run.inputs))throw failure('teloa/version-conflict','来源版本已变化，请发起新分析。')
    return {...state,business:{...business,runs:business.runs.map(item=>item.id===run.id?{...item,state:change.succeeded?'completed':'failed',findings:change.succeeded?1:0,result:change.succeeded?'演示重读成功；责任人仍待补齐，交给员工核实资料。':'示例连接仍失败，保留本批次和异常。'}:item)}}
  }
  if(change.type==='propose-operation'){
    const id=required(change.id,'操作编号'),refs=change.refs.map(objectRef),scope=refs[0]?.scope
    if(business.operations.some(op=>op.id===id))throw failure('teloa/conflict','操作编号冲突。')
    if(!scope||refs.some(ref=>ref.scope!==scope)||!inputsCurrent(business,refs))throw failure('teloa/version-conflict','请选择同业务的当前来源版本。')
    const title=required(change.title,'操作名称',120),goal=required(change.goal,'操作目的'),parameters=required(change.parameters,'操作参数'),risk=required(change.risk,'风险与影响')
    const targets=[...new Set(change.targets.map(value=>required(value,'目标',200)))]
    if(!targets.length||targets.length>30)throw failure('teloa/invalid-input','固定目标需要 1 至 30 项。')
    const op:BusinessOperation={id,scope,title,version:1,state:'pending',inputs:refs,goal,parameters,risk,targets:targets.map(name=>({id:name,name,state:'pending',attempts:[]})),approval:newApproval('approval-'+id,{subjectVersion:1,subjectLabel:'操作提议',title,goal,object:targets.join('、'),result:parameters,evidence:refs.map(ref=>ref.title+' · '+ref.id+' v'+ref.version),risk,effect:'仅批准固定目标、参数与依据；执行与效果分别记录。'},change.now),history:[{message:localizedText('business.work.history.proposed'),at:change.now}]}
    let next={...state,business:{...business,operations:[...business.operations,op]}}
    if(change.taskId)next=changeBusinessWork(next,{type:'link-operation',operationId:id,expectedVersion:1,taskId:change.taskId,now:change.now})
    return next
  }
  const op=business.operations.find(item=>item.id===change.operationId)
  if(!op)throw failure('teloa/not-found','执行操作不存在。')
  let next=op,message:LocalizedText|undefined
  if(change.type==='decide-operation'){
    if(!op.approval||!inputsCurrent(business,op.inputs))throw failure('teloa/version-conflict','当前审批依据已失效。')
    const approval=decideApproval(op.approval,change,op.approval.snapshot.subjectVersion)
    if(op.state!=='pending')throw failure('teloa/conflict','当前状态不能审批。')
    next={...op,approval,state:change.decision};message=localizedText(`business.work.history.${change.decision}`,{note:approval.decision!.note})
  }else{
    if(op.version!==change.expectedVersion)throw failure('teloa/version-conflict','操作版本已变化，请重新核对。')
    if(change.type==='link-operation'){
      const task=state.tasks.find(item=>item.id===change.taskId)
      if(!task||task.scope!==op.scope||!task.objectRefs?.some(ref=>op.inputs.some(input=>objectKey(input)===objectKey(ref))))throw failure('teloa/version-conflict','任务与操作没有相同版本的工作项。')
      if(op.taskId&&op.taskId!==task.id)throw failure('teloa/conflict','操作已有原关联任务。')
      if(op.taskId===task.id)return state
      next={...op,taskId:task.id};message=localizedText('business.work.history.linkedTask',{title:task.title})
    }else if(change.type==='execute'){
      if(op.state==='unknown')throw failure('teloa/conflict','效果未知，先核对原操作；不能直接重试。')
      if(!['approved','partial'].includes(op.state))throw failure('teloa/conflict','当前状态不能提交执行。')
      if(!inputsCurrent(business,op.inputs))throw failure('teloa/version-conflict','执行依据已变化，请提出新操作。')
      if(op.approval?.status!=='approved'||Date.parse(op.approval.expiresAt)<=Date.parse(change.now))throw failure('teloa/conflict','审批未批准或已过期，请重新核对授权。')
      next={...op,state:'executing',targets:op.targets.map(target=>target.state==='pending'||target.state==='failed'?{...target,state:'accepted',attempts:[...target.attempts,{id:op.id+':'+target.id+':'+(target.attempts.length+1),at:change.now,receipts:[{at:change.now,message:localizedText('business.work.receipt.accepted')}]}]}:target)};message=localizedText(op.state==='partial'?'business.work.history.retryTargets':'business.work.history.execute')
    }else if(change.type==='receipt'||change.type==='reconcile'){
      if(change.type==='reconcile'&&op.state!=='unknown'||change.type==='receipt'&&op.state!=='executing')throw failure('teloa/conflict','当前状态不能核对该回执。')
      const targets=op.targets.map((target,index)=>{
        if(!['accepted','unknown'].includes(target.state))return target
        const state=change.type==='receipt'?(change.unknown?'unknown':'verified'):index===0?'verified':'failed'
        const receipt=localizedText(state==='unknown'?'business.work.receipt.interrupted':state==='failed'?'business.work.receipt.unapplied':'business.work.receipt.verified')
        return {...target,state:state as 'unknown'|'verified'|'failed',attempts:target.attempts.map((attempt,i)=>i===target.attempts.length-1?{...attempt,receipts:[...attempt.receipts,{at:change.now,message:receipt}]}:attempt)}
      })
      next={...op,targets,state:targets.some(target=>target.state==='unknown')?'unknown':targets.every(target=>target.state==='verified')?'verified':'partial'};message=localizedText(change.type==='reconcile'?'business.work.history.reconcile':'business.work.history.receipt')
    }
  }
  if(!message)throw failure('teloa/invalid-input','操作类型无效。')
  next={...next,version:op.version+1,history:[...op.history,{message,at:change.now}]}
  return {...state,business:{...business,operations:business.operations.map(item=>item.id===op.id?next:item)}}
}
