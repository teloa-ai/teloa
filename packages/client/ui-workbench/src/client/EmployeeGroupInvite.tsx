import {useEffect,useRef,useState} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import {Search,Users} from 'lucide-react'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {useBusinessScopes} from './business-scope-context.js'
import {employeeCopy} from './employee-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {applicationPresentation} from './application-presentation.js'
import type {GroupApi,GroupSnapshot} from './group-api.js'
import type {PreviewRole} from './role-preview.js'
import css from './EmployeeGroupInvite.module.css'
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'

const inviteDrafts=createRoleFormDrafts<GroupSnapshot>()
const searchDrafts=createRoleFormDrafts<string>()

/** 加入原群只改变成员关系；不调用员工资料授权或执行授权入口。 */
export function EmployeeGroupInvite({role,api,close,invited}:{role:PreviewRole;api:GroupApi;close:()=>void;invited:(groupId:string)=>void}){
 const {locale,t}=useI18n(),scopes=useBusinessScopes(),[items,setItems]=useState<GroupSnapshot[]>(),[loadError,setLoadError]=useState<string>(),[loadAttempt,retryLoad]=useState(0)
 const [slot,draft]=useRoleFormDraft(inviteDrafts,api,role.id),selected=draft.value?.group.id??'',busy=!!draft.pending,error=draft.error?localizeWorkError(locale,draft.error):loadError
 const [searchSlot,searchDraft]=useRoleFormDraft(searchDrafts,api,role.id),query=searchDraft.value??''
 const available=items&&draft.value&&!items.some(({group})=>group.id===selected)?[draft.value,...items]:items
 const visible=available?.filter(({group})=>[group.name,group.purpose,scopes[group.scope]].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale)))
 const current=useRef(slot),mounted=useRef(true);current.current=slot
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{let active=true;setItems(undefined);setLoadError(undefined);void api.list().then(async({items})=>{
  const rows:GroupSnapshot[]=[]
  for(let start=0;start<items.length;start+=4)rows.push(...await Promise.all(items.slice(start,start+4).map(group=>api.get(group.id))))
  if(active)setItems(rows.filter(({group,members})=>!group.archived&&!members.some(member=>member.roleId===role.id)))
 }).catch(error=>{if(active)setLoadError(localizeWorkError(locale,error))});return()=>{active=false}},[api,role.id,locale,loadAttempt])
 return <ContextDrawer compact title={employeeCopy(locale,'inviteTitle')} close={()=>{if(!busy)close()}} canClose={!busy}><form className={css.form} onSubmit={async event=>{
  event.preventDefault();if(busy||!selected||!applicationPresentation.can('people')||role.state==='retired')return
  const original=draft.value
  if(!original)return
  try{
   await slot.run(original,async()=>{
    const latest=await api.get(original.group.id),{group,members}=original
    if(latest.group.archived)throw Error(employeeCopy(locale,'groupArchived'))
    if(latest.members.some(member=>member.roleId===role.id))return
    if(latest.group.version!==group.version)throw Object.assign(Error('group version changed'),{code:'teloa/version-conflict'})
    await api.change(group.id,group.version,{name:group.name,announcement:group.announcement,rules:{...group.rules},memberRoleIds:[...members.flatMap(member=>member.roleId?[member.roleId]:[]),role.id],pinned:group.pinned,archived:group.archived})
   })
   if(mounted.current&&current.current===slot){searchSlot.set(undefined);invited(original.group.id);close()}
  }catch{/* 原请求与失败草稿留在当前 API 的槽中。 */}
 }}>
  <div className={css.body}>
   <div className={css.identity}><EmployeeAvatar avatarKey={role.avatarKey} size="sm"/><div><strong>{role.name}</strong><p>{employeeCopy(locale,'invitePrompt')}</p></div></div>
   <label className={css.search}><Search size={16} aria-hidden/><input type="search" aria-label={employeeCopy(locale,'searchGroups')} placeholder={employeeCopy(locale,'searchGroups')} value={query} disabled={busy} onChange={event=>searchSlot.set(event.target.value)}/></label>
   {error&&<div className={css.error} role="alert"><p>{error}</p>{loadError&&<button type="button" disabled={busy} onClick={()=>retryLoad(value=>value+1)}>{t('common.retry')}</button>}</div>}
   <fieldset disabled={busy} className={css.groups}>
    <legend>{employeeCopy(locale,'chooseGroup')}</legend>
    {!items&&!loadError&&<p className={css.empty} role="status">{t('team.loading')}</p>}
    {items?.length===0&&<p className={css.empty}>{employeeCopy(locale,'noInviteGroups')}</p>}
    {items&&items.length>0&&visible?.length===0&&<p className={css.empty} role="status">{employeeCopy(locale,'noGroupMatches')}</p>}
    {visible?.map(snapshot=>{const {group,members}=snapshot;return <label key={group.id} className={css.choice}><input type="radio" name="invite-group" value={group.id} checked={selected===group.id} onChange={()=>slot.set(snapshot)}/><Users size={18} className={css.groupIcon} aria-hidden/><span className={css.groupText}><strong>{group.name}</strong><small>{[scopes[group.scope],t('collaboration.members.savedCount',{count:members.length})].filter(Boolean).join(' · ')}</small>{group.purpose&&<span className={css.purpose}>{group.purpose}</span>}</span></label>})}
   </fieldset>
  </div>
  <footer className={css.footer}><p>{employeeCopy(locale,'inviteBoundary')}</p><div className={css.actions}><span>{draft.value?.group.name}</span><button type="button" disabled={busy} onClick={close}>{t('team.form.cancel')}</button><button className={css.primary} type="submit" disabled={busy||!selected||!items?.length}>{employeeCopy(locale,busy?'joiningGroup':'joinGroup')}</button></div></footer>
 </form></ContextDrawer>
}
