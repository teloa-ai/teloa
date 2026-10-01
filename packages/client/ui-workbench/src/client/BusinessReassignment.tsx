import {useEffect,useId,useMemo,useRef,useState} from 'react'
import {isBusinessScopeKey,readBusinessReassignmentSelection,roleSupportsScope,type DigitalRole} from '@teloa/contract'
import {verifyBusinessReassignmentReceipt,type BusinessReassignmentOriginal,type BusinessReassignmentReceiptIdentity} from './business-reassignment-api.ts'
import type {BusinessReassignmentInputSelection} from './business-reassignment-input.ts'
import {BUSINESS_REASSIGNMENT_MESSAGES} from './i18n/locales/business-reassignment.ts'
import css from './BusinessReassignment.module.css'

export type BusinessReassignmentDailyIntent={scope:string;newConversation:true;oldRequestId:string}
export type BusinessReassignmentOutcome={oldRequestId:string}&(
 {phase:'stop-submitted'|'reconciling'|'no-successor'}|
 {phase:'established';expected:BusinessReassignmentReceiptIdentity;receipt:unknown}
)
export type BusinessReassignmentProps={
 locale:string;scope:string;sessionId:string
 context:{scope:string;sessionId:string;version:number;roleId:string|null}
 /** 仅传原 session 的已授权定位，不传旧正文。 */
 originals:readonly BusinessReassignmentOriginal[]
 /** 跨 daily 只携带本人此前明确选定的旧请求 ID。 */
 carriedOldRequestId?:string
 roles:readonly DigitalRole[];outcome?:BusinessReassignmentOutcome
 onPrepare:(selection:BusinessReassignmentInputSelection)=>Promise<void>
 onNewDaily:(intent:BusinessReassignmentDailyIntent)=>Promise<void>
}
type RoleSelection={id:string;version:number;name:string}
type State={identity:object;oldRequestId:string;role:RoleSelection|null;busy:boolean;prepared:boolean;failed:boolean}
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
/** 不写任务、context 或草稿；本人选择只输出原生输入准备和明确 daily 导航意图。 */
export function BusinessReassignment({locale,scope,sessionId,context,originals,carriedOldRequestId,roles,outcome,onPrepare,onNewDaily}:BusinessReassignmentProps){
 const messages=BUSINESS_REASSIGNMENT_MESSAGES[locale.startsWith('zh')?'zh':'en'],hintId=useId()
 const identity=useMemo(()=>({}),[scope,sessionId,context.scope,context.sessionId,context.version,context.roleId,carriedOldRequestId,onPrepare,onNewDaily]),active=useRef<object|null>(identity),running=useRef<object|null>(null)
 active.current=identity
 const first=carriedOldRequestId??(originals.length===1?originals[0]!.oldRequestId:'')
 const [state,setState]=useState<State>({identity,oldRequestId:first,role:null,busy:false,prepared:false,failed:false})
 const visible=state.identity===identity?state:{identity,oldRequestId:first,role:null,busy:false,prepared:false,failed:false}
 useEffect(()=>{active.current=identity;return()=>{if(active.current===identity)active.current=null}},[identity])
 const original=originals.find(row=>row.oldRequestId===visible.oldRequestId)
 let invalid=!isBusinessScopeKey(scope)||scope==='general'||context.scope!==scope||context.sessionId!==sessionId||!Number.isSafeInteger(context.version)||context.version<1||(context.roleId!==null&&!uuid(context.roleId))||!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)
 const seen=new Set<string>()
 for(const row of originals){if(row.scope!==scope||row.oldSessionId!==sessionId||!uuid(row.oldRequestId)||!uuid(row.oldRoleId)||seen.has(row.oldRequestId))invalid=true;seen.add(row.oldRequestId)}
 if(carriedOldRequestId!==undefined&&!uuid(carriedOldRequestId))invalid=true
 const validOriginal=!!visible.oldRequestId&&(!!original||visible.oldRequestId===carriedOldRequestId)
 const eligible=roles.filter(role=>uuid(role.id)&&Number.isSafeInteger(role.version)&&role.version>=1&&role.name===role.name.trim()&&!!role.name&&role.name.length<=120&&!/[\x00-\x1f\x7f]/.test(role.name)&&role.kind==='employee'&&role.state==='active'&&roleSupportsScope(role.scopes,scope)&&role.id!==original?.oldRoleId)
 const selected=visible.role&&eligible.find(role=>role.id===visible.role!.id&&role.version===visible.role!.version&&role.name===visible.role!.name)
 const conflict=!!selected&&context.roleId!==null&&context.roleId!==selected.id
 let established=false
 let phase:string=original?.stopSubmitted?messages.stopSubmitted:messages.reconciling
 if(outcome&&outcome.oldRequestId===visible.oldRequestId){
  if(outcome.phase==='established'){
   try{
    const receipt=verifyBusinessReassignmentReceipt(outcome.receipt,outcome.expected)
    if(receipt.oldRequestId!==visible.oldRequestId||receipt.newSessionId!==sessionId||receipt.scope!==scope||original&&receipt.oldSessionId!==original.oldSessionId)throw Error()
    established=true;phase=messages.established
   }catch{invalid=true;phase=messages.reconciling}
  }else phase=outcome.phase==='stop-submitted'?messages.stopSubmitted:outcome.phase==='no-successor'?messages.noSuccessor:messages.reconciling
 }
 const disabled=invalid||visible.busy||!validOriginal||!selected||established
 function change(patch:Partial<State>){setState({...visible,...patch,identity,prepared:false,failed:false})}
 async function prepare(newDaily=false){
  if(disabled||running.current===identity||!selected||!validOriginal||conflict&&!newDaily||!conflict&&newDaily)return
  const selection=readBusinessReassignmentSelection({oldRequestId:visible.oldRequestId,newRoleId:selected.id,expectedNewRoleVersion:selected.version})
  running.current=identity;setState({...visible,busy:true,failed:false})
  try{
   if(newDaily)await onNewDaily({scope,newConversation:true,oldRequestId:selection.oldRequestId})
   else await onPrepare({...selection,scope,newRoleName:selected.name,expectedContext:{version:context.version,roleId:context.roleId}})
   if(active.current===identity)setState(previous=>({...previous,busy:false,prepared:!newDaily,failed:false}))
  }catch{if(active.current===identity)setState(previous=>({...previous,busy:false,prepared:false,failed:true}))}
  finally{if(running.current===identity)running.current=null}
 }
 return <section className={css.card} aria-label={messages.title} aria-busy={visible.busy}>
  <header><h2>{messages.title}</h2><p id={hintId} className={css.hint}>{messages.hint}</p></header>
  <p role="status" aria-live="polite" className={css.status}>{phase}{visible.busy?' · '+messages.busy:visible.prepared&&!!selected&&validOriginal?' · '+messages.prepared:''}</p>
  {(invalid||visible.failed)&&<p role="alert" className={css.notice}>{invalid?messages.invalid:messages.failed}</p>}
  <div className={css.form}>
   <label>{messages.original}<select aria-label={messages.original} aria-describedby={hintId} disabled={invalid||visible.busy} value={validOriginal?visible.oldRequestId:''} onChange={event=>change({oldRequestId:event.target.value,role:null})}>
    <option value="">{messages.chooseOriginal}</option>
    {originals.map(row=><option key={row.oldRequestId} value={row.oldRequestId}>{row.title}</option>)}
    {carriedOldRequestId&&!originals.some(row=>row.oldRequestId===carriedOldRequestId)&&<option value={carriedOldRequestId}>{messages.carried}: {carriedOldRequestId}</option>}
   </select></label>
   <label>{messages.newColleague}<select aria-label={messages.newColleague} aria-describedby={hintId} disabled={invalid||visible.busy||!validOriginal} value={selected?.id??''} onChange={event=>{const role=eligible.find(row=>row.id===event.target.value);change({role:role?{id:role.id,version:role.version,name:role.name}:null})}}>
    <option value="">{messages.chooseColleague}</option>
    {eligible.map(role=><option key={role.id} value={role.id}>{role.name} · v{role.version}</option>)}
   </select></label>
  </div>
  {conflict&&<p className={css.notice}>{messages.conflict}</p>}
  <div className={css.actions}>
   <button type="button" className={css.primary} disabled={disabled||conflict} onClick={()=>void prepare()}>{messages.prepare}</button>
   {conflict&&<button type="button" disabled={disabled} onClick={()=>void prepare(true)}>{messages.newDaily}</button>}
  </div>
 </section>
}
