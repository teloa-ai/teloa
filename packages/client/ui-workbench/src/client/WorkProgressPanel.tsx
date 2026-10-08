import {useEffect,useState} from 'react'
import type {WorkProgress} from '@teloa/contract'
import type {WorkControlApi} from './work-control-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import {WorkBudgetPanel} from './WorkBudgetPanel.js'
export function WorkProgressPanel({api,rootTaskId,revision,budgetAccountId}:{api:WorkControlApi;rootTaskId:string;revision:string;budgetAccountId?:string}){
 const {t,locale,dateTime}=useI18n(),[value,setValue]=useState<WorkProgress|null>(),[error,setError]=useState('')
 useEffect(()=>{let live=true,reading=false;setValue(undefined);setError('');const load=()=>{if(reading)return;reading=true;void api.progress(rootTaskId).then(row=>{if(live){setValue(row);setError('')}},cause=>{if(live)setError(localizeWorkError(locale,cause))}).finally(()=>{reading=false})};load();const timer=setInterval(load,5000);return()=>{live=false;clearInterval(timer)}},[api,rootTaskId,revision,locale])
 if(!value&&!error&&!budgetAccountId)return null
 return <>{(value||error)&&<details className={css.block}><summary>{t('planWork.progress')}</summary>{error?<p className={css.error} role="alert">{error}</p>:value&&<><p>{value.stage}</p>{value.wait&&<p>{value.wait.reason}{value.wait.nextAt?' · '+dateTime(value.wait.nextAt):''}</p>}{value.nextStep&&<p>{t('planWork.next')}：{value.nextStep}</p>}</>}</details>}{budgetAccountId&&<WorkBudgetPanel key={budgetAccountId} api={api.budgets} budgetAccountId={budgetAccountId}/>}</>
}
