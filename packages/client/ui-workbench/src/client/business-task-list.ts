import type {BusinessTaskListApi,BusinessTaskListItem,BusinessTaskListQuery} from './business-task-list-api.ts'

export type BusinessTaskListState={phase:'loading'|'ready'|'failed';items:BusinessTaskListItem[];nextCursor?:string;loadingMore:boolean}
/** 每个已授权 API/业务/对象拥有独立只读目录；不轮询，不保存第二份任务。 */
export class BusinessTaskListController{
 private state:BusinessTaskListState={phase:'loading',items:[],loadingMore:false}
 private listeners=new Set<()=>void>()
 private generation=0
 private abort:AbortController|undefined
 private cursors=new Set<string>()
 private readonly api:BusinessTaskListApi
 private readonly query:Omit<BusinessTaskListQuery,'cursor'>
 constructor(api:BusinessTaskListApi,query:Omit<BusinessTaskListQuery,'cursor'>){this.api=api;this.query=structuredClone(query)}
 getSnapshot=()=>this.state
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private update(state:BusinessTaskListState){this.state=state;for(const listener of this.listeners)listener()}
 dispose(){this.generation++;this.abort?.abort()}
 refresh=async()=>{this.cursors.clear();await this.load()}
 more=async()=>{if(this.state.phase==='ready'&&!this.state.loadingMore&&this.state.nextCursor)await this.load(this.state.nextCursor)}
 private async load(cursor?:string){
  const generation=++this.generation;this.abort?.abort();const abort=new AbortController();this.abort=abort
  const previous=cursor?this.state.items:[]
  this.update(cursor?{...this.state,loadingMore:true}:{phase:'loading',items:[],loadingMore:false})
  try{
   const page=await this.api.list({...this.query,...(cursor?{cursor}:{})},abort.signal)
   if(generation!==this.generation)return
   const seen=new Set(previous.map(item=>item.task.id.toLowerCase()))
   for(const item of page.items){const id=item.task.id.toLowerCase();if(seen.has(id))throw Error('重复任务页');seen.add(id)}
   if(cursor)this.cursors.add(cursor)
   if(page.nextCursor&&this.cursors.has(page.nextCursor))throw Error('重复任务游标')
   this.update({phase:'ready',items:[...previous,...page.items],...(page.nextCursor!==undefined?{nextCursor:page.nextCursor}:{}),loadingMore:false})
  }catch{if(generation===this.generation)this.update({phase:'failed',items:[],loadingMore:false})}
 }
}
