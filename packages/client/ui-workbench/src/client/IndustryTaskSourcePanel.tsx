import {useEffect,useState} from 'react'
import type {IndustryTaskApi,IndustryTaskSource} from './industry-task-api.js'
import css from './TaskPage.module.css'
import {useI18n} from './i18n/provider.js'

export function IndustryTaskSourcePanel({taskId,api}:{taskId:string;api:IndustryTaskApi}){
 const {t,list}=useI18n(),[source,setSource]=useState<{taskId:string;value:IndustryTaskSource|null}>(),[error,setError]=useState<string>(),[revision,setRevision]=useState(0),[loading,setLoading]=useState(true)
 useEffect(()=>{let live=true;setLoading(true);setError(undefined);void api.source(taskId).then(value=>{if(live)setSource({taskId,value})},()=>{if(live)setError(t('market.industry.taskSource.failed'))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[api,taskId,revision,t])
 const current=source?.taskId===taskId?source.value:undefined
 if(current===null&&!error)return null
 return <section className={css.block} aria-label={t('market.industry.taskSource.aria')}><h3>{t('market.industry.taskSource.title')}{current?' · '+current.title:''}</h3>{loading&&current===undefined&&<p role="status">{t('market.industry.taskSource.loading')}</p>}{error&&<p role="alert">{error} <button type="button" disabled={loading} onClick={()=>setRevision(value=>value+1)}>{t('market.industry.taskSource.refresh')}</button></p>}{current&&<><p>{t('market.industry.taskSource.version',{version:current.templateVersion})}</p><p>{current.method}</p><dl>{current.requirements.map((requirement,index)=><div key={index}><dt>{requirement}</dt><dd>{current.inputs[index]}</dd></div>)}</dl><p>{t('market.industry.contents.delivery',{value:current.output})}</p>{current.createdAssignee&&<p>{t('market.industry.taskSource.assignee',{id:current.createdAssignee.roleId,version:current.createdAssignee.roleVersion})}</p>}{current.skills.length>0&&<p>{t('market.industry.taskSource.skills',{skills:list(current.skills.map(skill=>skill.title+' · '+skill.version))})}</p>}<small>{t('market.industry.taskSource.provenance',{load:current.loadId,hash:current.fileHash})}</small></>}</section>
}
