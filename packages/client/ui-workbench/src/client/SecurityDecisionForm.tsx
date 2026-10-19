import {readDecisionReason,writeDecisionReason} from './decision-reason-drafts.js'
import {useState} from 'react'
import {useI18n} from './i18n/provider.js'

type Props={
 draftKey?:string
 combined:boolean
 locked:boolean
 /** 两个入口各有自己的样式表，类名由宿主给；共用的是判据与结构，不是外观。 */
 classes:{form:string|undefined;check:string|undefined;actions:string|undefined}
 approve:(reason:string)=>void
 reject:(reason:string)=>void
 /** 业务审阅复用同一表单，默认安全审批文案与判据保持。 */
 labels?:{approve:string;reject:string}|undefined
 reasonDraft?:{value:string;change:(value:string)=>void}|undefined
 maxReasonLength?:number|undefined
 rejectDisabled?:boolean|undefined
 approveDisabled?:boolean|undefined
 reasonLocked?:boolean|undefined
}

/**
 * 审批表单：审核意见 + 影响确认 + 批准/拒绝，需要你决策卡与任务详情面板此前各画一份、
 * 判据几乎一样却容易漂移。这里收成一处：批准要求意见非空且已勾影响确认；拒绝只要求
 * 意见非空——与两处原实现逐字一致，不趁机改行为。`combined` 为真时把「批准」换成
 * 「批准并执行」文案，调用方决定这一步是否要连着把执行也发出去。
 */
export function SecurityDecisionForm({draftKey,combined,locked,classes,approve,reject,labels,reasonDraft,maxReasonLength=4000,rejectDisabled=false,approveDisabled=false,reasonLocked=false}:Props){
 const {t}=useI18n()
 const [localReason,setReason]=useState(()=>draftKey?readDecisionReason(draftKey):''),[impact,setImpact]=useState(false)
 const reason=reasonDraft?.value??localReason
 return <div className={classes.form}>
  <label>{t('security.decisionReason')}<textarea required maxLength={maxReasonLength} disabled={locked||reasonLocked} value={reason} onChange={event=>{setReason(event.target.value);reasonDraft?.change(event.target.value);if(draftKey)writeDecisionReason(draftKey,event.target.value)}}/></label>
  <label className={classes.check}><input type="checkbox" disabled={locked||approveDisabled} checked={impact} onChange={event=>setImpact(event.target.checked)}/>{t('security.impact')}</label>
  <div className={classes.actions}>
   <button type="button" disabled={locked||approveDisabled||!reason.trim()||!impact} onClick={()=>approve(reason.trim())}>{labels?.approve??t(combined?'attention.security.approveAndExecute':'security.approve')}</button>
   <button type="button" disabled={locked||rejectDisabled||!reason.trim()} onClick={()=>reject(reason.trim())}>{labels?.reject??t('security.reject')}</button>
  </div>
 </div>
}
