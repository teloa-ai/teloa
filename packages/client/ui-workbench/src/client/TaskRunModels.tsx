import type {RunView} from './task-run-api.js'
import type {ModelReference} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import css from './TaskPage.module.css'

const label=(model:ModelReference)=>`${model.model}${model.reasoningEffort?' · '+model.reasoningEffort:''}`
/** 不根据预设推测实际模型，旧宿主和读取失败都显示尚未核实。 */
export function TaskRunModels({run,planned=false}:{run:RunView;planned?:boolean}){
 const {t,locale}=useI18n(),policy=run.modelPolicy,status=run.modelStatus
 const c=(cn:string,en:string)=>locale.startsWith('zh')?cn:en
 const authority=run.executor?.kind==='owner'?c('本人授权的执行','Execution authorized by the owner'):run.roleSnapshot?run.roleSnapshot.name+' · '+(run.roleSnapshot.authorization.kind==='delegation'?c('本人执行委托','Owner delegation')+' v'+run.roleSnapshot.authorization.delegationVersion:c('本人确认的任务授权','Owner-approved task authorization')):c('历史授权主体尚未核实','Historical execution authority is unverified')
 const authorityView=<p>{c('实际授权主体：','Execution authority: ')}{authority}{run.scope?' · '+c('本次业务范围：','Business scope: ')+run.scope:''}</p>
 if(planned)return <>{authorityView}{policy&&<dl className={css.runModels}>
  <div><dt>{t('roleModels.primary')}</dt><dd>{label(policy.primary)}</dd></div>
 </dl>}</>
 if(!policy)return null
 return <div className={css.runModels}>
  {status?.state==='observed'?<>
   <p>{t('taskModels.request',{model:label(status.model)})}</p>
   {status.recovery&&<p className={css.muted}>{t('taskModels.switched',{from:status.recovery.from.model,to:status.recovery.to.model,reason:t('taskModels.reason.'+status.recovery.reason)})}</p>}
  </>:<p className={css.muted}>{t(status?.state==='unobserved'?'taskModels.unobserved':'taskModels.unavailable')}</p>}
 </div>
}
