import {useEffect,useState} from 'react'
import type {WorkProgress,WorkBudgetExhaustion} from '@teloa/contract'
import type {WorkControlApi} from './work-control-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import {WorkBudgetPanel} from './WorkBudgetPanel.js'
export function WorkProgressPanel({api,rootTaskId,revision,budgetAccountId,active=true,exhaustion}:{api:WorkControlApi;rootTaskId:string;revision:string;budgetAccountId?:string;active?:boolean;exhaustion?:Partial<WorkBudgetExhaustion>|undefined}){
 const {t,locale,dateTime}=useI18n(),[value,setValue]=useState<WorkProgress|null>(),[error,setError]=useState('')
 useEffect(()=>{let live=true,reading=false;setValue(undefined);setError('');if(!active)return;const load=()=>{if(reading)return;reading=true;void api.progress(rootTaskId).then(row=>{if(live){setValue(row);setError('')}},cause=>{if(live)setError(localizeWorkError(locale,cause))}).finally(()=>{reading=false})};load();const timer=setInterval(load,5000);return()=>{live=false;clearInterval(timer)}},[api,rootTaskId,revision,locale,active])
 // 日常任务不展示额度表单；旧设置存在未决回执时，只保留原请求核对。
 const next=value?.wait?.reason??value?.nextStep
 return <>{active&&(next||error)&&<section className={css.progressSummary} aria-label={t('planWork.progress')}>{error?<p className={css.error} role="alert">{error}</p>:<p>{next}{value?.wait?.nextAt?' · '+dateTime(value.wait.nextAt):''}</p>}</section>}{budgetAccountId&&<WorkBudgetPanel key={budgetAccountId} api={api.budgets} budgetAccountId={budgetAccountId} recoveryOnly={!exhaustion} initialScope={exhaustion?.scope==='owner'?'owner':'account'}/>}</>
}
