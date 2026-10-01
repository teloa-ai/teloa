import type {RunView} from './task-run-api.js'
import type {ModelReference} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import css from './TaskPage.module.css'

const label=(model:ModelReference)=>`${model.model} · ${model.provider}${model.reasoningEffort?' · '+model.reasoningEffort:''}`
/** 不根据预设推测实际模型，旧宿主和读取失败都显示尚未核实。 */
export function TaskRunModels({run,planned=false}:{run:RunView;planned?:boolean}){
 const {t}=useI18n(),policy=run.modelPolicy,status=run.modelStatus
 if(!policy)return null
 if(planned)return <dl className={css.runModels}>
  <div><dt>{t('roleModels.primary')}</dt><dd>{label(policy.primary)}</dd></div>
  {policy.fallback&&<div><dt>{t('roleModels.fallback')}</dt><dd>{label(policy.fallback)}</dd></div>}
 </dl>
 return <div className={css.runModels}>
  {status?.state==='observed'?<>
   <p>{t('taskModels.request',{model:label(status.model)})}</p>
   {status.recovery&&<p className={css.muted}>{t('taskModels.switched',{from:status.recovery.from.model,to:status.recovery.to.model,reason:t('taskModels.reason.'+status.recovery.reason)})}</p>}
  </>:<p className={css.muted}>{t(status?.state==='unobserved'?'taskModels.unobserved':'taskModels.unavailable')}</p>}
 </div>
}
