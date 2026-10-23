import {groupRoutingListInput,groupRoutingRetryInput,groupRoutingStatusInput,isGroupRoutingDecisionView,isGroupRoutingStatusView,type GroupRoutingDecisionView,type GroupRoutingStatusView} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
const clone=<T>(value:T):T=>structuredClone(value)
const exact=(value:unknown,keys:readonly string[],label:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error(label)
 return value as Record<string,unknown>
}

export type GroupRoutingApi=ReturnType<typeof createGroupRoutingApi>
/** 群消息行停止按钮：复用现有 TaskRun 停止链路，不新增 RPC 语义。端口由工作台用 taskRunApi.stop 接线。 */
export type GroupRoutingRunStopPort={stop:(input:{taskId:string;runId:string})=>Promise<void>}
export type GroupRunStopTarget={roleId:string;name:string;taskId:string;runId:string;phase:GroupRoutingStatusView['phase']}
/** 只有还在跑的接收者才给停止入口；已结束/待本人核对的结果列出来也不能「停止」。 */
const stoppablePhases:readonly GroupRoutingStatusView['phase'][]=['routing','queued','running','delivering','awaiting-approval']
export function groupRunStopTargets(status:GroupRoutingStatusView):GroupRunStopTarget[]{
 return status.recipients
  .filter(item=>item.taskId!==null&&item.runId!==null&&stoppablePhases.includes(item.phase))
  .map(item=>({roleId:item.roleId,name:item.name,taskId:item.taskId!,runId:item.runId!,phase:item.phase}))
}
/**
 * 路由决策与处理状态都是服务端投影，客户端只读；唯一的写口是「沿原消息重新安排」，
 * 它不发送正文、不指定决策，只请求宿主登记一次新尝试。
 */
export function createGroupRoutingApi(call:Call,runStop?:GroupRoutingRunStopPort){
 return {
  async list(groupId:string,messageIds:string[]):Promise<GroupRoutingDecisionView[]>{
   const request=groupRoutingListInput({groupId,messageIds})
   const row=exact(await call('groups/routing/list',request),['items'],'群内路由决策目录格式不正确。')
   if(!Array.isArray(row.items))throw Error('群内路由决策目录格式不正确。')
   const allowed=new Set(request.messageIds)
   const items=row.items.map(item=>{
    if(!isGroupRoutingDecisionView(item)||!allowed.has(item.messageId))throw Error('群内路由决策目录格式不正确。')
    return clone(item)
   })
   if(new Set(items.map(item=>item.messageId)).size!==items.length)throw Error('群内路由决策目录格式不正确。')
   return items
  },
  /** 本人消息的真实处理状态；服务端只回本人消息，员工消息不出状态。 */
  async status(groupId:string,messageIds:string[]):Promise<GroupRoutingStatusView[]>{
   const request=groupRoutingStatusInput({groupId,messageIds})
   const row=exact(await call('groups/routing/status',request),['items'],'群消息处理状态格式不正确。')
   if(!Array.isArray(row.items))throw Error('群消息处理状态格式不正确。')
   const allowed=new Set(request.messageIds)
   const items=row.items.map(item=>{
    if(!isGroupRoutingStatusView(item)||!allowed.has(item.messageId))throw Error('群消息处理状态格式不正确。')
    return clone(item)
   })
   if(new Set(items.map(item=>item.messageId)).size!==items.length)throw Error('群消息处理状态格式不正确。')
   return items
  },
  /** 停止本人消息上仍在运行的接收者：只按真实 taskId/runId 调既有停止链路，不重新选人、不发新正文。 */
  async stopRun(input:{taskId:string;runId:string}):Promise<void>{
   if(!runStop)throw Error('群运行停止端口未接入。')
   const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
   if(!uuid.test(input.taskId)||!uuid.test(input.runId))throw Error('停止目标身份不正确。')
   await runStop.stop({taskId:input.taskId,runId:input.runId})
  },
  /** 沿原 messageId 重新安排：同一 requestId 由宿主幂等回执兜住，回包必须对应原消息与下一尝试。 */
  async retry(input:{requestId:string;groupId:string;messageId:string;expectedAttempt:number;expectedGroupVersion:number}):Promise<{messageId:string;attemptVersion:number}>{
   const request=groupRoutingRetryInput(input)
   const row=exact(await call('groups/routing/retry',request),['messageId','attemptVersion'],'重新安排回执格式不正确。')
   if(row.messageId!==request.messageId||row.attemptVersion!==request.expectedAttempt+1)throw Error('重新安排回执与原请求不一致。')
   return {messageId:request.messageId,attemptVersion:request.expectedAttempt+1}
  },
 }
}
