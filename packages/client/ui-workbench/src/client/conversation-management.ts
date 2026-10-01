import type { Conversation } from '@teloa/contract'
import type { CopyAttempt } from './copy-recovery.js'
import type { ConversationWorkspace } from './work-presentation.js'

export interface ConversationManagementPort {
  state():{ready:boolean;baseline:boolean;archived:readonly string[];workspaces:readonly ConversationWorkspace[]}
  subscribe(listener:()=>void):()=>void
  summary(id:string):{running:boolean;blank?:boolean;title?:string;displayTitle?:string}|undefined
  rename(id:string,title:string):Promise<void>
  archive(id:string):Promise<void>
  fork(id:string):Promise<string>
  copyHistory():Promise<readonly CopyAttempt[]>
  releaseCopy(requestId:string):Promise<CopyAttempt>
  resolveCopy(requestId:string,childSessionId:string):Promise<CopyAttempt>
  ensure(id:string):Promise<Conversation>
  adopt(id:string,requestId:string,title:string):Promise<Conversation>
  move(workspaceId:string,id:string,before:string|undefined):Promise<void>
}
type Operation='rename'|'fork'|'archive'|'move'|'adopt'
/** 仅用于宿主明确在创建前拒绝的错误；传输错误仍保留结果未知。 */
export class ForkRejectedError extends Error {}
type Snapshot={copyHistory:readonly CopyAttempt[];ready:boolean;baseline:boolean;workspaces:readonly ConversationWorkspace[];archived:readonly string[];pending:Readonly<Record<string,Operation>>;copies:Readonly<Record<string,string>>;uncertain:readonly string[]}
export function managementAvailability(connection:string|undefined,sessionPhase:string,workspace:{phase:string;state:string;error:unknown}){
  return {baseline:workspace.phase==='ready',ready:connection==='connected'&&sessionPhase==='ready'&&workspace.phase==='ready'&&workspace.state==='idle'&&!workspace.error}
}

/** 使用 DSH 的标题和归档真源；只保存操作状态与尚待绑定的已知副本身份。 */
export class ConversationManagement {
  private port:ConversationManagementPort|undefined
  private historyGeneration=0
  private readonly adoptions=new Map<string,{requestId:string;title:string}>()
  private readonly rows:()=>readonly Conversation[]
  private snapshot:Snapshot={copyHistory:[],ready:false,baseline:false,workspaces:[],archived:[],pending:{},copies:{},uncertain:[]}
  private readonly listeners=new Set<()=>void>()
  constructor(rows:()=>readonly Conversation[]){this.rows=rows}
  getSnapshot=()=>this.snapshot
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}}
  private publish(patch:Partial<Snapshot>){this.snapshot={...this.snapshot,...patch};for(const listener of this.listeners)listener()}
  attach(port:ConversationManagementPort){
    this.port=port
    const sync=()=>{if(this.port===port)this.publish(port.state())}
    const off=port.subscribe(sync);sync()
    return ()=>{off();if(this.port===port){this.port=undefined;this.publish({ready:false})}}
  }
  private begin(id:string,operation:Operation){
    const port=this.port
    if(!port||!port.state().ready)throw Error('原生会话管理正在连接，请稍后重试。')
    const row=this.rows().find(row=>row.sessionId===id)
    if(!row)throw Error('目标不在本人工作目录中。')
    if(row.status!=='ready')throw Error('工作绑定尚未完成，请先恢复原会话。')
    if(port.state().archived.includes(id))throw Error('会话已归档。')
    if(this.snapshot.pending[id])throw Error('这个会话正在处理上一项操作。')
    const summary=port.summary(id)
    if(!summary)throw Error('原生会话尚未同步，请刷新后重试。')
    if(operation==='fork'&&summary.blank)throw new ForkRejectedError('会话尚未完成任何回复，暂时不能创建副本。')
    if(operation==='archive'&&summary.running)throw Error('会话仍在运行，请待工作结束后归档。')
    this.publish({pending:{...this.snapshot.pending,[id]:operation}})
    return port
  }
  private finish(id:string){const pending={...this.snapshot.pending};delete pending[id];this.publish({pending})}
  async adopt(id:string,fallbackTitle:string):Promise<Conversation>{
    const port=this.port
    if(!port||!port.state().ready)throw Error('原生会话正在连接，请稍后重试。')
    if(port.state().archived.includes(id))throw Error('会话已归档，不能加入工作目录。')
    if(this.snapshot.pending[id])throw Error('这个会话正在处理上一项操作。')
    const summary=port.summary(id)
    if(!summary)throw Error('原生会话尚未同步，请刷新后重试。')
    const existing=this.rows().find(row=>row.sessionId===id)
    if(existing?.status==='pending')throw Error('会话正在创建，请恢复原请求。')
    if(existing?.status==='ready')return existing
    const title=summary.title?.trim()||summary.displayTitle?.trim()||fallbackTitle.trim()
    if(!title)throw Error('会话名称不可为空。')
    const request=this.adoptions.get(id)??{requestId:crypto.randomUUID(),title:title.slice(0,200)}
    this.adoptions.set(id,request)
    this.publish({pending:{...this.snapshot.pending,[id]:'adopt'}})
    try{
      const result=await port.adopt(id,request.requestId,request.title)
      if(result.sessionId!==id||result.status!=='ready')throw Error('接入返回的会话身份或状态不一致。')
      this.adoptions.delete(id)
      return result
    }finally{this.finish(id)}
  }
  async rename(id:string,value:string){
    const title=value.trim()
    if(!title||title.length>200)throw Error('会话名称需为 1～200 个字符。')
    const port=this.begin(id,'rename')
    try{await port.rename(id,title)}finally{this.finish(id)}
  }
  async archive(id:string){
    const port=this.begin(id,'archive')
    try{await port.archive(id)}finally{this.finish(id)}
  }
  async refreshCopyHistory():Promise<void>{
    const port=this.port
    if(!port||!port.state().ready)throw Error('原生会话管理正在连接，请稍后重试。')
    const generation=++this.historyGeneration
    const history=await port.copyHistory()
    if(this.port!==port||generation!==this.historyGeneration)return
    this.publish({copyHistory:history,uncertain:history.filter(row=>row.state==='pending'&&!row.releasedAt).map(row=>row.sourceSessionId)})
  }
  async releaseCopy(source:string,requestId:string):Promise<void>{
    const port=this.begin(source,'fork')
    try{
      const attempt=this.snapshot.copyHistory.find(row=>row.requestId===requestId&&row.sourceSessionId===source)
      if(!attempt||attempt.state!=='pending')throw Error('副本记录已变化，请刷新后核对。')
      const result=await port.releaseCopy(requestId)
      if(result.requestId!==requestId||result.sourceSessionId!==source||result.state!=='pending'||!result.releasedAt)throw Error('返回的副本确认记录不一致。')
      await this.refreshCopyHistory()
    }finally{this.finish(source)}
  }
  async recoverCopy(source:string,requestId:string,child:string):Promise<Conversation>{
    const port=this.begin(source,'fork')
    try{
      const attempt=this.snapshot.copyHistory.find(row=>row.requestId===requestId&&row.sourceSessionId===source)
      if(!attempt)throw Error('副本恢复记录已变化，请刷新后核对。')
      const result=await port.resolveCopy(requestId,child)
      if(result.sourceSessionId!==source||result.requestId!==requestId||result.state!=='ready'||result.childSessionId!==child)throw Error('副本恢复返回的身份不一致。')
      const conversation=await port.ensure(child)
      if(conversation.sessionId!==child||conversation.status!=='ready')throw Error('副本工作绑定身份不一致。')
      await this.refreshCopyHistory()
      return conversation
    }finally{this.finish(source)}
  }
  async fork(id:string):Promise<Conversation>{
    if(this.snapshot.uncertain.includes(id))throw Error('上次创建结果未确认，请先核对会话记录，不要重复创建。')
    const port=this.begin(id,'fork')
    try{
      let child=this.snapshot.copies[id]
      if(!child){
        try{child=await port.fork(id)}catch(error){
          if(error instanceof ForkRejectedError)throw error
          this.publish({uncertain:[...this.snapshot.uncertain,id]})
          throw Object.assign(Error('副本创建结果未确认，请先核对会话记录。'),{code:'teloa/conflict'})
        }
        this.publish({copies:{...this.snapshot.copies,[id]:child}})
      }
      const conversation=await port.ensure(child)
      if(conversation.sessionId!==child||conversation.status!=='ready')throw Error('副本的工作绑定身份不一致，未打开会话。')
      return conversation
    }finally{this.finish(id)}
  }
  async move(id:string,workspaceId:string,direction:'up'|'down',expected:readonly string[]):Promise<void>{
    if(Object.values(this.snapshot.pending).includes('move'))throw Error('正在保存会话顺序，请稍后重试。')
    const port=this.begin(id,'move')
    try{
      const native=port.state(),workspace=native.workspaces.find(row=>row.workspaceId===workspaceId)
      if(!workspace||!workspace.sessionIds.includes(id))throw Error('会话已不在所选工作区，请查看最新目录。')
      const allowed=new Set(this.rows().filter(row=>row.status==='ready'&&!native.archived.includes(row.sessionId)).map(row=>row.sessionId))
      const order=workspace.sessionIds.filter(id=>allowed.has(id))
      if(order.length!==expected.length||order.some((value,index)=>value!==expected[index]))throw Error('会话顺序或成员已变化，请核对最新目录后重试。')
      const index=order.indexOf(id)
      if(direction==='up'&&index===0||direction==='down'&&index===order.length-1)return
      const before=direction==='up'?order[index-1]:order[index+2]
      await port.move(workspaceId,id,before)
    }finally{this.finish(id)}
  }
  acknowledgeCopy(id:string,child:string){
    if(this.snapshot.copies[id]!==child||this.snapshot.pending[id])return
    const copies={...this.snapshot.copies};delete copies[id];this.publish({copies})
  }
}
