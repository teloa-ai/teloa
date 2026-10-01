import {WorkError,isRecord,readBusinessConversationReserve,readBusinessConversationBinding,readBusinessConversationSession,type BusinessConversationBinding,type BusinessConversationReserve} from '@teloa/contract'
import type {BindingClient} from './binding-client.ts'
import type {BusinessBuilderApi} from './business-builder-api.ts'
import {checkBusinessBuilderSwitch,switchDecision,type BusinessBuilderSwitchPort,type BusinessBuilderSwitchSnapshot} from './business-builder-flow.ts'
import {createHomeContextApi} from './home-native-controller.ts'
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>
type DailyRequest=BusinessConversationReserve&{kind:'daily';scope:string}
type DailyApproval=BusinessBuilderSwitchSnapshot&{allowDraft:boolean}
type ContextCall=(endpoint:string,input:unknown)=>Promise<unknown>
const conflict=(message:string)=>new WorkError('teloa/conflict',message)
const changed=(message:string)=>new WorkError('teloa/conflict',message,{reason:'changed'})
const invalid=()=>new WorkError('teloa/invalid-host-response','日常会话返回的业务或固定身份不一致。')
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
/** personal-space UUID 同时标识当前数据库与本人；没有认证身份时不得退回全局key。 */
export function businessDailyStorageKeys(personalSpaceId:string){
 if(!uuid(personalSpaceId))throw conflict('日常会话存储身份尚未确认。')
 const prefix='teloa.business-daily/v1/'+personalSpaceId.toLowerCase()
 return {intent:prefix+'/intent',context:(requestId:string)=>{if(!uuid(requestId))throw conflict('日常会话请求标识不合法。');return prefix+'/context/'+requestId}}
}
function daily(value:unknown):DailyRequest{
 const request=readBusinessConversationReserve(value)
 if(request.kind!=='daily'||!request.scope)throw conflict('日常会话恢复记录身份不正确。')
 return request as DailyRequest
}
const requestOf=(binding:BusinessConversationBinding)=>daily({requestId:binding.requestId,kind:binding.kind,title:binding.title,...(binding.scope===undefined?{}:{scope:binding.scope}),...(binding.workspaceId===undefined?{}:{workspaceId:binding.workspaceId})})
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
export type BusinessDailyState={phase:'idle'|'loading'|'pending'|'creating'|'ready'|'error';binding:BusinessConversationBinding|null;error:unknown|null}
export type BusinessDailyOpenOptions={scope:string;title:string;workspaceId?:string;newConversation?:boolean;allowDraft?:boolean}
export type BusinessDailyFlowPorts={
 api:Pick<BusinessBuilderApi,'recentDaily'|'reserve'|'bind'|'byRequest'|'bySession'>
 work:Pick<BindingClient,'create'|'openSession'>;storage:Storage;personalSpaceId:string;id:()=>string
 contextCall:ContextCall;switching:BusinessBuilderSwitchPort;mayOpen?:()=>boolean
}
/** 只持久化预约意图和既有context协议请求；消息/附件/草稿始终归官方输入。 */
export class BusinessDailyFlow{
 private readonly ports:BusinessDailyFlowPorts
 private readonly keys:ReturnType<typeof businessDailyStorageKeys>
 private state:BusinessDailyState={phase:'idle',binding:null,error:null}
 private readonly listeners=new Set<()=>void>()
 private epoch=0
 private flight:{key:string;promise:Promise<BusinessConversationBinding>}|undefined
 private opening:AbortController|undefined
 constructor(ports:BusinessDailyFlowPorts){
  this.ports=ports;this.keys=businessDailyStorageKeys(ports.personalSpaceId)
  try{if(this.pending())this.state.phase='pending'}catch(error){this.state={...this.state,phase:'error',error}}
 }
 getSnapshot=()=>this.state
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private publish(patch:Partial<BusinessDailyState>){this.state={...this.state,...patch};for(const listener of this.listeners)listener()}
 /** 离开只失效导航/展示，已发送的固定预约保留用于恢复。 */
 leave(){this.epoch++;this.opening?.abort();this.publish({phase:'idle',binding:null,error:null})}
 pending():DailyRequest|null{
  const raw=this.ports.storage.getItem(this.keys.intent)
  if(raw===null)return null
  try{
   if(raw.length>4096)throw Error()
   const row:unknown=JSON.parse(raw)
   if(!isRecord(row)||Object.keys(row).length!==2||row.schema!=='teloa.business-daily-intent/v1'||!Object.hasOwn(row,'request'))throw Error()
   const request=daily(row.request);this.contextStorage(request).getItem('teloa.home-work-context/v1')
   return request
  }catch{throw conflict('日常会话恢复记录损坏，请先核对原预约。')}
 }
 private write(request:DailyRequest|null,previous:DailyRequest|null){
  if(!same(this.pending(),previous))throw conflict('另一个页面已修改日常会话恢复记录。')
  if(request===null){
   this.ports.storage.removeItem(this.keys.intent)
   if(this.ports.storage.getItem(this.keys.intent)!==null)throw conflict('日常会话恢复记录无法清除。')
  }else{
   const raw=JSON.stringify({schema:'teloa.business-daily-intent/v1',request})
   this.ports.storage.setItem(this.keys.intent,raw)
   if(this.ports.storage.getItem(this.keys.intent)!==raw)throw conflict('日常会话恢复记录未可靠保存。')
  }
 }
 /** 既有HomeContextApi的窄storage适配：单本人/原请求key、严格内容、写后读回。 */
 private contextStorage(request:DailyRequest,sessionId?:string):Storage{
  const key=this.keys.context(request.requestId),storage=this.ports.storage,helperKey='teloa.home-work-context/v1'
  const checkKey=(supplied:string)=>{if(supplied!==helperKey)throw conflict('业务上下文恢复key不正确。')}
  const validate=(raw:string)=>{
   try{
    if(!raw||raw.length>4096)throw Error()
    const row:unknown=JSON.parse(raw)
    if(!isRecord(row)||Object.keys(row).length!==5||!['requestId','sessionId','scopeId','roleId','expectedVersion'].every(k=>Object.hasOwn(row,k)))throw Error()
    if(row.requestId!==request.requestId||row.scopeId!==request.scope||row.roleId!==null||row.expectedVersion!==0||typeof row.sessionId!=='string'||sessionId!==undefined&&row.sessionId!==sessionId)throw Error()
    readBusinessConversationSession({sessionId:row.sessionId})
    return row
   }catch{throw conflict('业务上下文恢复记录损坏。')}
  }
  const read=()=>{
   const raw=storage.getItem(key)
   if(raw!==null){
    validate(raw)
   }
   return raw
  }
  return {
   getItem:supplied=>{checkKey(supplied);return read()},
   setItem:(supplied,raw)=>{checkKey(supplied);validate(raw);const previous=read();if(previous!==null&&!same(JSON.parse(previous),JSON.parse(raw)))throw conflict('业务上下文原请求已变化。');storage.setItem(key,raw);if(read()!==raw)throw conflict('业务上下文恢复记录未可靠保存。')},
   removeItem:supplied=>{checkKey(supplied);read();storage.removeItem(key);if(storage.getItem(key)!==null)throw conflict('业务上下文恢复记录无法清除。')},
  }
 }
 private run(key:string,action:(epoch:number)=>Promise<BusinessConversationBinding>):Promise<BusinessConversationBinding>{
  if(this.flight)return this.flight.key===key?this.flight.promise:Promise.reject(conflict('上次日常会话操作仍在进行，请先恢复原请求。'))
  const epoch=++this.epoch
  const promise=Promise.resolve().then(()=>action(epoch)).catch(error=>{if(epoch===this.epoch)this.publish({phase:'error',error});throw error})
  this.flight={key,promise};void promise.then(()=>{this.flight=undefined},()=>{this.flight=undefined})
  return promise
 }
 private location(epoch:number,approved:DailyApproval){return epoch===this.epoch&&this.ports.mayOpen?.()!==false&&this.ports.switching.read().mainSessionId===approved.mainSessionId}
 private canOpen(epoch:number,approved:DailyApproval){
  const current=this.ports.switching.read()
  return epoch===this.epoch&&this.ports.mayOpen?.()!==false&&current.mainSessionId===approved.mainSessionId&&switchDecision(current,approved.allowDraft&&current.input===approved.input)==='ready'
 }
 private async guard(epoch:number,approved:DailyApproval){
  const decision=await checkBusinessBuilderSwitch(this.ports.switching,approved.allowDraft)
  const current=this.ports.switching.read()
  const reason=!this.location(epoch,approved)||approved.allowDraft&&current.input!==approved.input?'changed':decision==='ready'?switchDecision(current,approved.allowDraft):decision
  if(reason!=='ready')throw new WorkError('teloa/conflict','请先处理当前会话的待发送内容或恢复状态。',{reason})
  return approved
 }
 private checked(value:BusinessConversationBinding,request:DailyRequest){
  const binding=readBusinessConversationBinding(value)
  if(!same(requestOf(binding),request))throw invalid()
  return binding
 }
 open(options:BusinessDailyOpenOptions):Promise<BusinessConversationBinding>{
  return this.run('open:'+JSON.stringify(options),async epoch=>{
   const pending=this.pending(),requested=daily({requestId:pending?.requestId??this.ports.id(),kind:'daily',scope:options.scope,title:options.title,...(options.workspaceId===undefined?{}:{workspaceId:options.workspaceId})})
   if(pending&&!same(pending,requested))throw conflict('上次日常会话仍待恢复，不能改变原业务、标题或工作区。')
   const approved:DailyApproval={...this.ports.switching.read(),allowDraft:options.allowDraft===true}
   this.publish({phase:'loading',error:null,binding:null})
   if(pending){await this.guard(epoch,approved);return this.create(pending,epoch,approved)}
   const recent=await this.ports.api.recentDaily({scope:requested.scope})
   if(!this.location(epoch,approved))throw changed('当前业务目标已变化。')
   if(recent){
    const binding=readBusinessConversationBinding(recent)
    if(binding.kind!=='daily'||binding.scope!==requested.scope)throw invalid()
    if(!binding.sessionId){this.publish({phase:'pending',binding});return binding}
    if(!options.newConversation)return this.openBound(binding,epoch,approved,true)
   }
   await this.guard(epoch,approved)
   this.write(requested,null)
   return this.create(requested,epoch,approved)
  })
 }
 recover(requestId?:string,allowDraft=false):Promise<BusinessConversationBinding>{
  return this.run('recover:'+(requestId??'')+':'+allowDraft,async epoch=>{
   let request=this.pending()
   if(requestId&&request&&request.requestId!==requestId)throw conflict('请先恢复原日常会话请求。')
   const approved=await this.guard(epoch,{...this.ports.switching.read(),allowDraft})
   if(!request){
    const id=requestId??this.state.binding?.requestId
    if(!id)throw conflict('没有可恢复的日常会话预约。')
    const binding=await this.ports.api.byRequest({requestId:id})
    if(!this.location(epoch,approved))throw changed('当前业务目标已变化。')
    if(!binding||binding.kind!=='daily'||binding.requestId!==id)throw invalid()
    request=requestOf(binding);this.contextStorage(request).getItem('teloa.home-work-context/v1');this.write(request,null)
   }
   return this.create(request,epoch,approved)
  })
 }
 /** 全局目录只识别原session的daily归属；pending必须由显式recover完成后才可放行发送。 */
 async inspectSession(sessionId:string):Promise<BusinessConversationBinding|null>{
  const epoch=++this.epoch;this.opening?.abort();this.publish({phase:'loading',binding:null,error:null})
  try{
   this.pending()
   const value=await this.ports.api.bySession({sessionId})
   if(epoch!==this.epoch||this.ports.mayOpen?.()===false)return null
   if(!value||value.kind!=='daily'){this.publish({phase:'idle'});return null}
   const binding=readBusinessConversationBinding(value)
   if(binding.sessionId!==undefined&&binding.sessionId!==sessionId)throw invalid()
   this.publish({phase:binding.sessionId?'ready':'pending',binding});return binding
  }catch(error){if(epoch===this.epoch)this.publish({phase:'error',error});throw error}
 }
 private async context(request:DailyRequest,sessionId:string,allowSet:boolean,active:()=>boolean){
  const check=()=>{if(!active())throw changed('当前业务目标已变化，原预约可稍后恢复。')}
  check()
  const storage=this.contextStorage(request,sessionId),api=createHomeContextApi(this.ports.contextCall,storage,()=>request.requestId)
  const existing=await api.read(sessionId)
  check()
  if(existing){if(existing.scopeId!==request.scope)throw conflict('原会话已属于其他业务，不能更改归属。');storage.removeItem('teloa.home-work-context/v1');return}
  if(!allowSet)throw conflict('日常会话的业务上下文尚未确认。')
  const result=api.pending()?await api.retry():await api.set({sessionId,scopeId:request.scope,roleId:null,expectedVersion:0})
  check()
  if(result.scopeId!==request.scope||result.version!==1)throw invalid()
 }
 private async openBound(binding:BusinessConversationBinding,epoch:number,approved:DailyApproval,continuing=false){
  const request=requestOf(binding),latest=await this.ports.api.byRequest({requestId:request.requestId})
  if(!latest||this.checked(latest,request).sessionId!==binding.sessionId)throw invalid()
  await this.context(request,binding.sessionId!,false,()=>this.location(epoch,approved))
  // 只有重新核实的当前同一session可直接保留原稿继续；另建/跨session仍需显式确认。
  if(continuing&&binding.sessionId===approved.mainSessionId)approved={...approved,allowDraft:true}
  await this.guard(epoch,approved)
  const controller=new AbortController();this.opening?.abort();this.opening=controller
  await this.ports.work.openSession(binding.sessionId!,controller.signal,()=>this.canOpen(epoch,approved))
  const opened=this.ports.switching.read().mainSessionId===binding.sessionId&&this.ports.mayOpen?.()!==false
  if(epoch===this.epoch)this.publish({phase:opened?'ready':'pending',binding,error:null})
  return binding
 }
 private async create(request:DailyRequest,epoch:number,approved:DailyApproval){
  if(!this.location(epoch,approved))throw changed('当前业务目标已变化，原预约可稍后恢复。')
  this.publish({phase:'creating',error:null})
  const known=await this.ports.api.byRequest({requestId:request.requestId})
  if(!this.location(epoch,approved))throw changed('当前业务目标已变化，原预约可稍后恢复。')
  const reserved=this.checked(known??await this.ports.api.reserve(request),request)
  if(!this.canOpen(epoch,approved)){if(epoch===this.epoch)this.publish({phase:'pending',binding:reserved});return reserved}
  if(reserved.sessionId){
   const bound=await this.openBound(reserved,epoch,approved)
   if(this.state.phase==='ready'&&epoch===this.epoch)this.write(null,request)
   return bound
  }
  let bound:BusinessConversationBinding|undefined,opened=false
  await this.ports.work.create({requestId:request.requestId,title:request.title,...(request.workspaceId===undefined?{}:{workspaceId:request.workspaceId}),beforeOpen:async conversation=>{
   await this.context(request,conversation.sessionId,true,()=>this.location(epoch,approved))
   bound=this.checked(await this.ports.api.bind({requestId:request.requestId,sessionId:conversation.sessionId}),request)
   if(bound.sessionId!==conversation.sessionId)throw invalid()
  },mayOpen:()=>{opened=this.canOpen(epoch,approved);return opened}})
  if(!bound)throw invalid()
  if(opened)this.write(null,request)
  if(epoch===this.epoch)this.publish({phase:opened?'ready':'pending',binding:bound,error:null})
  return bound
 }
}
