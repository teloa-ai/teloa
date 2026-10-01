import {useEffect,useState} from 'react'
import type {IndustryPlanApi,IndustryPlanRecord} from './industry-plan-api.js'
import css from './ContinuousPage.module.css'
import {useI18n} from './i18n/provider.js'

export function IndustryPlanSourcePanel({planId,api}:{planId:string;api:IndustryPlanApi}){
 const {t}=useI18n(),[row,setRow]=useState<{id:string;value:IndustryPlanRecord|null}>(),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 useEffect(()=>{let live=true;setError('');void api.source(planId).then(value=>{if(live)setRow({id:planId,value})},()=>{if(live)setError(t('market.industry.planSource.failed'))});return()=>{live=false}},[api,planId,retry,t])
 const value=row?.id===planId?row.value:undefined
 if(value===null&&!error)return null
 return <section className={css.block} aria-label={t('market.industry.planSource.aria')}><h3>{t('market.industry.planSource.title')}{value?' · '+value.title:''}</h3>{error&&<p role="alert">{error} <button type="button" onClick={()=>setRetry(x=>x+1)}>{t('market.industry.planSource.refresh')}</button></p>}{value&&<><p>{value.dataScope}</p><p>{t('market.industry.planSource.method',{value:value.work.method})}</p><p>{t('market.industry.planSource.goal',{value:value.goal})}</p><p>{t('market.industry.contents.delivery',{value:value.delivery})}</p><small>{t('market.industry.planSource.provenance',{load:value.loadId,hash:value.planFileHash})}</small></>}</section>
}
