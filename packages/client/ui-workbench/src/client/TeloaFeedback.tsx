import {useEffect,useId,useRef,useSyncExternalStore} from 'react'
import {X} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import {openDialog} from './dialog-focus.js'
import type {NativeFeedbackBridge} from './TeloaFeedbackBridge.js'
import type {TeloaFeedbackModel} from './TeloaFeedbackClient.js'
import tokens from './theme-tokens.module.css'
import css from './TeloaFeedback.module.css'

export type TeloaFeedbackProps=NativeFeedbackBridge&{model:TeloaFeedbackModel}
export function TeloaFeedback({nativeDialog,dismissNative,model}:TeloaFeedbackProps){
  const state=useSyncExternalStore(nativeDialog.subscribe,nativeDialog.getSnapshot,nativeDialog.getSnapshot)
  return state.target?<TeloaFeedbackForm onClose={dismissNative} model={model}/>:null
}
/** 模型带资源时（市场条目详情入口）在顶部显示反馈对象；`resourceTitle` 缺省时以资源标识代替。 */
export function TeloaFeedbackForm({onClose,model,resourceTitle}:{onClose:()=>void;model:TeloaFeedbackModel;resourceTitle?:string}){
  const {t}=useI18n(),state=useSyncExternalStore(model.subscribe,model.getSnapshot,model.getSnapshot)
  const dialog=useRef<HTMLDialogElement>(null),content=useRef<HTMLTextAreaElement>(null)
  // 系统菜单与市场资源反馈可能同时打开，id 按实例区分
  const id=useId(),field=(name:string)=>`${id}teloa-feedback-${name}`
  useEffect(()=>openDialog(dialog.current,content.current),[])
  const close=()=>{if(state.pending)return;onClose();if(state.receipt)model.reset()}
  return <dialog ref={dialog} className={`${tokens.tokens} ${css.dialog}`} aria-labelledby={field('title')}
    {...(model.resource?{'aria-describedby':field('resource')}:{})}
    onCancel={event=>{event.preventDefault();close()}} onClick={event=>{if(event.target===event.currentTarget)close()}}>
    <form onSubmit={event=>{event.preventDefault();void model.submit()}}>
      <header><h2 id={field('title')}>{t(state.receipt?'feedback.received':'feedback.title')}</h2><button type="button" className={css.close} disabled={state.pending} onClick={close} aria-label={t('feedback.close')}><X size={18}/></button></header>
      {model.resource&&<p id={field('resource')} className={css.resource}>{t('feedback.resource',{title:resourceTitle??model.resource.entryId,id:model.resource.entryId,version:model.resource.version})}</p>}
      {state.receipt?<div className={css.receipt} role="status">
        <p>{t('feedback.receipt',{id:state.receipt.receiptId})}</p>
        {state.receipt.notification!=='sent'&&<p>{t('feedback.notificationPending')}</p>}
        <p>{t('feedback.private')}</p>
        <footer><button type="button" className={css.primary} onClick={close}>{t('feedback.done')}</button></footer>
      </div>:<>
        <p id={field('privacy')} className={css.description}>{t('feedback.disclosure')}</p>
        <label htmlFor={field('category')}>{t('feedback.category')}</label>
        <select id={field('category')} value={state.draft.category} disabled={state.pending} onChange={event=>model.edit({category:event.target.value as 'bug'|'idea'|'other'})}>
          <option value="bug">{t('feedback.bug')}</option><option value="idea">{t('feedback.idea')}</option><option value="other">{t('feedback.other')}</option>
        </select>
        <label htmlFor={field('content')}>{t('feedback.content')}</label>
        <textarea ref={content} id={field('content')} required minLength={3} maxLength={4000} value={state.draft.message} disabled={state.pending} aria-describedby={field('privacy')} onChange={event=>model.edit({message:event.target.value})}/>
        <label htmlFor={field('email')}>{t('feedback.email')}</label>
        <input id={field('email')} type="email" autoComplete="email" maxLength={254} value={state.draft.email} disabled={state.pending} onChange={event=>model.edit({email:event.target.value})}/>
        <p className={css.description}>{t('feedback.emailHint')}</p>
        {state.error&&<div className={css.failure}><p className={css.error} role="alert">{t(`feedback.error.${state.error}`)}</p><a href="mailto:support@teloa.ai?subject=Teloa%20feedback">{t('feedback.emailFallback')}</a></div>}
        <footer><button type="button" disabled={state.pending} onClick={close}>{t('feedback.cancel')}</button><button type="submit" className={css.primary} disabled={state.pending}>{t(state.pending?'feedback.sending':'feedback.send')}</button></footer>
      </>}
    </form>
  </dialog>
}
