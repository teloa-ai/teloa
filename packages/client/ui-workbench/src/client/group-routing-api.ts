import {groupRoutingListInput,isGroupRoutingDecisionView,type GroupRoutingDecisionView} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
const clone=<T>(value:T):T=>structuredClone(value)
const exact=(value:unknown,keys:readonly string[],label:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error(label)
 return value as Record<string,unknown>
}

export type GroupRoutingApi=ReturnType<typeof createGroupRoutingApi>
/** 只读：路由决策由服务端自动产生，客户端不下发任何决策指令，只读投影。 */
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
 }
}
