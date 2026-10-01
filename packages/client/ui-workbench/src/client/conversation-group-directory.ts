import type {Group} from '@teloa/contract'
import type {GroupApi} from './group-api.ts'

type Snapshot={status:'idle'|'loading'|'ready'|'failed';items:readonly Group[];error?:unknown}
export type ConversationGroupDirectory=ReturnType<typeof createConversationGroupDirectory>

/** 对话目录与群详情共用的只读投影；既有 GroupApi 负责回包核验，读取失败不冒充空目录。 */
export function createConversationGroupDirectory(api:Pick<GroupApi,'list'>){
 let snapshot:Snapshot={status:'idle',items:[]},generation=0
 const listeners=new Set<()=>void>()
 const publish=(next:Snapshot)=>{snapshot=next;for(const listener of listeners)listener()}
 return {
  getSnapshot:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
  async refresh(){
   const current=++generation
   publish({status:'loading',items:snapshot.items})
   try{
    const directory=await api.list()
    if(current===generation)publish({status:'ready',items:directory.items})
   }catch(error){if(current===generation)publish({status:'failed',items:[],error})}
  },
 }
}
