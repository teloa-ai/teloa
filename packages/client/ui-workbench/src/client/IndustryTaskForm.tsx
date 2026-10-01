import { useEffect, useRef, useState } from 'react'
import { openDialog } from './dialog-focus.js'
import type { IndustryLoad } from './industry-load.js'
import type { IndustryTaskCommand } from './industry-task.js'
import css from './TaskPage.module.css'
import {useI18n} from './i18n/provider.js'

export function IndustryTaskForm({loads,source,create,close}:{loads:readonly IndustryLoad[];source:{loadId:string;resourceId:string};create:(command:IndustryTaskCommand)=>void;close:()=>void}){
 const {t,list}=useI18n()
 const dialog=useRef<HTMLDialogElement>(null)
 const load=loads.find(row=>row.id===source.loadId),definition=load?.resources.find(row=>row.id===source.resourceId)?.inspection.definition
 const template=definition?.kind==='work-template'?definition.manifest:undefined
 const [id]=useState(()=>crypto.randomUUID()),[goal,setGoal]=useState(''),[inputs,setInputs]=useState<string[]>(()=>template?.requirements.map(()=>'')||[]),[error,setError]=useState('')
 useEffect(()=>openDialog(dialog.current),[])
 return <dialog ref={dialog} className={css.dialog} aria-label={t('market.industry.taskForm.aria')} onCancel={close}><form className={css.form} onSubmit={event=>{event.preventDefault();try{create({...source,id,goal,inputs,now:new Date().toISOString()})}catch{setError(t('market.industry.taskForm.failed'))}}}>
  <h2>{template?.title||t('market.industry.taskForm.unavailable')}</h2><p>{t('market.industry.taskForm.help')}</p>
  {error&&<p role="alert">{error}</p>}
  {template&&<><details><summary>{t('market.industry.taskForm.method')}</summary><p>{template.description}</p><p>{t('market.industry.contents.delivery',{value:template.output})}</p>{template.skills.length>0&&<p>{t('market.industry.taskForm.skills',{skills:list(template.skills.map(skill=>skill.title+' · '+skill.version))})}</p>}</details><label>{t('market.industry.taskForm.goal')}<textarea required rows={3} maxLength={4000} value={goal} onChange={event=>setGoal(event.target.value)}/></label>{template.requirements.map((requirement,index)=><label key={index}>{index+1}. {requirement}<textarea aria-label={t('market.industry.taskForm.inputAria',{index:index+1,requirement})} required rows={2} maxLength={4000} value={inputs[index]||''} onChange={event=>setInputs(current=>current.map((value,i)=>i===index?event.target.value:value))}/></label>)}</>}
  <footer className={css.buttons}><button type="button" onClick={close}>{t('market.common.cancel')}</button><button type="submit" disabled={!template||!goal.trim()||inputs.some(value=>!value.trim())}>{t('market.industry.taskForm.create')}</button></footer>
 </form></dialog>
}
