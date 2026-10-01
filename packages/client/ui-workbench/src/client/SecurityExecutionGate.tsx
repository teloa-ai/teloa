import {useState} from 'react'
import type {SecurityAction,SecurityActionPanel} from '@teloa/contract'
import {confirmTargetMatches,securityExecutionChecks,type SecurityDecisionStage} from './attention-decision.js'
import {useI18n} from './i18n/provider.js'

type Props={
 action:SecurityAction;panel:SecurityActionPanel
 /** 已经算好的执行段：`confirmTarget` 非空就是不可逆动作，必须逐字抄目标名。 */
 stage:Extract<SecurityDecisionStage,{stage:'execute'}>
 /** 两个入口各有自己的样式表，类名由宿主给；共用的是判据与结构，不是外观。 */
 classes:{checks:string|undefined;actions:string|undefined}
 locked:boolean
 execute:()=>void
}

/**
 * 执行区的共用门：三行核对（目标集 / 执行器就绪 / 目标在授权范围内）+ 不可逆动作逐字抄目标名 + 执行按钮。
 *
 * 需要你决策卡与任务详情面板同用这一份。此前面板的“执行”只判一个 journal 锁，既不摆三行核对、
 * 也不要求抄目标名——服务端审批链一致，所以不是权限绕过，但规格要求的“高风险 / 不可逆必须两次显式
 * 确认”在任务详情页是失效的。两个入口共用同一扇门，才谈得上“这道关存在”。
 */
export function SecurityExecutionGate({action,panel,stage,classes,locked,execute}:Props){
 const {t}=useI18n()
 const [confirm,setConfirm]=useState('')
 const checks=securityExecutionChecks(action,panel)
 const confirmed=stage.confirmTarget===null||confirmTargetMatches(confirm,stage.confirmTarget)
 return <>
  <dl className={classes.checks}>
   <div><dt>{t('attention.security.checkTargets')}</dt><dd>{checks.targets.join('、')}</dd></div>
   <div><dt>{t('attention.security.checkExecutor')}</dt><dd>{t(checks.executorReady?'attention.security.checkPass':'attention.security.checkExecutorMissing')}</dd></div>
   <div><dt>{t('attention.security.checkReachable')}</dt><dd>{t(checks.targetsAllowed?'attention.security.checkPass':'attention.security.checkTargetsBlocked')}</dd></div>
  </dl>
  {stage.confirmTarget!==null&&<label>{t('attention.security.confirmTarget',{target:stage.confirmTarget})}<input value={confirm} onChange={event=>setConfirm(event.target.value)}/></label>}
  <div className={classes.actions}>
   <button type="button" disabled={locked||!checks.executorReady||!checks.targetsAllowed||!confirmed} onClick={execute}>{t('security.execute')}</button>
  </div>
 </>
}
