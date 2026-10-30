import type {Group,GroupAttention} from '@teloa/contract'
import type {GroupApi} from './group-api.ts'

type Snapshot={status:'idle'|'loading'|'ready'|'failed';items:readonly Group[];error?:unknown;attention?:readonly GroupAttention[]|undefined;attentionFailed?:boolean|undefined}
export type ConversationGroupDirectory=ReturnType<typeof createConversationGroupDirectory>

/** 对话目录与群详情共用的只读投影；既有 GroupApi 负责回包核验，读取失败不冒充空目录。 */
export function createConversationGroupDirectory(api:Pick<GroupApi,'list'>&Partial<Pick<GroupApi,'attention'>>){
 let snapshot:Snapshot={status:'idle',items:[]},generation=0,attentionGeneration=0,lastLoaded=0
 let loading:Promise<void>|undefined,attentionLoading:Promise<void>|undefined
 const listeners=new Set<()=>void>()
 const publish=(next:Snapshot)=>{snapshot=next;for(const listener of listeners)listener()}
 const directory={
  getSnapshot:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
  refreshAttention():Promise<void>{
   if(!api.attention)return Promise.resolve()
   const current=++attentionGeneration
   const operation=(async()=>{
    try{const result=await api.attention!();if(current===attentionGeneration)publish({...snapshot,attention:result.items,attentionFailed:false})}
    catch{if(current===attentionGeneration)publish({...snapshot,attention:undefined,attentionFailed:true})}
   })()
   attentionLoading=operation
   const clear=()=>{if(attentionLoading===operation)attentionLoading=undefined}
   void operation.then(clear,clear)
   return operation
  },
  ensureAttention():Promise<void>{
   return attentionLoading??directory.refreshAttention()
  },
  ensureLoaded():Promise<void>{
   if(loading)return loading
   if(snapshot.status==='ready'&&Date.now()-lastLoaded<30_000)return Promise.resolve()
   return directory.refresh()
  },
  refresh():Promise<void>{
   const current=++generation
   const {error,...prior}=snapshot
   publish({...prior,status:'loading'})
   const operation=(async()=>{
    try{
     const directory=await api.list()
     if(current===generation){const {error,...prior}=snapshot;lastLoaded=Date.now();publish({...prior,status:'ready',items:directory.items})}
    }catch(error){if(current===generation)publish({...snapshot,status:'failed',items:[],error})}
   })()
   loading=operation
   const clear=()=>{if(loading===operation)loading=undefined}
   void operation.then(clear,clear)
   return operation
  },
 }
 return directory
}
