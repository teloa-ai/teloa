export type ContentHit={sessionId:string;snippet:string}
export type ContentResult={items:readonly ContentHit[];hasMore:boolean}
export type SearchSnapshot={query:string;status:'idle'|'loading'|'ready'|'failed';items:readonly ContentHit[];hasMore:boolean;error?:string}
export function searchPhase(query:string,available:boolean,state:SearchSnapshot):'idle'|'waiting'|'loading'|'ready'|'failed'{
  if(!query.trim())return 'idle'
  if(!available)return 'waiting'
  if(state.query!==query.trim()||state.status==='loading'||state.status==='idle')return 'loading'
  return state.status==='failed'?'failed':'ready'
}
/** 搜索结果只作为当前查询的摘要；会话标题、状态、绑定仍由原目录提供。 */
export class ConversationSearch {
  private readonly read:(query:string,signal:AbortSignal)=>Promise<ContentResult>
  private readonly allowed:()=>readonly string[]
  private snapshot:SearchSnapshot={query:'',status:'idle',items:[],hasMore:false}
  private pending:AbortController|undefined
  private readonly listeners=new Set<()=>void>()
  constructor(read:(query:string,signal:AbortSignal)=>Promise<ContentResult>,allowed:()=>readonly string[]){this.read=read;this.allowed=allowed}
  getSnapshot=()=>this.snapshot
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}}
  private publish(value:SearchSnapshot){this.snapshot=value;for(const listener of this.listeners)listener()}
  async run(input:string):Promise<void>{
    const query=input.trim()
    this.pending?.abort()
    if(!query){this.clear();return}
    const request=new AbortController();this.pending=request
    this.publish({query,status:'loading',items:[],hasMore:false})
    try{
      const result=await this.read(query,request.signal)
      if(request.signal.aborted||this.pending!==request)return
      const allowed=new Set(this.allowed())
      this.publish({query,status:'ready',items:result.items.filter(item=>allowed.has(item.sessionId)),hasMore:result.hasMore})
    }catch(error){
      if(request.signal.aborted||this.pending!==request)return
      this.publish({query,status:'failed',items:[],hasMore:false,error:error instanceof Error?error.message:'正文搜索暂不可用。'})
    }finally{if(this.pending===request)this.pending=undefined}
  }
  clear(){this.pending?.abort();this.pending=undefined;this.publish({query:'',status:'idle',items:[],hasMore:false})}
}
