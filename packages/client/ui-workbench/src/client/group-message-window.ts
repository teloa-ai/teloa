import type {GroupMessage,GroupMessagePage,GroupMessagePageInput,GroupTopicSummary} from '@teloa/contract'
import type {GroupApi} from './group-api.ts'
type Segment={first:string;last:string;older:string|null;newer:string|null}
export type GroupMessageWindow={items:GroupMessage[];older:string|null;newer:string|null;gaps:string[];topics:GroupTopicSummary[];segments:Segment[]}
const windows=new WeakMap<GroupApi,Map<string,GroupMessageWindow>>()
const key=(groupId:string,rootId?:string)=>JSON.stringify([groupId,rootId??null])
const order=(left:GroupMessage,right:GroupMessage)=>left.createdAt.localeCompare(right.createdAt)||left.id.localeCompare(right.id)
/** 缓存已加载的连续段；搜索定位可补独立段，间隙有明确继续加载入口，不伪装成连续历史。 */
export function mergeGroupMessageWindow(previous:GroupMessageWindow|undefined,page:GroupMessagePage,request:Partial<GroupMessagePageInput>={}):GroupMessageWindow{
 const items=[...new Map([...(previous?.items??[]),...page.items].map(row=>[row.id,row])).values()].sort(order),rows=page.rootId?items.filter(row=>row.id!==page.rootId):items
 if(page.rootId){const root=items.find(row=>row.id===page.rootId);if(root)items.splice(0,items.length,root,...rows)}
 const rank=new Map(items.map((row,index)=>[row.id,index])),pageRows=page.items.filter(row=>row.id!==page.rootId),segments=(previous?.segments??[]).map(row=>({...row})),first=pageRows[0]?.id,last=pageRows.at(-1)?.id
 if(first&&last){
  const before=request.before&&rank.has(request.before)?request.before:undefined,after=request.after&&rank.has(request.after)?request.after:undefined
  segments.push({first:after??first,last:before??last,older:page.older,newer:page.newer})
 }
 segments.sort((a,b)=>rank.get(a.first)!-rank.get(b.first)!)
 const merged:Segment[]=[]
 for(const segment of segments){const prior=merged.at(-1)
  if(prior&&rank.get(segment.first)! <=rank.get(prior.last)!){
   if(rank.get(segment.first)===rank.get(prior.first))prior.older=segment.older
   if(rank.get(segment.last)! >=rank.get(prior.last)!){prior.last=segment.last;prior.newer=segment.newer}
  }else merged.push(segment)
 }
 const topics=[...new Map([...(previous?.topics??[]),...page.topics].map(row=>[row.rootId,row])).values()]
 return {items,older:merged[0]?.older??null,newer:merged.at(-1)?.newer??null,gaps:merged.slice(0,-1).map(row=>row.last),topics,segments:merged}
}
export function readGroupMessageWindow(api:GroupApi,groupId:string,rootId?:string){return windows.get(api)?.get(key(groupId,rootId))}
export async function loadGroupMessageWindow(api:GroupApi,groupId:string,rootId?:string,options:Partial<Omit<GroupMessagePageInput,'groupId'|'rootId'>>={}){
 const previous=readGroupMessageWindow(api,groupId,rootId)
 // 旧可注入端口仍可复用原夹具；正式RPC始终走有界page，失败不会退回全量list。
 if(!api.messagePage)return api.messages(groupId,rootId)
 const request={...options,...(!rootId?{topicRoots:options.topicRoots??(previous?.items??[]).filter(row=>row.rootId===null).slice(-50).map(row=>row.id)}:{})}
 const page=await api.messagePage(groupId,rootId,request),current=readGroupMessageWindow(api,groupId,rootId)
 const additions:Array<{page:GroupMessagePage;request:Partial<GroupMessagePageInput>}>=[{page,request}]
 let window=mergeGroupMessageWindow(current,page,request)
 if(!previous&&!options.before&&!options.after&&!options.around&&api.reading){
  // 水位不在尾页时补原消息附近的有界窗口，不能把未读历史直接跳成已读。
  const reading=await api.reading(groupId,rootId).catch(()=>undefined)
  if(reading?.unreadCount&&reading.cursor&&!window.items.some(row=>row.id===reading.cursor!.messageId)){
   const around={around:reading.cursor.messageId},page=await api.messagePage(groupId,rootId,around)
   additions.push({page,request:around})
   window=mergeGroupMessageWindow(window,page,around)
  }
 }
 const latest=readGroupMessageWindow(api,groupId,rootId)
 if(latest!==current)for(const [index,addition] of additions.entries())window=mergeGroupMessageWindow(index===0?latest:window,addition.page,addition.request)
 let cache=windows.get(api);if(!cache){cache=new Map();windows.set(api,cache)}cache.set(key(groupId,rootId),window)
 if(rootId&&window.topics.length){const main=cache.get(key(groupId));if(main)cache.set(key(groupId),{...main,topics:[...new Map([...main.topics,...window.topics].map(row=>[row.rootId,row])).values()]})}
 return window
}
