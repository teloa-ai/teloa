import type {Group,GroupAttention} from '@teloa/contract'
import type {GroupApi} from './group-api.ts'

type Snapshot={status:'idle'|'loading'|'ready'|'failed';items:readonly Group[];error?:unknown;attention?:readonly GroupAttention[]|undefined;attentionFailed?:boolean|undefined}
export type ConversationGroupDirectory=ReturnType<typeof createConversationGroupDirectory>

/** 对话目录与群详情共用的只读投影；既有 GroupApi 负责回包核验，读取失败不冒充空目录。 */
export function createConversationGroupDirectory(api:Pick<GroupApi,'list'>&Partial<Pick<GroupApi,'attention'>>){
 let snapshot:Snapshot={status:'idle',items:[]},generation=0,attentionGeneration=0
 const listeners=new Set<()=>void>()
 const publish=(next:Snapshot)=>{snapshot=next;for(const listener of listeners)listener()}
 return {
  getSnapshot:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
  async refreshAttention(){
   if(!api.attention)return
   const current=++attentionGeneration
   try{const result=await api.attention();if(current===attentionGeneration)publish({...snapshot,attention:result.items,attentionFailed:false})}
   catch{if(current===attentionGeneration)publish({...snapshot,attention:undefined,attentionFailed:true})}
  },
  async refresh(){
   const current=++generation
   const {error,...prior}=snapshot
   publish({...prior,status:'loading'})
   try{
    const directory=await api.list()
    if(current===generation){const {error,...prior}=snapshot;publish({...prior,status:'ready',items:directory.items})}
   }catch(error){if(current===generation)publish({...snapshot,status:'failed',items:[],error})}
  },
 }
}
