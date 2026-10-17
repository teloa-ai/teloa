import type { CapabilitySnapshot, Conversation } from '@teloa/contract'
export type BindingState={sessionId:string|undefined;status:'idle'|'loading'|'ready'|'failed';conversation:Conversation|undefined;error:string|undefined;capabilities:CapabilitySnapshot|undefined;catalogStatus:'idle'|'loading'|'ready'|'failed';catalogError:string|undefined}
// roleId 只进「同一 requestId 不能改投另一项工作」的请求指纹（服务端按落盘的 requestedRoleId 比对）；
// 回包 Conversation 零新键，客户端读不回它，因此恢复路径重建请求时无从补上（见 T14 报告疑虑）。
export type ConversationCreation=Readonly<{requestId:string;title?:string;workspaceId?:string;roleId?:string}>
export type CreateConversationOptions=Readonly<{requestId?:string;title?:string;workspaceId?:string;roleId?:string;beforeOpen?:(conversation:Conversation)=>Promise<void>;mayOpen?:()=>boolean}>
/** opened 表示守卫通过并已派发原生打开，不依赖随后到达的选中投影。 */
export type ConversationOpenResult='opened'|'cancelled'
const taskRunInputBlock='工作会话正在由任务执行编排，请从原任务恢复。'
export interface WorkPort {
  list(signal?:AbortSignal):Promise<Conversation[]>
  read(sessionId:string):Promise<Conversation>
  ensure(sessionId:string):Promise<Conversation>
  /** 选中恢复时可借用已核验的专用预约；普通会话仍委派 ensure。 */
  selectBinding?(sessionId:string):Promise<Conversation>
  /** 只读核对已有原生运行目录，不创建或领养普通会话。 */
  readRunSession?(sessionId:string):Promise<string>
  isNativeChild(sessionId:string):boolean
  homeSkills?(signal?:AbortSignal):Promise<CapabilitySnapshot['skills']>
  catalog(sessionId:string):Promise<CapabilitySnapshot>
  block(sessionId:string,reason:string|undefined):void
  create(input:ConversationCreation&Readonly<{title?:string}>):Promise<Conversation>
  assistant?(input:Readonly<{workspaceId?:string}>):Promise<Conversation>
  adopt(sessionId:string,workspaceId?:string):Promise<string>
  open(sessionId:string):void
  current():string|undefined
}
export class BindingClient {
  private readonly port:WorkPort
  private state:BindingState={sessionId:undefined,status:'idle',conversation:undefined,error:undefined,capabilities:undefined,catalogStatus:'idle',catalogError:undefined}
  private listeners=new Set<()=>void>()
  private generation=0
  private catalogGeneration=0
  private creation:ConversationCreation|undefined
  private creating:Promise<Conversation>|undefined
  private assisting:Promise<{conversation:Conversation;result:ConversationOpenResult}>|undefined
  private opening=0
  private releaseOpeningBlock:(()=>void)|undefined
  private listing=0
  private directory:{status:'idle'|'loading'|'ready'|'failed';rows:Conversation[];error:unknown|undefined}={status:'idle',rows:[],error:undefined}
  constructor(port:WorkPort) {this.port=port}
  getSnapshot=():BindingState=>this.state
  getDirectorySnapshot=()=>this.directory
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}}
  private publish(patch:Partial<BindingState>) {this.state={...this.state,...patch};for(const listener of this.listeners)listener()}
  private assertCreationResult(conversation:Conversation,creation:ConversationCreation):void {
    if(conversation.requestId!==creation.requestId)throw Error('创建结果请求身份不一致，已停止原生会话领养。')
    if(creation.title!==undefined&&conversation.title!==creation.title)throw Error('创建结果标题不一致，已停止原生会话领养。')
    if(conversation.requestedWorkspaceId!==creation.workspaceId)throw Error('创建结果工作区身份不一致，已停止原生会话领养。')
  }
  async select(sessionId:string|undefined):Promise<void> {
    const nativeChild=sessionId!==undefined&&this.port.isNativeChild(sessionId)
    if(!nativeChild&&sessionId&&this.state.sessionId===sessionId&&this.state.status==='ready'&&this.state.conversation?.sessionId===sessionId){
      this.port.block(sessionId,this.state.conversation.purpose==='task-run'?taskRunInputBlock:undefined)
      return
    }
    const generation=++this.generation;this.catalogGeneration++
    // 原生子会话没有普通业务绑定；历史与继续权限仍由 DSH 的直接父会话地址管理。
    if(sessionId)this.port.block(sessionId,nativeChild?undefined:'正在确认工作会话绑定…')
    this.publish({sessionId,status:sessionId&&!nativeChild?'loading':'idle',conversation:undefined,error:undefined,capabilities:undefined,catalogStatus:'idle',catalogError:undefined})
    if(!sessionId||nativeChild)return
    try {
      const conversation=await (this.port.selectBinding?.(sessionId)??this.port.ensure(sessionId))
      if(generation!==this.generation)return
      if(conversation.sessionId!==sessionId||conversation.status!=='ready')throw Error('返回的工作会话绑定与当前会话不一致。')
      this.publish({status:'ready',conversation});this.port.block(sessionId,conversation.purpose==='task-run'?taskRunInputBlock:undefined)
    }catch(error){
      if(generation!==this.generation)return
      const reason=error instanceof Error?error.message:'工作会话绑定读取失败。'
      this.port.block(sessionId,reason);this.publish({status:'failed',error:reason})
    }
  }
  retry=()=>this.select(this.state.sessionId)
  async refreshDirectory(signal?:AbortSignal):Promise<void> {
    if(signal?.aborted)return
    const listing=++this.listing
    this.directory={...this.directory,status:'loading',error:undefined};this.publish({})
    try {const rows=await this.port.list(signal);if(listing===this.listing&&!signal?.aborted){this.directory={status:'ready',rows,error:undefined};this.publish({})}}
    catch(error){if(listing===this.listing&&!signal?.aborted){this.directory={...this.directory,status:'failed',error};this.publish({})}}
  }
  async openSession(sessionId:string,signal?:AbortSignal,mayOpen?:()=>boolean):Promise<void> {
    await this.openSessionResult(sessionId,signal,mayOpen)
  }
  /** 只有本次已派发原生打开才回执 opened；当前同 ID 不能证明未取消的导航。 */
  async openSessionResult(sessionId:string,signal?:AbortSignal,mayOpen?:()=>boolean):Promise<ConversationOpenResult> {
    // 新入口使旧导航失效时，先撤下旧导航自己的临时阻断；read 未完成也不能遗留它。
    this.releaseOpeningBlock?.()
    const navigation={opening:++this.opening,generation:this.generation,previous:this.port.current(),mayOpen}
    const valid=()=>!signal?.aborted&&this.opening===navigation.opening&&this.generation===navigation.generation&&this.port.current()===navigation.previous&&mayOpen?.()!==false
    if(!valid())return 'cancelled'
    const conversation=await this.port.read(sessionId)
    if(!valid())return 'cancelled'
    if(conversation.sessionId!==sessionId||conversation.status!=='ready')throw Error('返回的工作会话绑定与目标会话不一致。')
    const previous=this.state
    const commit=()=>{
      this.publish({sessionId,status:'ready',conversation,error:undefined,capabilities:undefined,catalogStatus:'idle',catalogError:undefined})
      this.port.block(sessionId,conversation.purpose==='task-run'?taskRunInputBlock:undefined)
    }
    try {return await this.openResolvedConversation(conversation,signal,true,{...navigation,commit})}
    catch(error){
      if(this.generation===navigation.generation&&this.opening===navigation.opening&&this.port.current()===navigation.previous&&this.state.sessionId===sessionId&&this.state.conversation===conversation)this.publish(previous)
      throw error
    }
  }
  async openConversation(conversation:Conversation,signal?:AbortSignal):Promise<ConversationOpenResult> {
    return this.openResolvedConversation(conversation,signal,false)
  }
  private async openResolvedConversation(conversation:Conversation,signal:AbortSignal|undefined,resolved:boolean,navigation?:{opening:number;generation:number;previous:string|undefined;mayOpen:(()=>boolean)|undefined;commit:()=>void}):Promise<ConversationOpenResult> {
    if(signal?.aborted)return 'cancelled'
    const opening=navigation?.opening??++this.opening,previous=navigation?navigation.previous:this.port.current(),generation=navigation?.generation??this.generation
    if(navigation&&(opening!==this.opening||generation!==this.generation||this.port.current()!==previous||navigation.mayOpen?.()===false))return 'cancelled'
    if(previous)this.port.block(previous,'正在打开目标工作会话…')
    const restore=()=>{
      if(this.releaseOpeningBlock!==restore)return
      this.releaseOpeningBlock=undefined
      if(opening!==this.opening||generation!==this.generation||this.port.current()!==previous||!previous)return
      const ready=this.state.sessionId===previous&&this.state.status==='ready'
      this.port.block(previous,this.port.isNativeChild(previous)?undefined:ready?this.state.conversation?.purpose==='task-run'?taskRunInputBlock:undefined:this.state.error??'正在确认工作会话绑定…')
    }
    this.releaseOpeningBlock=restore
    const cancel=()=>{
      if(opening!==this.opening||generation!==this.generation||this.port.current()!==previous)return
      restore()
      ++this.opening
    }
    signal?.addEventListener('abort',cancel,{once:true})
    try {
      const creation=conversation.status==='pending'&&conversation.requestId?{requestId:conversation.requestId,title:conversation.title,...(conversation.requestedWorkspaceId===undefined?{}:{workspaceId:conversation.requestedWorkspaceId})}:undefined
      const target=resolved?conversation:conversation.purpose==='task-run'?await this.port.read(conversation.sessionId):creation?conversation.purpose==='assistant'
        ?await (this.port.assistant?.({... (conversation.requestedWorkspaceId===undefined?{}:{workspaceId:conversation.requestedWorkspaceId})})??Promise.reject(Error('助手身份服务尚未接入。')))
        :await this.port.create({...creation,title:conversation.title}):await this.port.ensure(conversation.sessionId)
      if(creation&&conversation.purpose==='assistant'&&(target.purpose!=='assistant'||target.status!=='ready'||target.sessionId!==conversation.sessionId))throw Error('助手恢复回执与原预约不一致。')
      const recovery=creation??(this.creation?.requestId===target.requestId?this.creation:undefined)
      if(recovery)this.assertCreationResult(target,recovery)
      const sessionId=target.purpose==='task-run'?await (this.port.readRunSession?.(target.sessionId)??Promise.reject(Error('运行专用会话只读目录尚未接入。'))):await this.port.adopt(target.sessionId,target.requestedWorkspaceId)
      if(sessionId!==target.sessionId)throw Error('原生会话领养身份不一致。')
      if(recovery&&this.creation?.requestId===recovery.requestId)this.creation=undefined
      if(signal?.aborted||opening!==this.opening||generation!==this.generation||navigation&&(this.port.current()!==previous||navigation.mayOpen?.()===false))return 'cancelled'
      navigation?.commit()
      this.port.open(sessionId)
      void this.refreshDirectory()
      return 'opened'
    }finally{
      signal?.removeEventListener('abort',cancel)
      restore()
    }
  }
  async readHomeSkills(signal?:AbortSignal):Promise<CapabilitySnapshot['skills']>{if(!this.port.homeSkills)throw Error('首页技能目录暂不可用。');return this.port.homeSkills(signal)}
  async readCatalog():Promise<void> {
    const {sessionId,conversation}=this.state
    if(!sessionId||this.state.status!=='ready'||!conversation)return
    const generation=++this.catalogGeneration
    this.publish({catalogStatus:'loading',catalogError:undefined,capabilities:undefined})
    try {
      const capabilities=await this.port.catalog(sessionId)
      if(generation!==this.catalogGeneration)return
      if(capabilities.conversation.sessionId!==sessionId||capabilities.conversation.id!==conversation.id||capabilities.conversation.version!==conversation.version)throw Error('能力目录与当前工作绑定不一致，请重新确认绑定。')
      this.publish({catalogStatus:'ready',capabilities})
    }catch(error){if(generation===this.catalogGeneration)this.publish({catalogStatus:'failed',catalogError:error instanceof Error?error.message:'能力目录读取失败。'})}
  }
  getPendingCreation=():ConversationCreation|undefined=>this.creation&&{...this.creation}
  /** 仅解除本地重试锁；服务端原尝试保留，不能把未知结果当成取消。 */
  releaseCreationForNewWork(expectedRequestId:string):void {
    if(this.creating)throw Error('正在创建，请等待本次请求结束后再另建工作。')
    if(!this.creation||this.creation.requestId!==expectedRequestId)throw Error('创建请求已变化，请重新核对。')
    this.creation=undefined
    this.publish({})
    void this.refreshDirectory()
  }
  /** 默认主聊由服务端预约；无论浏览器请求身份如何都只领养原助手。 */
  createAssistant(options:Pick<CreateConversationOptions,'workspaceId'|'beforeOpen'|'mayOpen'>={}):Promise<Conversation>{
    return this.createAssistantResult(options).then(value=>value.conversation)
  }
  createAssistantResult(options:Pick<CreateConversationOptions,'workspaceId'|'beforeOpen'|'mayOpen'>={}):Promise<{conversation:Conversation;result:ConversationOpenResult}>{
    if(!this.port.assistant)return Promise.reject(Error('助手身份服务尚未接入。'))
    if(this.assisting)return this.assisting
    this.releaseOpeningBlock?.()
    let previousState:BindingState|undefined,committed:Conversation|undefined
    const previous=this.port.current(),generation=this.generation,opening=++this.opening
    const operation=(async()=>{try{
      const row=await this.port.assistant!({... (options.workspaceId===undefined?{}:{workspaceId:options.workspaceId})})
      if(row.purpose!=='assistant'||row.status!=='ready')throw Error('助手身份回执不正确，未打开其他会话。')
      const sessionId=await this.port.adopt(row.sessionId,row.requestedWorkspaceId)
      if(sessionId!==row.sessionId)throw Error('助手原生领养身份不一致。')
      await options.beforeOpen?.(row)
      const opened=this.port.current()===previous&&this.generation===generation&&this.opening===opening&&options.mayOpen?.()!==false
      if(opened){
        previousState=this.state;committed=row
        this.publish({sessionId,status:'ready',conversation:row,error:undefined,capabilities:undefined,catalogStatus:'idle',catalogError:undefined})
        this.port.block(sessionId,undefined);this.port.open(sessionId)
      }
      void this.refreshDirectory()
      return {conversation:row,result:opened?'opened' as const:'cancelled' as const}
    }catch(error){
      if(previousState&&this.port.current()===previous&&this.generation===generation&&this.opening===opening&&this.state.conversation===committed)this.publish(previousState)
      throw error
    }})()
    this.assisting=operation
    void operation.then(()=>{this.assisting=undefined},()=>{this.assisting=undefined})
    return operation
  }
  create(options:CreateConversationOptions={}):Promise<Conversation> {
    const title=options.title===undefined?undefined:options.title.trim()
    if(options.requestId!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.requestId)||options.title!==undefined&&(!title||options.title.length>200))return Promise.reject(Error('创建请求身份或标题不合法。'))
    if(this.creation&&(options.requestId!==undefined&&this.creation.requestId!==options.requestId||this.creation.title!==title))return Promise.reject(Error('上次创建仍待恢复，请按原请求身份与标题重试。'))

    // 待恢复的创建请求只能原样重试：工作区与岗位都得对上。roleId 决定服务端拿哪个岗位预设起会话，
    // 换岗位重试会在服务端撞 requestedRoleId 比对判 teloa/conflict，本地先拦住并说清是哪一项变了。
    if(this.creation&&(this.creation.workspaceId!==options.workspaceId||this.creation.roleId!==options.roleId))return Promise.reject(Error(this.creation.roleId!==options.roleId?'上次创建仍待恢复，请按原员工重试；不能把同一创建请求改投其他员工。':'上次创建仍待恢复，请在原工作区重试；不能把同一请求改投其他工作区。'))
    if(this.creating)return this.creating
    const creation=this.creation??={requestId:options.requestId??crypto.randomUUID(),...(title===undefined?{}:{title}),...(options.workspaceId===undefined?{}:{workspaceId:options.workspaceId}),...(options.roleId===undefined?{}:{roleId:options.roleId})}
    const previous=this.port.current(),generation=this.generation,opening=++this.opening
    const operation=(async()=>{try{
      const conversation=await this.port.create(creation)
      this.assertCreationResult(conversation,creation)
      const sessionId=await this.port.adopt(conversation.sessionId,conversation.requestedWorkspaceId)
      if(sessionId!==conversation.sessionId)throw Error('原生会话领养返回了不同身份，已停止切换。')
      await options.beforeOpen?.(conversation)
      this.creation=undefined
      if(this.port.current()===previous&&this.generation===generation&&this.opening===opening&&options.mayOpen?.()!==false)this.port.open(sessionId)
      void this.refreshDirectory()
      return conversation
    }catch(error){
      if(this.opening===opening&&this.generation===generation&&this.port.current()===previous)await this.select(previous)
      throw error
    }
    })()
    this.creating=operation
    void operation.then(()=>{this.creating=undefined},()=>{this.creating=undefined})
    return operation
  }
}
