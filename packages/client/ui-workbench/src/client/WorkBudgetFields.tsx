import {useEffect,useId,useState} from 'react'
import type {WorkBudgetPolicy} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import css from './WorkBudgetFields.module.css'

export const workBudgetResourceKeys=['maxTokens','maxGoalRounds','maxConcurrent','maxElapsedMs'] as const
const recoveryKeys=['maxRetries','stagnationRounds'] as const
const keys=[...workBudgetResourceKeys,...recoveryKeys] as const
type Key=typeof keys[number]
const labels={maxTokens:'planWork.tokens',maxGoalRounds:'planWork.rounds',maxConcurrent:'planWork.concurrent',maxElapsedMs:'planWork.elapsed',maxRetries:'planWork.retries',stagnationRounds:'planWork.stagnation'} as const
const numberFor=(key:Key,value:string)=>value.trim()===''?Number.NaN:key==='maxElapsedMs'?Number(value)*60000:Number(value)
const display=(key:Key,value:number|null)=>value===null?'1':String(key==='maxElapsedMs'?value/60000:value)
const valid=(key:Key,value:number|null)=>value===null?workBudgetResourceKeys.some(item=>item===key):Number.isSafeInteger(value)&&value>=(key==='maxRetries'?0:1)
export function isWorkBudgetPolicyValid(value:WorkBudgetPolicy):boolean{return keys.every(key=>valid(key,value[key]))&&value.money===null}
/** 仅比较额度方向；null 表示不限，不修改任何运行或累计用量。 */
export function isWorkBudgetIncrease(previous:WorkBudgetPolicy,next:WorkBudgetPolicy):boolean{return keys.every(key=>next[key]===null||(previous[key]!==null&&Number(next[key])>=Number(previous[key])))}

/** 受控策略与有限值草稿分开：切换“不限”保留原数字，清空输入也不会冒充有效的零额度。 */
export function WorkBudgetFields({value,onChange,disabled=false,includeRecovery=true,onValidityChange}:{value:WorkBudgetPolicy;onChange:(next:WorkBudgetPolicy)=>void;disabled?:boolean;includeRecovery?:boolean;onValidityChange?:(valid:boolean)=>void}){
 const {t}=useI18n(),id=useId(),[drafts,setDrafts]=useState(()=>Object.fromEntries(keys.map(key=>[key,display(key,value[key])])) as Record<Key,string>)
 useEffect(()=>{setDrafts(previous=>{const next={...previous};for(const key of keys)if(value[key]!==null&&!Object.is(numberFor(key,previous[key]),value[key]))next[key]=display(key,value[key]);return next})},[value])
 const policyValid=isWorkBudgetPolicyValid(value)
 useEffect(()=>onValidityChange?.(policyValid),[policyValid,onValidityChange])
 const change=(key:Key,raw:string)=>{setDrafts(previous=>({...previous,[key]:raw}));onChange({...value,[key]:numberFor(key,raw)})}
 const input=(key:Key)=>{const invalid=!valid(key,value[key]),inputId=id+'-'+key;return <><label htmlFor={inputId}>{t(labels[key])}</label><input id={inputId} type="number" inputMode="numeric" required min={key==='maxRetries'?0:key==='maxElapsedMs'?1/60000:1} step={key==='maxElapsedMs'?'any':1} disabled={disabled} value={drafts[key]} aria-invalid={invalid||undefined} aria-describedby={invalid?inputId+'-error':undefined} onChange={event=>change(key,event.target.value)}/>{invalid&&<small id={inputId+'-error'} className={css.invalid}>{t(key==='maxRetries'?'planWork.budget.invalidRetries':key==='maxElapsedMs'?'planWork.budget.invalidElapsed':'planWork.budget.invalidLimit')}</small>}</>}
 return <fieldset className={css.fields} disabled={disabled}><legend>{t('planWork.budget.title')}</legend>{workBudgetResourceKeys.map(key=><div className={css.field} key={key}><div className={css.heading}><span>{t(labels[key])}</span><select aria-label={t('planWork.budget.limitMode',{resource:t(labels[key])})} value={value[key]===null?'unlimited':'finite'} onChange={event=>{const next=event.target.value==='unlimited'?null:numberFor(key,drafts[key]);onChange({...value,[key]:next})}}><option value="finite">{t('planWork.budget.finite')}</option><option value="unlimited">{t('planWork.budget.unlimited')}</option></select></div>{value[key]===null?<p className={css.unlimited}>{t('planWork.budget.unlimitedResource')}</p>:<div className={css.value}>{input(key)}</div>}</div>)}{includeRecovery&&recoveryKeys.map(key=><div className={css.field+' '+css.recovery} key={key}>{input(key)}</div>)}</fieldset>
}
