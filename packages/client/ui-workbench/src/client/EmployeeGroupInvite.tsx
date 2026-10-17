import {useEffect,useRef,useState} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import {employeeCopy} from './employee-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {applicationPresentation} from './application-presentation.js'
import type {GroupApi,GroupSnapshot} from './group-api.js'
import type {PreviewRole} from './role-preview.js'
import css from './TaskPage.module.css'
import teamCss from './TeamPage.module.css'
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'

const inviteDrafts=createRoleFormDrafts<GroupSnapshot>()

/** 加入原群只改变成员关系；不调用员工资料授权或执行授权入口。 */
export function EmployeeGroupInvite({role,api,close,invited}:{role:PreviewRole;api:GroupApi;close:()=>void;invited:(groupId:string)=>void}){
 const {locale,t}=useI18n(),[items,setItems]=useState<GroupSnapshot[]>(),[loadError,setLoadError]=useState<string>()
 const [slot,draft]=useRoleFormDraft(inviteDrafts,api,role.id),selected=draft.value?.group.id??'',busy=!!draft.pending,error=draft.error?localizeWorkError(locale,draft.error):loadError
 const current=useRef(slot),mounted=useRef(true);current.current=slot
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{let active=true;void api.list().then(async({items})=>{
  const rows:GroupSnapshot[]=[]
  for(let start=0;start<items.length;start+=4)rows.push(...await Promise.all(items.slice(start,start+4).map(group=>api.get(group.id))))
  if(active)setItems(rows.filter(({group,members})=>!group.archived&&!members.some(member=>member.roleId===role.id)))
 }).catch(error=>{if(active)setLoadError(localizeWorkError(locale,error))});return()=>{active=false}},[api,role.id,locale])
 return <ContextDrawer title={employeeCopy(locale,'inviteTitle')} close={()=>{if(!busy)close()}} canClose={!busy} {...(css.dialog?{className:css.dialog}:{})}><form className={css.form} onSubmit={async event=>{
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
   if(mounted.current&&current.current===slot){invited(original.group.id);close()}
  }catch{/* 原请求与失败草稿留在当前 API 的槽中。 */}
 }}>
  <p>{role.name}</p><p className={css.muted}>{employeeCopy(locale,'inviteBoundary')}</p>
  {error&&<p role="alert">{error}</p>}
  <fieldset disabled={busy} className={teamCss.formBody}>
   {items?<label>{employeeCopy(locale,'chooseGroup')}<select aria-label={employeeCopy(locale,'chooseGroup')} required value={selected} onChange={event=>slot.set(items.find(({group})=>group.id===event.target.value))}><option value="">{employeeCopy(locale,'chooseGroup')}</option>{selected&&!items.some(({group})=>group.id===selected)&&<option value={selected}>{draft.value?.group.name}</option>}{items.map(({group})=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>:!error&&<p role="status">{t('team.loading')}</p>}
   {items?.length===0&&<p>{employeeCopy(locale,'noInviteGroups')}</p>}
   <footer className={css.buttons}><button type="button" onClick={close}>{t('team.form.cancel')}</button><button type="submit" disabled={!selected||!items?.length}>{employeeCopy(locale,'invite')}</button></footer>
  </fieldset>
 </form></ContextDrawer>
}
