import {useEffect,useMemo,useRef,useState} from 'react'
import {roleSupportsScope,type BusinessResponsibility as Responsibility,type DigitalRole} from '@teloa/contract'
import type {BusinessResponsibilityApi} from './business-responsibility-api.js'
import type {RoleApi} from './role-api.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessResponsibility.module.css'

export type BusinessResponsibilityProps={scope:string;api:BusinessResponsibilityApi;roles:Pick<RoleApi,'list'>;onChanged?:()=>void}
type State={identity:object;current:Responsibility|null;roles:DigitalRole[];selection:string;pending:boolean;busy:boolean;error:boolean}
/** 可选业务负责人；设置只保存归属，不创建任务或启动工作。 */
export function BusinessResponsibility({scope,api,roles,onChanged}:BusinessResponsibilityProps){
 const {t}=useI18n(),identity=useMemo(()=>({}),[scope,api,roles]),active=useRef<object|null>(identity),running=useRef<object|null>(null)
 active.current=identity
 const [state,setState]=useState<State>({identity,current:null,roles:[],selection:'',pending:false,busy:true,error:false})
 const visible=state.identity===identity?state:null,live=()=>active.current===identity
 function hasPending(){try{return api.pending(scope)!==null}catch{return false}}
 async function load(){
  if(running.current===identity)return
  running.current=identity;setState({identity,current:null,roles:[],selection:'',pending:false,busy:true,error:false})
  try{
   const [current,directory]=await Promise.all([api.reconcile({scope}),roles.list()])
   if(live())setState({identity,current,roles:directory,selection:current.roleId??'',pending:api.pending(scope)!==null,busy:false,error:false})
  }catch{if(live())setState({identity,current:null,roles:[],selection:'',pending:hasPending(),busy:false,error:true})}
  finally{if(running.current===identity)running.current=null}
 }
 useEffect(()=>{active.current=identity;void load();return()=>{if(active.current===identity)active.current=null}},[identity])
 async function save(mode:'save'|'recover'|'reselect'='save'){
  if(!visible||visible.busy||running.current===identity)return
  running.current=identity;setState(previous=>({...previous,busy:true,error:false}))
  try{
   let current:Responsibility,directory=visible.roles
   if(mode!=='save')[current,directory]=await Promise.all([mode==='recover'?api.recover({scope}):api.reselect({scope}),roles.list()])
   else{
    if(!visible.current)throw Error('Responsibility is not loaded')
    const selected=visible.selection?visible.roles.find(role=>role.id===visible.selection):undefined
    if(visible.selection&&(!selected||selected.state!=='active'||selected.kind!=='employee'||!roleSupportsScope(selected.scopes,scope)))throw Error('Role is unavailable')
    await api.set({scope,requestId:crypto.randomUUID(),expectedVersion:visible.current.version,role:selected?{id:selected.id,expectedVersion:selected.version}:null})
    if(!live())return
    current=await api.read({scope})
   }
   if(live()){const pending=api.pending(scope)!==null;setState(previous=>({...previous,current,roles:directory,selection:current.roleId??'',pending,busy:false,error:false}));if(!pending)onChanged?.()}
  }catch{if(live()){const pending=hasPending();setState(previous=>({...previous,current:pending?previous.current:null,pending,busy:false,error:true}))}}
  finally{if(running.current===identity)running.current=null}
 }
 const current=visible?.current,selected=current?.roleId?visible?.roles.find(role=>role.id===current.roleId):undefined
 const eligible=visible?.roles.filter(role=>role.kind==='employee'&&role.state==='active'&&roleSupportsScope(role.scopes,scope)&&!(role.id===current?.roleId&&current.availability!=='ready'))??[]
 const unavailable=current?.roleId&&!eligible.some(role=>role.id===current.roleId)
 const disabled=!visible||visible.busy||visible.pending
 let canReselect=false
 try{canReselect=!!visible?.pending&&api.canReselect(scope)}catch{/* 身份失效/存储损坏不会开放重新选择。 */}
 const optionRoles=unavailable&&selected?[selected,...eligible]:eligible
 const readable=(value:string)=>value.trim().replace(/\s+/g,' ')
 function roleLabel(role:DigitalRole){
  const peers=optionRoles.filter(other=>other.name===role.name)
  if(peers.length<2)return role.name
  const duty=readable(role.duty),short=duty.slice(0,100)
  let detail=peers.filter(other=>readable(other.duty).slice(0,100)===short).length>1?duty:short
  if(peers.filter(other=>readable(other.duty)===duty).length>1)detail=[duty,readable(role.dataScope),readable(role.executionScope)].join(' · ')
  return role.name+' — '+detail
 }
 return <section className={css.card} aria-label={t('business.responsibility.title')} aria-busy={!visible||visible.busy}>
  <header><h2>{t('business.responsibility.title')}</h2><p>{t('business.responsibility.optional')}</p></header>
  {(!visible||visible.busy&&!current)&&<p role="status">{t('business.responsibility.loading')}</p>}
  {visible?.error&&<p className={css.notice} role="alert">{t('business.responsibility.failed')}{!visible.pending&&<button type="button" disabled={visible.busy} onClick={()=>void load()}>{t('business.records.retry')}</button>}</p>}
  {current&&<>
   <p className={css.current}>{current.roleId?(selected?.name??t('business.responsibility.unavailable')):t('business.responsibility.none')}
    {current.availability!=='none'&&current.availability!=='ready'&&<span>{t(`business.responsibility.${current.availability}`)}</span>}
   </p>
   <div className={css.form}>
    <label>{t('business.responsibility.select')}<select value={visible!.selection} disabled={disabled} onChange={event=>setState(previous=>({...previous,selection:event.target.value}))}>
     <option value="">{t('business.responsibility.none')}</option>
     {unavailable&&<option value={current.roleId!} disabled>{selected?roleLabel(selected):t('business.responsibility.unavailable')}</option>}
     {eligible.map(role=><option key={role.id} value={role.id}>{roleLabel(role)}</option>)}
    </select></label>
    <button type="button" className={css.primary} disabled={disabled||visible!.selection===(current.roleId??'')} onClick={()=>void save()}>{t('business.responsibility.save')}</button>
   </div>
  </>}
  {visible?.pending&&<div className={css.notice} role="status"><p>{t('business.responsibility.pending')}</p><button type="button" disabled={visible.busy} onClick={()=>void save('recover')}>{t('business.responsibility.recover')}</button>{canReselect&&<button type="button" disabled={visible.busy} onClick={()=>void save('reselect')}>{t('business.responsibility.reselect')}</button>}</div>}
 </section>
}
