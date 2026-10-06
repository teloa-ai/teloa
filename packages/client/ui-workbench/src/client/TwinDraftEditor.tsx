import {useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import type { PreviewRole, TeamChange } from './role-preview.js'
import {useI18n} from './i18n/provider.js'
import css from './TaskPage.module.css'

export type TwinDraftInput={version:number;body:string}

export function TwinDraftEditor({role,input,update,save}:{role:PreviewRole;input:TwinDraftInput|undefined;update:(input:TwinDraftInput|undefined)=>void;save:(command:TeamChange)=>boolean}){
  const {t,dateTime}=useI18n()
  const allowed=useApplicationCapability('people')
  const body=input?.body??role.draft?.body??'',retired=role.state==='retired'
  const stale=!!input&&input.version!==role.version
  return <section className={css.block}>
    <h3>{t('twinDraft.title')}</h3><p className={css.muted}>{t('twinDraft.description')}</p>
    {input&&<p>{t(retired?'twinDraft.retired':'twinDraft.unsaved')}</p>}
    {stale&&!retired&&<div className={css.record}><p>{t('twinDraft.stale',{draftVersion:input!.version,roleVersion:role.version})}</p><button type="button" onClick={()=>update({version:role.version,body})}>{t('twinDraft.continue')}</button></div>}
    <form className={css.form} onSubmit={event=>{
      event.preventDefault()
      if(!input||retired||!applicationPresentation.can('people'))return
      if(save({type:'draft',roleId:role.id,expectedVersion:input.version,body,now:new Date().toISOString()}))update(undefined)
    }}>
      <label>{t('twinDraft.content')}<textarea rows={8} maxLength={8000} required readOnly={retired||!allowed} value={body} onChange={event=>update({version:input?.version??role.version,body:event.target.value})}/></label>
      {!retired&&<button type="submit" disabled={!allowed||!input||stale||!body.trim()}>{t('twinDraft.save')}</button>}
      {!input&&role.draft&&<p role="status">{t('twinDraft.saved')}</p>}
      {role.draft&&<details><summary>{t('twinDraft.savedVersion',{version:role.draft.version})}</summary><p>{role.draft.body}</p><small>{t('twinDraft.editor',{editor:t(role.draft.editorId==='self'?'twinDraft.self':'twinDraft.originalEditor'),time:dateTime(role.draft.updatedAt)})}</small></details>}
    </form>
  </section>
}
