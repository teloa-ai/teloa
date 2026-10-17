import {WorkError,type WorkAttentionIncomplete,type WorkAttentionItem} from '@teloa/contract'
import type {WorkAttentionApi} from './work-attention-api.js'

export type WorkAttentionDirectorySnapshot={
 items:readonly WorkAttentionItem[];loaded:boolean;loading:boolean;known:boolean;
 incomplete:readonly WorkAttentionIncomplete[];nextCursor?:string;error?:unknown
}
export const emptyWorkAttentionDirectory:WorkAttentionDirectorySnapshot={items:[],loaded:false,loading:false,known:false,incomplete:[]}

/** 已读事实和完整性分开保留；只读当前目录，不恢复或执行任何来源。 */
export function createWorkAttentionDirectory(api:WorkAttentionApi){
 let snapshot=emptyWorkAttentionDirectory,generation=0,disposed=false,pending:AbortController|undefined
 let consumedCursors=new Set<string>()
 const listeners=new Set<()=>void>(),getSnapshot=()=>snapshot
 const publish=(value:WorkAttentionDirectorySnapshot)=>{snapshot=value;for(const listener of listeners)listener()}
 const read=async(cursor?:string)=>{
  if(disposed||cursor!==undefined&&snapshot.loading)return
  pending?.abort()
  const controller=new AbortController(),requestGeneration=++generation
  pending=controller
  const current=()=>!disposed&&!controller.signal.aborted&&requestGeneration===generation
  const {error:_error,...previous}=snapshot
  publish({...previous,loading:true,known:false})
  if(!current())return
  try{
   const page=await api.list(cursor===undefined?{}:{cursor},controller.signal)
   if(!current())return
   if(page.nextCursor!==undefined&&(page.nextCursor===cursor||cursor!==undefined&&consumedCursors.has(page.nextCursor)))throw new WorkError('teloa/invalid-host-response','需要你目录返回了重复的分页游标。')
   const items=cursor===undefined?new Map<string,WorkAttentionItem>():new Map(snapshot.items.map(item=>[item.id,item]))
   for(const item of page.items)items.set(item.id,item)
   const incompleteKey=(item:WorkAttentionIncomplete)=>JSON.stringify([item.source,item.scope??null,item.reason])
   const incomplete=cursor===undefined?new Map<string,WorkAttentionIncomplete>():new Map(snapshot.incomplete.map(item=>[incompleteKey(item),item]))
   for(const item of page.incomplete)incomplete.set(incompleteKey(item),item)
   if(cursor===undefined)consumedCursors=new Set()
   else consumedCursors.add(cursor)
   pending=undefined
   publish({items:[...items.values()],loaded:true,loading:false,known:!incomplete.size&&page.nextCursor===undefined,incomplete:[...incomplete.values()],...(page.nextCursor===undefined?{}:{nextCursor:page.nextCursor})})
  }catch(error){
   if(!current())return
   pending=undefined
   publish({...snapshot,loading:false,known:false,error})
  }
 }
 return {
  getSnapshot,
  subscribe:(listener:()=>void)=>{if(disposed)return()=>{};listeners.add(listener);return()=>{listeners.delete(listener)}},
  reload:()=>read(),
  more:()=>snapshot.nextCursor===undefined?Promise.resolve():read(snapshot.nextCursor),
  dispose:()=>{if(disposed)return;disposed=true;generation++;pending?.abort();pending=undefined;listeners.clear()},
 }
}
export type WorkAttentionDirectory=ReturnType<typeof createWorkAttentionDirectory>
