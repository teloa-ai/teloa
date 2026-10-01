import type {SessionEventSource} from '@deepseek-ai/dsh-api-session-controller/client'
import {BusinessRecordFlow} from './business-record-flow.ts'
import type {BusinessRecordApi} from './business-record-api.ts'
import {WorkError,type BusinessConversationBinding} from '@teloa/contract'
import {BusinessDailyFlow,type BusinessDailyOpenOptions} from './business-daily-flow.ts'
import {checkBusinessBuilderSwitch,switchDecision,BusinessBuilderFlow,type BusinessBuilderSwitchSnapshot,type BusinessBuilderSwitchPort} from './business-builder-flow.ts'
import type {BusinessBuilderApi} from './business-builder-api.ts'
import type {BindingClient} from './binding-client.ts'

/** 只消费官方实时 append 的新成功结果；历史补页和基线替换不重放工具完成。 */
export function watchBusinessBuilderRevisions(source:SessionEventSource,changed:()=>void){
 const high=()=>source.getSnapshot().entries.reduce((seq,{event})=>Math.max(seq,event.seq),-1)
 let cursor=high()
 return source.subscribe(()=>{
  const window=source.getSnapshot(),before=cursor;cursor=Math.max(cursor,high())
  if(window.change.kind!=='append')return
  const calls=new Set(window.entries.flatMap(({event})=>event.type==='tool/call'&&event.data.name==='teloa_business_builder_revise'?[event.data.callId]:[]))
  if(window.change.entries.some(({event})=>event.seq>before&&event.type==='tool/result'&&event.surfaceOp==='append'&&calls.has(event.data.message.toolCallId)&&!event.data.message.isError))changed()
 })
}
type NativeFacts=BusinessBuilderSwitchSnapshot&{connected:boolean;generationReady:boolean;selectionReady:boolean}
/** null 只表示官方连接、选择目录均就绪且确无输入作用域；缺状态不拼装空输入。 */
export function readBuilderSwitchSnapshot(facts:NativeFacts):BusinessBuilderSwitchSnapshot{
 const {connected,generationReady,selectionReady,...snapshot}=facts
 const empty=connected&&generationReady&&selectionReady&&snapshot.mainSessionId===undefined&&snapshot.bindingSessionId===undefined&&snapshot.input==null
 return {...snapshot,bindingReady:empty||connected&&generationReady&&snapshot.bindingReady,input:empty?null:snapshot.input??undefined}
}
export const builderJournalKey=(personalSpaceId:string)=>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(personalSpaceId))throw Error('本人工作空间身份尚未确认。')
 return 'teloa.business-builder/v1/personal-space/'+personalSpaceId.toLowerCase()
}
export type BusinessNavigationToken=Readonly<{id:symbol}>
type Navigation={epoch:number;session:string|undefined;input:BusinessBuilderSwitchSnapshot['input'];location:string|undefined;approved:boolean}
type DailyPending=Pick<BusinessConversationBinding,'requestId'|'scope'|'title'>
type State={nativeReady:boolean;sessionKind:'builder'|'daily'|null;daily:BusinessDailyFlow|null;dailyPending:DailyPending|null;api:BusinessBuilderApi|null;status:'loading'|'ready'|'failed';flow:BusinessBuilderFlow|null;namespace:string|null;checkedSessionId:string|null|undefined;error:unknown|null}
type Ports={api:BusinessBuilderApi;work:Pick<BindingClient,'create'|'openSession'>;storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>;identity:()=>Promise<string>;switching:BusinessBuilderSwitchPort;subscribeNative:(listener:()=>void)=>()=>void;contextCall:(endpoint:string,payload:unknown)=>Promise<unknown>;block:(sessionId:string,reason:string|undefined)=>void;watch:(sessionId:string,changed:()=>void)=>()=>void;id:()=>string}
const checking='checking',pending='builder-pending'
const changed=()=>new WorkError('teloa/conflict','当前会话内容或业务目标已变化。',{reason:'changed'})
/** 薄装配生命周期：只持有连接和展示归属，创建/采用/草案真源全部委派既有 Flow。 */
export class BusinessBuilderController{
 private state:State={nativeReady:false,sessionKind:null,daily:null,dailyPending:null,api:null,status:'loading',flow:null,namespace:null,checkedSessionId:undefined,error:null}
 private readonly listeners=new Set<()=>void>()
 private generation:object|undefined
 private epoch=0
 private selection=0
 private creation=false
 private readonly tokens=new WeakMap<BusinessNavigationToken,Navigation>()
 private activeNavigation:Navigation|undefined
 private offNative:(()=>void)|undefined
 private offDaily:(()=>void)|undefined
 private offFlow:(()=>void)|undefined
 private offWatch:(()=>void)|undefined
 private watchSession:string|undefined
 private refreshJob:{flow:BusinessBuilderFlow;session:string;again:boolean}|undefined
 private readonly blocked=new Set<string>()
 private navigation:{location:()=>string;refreshScopes:()=>Promise<unknown>}|undefined
 readonly ports:Ports
 constructor(ports:Ports){this.ports=ports;this.offNative=ports.subscribeNative(()=>this.refreshNative());this.refreshNative()}
 getSnapshot=()=>this.state
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private refreshNative(){const s=this.ports.switching.read(),nativeReady=s.bindingReady&&s.input!==undefined&&(s.mainSessionId?s.bindingSessionId===s.mainSessionId:s.bindingSessionId===undefined&&s.input===null);if(nativeReady!==this.state.nativeReady)this.publish({nativeReady})}
 captureNavigation():BusinessNavigationToken{
  this.flow();this.refreshNative();if(!this.state.nativeReady)throw new WorkError('teloa/conflict','原生会话尚未就绪。',{reason:'binding'})
  const s=this.ports.switching.read(),token={id:Symbol('business navigation')}
  this.tokens.set(token,{epoch:this.epoch,session:s.mainSessionId,input:s.input,location:this.navigation?.location(),approved:false});return token
 }
 private validNavigation(n:Navigation,afterOpen=false){const s=this.ports.switching.read();return n.epoch===this.epoch&&n.location===this.navigation?.location()&&(afterOpen&&s.mainSessionId!==n.session||s.mainSessionId===n.session&&s.input===n.input)}
 private token(token:BusinessNavigationToken){const n=this.tokens.get(token);if(!n||!this.validNavigation(n))throw changed();return n}
 approveNavigation(token:BusinessNavigationToken){const n=this.token(token);if(n.approved)throw changed();n.approved=true}
 private async action<T>(token:BusinessNavigationToken|undefined,run:(approved:boolean)=>Promise<T>):Promise<T>{
  const key=token??this.captureNavigation(),n=this.token(key);if(this.creation)throw changed();this.activeNavigation=n;this.creation=true
  try{const result=await run(n.approved);this.tokens.delete(key);return result}
  catch(error){if(!(error instanceof WorkError&&error.details?.reason==='draft'))this.tokens.delete(key);throw error}
  finally{if(this.activeNavigation===n&&n.epoch===this.epoch){this.creation=false;this.activeNavigation=undefined;this.publish({checkedSessionId:undefined});await this.followSession(this.ports.switching.read().mainSessionId)}}
 }
 private publish(patch:Partial<State>){this.state={...this.state,...patch};for(const listener of this.listeners)listener()}
 configure(navigation:{location:()=>string;refreshScopes:()=>Promise<unknown>}){this.navigation=navigation}
 private block(id:string,reason:string|undefined){if(reason)this.blocked.add(id);else this.blocked.delete(id);this.ports.block(id,reason)}
 async connect(generation:object|undefined){
  if(!this.offNative)this.offNative=this.ports.subscribeNative(()=>this.refreshNative())
  if(generation===this.generation&&this.state.status==='ready')return
  this.generation=generation;const epoch=++this.epoch;++this.selection;this.creation=false;this.activeNavigation=undefined
  const current=this.ports.switching.read().mainSessionId
  if(current)this.block(current,checking)
  this.offWatch?.();this.offWatch=undefined;this.watchSession=undefined
  this.offFlow?.();this.offDaily?.();this.offFlow=undefined;this.state.flow?.leave();this.state.daily?.leave();this.publish({api:null,status:'loading',flow:null,daily:null,dailyPending:null,sessionKind:null,namespace:null,checkedSessionId:undefined,error:null})
  if(!generation)return
  try{
   const personalSpaceId=await this.ports.identity(),namespace=builderJournalKey(personalSpaceId)
   if(epoch!==this.epoch)return
   const api=new Proxy(this.ports.api,{get:(target,key)=>{const method=Reflect.get(target,key);return typeof method!=='function'?method:async(...args:unknown[])=>{if(epoch!==this.epoch)throw Error('业务连接已变化。');const result=await Reflect.apply(method,target,args);if(epoch!==this.epoch)throw Error('业务连接已变化。');return result}}})
   const mayOpen=()=>epoch===this.epoch&&!!this.navigation&&(!this.activeNavigation||this.validNavigation(this.activeNavigation,true))
   const daily=new BusinessDailyFlow({api,work:this.ports.work,storage:this.ports.storage,personalSpaceId,id:this.ports.id,switching:this.ports.switching,contextCall:async(endpoint,payload)=>{if(epoch!==this.epoch)throw changed();const result=await this.ports.contextCall(endpoint,payload);if(epoch!==this.epoch)throw changed();return result},mayOpen})
   const flow=new BusinessBuilderFlow({api,work:this.ports.work,storage:this.ports.storage,journalKey:namespace,id:this.ports.id,switching:this.ports.switching,refreshScopes:()=>{if(!this.navigation)throw Error('业务目录尚未就绪。');return this.navigation.refreshScopes()},mayOpen})
   this.publish({status:'ready',api,flow,daily,namespace});this.refreshNative()
   this.offFlow=flow.subscribe(()=>{const value=flow.getSnapshot(),id=value.binding?.sessionId;if(id&&value.draft&&id===this.ports.switching.read().mainSessionId){this.block(id,undefined);this.watchReady(flow,id)}})
   this.offDaily=daily.subscribe(()=>{const value=daily.getSnapshot();if(value.binding&&!this.creation)this.publish({dailyPending:value.phase==='pending'?value.binding:null})})
   await this.followSession(this.ports.switching.read().mainSessionId)
  }catch(error){if(epoch===this.epoch)this.publish({status:'failed',error})}
 }
 retry(){
  if(this.state.status!=='ready')return this.connect(this.generation)
  this.publish({checkedSessionId:undefined,error:null})
  return this.followSession(this.ports.switching.read().mainSessionId)
 }
 createRecordFlow(api:BusinessRecordApi){
  const namespace=this.state.namespace
  if(!namespace||this.state.status!=='ready')throw Error('本人工作空间尚未核对。')
  return new BusinessRecordFlow(api,this.ports.id,(scope,type)=>{
   const key=namespace+'/records/'+encodeURIComponent(JSON.stringify([scope,type]))
   return {read:()=>this.ports.storage.getItem(key),write:value=>{this.ports.storage.setItem(key,value);if(this.ports.storage.getItem(key)!==value)throw Error('记录恢复意图未可靠保存。')},clear:()=>{this.ports.storage.removeItem(key);if(this.ports.storage.getItem(key)!==null)throw Error('记录恢复意图无法清除。')}}
  })
 }
 private flow(){if(!this.state.flow||this.state.status!=='ready')throw Error('本人工作空间尚未核对。');return this.state.flow}
 async followSession(sessionId:string|undefined){
  const flow=this.state.flow
  if(!flow||this.state.status!=='ready'){if(sessionId)this.block(sessionId,checking);return}
  if(this.creation)return
  if(this.state.checkedSessionId===(sessionId??null))return
  const selection=++this.selection
  this.offWatch?.();this.offWatch=undefined;this.watchSession=undefined
  if(!sessionId){flow.leave();this.state.daily?.leave();this.publish({checkedSessionId:null,sessionKind:null});return}
  flow.leave();this.state.daily?.leave();this.block(sessionId,checking);this.publish({checkedSessionId:undefined,error:null})
  try{
   const binding=await this.state.api!.bySession({sessionId})
   if(selection!==this.selection||flow!==this.state.flow)return
   this.publish({sessionKind:binding?.kind??null})
   if(binding?.kind==='daily'){
    flow.leave();const daily=this.state.daily!;await daily.inspectSession(sessionId)
    if(selection!==this.selection||flow!==this.state.flow)return
    const value=daily.getSnapshot();this.block(sessionId,value.phase==='pending'?'daily-pending':undefined);this.publish({checkedSessionId:sessionId,dailyPending:value.phase==='pending'?value.binding:null});return
   }
   this.state.daily?.leave();
   if(!binding){flow.leave();this.block(sessionId,undefined);this.publish({checkedSessionId:sessionId});return}
   await flow.restoreSession(sessionId)
   if(selection!==this.selection||flow!==this.state.flow)return
   const state=flow.getSnapshot(),bound=state.binding
   this.block(sessionId,bound?.kind==='builder'&&(!bound.sessionId||!state.draft)?pending:undefined)
   this.publish({checkedSessionId:sessionId})
   if(bound?.kind==='builder'&&bound.sessionId===sessionId&&state.draft){
    this.watchReady(flow,sessionId)
    await this.refreshPreview()
   }
  }catch(error){if(selection===this.selection&&flow===this.state.flow)this.publish({checkedSessionId:sessionId,error})}
 }
 private watchReady(flow:BusinessBuilderFlow,sessionId:string){
  if(flow!==this.state.flow||this.watchSession===sessionId)return
  this.offWatch?.();this.watchSession=sessionId;this.offWatch=this.ports.watch(sessionId,()=>void this.refreshPreview())
 }

 async start(options:{scope?:string;workspaceId?:string;allowDraft?:boolean}={},token?:BusinessNavigationToken){
  return this.action(token,approved=>this.flow().start({...options,allowDraft:approved}))
 }
 async open(sessionId:string,allowDraft=false,token?:BusinessNavigationToken){
  return this.action(token,async approved=>{
   const n=this.activeNavigation!,sameSession=n.session===sessionId
   if(sameSession){
    const binding=await this.state.api!.bySession({sessionId})
    if(!this.validNavigation(n))throw changed()
    if(binding?.kind!=='builder'||binding.sessionId!==sessionId)throw new WorkError('teloa/conflict','当前搭建会话归属尚未确认。',{reason:'binding'})
   }
   // 重新打开已核实的同一会话不迁移原稿；未知发送、在途和最终身份守卫仍照常执行。
   const keepDraft=approved||sameSession,decision=await checkBusinessBuilderSwitch(this.ports.switching,keepDraft)
   if(!this.validNavigation(n))throw changed()
   if(decision!=='ready')throw new WorkError('teloa/conflict','请先处理当前会话的待发送内容或恢复状态。',{reason:decision})
   await this.ports.work.openSession(sessionId,undefined,()=>this.validNavigation(n)&&switchDecision(this.ports.switching.read(),keepDraft)==='ready')
  })
 }
 async recover(requestId?:string,allowDraft=false,token?:BusinessNavigationToken){
  return this.action(token,approved=>this.flow().recoverCreation(requestId,approved))
 }
 /** 只读决定是否需要执行位置；正式Flow仍会重读recent，pending从不隐式换业务。 */
 async prepareDaily(options:BusinessDailyOpenOptions,token?:BusinessNavigationToken):Promise<boolean>{
  const key=token??this.captureNavigation(),n=this.token(key),daily=this.state.daily!,local=daily.pending()
  const recent=local??await this.state.api!.recentDaily({scope:options.scope})
  if(!this.validNavigation(n))throw changed()
  if(recent&&(!('sessionId' in recent)||!recent.sessionId)){this.publish({dailyPending:recent});return false}
  this.publish({dailyPending:null})
  if(recent&&!options.newConversation){await this.openDaily(options,key);return false}
  return true
 }
 async openDaily(options:BusinessDailyOpenOptions,token?:BusinessNavigationToken){
  return this.action(token,approved=>this.state.daily!.open({...options,allowDraft:approved}))
 }
 async recoverDaily(requestId?:string,token?:BusinessNavigationToken){
  return this.action(token,approved=>this.state.daily!.recover(requestId,approved))
 }
 /** 原生公开事件驱动；在途只合并一次后续刷新，不开后台计时器。 */
 async refreshPreview(){
  const flow=this.state.flow,session=this.watchSession
  if(!flow||!session||flow.getSnapshot().binding?.sessionId!==session)return
  if(this.refreshJob?.flow===flow&&this.refreshJob.session===session){this.refreshJob.again=true;return}
  const job={flow,session,again:false};this.refreshJob=job
  try{
   do{
    job.again=false
    if(flow!==this.state.flow||session!==this.watchSession)return
    const previous=flow.getSnapshot().page?.page.definition.id,draft=await flow.refreshDraft()
    if(flow!==this.state.flow||session!==this.watchSession||draft.status!=='draft'||!draft.candidate.pages.length)return
    const checked=await flow.preview()
    if(flow!==this.state.flow||session!==this.watchSession||checked.revision!==flow.getSnapshot().draft?.revision)return
    const pageId=previous&&draft.candidate.pages.some(p=>p.id===previous)?previous:draft.candidate.homePageId??draft.candidate.pages[0]!.id
    await flow.page(pageId)
   }while(job.again)
  }catch(error){if(flow===this.state.flow&&session===this.watchSession)this.publish({error})}
  finally{if(this.refreshJob===job)this.refreshJob=undefined}
 }
 dispose(){
  ++this.epoch;++this.selection;this.generation=undefined;this.creation=false;this.activeNavigation=undefined
  this.offNative?.();this.offNative=undefined;this.offWatch?.();this.offWatch=undefined;this.offFlow?.();this.offFlow=undefined;this.offDaily?.();this.offDaily=undefined
  this.state.flow?.leave();this.state.daily?.leave();for(const id of this.blocked)this.ports.block(id,undefined);this.blocked.clear()
  // 真实上下文销毁必须同步撤销公开身份；外围 API 不能仅凭旧 snapshot 继续消费晚包。
  this.publish({nativeReady:false,api:null,status:'loading',flow:null,daily:null,dailyPending:null,sessionKind:null,namespace:null,checkedSessionId:undefined,error:null})
 }
}
