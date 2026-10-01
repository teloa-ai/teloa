import {WorkError,isBusinessScopeKey,readBusinessReassignmentSelection,type BusinessReassignmentSelection} from '@teloa/contract'
import type {InputState,InsertTextRequest} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {HomeWorkContext} from './home-native-controller.ts'
import {checkBusinessBuilderSwitch,switchDecision,type BusinessBuilderSwitchPort} from './business-builder-flow.ts'

export type BusinessReassignmentInputSelection=BusinessReassignmentSelection&{scope:string;newRoleName:string;expectedContext:Pick<HomeWorkContext,'version'|'roleId'>}
export type BusinessReassignmentInputPort={
 switching:BusinessBuilderSwitchPort
 /** 绑定发起时的scope/session/context版本与岗位，回显期间也须保持同一身份。 */
 isCurrent:()=>boolean
 verify:()=>Promise<BusinessReassignmentInputSelection&{context:HomeWorkContext|null}>
 state:{getSnapshot:()=>InputState;subscribe:(listener:()=>void)=>()=>void}
 insertText:(request:InsertTextRequest)=>true|undefined
 locale?:string
}
const failure=()=>new WorkError('teloa/conflict','请保留原输入，核对当前业务、会话与所选员工后重新带入改派指令。',{reason:'reassignment-input'})
function selected(value:BusinessReassignmentInputSelection):BusinessReassignmentInputSelection{
 const selection=readBusinessReassignmentSelection({oldRequestId:value.oldRequestId,newRoleId:value.newRoleId,expectedNewRoleVersion:value.expectedNewRoleVersion})
 if(!isBusinessScopeKey(value.scope)||value.scope==='general'||typeof value.newRoleName!=='string'||!value.newRoleName.trim()||value.newRoleName!==value.newRoleName.trim()||value.newRoleName.length>120||/[\x00-\x1f\x7f]/.test(value.newRoleName))throw failure()
 const context=value.expectedContext
 if(!context||!Number.isSafeInteger(context.version)||context.version<1||context.version>2147483647||context.roleId!==null&&(typeof context.roleId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(context.roleId)))throw failure()
 return {...selection,scope:value.scope,newRoleName:value.newRoleName,expectedContext:{version:context.version,roleId:context.roleId}}
}
/** 草稿、附件及发送仍由官方输入持有；这里只核对空输入并带入本人待确认文本。 */
export async function insertBusinessReassignmentInput(value:BusinessReassignmentInputSelection,sessionId:string,port:BusinessReassignmentInputPort):Promise<void>{
 const selection=selected(value),initial=port.switching.read(),input=port.state.getSnapshot()
 const current=()=>{const state=port.switching.read();return port.isCurrent()&&state.mainSessionId===sessionId&&state.bindingSessionId===sessionId&&state.input===port.state.getSnapshot()}
 if(!current()||initial.input!==input||await checkBusinessBuilderSwitch(port.switching)!=='ready'||port.state.getSnapshot()!==input)throw failure()
 const verified=await port.verify(),context=verified.context
 // 原work-context/read对象是当前事实；兼容岗位也不能掩盖审批前的context版本变化。
 if(JSON.stringify(selected(verified))!==JSON.stringify(selection)||!context||context.sessionId!==sessionId||context.scopeId!==selection.scope||context.version!==selection.expectedContext.version||context.roleId!==selection.expectedContext.roleId||typeof context.locked!=='boolean'||context.roleId!==null&&context.roleId!==selection.newRoleId||!current()||port.state.getSnapshot()!==input||switchDecision(port.switching.read(),false)!=='ready')throw failure()
 const name=JSON.stringify(selection.newRoleName),text=port.locale?.startsWith('en')
  ?`Please reassign original work request ${selection.oldRequestId} to colleague ${name} (role ${selection.newRoleId}, version ${selection.expectedNewRoleVersion}). Keep the original materials and record reference; prepare the reassignment for my approval.`
  :`请将原交办（请求 ${selection.oldRequestId}）改派给同事 ${name}（岗位 ${selection.newRoleId}，版本 ${selection.expectedNewRoleVersion}）。保留原资料和记录引用，先准备改派并让我确认。`
 await new Promise<void>((resolve,reject)=>{
  let settled=false,applied=false,off=()=>{}
  const finish=(error?:Error)=>{if(settled)return;settled=true;off();clearTimeout(timer);error?reject(error):resolve()}
  const check=()=>{
   if(!applied||settled)return
   try{
    const next=port.state.getSnapshot()
    if(next===input)return
    if(!current()||switchDecision(port.switching.read(),true)!=='ready'||next.draftRev!==input.draftRev+1||next.draft!==text||next.phase!=='plain'||next.attachmentIds.length||next.occurrences.length||next.queue.length||next.claim!==undefined)finish(failure())
    else finish()
   }catch(error){finish(error instanceof Error?error:failure())}
  }
  // 超时结果仍待核对；不清稿、不重试、不自动发送。
  const timer=setTimeout(()=>finish(failure()),3000)
  off=port.state.subscribe(check)
  try{applied=port.insertText({text,span:{start:0,end:0,draftRev:input.draftRev}})===true;if(!applied)finish(failure());else check()}catch(error){finish(error instanceof Error?error:failure())}
  if(settled)off()
 })
}
