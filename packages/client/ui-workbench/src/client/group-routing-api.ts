import {groupRoutingListInput,groupRoutingRetryInput,groupRoutingStatusInput,isGroupRoutingDecisionView,isGroupRoutingStatusView,type GroupRoutingDecisionView,type GroupRoutingStatusView} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
const clone=<T>(value:T):T=>structuredClone(value)
const exact=(value:unknown,keys:readonly string[],label:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error(label)
 return value as Record<string,unknown>
}

export type GroupRoutingApi=ReturnType<typeof createGroupRoutingApi>
/**
 * 路由决策与处理状态都是服务端投影，客户端只读；唯一的写口是「沿原消息重新安排」，
 * 它不发送正文、不指定决策，只请求宿主登记一次新尝试。
 */
export function createGroupRoutingApi(call:Call){
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
  /** 沿原 messageId 重新安排：同一 requestId 由宿主幂等回执兜住，回包必须对应原消息与下一尝试。 */
  async retry(input:{requestId:string;groupId:string;messageId:string;expectedAttempt:number;expectedGroupVersion:number}):Promise<{messageId:string;attemptVersion:number}>{
   const request=groupRoutingRetryInput(input)
   const row=exact(await call('groups/routing/retry',request),['messageId','attemptVersion'],'重新安排回执格式不正确。')
   if(row.messageId!==request.messageId||row.attemptVersion!==request.expectedAttempt+1)throw Error('重新安排回执与原请求不一致。')
   return {messageId:request.messageId,attemptVersion:request.expectedAttempt+1}
  },
 }
}
