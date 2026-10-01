import type {BindingClient} from './binding-client.js'
import type { ResourceApi } from './resource-api.js'
import { useEffect,useRef,useState,useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PreparedInputPort,PreparedPrompt,PromptPreparation } from './prompt-preparation.js'
import css from './ResourceRecovery.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

type PreparationIssue={type:'prepared-prompt';kind:'skill'|'input'}
const preparationIssue=(kind:PreparationIssue['kind']):PreparationIssue=>({type:'prepared-prompt',kind})
const isPreparationIssue=(value:unknown):value is PreparationIssue=>!!value&&typeof value==='object'&&'type' in value&&(value as PreparationIssue).type==='prepared-prompt'

export function PreparedPromptCard({sessionId,session,input,inputActions,preparation,resourceApi,resourceInput,work,validateTask,openSource}:PropsRuntime<'conversation.input.dock'>&{work:BindingClient;preparation:PromptPreparation;resourceApi:ResourceApi;resourceInput:PreparedInputPort;validateTask:(row:PreparedPrompt)=>Promise<void>;openSource:(id:string,kind?:'home'|'task')=>void}){
  const {locale,t}=useI18n()
  const rows=useSyncExternalStore(preparation.subscribe,preparation.getSnapshot),[error,setError]=useState('')
  const [busy,setBusy]=useState(false),request=useRef<AbortController|null>(null)
  useEffect(()=>()=>request.current?.abort(),[])
  const current=rows.filter(row=>row.sessionId===sessionId&&(row.status==='pending'||row.status==='stale'))
  const insert=async(row:PreparedPrompt)=>{
    setBusy(true);setError('');request.current?.abort()
    const controller=new AbortController();request.current=controller
    try{
      if(row.sourceKind==='task')await validateTask(row)
      if(row.sourceKind==='task'||row.resources?.length||row.skills?.length||row.transfer)await preparation.insertResources(row.id,sessionId,()=>resourceApi.candidates(sessionId,controller.signal),resourceInput,async()=>{await work.readCatalog();const state=work.getSnapshot();if(state.sessionId!==sessionId||state.status!=='ready'||state.catalogStatus!=='ready'||!state.capabilities)throw preparationIssue('skill');return state.capabilities.skills})
      else {if(!inputActions)throw preparationIssue('input');preparation.insert(row.id,sessionId,input,session.running,inputActions)}
    }catch(error){if(!controller.signal.aborted)setError(isPreparationIssue(error)?t(error.kind==='skill'?'p6.preparedPrompt.skillUnavailable':'p6.preparedPrompt.inputUnavailable'):localizeWorkError(locale,error))}
    finally{if(!controller.signal.aborted)setBusy(false)}
  }
  if(!current.length)return null
  const aria=t(current.every(row=>row.sourceKind==='task')?'p6.preparedPrompt.aria.task':current.every(row=>row.sourceKind==='home')?'p6.preparedPrompt.aria.home':'p6.preparedPrompt.aria.market')
  return <section className={css.panel} aria-label={aria}><div className={css.body}><p><strong>{t('p6.preparedPrompt.title')}</strong></p><p className={css.muted}>{t('p6.preparedPrompt.description')}</p>{error&&<p role="alert">{error}</p>}{current.map(row=><div key={row.id} className={css.message}><strong>{t(row.sourceKind==='home'?'p6.preparedPrompt.homeSource':'p6.preparedPrompt.versionedSource',{title:row.title,version:row.sourceVersion})}</strong><details><summary>{t('p6.preparedPrompt.review')}</summary><pre>{row.text}</pre></details>{row.skills&&<ul>{row.skills.map(skill=><li key={skill.name}>/{skill.name} · {t(row.transfer?.textInserted?'p6.preparedPrompt.inserted':'p6.preparedPrompt.reviewNeeded')}{!row.transfer?.textInserted&&<button type="button" disabled={busy} onClick={()=>preparation.removeSkill(row.id,skill.name)}>{t('p6.preparedPrompt.removeSkill',{name:skill.name})}</button>}</li>)}</ul>}{row.resources&&<ul>{row.resources.map(resource=><li key={resource.id}>{resource.title} · v{resource.version} · {t(row.transfer?.resourceIds.includes(resource.id)?'p6.preparedPrompt.inserted':'p6.preparedPrompt.reviewNeeded')}{!row.transfer?.resourceIds.includes(resource.id)&&<button type="button" disabled={busy} onClick={()=>preparation.removeResource(row.id,resource.id)}>{t('p6.preparedPrompt.removeResource',{title:resource.title})}</button>}</li>)}</ul>}{row.transfer?.textInserted&&<p>{t('p6.preparedPrompt.partial')}</p>}{row.status==='stale'&&<p>{t('p6.preparedPrompt.stale')}</p>}<div className={css.actions}><button type="button" className={css.button} disabled={busy||row.status!=='pending'||session.running||input.phase!=='plain'||(!row.transfer?.textInserted&&input.draft.length>0)||input.attachmentIds.length>0} onClick={()=>void insert(row)}>{t('p6.preparedPrompt.insert')}</button><button type="button" className={css.button} disabled={busy} onClick={()=>openSource(row.sourceId,row.sourceKind)}>{t(row.sourceKind==='task'?'p6.preparedPrompt.backTask':row.sourceKind==='home'?'p6.preparedPrompt.backHome':'p6.preparedPrompt.backSource')}</button><button type="button" className={css.button} disabled={busy} onClick={()=>preparation.dismiss(row.id)}>{t('p6.preparedPrompt.dismiss')}</button></div></div>)}</div></section>
}
