import {WorkError,groupChangeInput,groupCreateInput,groupListInput,groupMessageListInput,groupReactionListInput,groupReactionToggleInput,groupResourceGetInput,groupResourceListInput,groupResourceSaveInput,groupResourceWithdrawInput,groupRoutingListInput,groupSendInput} from '@teloa/contract'

export const groupEndpoints=['groups/list','groups/get','groups/create','groups/change','groups/messages/list','groups/messages/send','groups/resources/list','groups/resources/get','groups/resources/save','groups/resources/withdraw','groups/reactions/list','groups/reactions/toggle','groups/routing/list'] as const

type GroupOperations={
  list:(owner:string,input:unknown)=>Promise<unknown>
  get:(owner:string,input:unknown)=>Promise<unknown>
  create:(owner:string,input:unknown)=>Promise<unknown>
  change:(owner:string,input:unknown)=>Promise<unknown>
  messages:(owner:string,input:unknown)=>Promise<unknown>
  send:(owner:string,input:unknown)=>Promise<unknown>
  resources:(owner:string,input:unknown)=>Promise<unknown>
  resource:(owner:string,input:unknown)=>Promise<unknown>
  saveResource:(owner:string,input:unknown)=>Promise<unknown>
  withdrawResource:(owner:string,input:unknown)=>Promise<unknown>
  /** 表情与路由决策不在 `CollaborationService` 上：提供方是 index.ts 里的组合对象。 */
  reactions:(owner:string,input:unknown)=>Promise<unknown>
  toggleReaction:(owner:string,input:unknown)=>Promise<unknown>
  routing:(owner:string,input:unknown)=>Promise<unknown>
}

function groupGetInput(input:unknown):void{
  const request=groupMessageListInput(input)
  if(request.rootId!==undefined)throw new WorkError('teloa/invalid-input','群详情不接受消息根记录。')
}

/** 群协作只由认证后的工作台 RPC 调用；本人身份由宿主固定。 */
export function createGroupHandler(owner:string,get:()=>Promise<GroupOperations|undefined>,admitText:(text:string)=>void){
  return async(endpoint:string,payload:unknown)=>{
    if(!(groupEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此群协作接口。')
    if(endpoint==='groups/list')groupListInput(payload)
    else if(endpoint==='groups/get')groupGetInput(payload)
    else if(endpoint==='groups/create')groupCreateInput(payload)
    else if(endpoint==='groups/change')groupChangeInput(payload)
    else if(endpoint==='groups/messages/list')groupMessageListInput(payload)
    else if(endpoint==='groups/messages/send')admitText(groupSendInput(payload).text)
    else if(endpoint==='groups/resources/list')groupResourceListInput(payload)
    else if(endpoint==='groups/resources/get')groupResourceGetInput(payload)
    else if(endpoint==='groups/resources/save')groupResourceSaveInput(payload)
    else if(endpoint==='groups/resources/withdraw')groupResourceWithdrawInput(payload)
    else if(endpoint==='groups/reactions/list')groupReactionListInput(payload)
    else if(endpoint==='groups/reactions/toggle')groupReactionToggleInput(payload)
    else groupRoutingListInput(payload)
    const service=await get()
    if(!service)throw new WorkError('teloa/host-unavailable','群协作服务尚未就绪。')
    if(endpoint==='groups/list')return service.list(owner,payload)
    if(endpoint==='groups/get')return service.get(owner,payload)
    if(endpoint==='groups/create')return service.create(owner,payload)
    if(endpoint==='groups/change')return service.change(owner,payload)
    if(endpoint==='groups/messages/list')return service.messages(owner,payload)
    if(endpoint==='groups/messages/send')return service.send(owner,payload)
    if(endpoint==='groups/resources/list')return service.resources(owner,payload)
    if(endpoint==='groups/resources/get')return service.resource(owner,payload)
    if(endpoint==='groups/resources/save')return service.saveResource(owner,payload)
    if(endpoint==='groups/resources/withdraw')return service.withdrawResource(owner,payload)
    if(endpoint==='groups/reactions/list')return service.reactions(owner,payload)
    if(endpoint==='groups/reactions/toggle')return service.toggleReaction(owner,payload)
    return service.routing(owner,payload)
  }
}
