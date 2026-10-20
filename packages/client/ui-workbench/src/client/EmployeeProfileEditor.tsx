import {useState} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import {EmployeeAvatarPicker} from './EmployeeAvatarPicker.js'
import {employeeCopy} from './employee-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {applicationPresentation} from './application-presentation.js'
import type {PreviewRole,RoleFields} from './role-preview.js'
import css from './TaskPage.module.css'
import teamCss from './TeamPage.module.css'

export type EmployeeProfileFields=Pick<RoleFields,'name'|'duty'|'avatarKey'>

/** 身份资料独立保存；职责修改走岗位版本校验，执行配置与授权保持原字段。未提交内容经 onDraft 交回调用方按原员工保留，关闭不保存。 */
export function EmployeeProfileEditor({role,initial,onDraft,close,save}:{role:PreviewRole;initial?:EmployeeProfileFields|undefined;onDraft?:((fields:EmployeeProfileFields|undefined)=>void)|undefined;close:()=>void;save:(fields:RoleFields)=>Promise<void>}){
 const {locale,t}=useI18n(),[name,setName]=useState(initial?.name??role.name),[duty,setDuty]=useState(initial?.duty??role.duty),[avatarKey,setAvatarKey]=useState(initial?initial.avatarKey:role.avatarKey)
 // 只在本人编辑时回传草稿，不能因父层刷新或回调身份变化反复写回。
 const change=(patch:Partial<EmployeeProfileFields>)=>{
  const next={name,duty,...(avatarKey?{avatarKey}:{}),...patch}
  setName(next.name);setDuty(next.duty);setAvatarKey(next.avatarKey)
  onDraft?.(next.name!==role.name||next.duty!==role.duty||next.avatarKey!==role.avatarKey?next:undefined)
 }
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>()
 return <ContextDrawer title={employeeCopy(locale,'profileEditTitle')} close={()=>{if(!busy)close()}} canClose={!busy} {...(css.dialog?{className:css.dialog}:{})}>
  <form className={`${css.form} ${teamCss.profileEditor}`} onSubmit={async event=>{
   event.preventDefault();if(busy||!applicationPresentation.can('people')||!name.trim()||!duty.trim())return
   setBusy(true);setError(undefined)
   try{await save({name:name.trim(),duty:duty.trim(),kind:role.kind,scopes:[...role.scopes],dataScope:role.dataScope,executionScope:role.executionScope,skills:[...role.skills],knowledge:[...role.knowledge],...(role.responsibility?{responsibility:role.responsibility}:{}),...(role.runtimeConfig?{runtimeConfig:role.runtimeConfig}:{}),...(avatarKey?{avatarKey}:{})});close()}
   catch(error){const details=error&&typeof error==='object'&&'details' in error?error.details:undefined;setError(details&&typeof details==='object'&&'reason' in details&&details.reason==='role-work-outstanding'?employeeCopy(locale,'profileBusy'):localizeWorkError(locale,error))}finally{setBusy(false)}
  }}>
   {error&&<p role="alert">{error}</p>}
   <fieldset disabled={busy} className={teamCss.formBody}>
    <label>{t('team.form.name')}<input required maxLength={80} value={name} onChange={event=>change({name:event.target.value})}/></label>
    <EmployeeAvatarPicker value={avatarKey} name={name} onChange={avatarKey=>change({avatarKey})}/>
    <label>{t('team.form.mission')}<textarea required maxLength={4000} rows={5} value={duty} onChange={event=>change({duty:event.target.value})}/></label>
    <p className={css.muted}>{employeeCopy(locale,'profileEditHint')}</p>
    <footer className={css.buttons}><button type="button" onClick={close}>{t('team.form.cancel')}</button><button type="submit" disabled={!name.trim()||!duty.trim()}>{employeeCopy(locale,'save')}</button></footer>
   </fieldset>
  </form>
 </ContextDrawer>
}
