import {readBusinessSetupAdoption,businessSetupUuid,readBusinessConversationSession,type BusinessSetupPlan,type BusinessSetupPreview,type BusinessSetupAdoption,type BusinessSetupManual} from '@teloa/contract'
import {businessConfigurationPreviewReceiptRejected} from '@teloa/contract'
import {WorkError,isRecord,isBusinessScopeKey,readBusinessConversationReserve,readBusinessBuilderRequest,type BusinessConversationReserve,type BusinessConversationBinding,type BusinessConversationDirectory,type BusinessConfigurationDraftResponseVersioned as BusinessConfigurationDraftResponse,type BusinessConfigurationPreviewResponse,type BusinessConfigurationApplyResult,type BusinessConfigurationPageProjectionVersioned as BusinessConfigurationPageProjection,type BusinessTimeRange} from '@teloa/contract'
import type {InputState} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {BindingClient} from './binding-client.ts'
import type {BusinessBuilderApi,BusinessBuilderApplyInput} from './business-builder-api.ts'
import type {HomeSubmissionMonitor} from './home-native-submission.ts'
import {readBusinessSetupManualInput,serializeBusinessSetupManualInput,type BusinessSetupManualInput} from './business-setup-manual-journal.ts'
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>
export type BusinessBuilderSwitchSnapshot={mainSessionId:string|undefined;bindingSessionId:string|undefined;bindingReady:boolean;input:InputState|null|undefined;pendingSubmissions:readonly {requestId:string}[];monitor:Pick<HomeSubmissionMonitor,'getSnapshot'|'check'>|undefined}
export type BusinessBuilderSwitchPort={read:()=>BusinessBuilderSwitchSnapshot}
export type BusinessBuilderSwitchDecision='ready'|'unknown'|'draft'|'pending'|'binding'|'changed'
/** 只读官方完整状态；正文/附件/引用/队列始终留在原生会话，不在业务流程内复制。 */
export async function checkBusinessBuilderSwitch(port:BusinessBuilderSwitchPort,allowDraft=false):Promise<BusinessBuilderSwitchDecision>{
 const initial=port.read()
 if(initial.monitor?.getSnapshot())await initial.monitor.check()
 const current=port.read()
 if(current.mainSessionId!==initial.mainSessionId)return 'changed'
 return switchDecision(current,allowDraft)
}
export function switchDecision(current:BusinessBuilderSwitchSnapshot,allowDraft:boolean):BusinessBuilderSwitchDecision{
 if(current.monitor?.getSnapshot())return 'unknown'
 if(current.pendingSubmissions.length||current.input?.phase==='adjudicating'||current.input?.phase==='submitting')return 'pending'
 // null 仅由装配层核实连接/选择已就绪且没有会话输入作用域后提供。
 if(current.input===null)return !current.mainSessionId&&current.bindingSessionId===undefined&&current.bindingReady?'ready':'binding'
 if(current.input===undefined)return 'binding'
 if(current.mainSessionId?(!current.bindingReady||current.bindingSessionId!==current.mainSessionId):current.bindingSessionId!==undefined)return 'binding'
 const input=current.input
 if((!allowDraft||!current.mainSessionId)&&(input.draft.length>0||input.attachmentIds.length>0||input.occurrences.length>0||input.queue.length>0||input.phase!=='plain'||input.claim!==undefined))return 'draft'
 return 'ready'
}
type SaveIntent={input:BusinessBuilderApplyInput;scope:string;candidateHash:string}
type Journal={schema:'teloa.business-builder-journal/v1';creation:BusinessConversationReserve|null;save:SaveIntent|null}
const empty=():Journal=>({schema:'teloa.business-builder-journal/v1',creation:null,save:null})
const conflict=(message:string)=>new WorkError('teloa/conflict',message)
const invalid=()=>new WorkError('teloa/invalid-host-response','业务搭建返回的版本或身份不一致。')
const code=(error:unknown)=>isRecord(error)?error.code:undefined
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
export type BusinessBuilderState={
 setupPlan?:BusinessSetupPlan|null;setupPreview?:BusinessSetupPreview|null;setupReadiness?:{digest:string;rows:{itemInstanceId:string;kind:string;title:string;state:string}[]}|null;setupUnknown?:boolean;leaveConfirmation?:boolean

 phase:'idle'|'creating'|'recovering'|'ready'|'saving'|'unknown'|'saved'|'error'
 binding:BusinessConversationBinding|null;draft:BusinessConfigurationDraftResponse|null;preview:BusinessConfigurationPreviewResponse|null
 page:BusinessConfigurationPageProjection|null;pageStatus:'idle'|'loading'|'ready'|'invalid'
 directory:BusinessConversationDirectory|null;result:BusinessConfigurationApplyResult|null;error:unknown|null
 discardedDraft?:{id:string;revision:number}|undefined
}
export type BusinessBuilderFlowPorts={
 api:BusinessBuilderApi;work:Pick<BindingClient,'create'>;storage:Storage;journalKey:string;id:()=>string
 refreshScopes:()=>Promise<unknown>;switching:BusinessBuilderSwitchPort;mayOpen?:()=>boolean
}
/** 浏览器journal只持久固定请求意图。草案正文、会话内容和正式配置始终从服务端读取。 */
export class BusinessBuilderFlow{
 private readonly ports:BusinessBuilderFlowPorts
 private leavePending:{resolve:(allowed:boolean)=>void;epoch:number;draftId:string;revision:number;sessionId:string|undefined}|undefined
 private setupFlight:Promise<BusinessSetupAdoption>|undefined
 private manualIntent:{spec:string;input:Parameters<BusinessBuilderApi['setupEdit']>[0]}|undefined
 private restoreIntent:{spec:string;input:Parameters<BusinessBuilderApi['setupRestore']>[0]}|undefined
 private state:BusinessBuilderState={phase:'idle',binding:null,draft:null,preview:null,page:null,pageStatus:'idle',directory:null,result:null,error:null}
 private listeners=new Set<()=>void>()
 private epoch=0
 private draftRead=0
 private previewRead=0
 private pageRead=0
 private directoryRead=0
 private discardedDraftIds=new Set<string>()
 private creationFlight:Promise<BusinessConversationBinding>|undefined
 private saveFlight:Promise<BusinessConfigurationApplyResult>|undefined
 constructor(ports:BusinessBuilderFlowPorts){
  this.ports=ports
  try{const journal=this.journal();if(journal.creation||journal.save)this.state.phase='recovering'}catch(error){this.state={...this.state,phase:'error',error}}
 }
 getSnapshot=()=>this.state
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private publish(patch:Partial<BusinessBuilderState>){const next={...this.state,...patch},leave=this.leavePending;if(leave&&(leave.epoch!==this.epoch||leave.draftId!==next.draft?.id||leave.revision!==next.draft?.revision||leave.sessionId!==next.binding?.sessionId)){this.leavePending=undefined;leave.resolve(false);next.leaveConfirmation=false}this.state=next;for(const listener of this.listeners)listener()}
 private journal():Journal{
  const raw=this.ports.storage.getItem(this.ports.journalKey)
  if(raw===null)return empty()
  try{
   if(raw.length>8192)throw Error()
   const r:unknown=JSON.parse(raw)
   if(!isRecord(r)||Object.keys(r).length!==3||r.schema!=='teloa.business-builder-journal/v1'||!Object.hasOwn(r,'creation')||!Object.hasOwn(r,'save'))throw Error()
   const creation=r.creation===null?null:readBusinessConversationReserve(r.creation)
   if(creation&&creation.kind!=='builder')throw Error()
   let save:SaveIntent|null=null
   if(r.save!==null){
    if(!isRecord(r.save)||Object.keys(r.save).length!==3||!isBusinessScopeKey(r.save.scope)||r.save.scope==='general'||!hash(r.save.candidateHash))throw Error()
    const input=readBusinessBuilderRequest('business-configuration/apply',r.save.input) as BusinessBuilderApplyInput
    save={input,scope:r.save.scope,candidateHash:r.save.candidateHash}
   }
   return {schema:'teloa.business-builder-journal/v1',creation,save}
  }catch{throw conflict('业务搭建恢复记录损坏，请先核对服务端预约与采用结果。')}
 }
 private write(next:Journal,previous:Journal):void{
  if(JSON.stringify(this.journal())!==JSON.stringify(previous))throw conflict('另一个页面已修改业务搭建恢复记录，请重新读取。')
  if(!next.creation&&!next.save){this.ports.storage.removeItem(this.ports.journalKey);if(this.ports.storage.getItem(this.ports.journalKey)!==null)throw Error('业务恢复记录无法清除。')}
  else{const serialized=JSON.stringify(next);this.ports.storage.setItem(this.ports.journalKey,serialized);if(this.ports.storage.getItem(this.ports.journalKey)!==serialized)throw Error('业务恢复记录未可靠保存。')}
 }
 pendingCreation=()=>this.journal().creation
 pendingSave=()=>this.journal().save
 async requestLeave():Promise<boolean>{
  if(this.leavePending)return false
  const draft=this.state.draft
  if(!draft||draft.status!=='draft'||draft.revision===1&&!this.state.setupPlan)return true
  return new Promise(resolve=>{this.leavePending={resolve,epoch:this.epoch,draftId:draft.id,revision:draft.revision,sessionId:this.state.binding?.sessionId};this.publish({leaveConfirmation:true})})
 }
 decideLeave(choice:'keep'|'continue'){const leave=this.leavePending;this.leavePending=undefined;const matches=!!leave&&leave.epoch===this.epoch&&leave.draftId===this.state.draft?.id&&leave.revision===this.state.draft?.revision&&leave.sessionId===this.state.binding?.sessionId;this.publish({leaveConfirmation:false});leave?.resolve(matches&&choice==='keep')}
 /** 离开只失效展示与导航回调；不能取消或换ID重建已提交的业务操作。 */
 leave(){this.epoch++;this.draftRead++;this.previewRead++;this.pageRead++;this.publish({phase:'idle',discardedDraft:undefined})}
 private async maySwitch(allowDraft:boolean){
  const epoch=this.epoch,initial=this.ports.switching.read()
  const decision=await checkBusinessBuilderSwitch(this.ports.switching,allowDraft)
  const current=this.ports.switching.read()
  if(epoch!==this.epoch||current.mainSessionId!==initial.mainSessionId||this.ports.mayOpen?.()===false)throw conflict('当前业务目标已变化。')
  const finalDecision=decision==='ready'?switchDecision(current,allowDraft):decision
  if(finalDecision!=='ready')throw new WorkError('teloa/conflict','请先处理当前会话的待发送内容或恢复状态。',{reason:finalDecision})
  return current
 }
 async refreshDirectory(cursor?:string){
  const generation=++this.directoryRead
  const result=await this.ports.api.list({kind:'builder',...(cursor===undefined?{}:{cursor})})
  if(generation===this.directoryRead)this.publish({directory:{...result,items:result.items.filter(item=>!item.binding.draftId||!this.discardedDraftIds.has(item.binding.draftId))}})
  return result
 }
 async discard(binding:BusinessConversationBinding,draft:Pick<BusinessConfigurationDraftResponse,'id'|'scope'|'revision'|'status'>){
  if(this.pendingSave()||this.state.phase==='saving'||this.state.phase==='unknown'||this.pendingSetupSave())throw conflict('请先核对原保存结果，再放弃草案。')
  if(this.state.result&&this.state.binding?.draftId===draft.id)throw conflict('已采用的草案不能放弃。')
  if(this.creationFlight)throw conflict('请先等待当前业务会话创建完成。')
  if(binding.kind!=='builder'||binding.draftId!==draft.id||draft.status!=='draft')throw conflict('请先恢复并核对原业务草案。')
  const epoch=this.epoch
  const leave=this.leavePending?.draftId===draft.id&&this.leavePending.revision===draft.revision?this.leavePending:undefined
  const result=await this.ports.api.discard({...(binding.sessionId?{sessionId:binding.sessionId}:{requestId:binding.requestId}),draftId:draft.id,expectedRevision:draft.revision})
  if(result.scope!==draft.scope)throw invalid()
  this.discardedDraftIds.add(draft.id)
  const journal=this.journal()
  if(journal.creation?.requestId===binding.requestId)this.write({...journal,creation:null},journal)
  const directory=this.state.directory
  const same=epoch===this.epoch&&this.state.draft?.id===draft.id&&this.state.draft.revision===draft.revision
  const discardedForLeave=!!leave&&this.leavePending===leave&&same&&leave.epoch===this.epoch
  if(discardedForLeave)this.leavePending=undefined
  this.publish({...(epoch===this.epoch?{discardedDraft:{id:result.id,revision:result.revision}}:{}),...(directory?{directory:{...directory,items:directory.items.filter(item=>item.binding.draftId!==draft.id)}}:{}),...(same?{draft:result,preview:null,page:null,pageStatus:'idle',error:null}: {})})
  if(discardedForLeave){this.publish({leaveConfirmation:false});leave!.resolve(true)}
  return result
 }
 async start(options:{title?:string;scope?:string;workspaceId?:string;allowDraft?:boolean}={}):Promise<BusinessConversationBinding>{
  const journal=this.journal()
  const request=readBusinessConversationReserve({requestId:journal.creation?.requestId??this.ports.id(),kind:'builder',title:options.title??'新业务',...(options.scope===undefined?{}:{scope:options.scope}),...(options.workspaceId===undefined?{}:{workspaceId:options.workspaceId})})
  if(journal.creation&&JSON.stringify(journal.creation)!==JSON.stringify(request))throw conflict('上次创建仍待恢复，不能改变原预约标题、工作区或业务。')
  if(this.creationFlight)return this.creationFlight
  const approved=await this.maySwitch(options.allowDraft===true)
  const latest=this.journal()
  if(latest.creation&&JSON.stringify(latest.creation)!==JSON.stringify(request))throw conflict('创建预约已变化。')
  this.write({...latest,creation:request},latest)
  return this.create(request,options.allowDraft===true,approved)
 }
 async recoverCreation(requestId?:string,allowDraft=false):Promise<BusinessConversationBinding>{
  if(this.creationFlight)return this.creationFlight
  const journal=this.journal()
  if(requestId!==undefined&&journal.creation&&requestId!==journal.creation.requestId)throw conflict('请先恢复原创建请求，不能改投另一预约。')
  const approved=await this.maySwitch(allowDraft)
  let request=journal.creation
  if(!request){
   if(!requestId)throw conflict('没有待恢复的创建请求，请从服务端搭建目录选择。')
   const epoch=this.epoch
   const binding=await this.ports.api.byRequest({requestId})
   if(epoch!==this.epoch)throw conflict('当前业务目标已变化。')
   if(!binding||binding.kind!=='builder')throw conflict('没有可恢复的业务搭建预约。')
   request=readBusinessConversationReserve({requestId:binding.requestId,kind:binding.kind,title:binding.title,...(binding.scope===undefined?{}:{scope:binding.scope}),...(binding.workspaceId===undefined?{}:{workspaceId:binding.workspaceId})})
   this.write({...journal,creation:request},journal)
  }
  return this.create(request,allowDraft,approved)
 }
 private create(request:BusinessConversationReserve,allowDraft:boolean,approved:BusinessBuilderSwitchSnapshot):Promise<BusinessConversationBinding>{
  if(this.creationFlight)return this.creationFlight
  const locationMatches=()=>this.ports.switching.read().mainSessionId===approved.mainSessionId&&this.ports.mayOpen?.()!==false
  if(!locationMatches())return Promise.reject(conflict('当前业务目标已变化，原预约可稍后恢复。'))
  const epoch=++this.epoch,approvedInput=approved.input
  this.publish({phase:'creating',binding:null,draft:null,preview:null,page:null,pageStatus:'idle',result:null,error:null,discardedDraft:undefined,setupPlan:null,setupPreview:null,setupReadiness:null})
  const operation=(async()=>{
   try{
    const reserved=await this.ports.api.reserve(request)
    if(epoch!==this.epoch)return reserved
    if(!locationMatches()){this.publish({phase:'recovering'});return reserved}
    let bound:BusinessConversationBinding|undefined
    await this.ports.work.create({requestId:request.requestId,title:request.title,...(request.workspaceId===undefined?{}:{workspaceId:request.workspaceId}),mayOpen:()=>{
     const current=this.ports.switching.read()
     return epoch===this.epoch&&current.mainSessionId===approved.mainSessionId&&this.ports.mayOpen?.()!==false&&switchDecision(current,allowDraft&&current.input===approvedInput)==='ready'
    },beforeOpen:async conversation=>{
     bound=await this.ports.api.bind({requestId:request.requestId,sessionId:conversation.sessionId})
     if(bound.kind!=='builder'||(['draftId','scope','workspaceId','title'] as const).some(key=>bound![key]!==reserved[key]))throw invalid()
     const draft=await this.ports.api.draft({sessionId:conversation.sessionId,draftId:bound.draftId!})
     if(bound.scope!==undefined&&draft.scope!==bound.scope)throw invalid()
     const latest=this.journal()
     if(latest.creation?.requestId!==request.requestId)throw conflict('创建恢复记录已变化。')
     this.write({...latest,creation:null},latest)
     if(epoch===this.epoch)this.publish({phase:'ready',binding:bound,draft,error:null});if(epoch===this.epoch)await this.refreshSetupPlan()
    }})
    if(!bound)throw invalid()
    return bound
   }catch(error){if(epoch===this.epoch)this.publish({phase:'error',error});throw error}
  })()
  this.creationFlight=operation
  void operation.then(()=>{this.creationFlight=undefined},()=>{this.creationFlight=undefined})
  return operation
 }
 /** 全局目录打开原session时恢复外壳，不创建、领养或提交任何原生消息。 */
 async restoreSession(sessionId:string){
  const epoch=++this.epoch
  this.publish({phase:'recovering',binding:null,draft:null,preview:null,page:null,pageStatus:'idle',result:null,error:null,discardedDraft:undefined,setupPlan:null,setupPreview:null,setupReadiness:null})
  try{
   const binding=await this.ports.api.bySession({sessionId})
   if(epoch!==this.epoch)return
   if(!binding||binding.kind!=='builder'){this.publish({phase:'idle'});return}
   this.publish({binding})
   if(binding.sessionId!==sessionId||!binding.draftId)return
   const draft=await this.ports.api.draft({sessionId,draftId:binding.draftId})
   if(binding.scope!==undefined&&draft.scope!==binding.scope)throw invalid()
   if(epoch===this.epoch){this.publish({phase:'ready',draft});await this.refreshSetupPlan()}
  }catch(error){if(epoch===this.epoch)this.publish({phase:'error',error});throw error}
 }
 private target(){
  const {binding,draft}=this.state
  if(!binding?.sessionId||!binding.draftId||!draft||draft.id!==binding.draftId)throw conflict('业务会话绑定尚未完成。')
  return {binding,draft,sessionId:binding.sessionId,draftId:draft.id}
 }
 async refreshDraft(){
  const target=this.target(),epoch=this.epoch,generation=++this.draftRead
  const draft=await this.ports.api.draft({sessionId:target.sessionId,draftId:target.draftId})
  if(epoch!==this.epoch||generation!==this.draftRead)return draft
  if(draft.scope!==target.draft.scope)throw invalid()
  if(draft.revision<this.state.draft!.revision)return draft
  if(draft.revision===this.state.draft!.revision&&draft.hash!==this.state.draft!.hash)throw invalid()
  const changed=draft.revision!==this.state.draft!.revision||draft.status!==this.state.draft!.status
  this.publish({draft,...(changed?{preview:null,pageStatus:'idle' as const}:{}),error:null})
  await this.refreshSetupPlan()
  return draft
 }
 private same(epoch:number,draft:BusinessConfigurationDraftResponse){return epoch===this.epoch&&this.state.draft?.id===draft.id&&this.state.draft.revision===draft.revision&&this.state.draft.hash===draft.hash}
 async preview(){
  const {sessionId,draftId,draft}=this.target(),epoch=this.epoch,generation=++this.previewRead
  const result=await this.ports.api.preview({sessionId,draftId,expectedRevision:draft.revision})
  if(result.candidateHash!==draft.hash||result.baseVersion!==draft.baseVersion)throw invalid()
  if(this.same(epoch,draft)&&generation===this.previewRead)this.publish({preview:result,error:null})
  return result
 }
 async page(pageId:string,timeRange?:BusinessTimeRange){
  const {sessionId,draftId,draft}=this.target(),epoch=this.epoch,generation=++this.pageRead
  this.publish({pageStatus:'loading',error:null})
  try{
   const result=await this.ports.api.page({sessionId,draftId,expectedRevision:draft.revision,pageId,...(timeRange===undefined?{}:{timeRange})})
   if(result.configurationHash!==draft.hash||result.scope!==draft.scope)throw invalid()
   if(this.same(epoch,draft)&&generation===this.pageRead)this.publish({page:result,pageStatus:'ready'})
   return result
  }catch(error){if(this.same(epoch,draft)&&generation===this.pageRead)this.publish({pageStatus:'invalid',error});throw error}
 }
 async refreshSetupPlan(){
  if(!this.ports.api.setupPlan)return null
  const target=this.target(),epoch=this.epoch,plan=await this.ports.api.setupPlan({sessionId:target.sessionId,draftId:target.draftId})
  if(epoch===this.epoch){const changed=plan?.revision!==this.state.setupPlan?.revision||plan?.configurationHash!==this.state.setupPlan?.configurationHash;this.publish({setupPlan:plan,...(changed?{setupPreview:null}: {})})}
  return plan
 }
 async readManual(){const target=this.target(),epoch=this.epoch;const manual=await this.ports.api.setupManual({sessionId:target.sessionId,draftId:target.draftId});if(!this.same(epoch,target.draft)||manual.configurationRevision!==target.draft.revision||manual.configurationHash!==target.draft.hash)throw conflict('原业务草案已变化，请刷新后编辑。');this.manualIntent=undefined;return manual}
 private manualInputKey(draftId:string){if(this.target().draftId!==draftId)throw conflict('编辑目标已变化。');return this.ports.journalKey+'/setup-editor/'+draftId}
 readManualInput(snapshot:BusinessSetupManual){const raw=this.ports.storage.getItem(this.manualInputKey(snapshot.draftId));if(raw===null)return null;const value=readBusinessSetupManualInput(raw);if(value.snapshot.draftId!==snapshot.draftId||value.snapshot.candidate.scope!==snapshot.candidate.scope)throw conflict('编辑恢复内容不属于当前草案。');return value}
 writeManualInput(value:BusinessSetupManualInput){const key=this.manualInputKey(value.snapshot.draftId),raw=serializeBusinessSetupManualInput(value);this.ports.storage.setItem(key,raw);if(this.ports.storage.getItem(key)!==raw)throw conflict('编辑输入尚未可靠保存在本机。')}
 clearManualInput(snapshot:BusinessSetupManual){this.ports.storage.removeItem(this.manualInputKey(snapshot.draftId))}
 async saveManual(snapshot:BusinessSetupManual,edit:Pick<BusinessSetupManual,'candidate'|'description'|'roleEdits'>){
  const target=this.target(),epoch=this.epoch
  if(this.pendingSave()||this.pendingSetupSave()||target.draft.status!=='draft'||snapshot.draftId!==target.draftId||snapshot.configurationRevision!==target.draft.revision||snapshot.configurationHash!==target.draft.hash||(this.state.setupPlan?.revision??0)!==snapshot.revision)throw conflict('编辑所依据的方案已变化，请重新读取原稿。')
  const spec=JSON.stringify([snapshot,edit]);if(this.manualIntent&&this.manualIntent.spec!==spec)throw conflict('上次编辑结果待核对，请先读取原稿。')
  const intent=this.manualIntent??{spec,input:{sessionId:target.sessionId,draftId:target.draftId,requestId:this.ports.id(),expectedRevision:snapshot.revision,configurationRevision:snapshot.configurationRevision,configurationHash:snapshot.configurationHash,...edit}}
  this.manualIntent=intent
  const plan=await this.ports.api.setupEdit(intent.input)
  if(this.manualIntent===intent)this.manualIntent=undefined
  if(epoch===this.epoch){await this.refreshDraft();if(epoch===this.epoch)await this.previewSetup([])}
  return plan
 }
 async restoreConfiguration(version:number,expectedHash:string){
  const target=this.target(),epoch=this.epoch
  if(target.draft.status!=='draft'||this.state.setupPlan||this.pendingSave()||this.pendingSetupSave()||!Number.isSafeInteger(version)||version<1||!hash(expectedHash))throw conflict('请选择同业务的新编辑草案复核历史版本。')
  const spec=JSON.stringify([target.draftId,target.draft.revision,target.draft.hash,version,expectedHash]);if(this.restoreIntent&&this.restoreIntent.spec!==spec)throw conflict('原版本准备结果待核对，请先读取原草案。')
  const intent=this.restoreIntent??{spec,input:{sessionId:target.sessionId,draftId:target.draftId,requestId:this.ports.id(),expectedRevision:0 as const,configurationRevision:target.draft.revision,configurationHash:target.draft.hash,version,expectedHash}}
  this.restoreIntent=intent
  const plan=await this.ports.api.setupRestore(intent.input)
  if(this.restoreIntent===intent)this.restoreIntent=undefined
  if(epoch===this.epoch){await this.refreshDraft();if(epoch===this.epoch)await this.previewSetup([])}
  return plan
 }
 async previewSetup(rejected:string[]=[]){
  const target=this.target(),plan=this.state.setupPlan,epoch=this.epoch
  if(!plan||plan.state!=='draft')throw conflict('请先保存完整业务方案草案。')
  const preview=await this.ports.api.setupPreview({sessionId:target.sessionId,draftId:target.draftId,expectedRevision:plan.revision,rejected})
  await this.refreshDraft()
  if(epoch===this.epoch)this.publish({setupPreview:preview,error:null})
  return preview
 }
 private setupJournalKey(){return this.ports.journalKey+'/setup-apply'}
 pendingSetupSave(){
  const raw=this.ports.storage.getItem(this.setupJournalKey());if(raw===null)return null
  try{if(raw.length>8192)throw Error();const value:unknown=JSON.parse(raw)
   if(!isRecord(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'scope')||!Object.hasOwn(value,'input')||!isBusinessScopeKey(value.scope)||value.scope==='general'||!isRecord(value.input))throw Error()
   const input=value.input,keys=['requestId','draftId','sessionId','expectedRevision','expectedDigest','previewReceipt']
   if(Object.keys(input).length!==keys.length||Object.keys(input).some(key=>!keys.includes(key))||!businessSetupUuid(input.requestId)||!businessSetupUuid(input.draftId)||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<1||!hash(input.expectedDigest)||!hash(input.previewReceipt))throw Error()
   readBusinessConversationSession({sessionId:input.sessionId})
   return value as {scope:string;input:{requestId:string;draftId:string;sessionId:string;expectedRevision:number;expectedDigest:string;previewReceipt:string}}
  }catch{throw conflict('方案采用恢复记录无法读取；原记录已保留，请先核对原业务会话与服务端回执。')}
 }
 adoptSetup(recover=false):Promise<BusinessSetupAdoption>{
  if(this.setupFlight)return this.setupFlight
  const operation=(async()=>{
   const target=this.target(),plan=this.state.setupPlan,preview=this.state.setupPreview,epoch=this.epoch
   let pending=this.pendingSetupSave()
   if(!pending){if(recover)throw conflict('没有待核对的方案采用请求。');if(!plan||!preview||preview.blocked||preview.revision!==plan.revision)throw conflict('请先核对完整方案与逐项决定。');pending={scope:plan.scope,input:{sessionId:target.sessionId,draftId:target.draftId,requestId:this.ports.id(),expectedRevision:plan.revision,expectedDigest:preview.digest,previewReceipt:preview.receipt}};this.ports.storage.setItem(this.setupJournalKey(),JSON.stringify(pending));if(JSON.stringify(this.pendingSetupSave())!==JSON.stringify(pending))throw conflict('采用意图无法可靠保存。')}
   if(pending.scope!==target.draft.scope||pending.input.draftId!==target.draftId||pending.input.sessionId!==target.sessionId)throw conflict('请回到原业务会话核对采用结果。')
   if(epoch===this.epoch)this.publish({phase:'saving',setupUnknown:false,error:null})
   try{
    let adoption=recover?await this.ports.api.setupReceipt(pending.input):null
    if(!adoption)try{adoption=await this.ports.api.setupApply(pending.input)}catch(error){
     if(!recover||!businessConfigurationPreviewReceiptRejected(error))throw error
     adoption=await this.ports.api.setupReceipt(pending.input)
     if(!adoption){
      const original=await this.ports.api.setupPlan({sessionId:target.sessionId,draftId:target.draftId})
      if(!original||original.state!=='draft'||original.scope!==pending.scope||original.revision!==pending.input.expectedRevision)throw conflict('原方案已变化，不能替换待核对的采用请求。')
      const checked=await this.ports.api.setupPreview({sessionId:target.sessionId,draftId:target.draftId,expectedRevision:original.revision,rejected:original.rejected})
      if(this.pendingSetupSave()?.input.requestId!==pending.input.requestId)throw conflict('采用恢复记录已变化。')
      if(epoch===this.epoch)await this.refreshDraft()
      this.ports.storage.removeItem(this.setupJournalKey())
      if(epoch===this.epoch)this.publish({phase:'ready',setupUnknown:false,setupPreview:checked,error:null})
      throw new WorkError('teloa/conflict','预览已更新，请本人重新核对后采用。',{reason:'preview-review-required'})
     }
    }
    if(adoption.configuration.scope!==pending.scope)throw invalid()
    await this.ports.refreshScopes()
    if(this.pendingSetupSave()?.input.requestId!==pending.input.requestId)throw conflict('采用恢复记录已变化。')
    if(epoch===this.epoch)await this.refreshSetupPlan()
    if(this.pendingSetupSave()?.input.requestId!==pending.input.requestId)throw conflict('采用恢复记录已变化。')
    this.ports.storage.removeItem(this.setupJournalKey())
    if(epoch===this.epoch)this.publish({phase:'saved',result:adoption.configuration,setupUnknown:false,setupPreview:null})
    return adoption
   }catch(error){if(epoch===this.epoch){const reviewed=isRecord(error)&&isRecord(error.details)&&error.details.reason==='preview-review-required';this.publish({phase:reviewed?'ready':'unknown',setupUnknown:!reviewed,error})}throw error}
  })()
  this.setupFlight=operation;void operation.then(()=>{this.setupFlight=undefined},()=>{this.setupFlight=undefined});return operation
 }
 async prepareSetup(confirmed=false){
  if(this.pendingSetupSave())throw conflict('请先核对原方案采用结果。')
  const target=this.target(),epoch=this.epoch,readiness=this.state.setupReadiness
  if(confirmed&&!readiness)throw conflict('请先读取并核对资源准备清单。')
  const plan=await this.ports.api.setupPrepare({sessionId:target.sessionId,draftId:target.draftId,...(confirmed?{expectedDigest:readiness!.digest}:{})})
  const after=await this.ports.api.setupReadiness({sessionId:target.sessionId,draftId:target.draftId})
  if(epoch===this.epoch)this.publish({setupPlan:plan,setupReadiness:after,error:null})
  return plan
 }
 save():Promise<BusinessConfigurationApplyResult>{
  if(this.saveFlight)return this.saveFlight
  try{
   const journal=this.journal()
   if(this.pendingSetupSave())throw conflict('请先核对原完整方案采用结果。')
   if(this.state.setupPlan)throw conflict('请在完整方案预览中采用业务。')
   if(journal.save)throw conflict('上次保存结果仍待核对，请先读取原请求回执。')
   const {sessionId,draftId,draft}=this.target(),preview=this.state.preview
   if(draft.status!=='draft'||!preview||preview.impact?.blocked||preview.draftId!==draftId||preview.revision!==draft.revision||preview.candidateHash!==draft.hash||preview.baseVersion!==draft.baseVersion)throw conflict('业务草案已变化或影响现有记录，请重新预览后保存。')
   const input={sessionId,draftId,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:preview.receipt,requestId:this.ports.id()}
   readBusinessBuilderRequest('business-configuration/apply',input)
   const intent={input,scope:draft.scope,candidateHash:draft.hash}
   this.write({...journal,save:intent},journal)
   return this.runSave(intent,false)
  }catch(error){return Promise.reject(error)}
 }
 recoverSave():Promise<BusinessConfigurationApplyResult>{
  if(this.saveFlight)return this.saveFlight
  try{const intent=this.journal().save;if(!intent)throw conflict('没有待核对的业务保存请求。');return this.runSave(intent,true)}catch(error){return Promise.reject(error)}
 }
 private runSave(intent:SaveIntent,recover:boolean):Promise<BusinessConfigurationApplyResult>{
  const epoch=this.epoch,draft=this.state.draft
  const visible=()=>epoch===this.epoch&&(!draft||draft.id===intent.input.draftId&&draft.revision===intent.input.expectedRevision&&draft.hash===intent.candidateHash&&this.same(epoch,draft))
  if(visible())this.publish({phase:recover?'recovering':'saving',error:null})
  const receipt=async()=>{await this.ports.refreshScopes();return this.ports.api.receipt({requestId:intent.input.requestId})}
  const operation=(async()=>{
   try{
    let result=recover?await receipt():null,applied=false
    if(!result){
     try{result=await this.ports.api.apply(intent.input);applied=true}
     catch(error){
      // 未知网络结果、权限/版本/一般冲突绝不刷新token或修改固定请求。
      if(!recover||!businessConfigurationPreviewReceiptRejected(error))throw error
      result=await receipt()
      if(!result){
       const current=await this.ports.api.draft({sessionId:intent.input.sessionId,draftId:intent.input.draftId})
       if(current.status!=='draft'||current.revision!==intent.input.expectedRevision||current.baseVersion!==intent.input.expectedBaseVersion||current.hash!==intent.candidateHash||current.scope!==intent.scope)throw conflict('原草案已变化，不能改写待核对的保存请求。')
       const preview=await this.ports.api.preview({sessionId:intent.input.sessionId,draftId:intent.input.draftId,expectedRevision:intent.input.expectedRevision})
       if(preview.candidateHash!==intent.candidateHash||preview.baseVersion!==intent.input.expectedBaseVersion)throw invalid()
       const journal=this.journal()
       if(JSON.stringify(journal.save)!==JSON.stringify(intent))throw conflict('保存恢复记录已变化。')
       this.write({...journal,save:null},journal)
       if(visible())this.publish({draft:current,preview,phase:'ready',error:null})
       throw new WorkError('teloa/conflict','预览已更新，请本人核对后再次采用。',{reason:'preview-review-required'})
      }
     }
    }
    if(result.scope!==intent.scope||result.version!==intent.input.expectedBaseVersion+1||result.requestId!==intent.input.requestId.toLowerCase())throw invalid()
    if(applied)await this.ports.refreshScopes()
    const journal=this.journal()
    if(JSON.stringify(journal.save)!==JSON.stringify(intent))throw conflict('保存恢复记录已变化。')
    this.write({...journal,save:null},journal)
    if(visible())this.publish({phase:'saved',result,preview:null,error:null})
    return result
   }catch(error){
    if(visible())this.publish({phase:isRecord(error)&&isRecord(error.details)&&error.details.reason==='preview-review-required'?'ready':code(error)==='teloa/version-conflict'||code(error)==='teloa/forbidden'?'error':'unknown',error})
    throw error
   }
  })()
  this.saveFlight=operation
  void operation.then(()=>{this.saveFlight=undefined},()=>{this.saveFlight=undefined})
  return operation
 }
}
