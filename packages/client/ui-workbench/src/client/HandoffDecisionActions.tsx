import {useState} from 'react'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './AttentionDecisionCard.module.css'

type Props={
 canTakeOver:boolean;pending:boolean;error:string|undefined
 recover:()=>Promise<void>;takeOver:(note:string)=>Promise<void>;openSection:()=>void
}

/**
 * 交接的两条出路：交由另一岗位要挑人，那是详情页交接段的事，这里只负责把人送过去；
 * 本人接手在卡内落地，但契约要求接任说明必填（`handoffs/resolve` 的 note），
 * 所以点了“本人接手”才展开说明栏——导航那条路不需要说明，不该陪着填。
 * 写之前先看 journal：有未决的接任就只给“恢复”，不另造一份请求去撞 conflict。
 */
export function HandoffDecisionActions({canTakeOver,pending,error,recover,takeOver,openSection}:Props){
 const {locale,t}=useI18n()
 const [note,setNote]=useState(''),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[failure,setFailure]=useState<string>()
 const run=async(work:()=>Promise<unknown>)=>{
  if(busy)return
  setBusy(true);setFailure(undefined)
  try{await work()}
  catch(cause){setFailure(localizeWorkError(locale,cause))}
  finally{setBusy(false)}
 }
 return <div className={css.decision}>
  {(failure??error)!==undefined&&<p role="alert">{failure??error}</p>}
  {pending&&<>
   <p role="status">{t('collaboration.pending.description')}</p>
   <div className={css.actions}><button type="button" disabled={busy} onClick={()=>void run(recover)}>{t('collaboration.action.recover')}</button></div>
  </>}
  <div className={css.actions}>
   <button type="button" disabled={busy} onClick={openSection}>{t('attention.action.handoffOther')}</button>
   {canTakeOver&&<button type="button" aria-expanded={open} disabled={busy||pending||error!==undefined} onClick={()=>setOpen(value=>!value)}>{t('attention.action.handoffSelf')}</button>}
  </div>
  {canTakeOver&&open&&<>
   <label>{t('task.detail.handoffNote')}<textarea required maxLength={4000} value={note} onChange={event=>setNote(event.target.value)}/></label>
   <div className={css.actions}><button type="button" disabled={busy||pending||error!==undefined||!note.trim()} onClick={()=>void run(()=>takeOver(note.trim()))}>{t('task.detail.confirmTakeOver')}</button></div>
  </>}
 </div>
}
