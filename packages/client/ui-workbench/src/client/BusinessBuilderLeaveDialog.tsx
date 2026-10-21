import {useEffect,useId,useRef} from 'react'
import {createPortal} from 'react-dom'
import type {BusinessBuilderFlow} from './business-builder-flow.js'
import {BusinessDraftDiscard} from './BusinessDraftDiscard.js'
import {openDialog} from './dialog-focus.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {useI18n} from './i18n/provider.js'
import base from './dialog-base.module.css'
import css from './BusinessBuilderPanel.module.css'

/** 确认独立于窄屏页签；共享关闭语义仅继续原搭建，焦点回原可见入口。 */
export function BusinessBuilderLeaveDialog({flow,disabled}:{flow:BusinessBuilderFlow;disabled:boolean}){
 const {t}=useI18n(),state=flow.getSnapshot(),dialog=useRef<HTMLDialogElement>(null),stay=useRef<HTMLButtonElement>(null),heading=useId(),description=useId()
 useEffect(()=>openDialog(dialog.current,stay.current),[])
 const dismiss=useDialogDismiss(()=>flow.decideLeave('continue'))
 if(typeof document==='undefined')return null
 return createPortal(<dialog ref={dialog} className={[base.dialog,css.leaveDialog,css.panel].join(' ')} aria-labelledby={heading} aria-describedby={description} {...dismiss}>
  <h3 id={heading}>{t('business.plan.leaveTitle')}</h3><p id={description}>{t('business.plan.leaveNote')}</p>
  <div className={css.leaveActions}>{state.binding&&state.draft&&<BusinessDraftDiscard flow={flow} binding={state.binding} draft={state.draft} disabled={disabled} onDiscarded={()=>flow.decideLeave('keep')}/>}<button onClick={()=>flow.decideLeave('keep')}>{t('business.plan.keepLeave')}</button><button ref={stay} className={css.primary} onClick={()=>flow.decideLeave('continue')}>{t('business.plan.continue')}</button></div>
 </dialog>,document.body)
}
