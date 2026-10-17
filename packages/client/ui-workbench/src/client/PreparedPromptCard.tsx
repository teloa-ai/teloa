import type {BindingClient} from './binding-client.js'
import type { ResourceApi } from './resource-api.js'
import { useCallback,useEffect,useRef,useState,useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PreparedInputPort,PreparedPrompt,PromptPreparation } from './prompt-preparation.js'
import css from './ResourceRecovery.module.css'
import {X} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

type PreparationIssue={type:'prepared-prompt';kind:'skill'|'input'}
const preparationIssue=(kind:PreparationIssue['kind']):PreparationIssue=>({type:'prepared-prompt',kind})
const isPreparationIssue=(value:unknown):value is PreparationIssue=>!!value&&typeof value==='object'&&'type' in value&&(value as PreparationIssue).type==='prepared-prompt'

export function PreparedPromptCard({sessionId,session,input,preparation,resourceApi,resourceInput,work,validateTask,openSource}:PropsRuntime<'conversation.input.dock'>&{work:BindingClient;preparation:PromptPreparation;resourceApi:ResourceApi;resourceInput:PreparedInputPort;validateTask:(row:PreparedPrompt)=>Promise<void>;openSource:(id:string,kind?:'home'|'task')=>void}){
  const {locale,t}=useI18n()
  const rows=useSyncExternalStore(preparation.subscribe,preparation.getSnapshot)
  const binding=useSyncExternalStore(work.subscribe,work.getSnapshot)
  const [busy,setBusy]=useState(false),request=useRef<AbortController|null>(null)
  useEffect(()=>{setBusy(false);return()=>{request.current?.abort();request.current=null}},[sessionId,preparation])
  const current=rows.filter(row=>row.sessionId===sessionId&&(row.status==='pending'||row.status==='stale'))
  const insert=useCallback(async(row:PreparedPrompt)=>{
    if(request.current)return
    setBusy(true);preparation.clearInsertionFailure(row.id)
    const controller=new AbortController();request.current=controller
    const active=()=>{if(controller.signal.aborted)throw preparationIssue('input')}
    const port:PreparedInputPort={read:()=>{active();return resourceInput.read()},text:(text,revision)=>{active();return resourceInput.text(text,revision)},reference:(resource,revision)=>{active();return resourceInput.reference(resource,revision)}}
    try{
      // 先记录原输入修订号，再核验任务、候选和技能；统一由原生 CAS 写入，不发送。
      await preparation.insertResources(row.id,sessionId,async()=>{active();if(row.sourceKind==='task')await validateTask(row);active();return row.resources?.length?resourceApi.candidates(sessionId,controller.signal):[]},port,async()=>{active();await work.readCatalog();active();const state=work.getSnapshot();if(state.sessionId!==sessionId||state.status!=='ready'||state.catalogStatus!=='ready'||!state.capabilities)throw preparationIssue('skill');return state.capabilities.skills})
    }catch(error){preparation.failInsertion(row.id,controller.signal.aborted?preparationIssue('input'):error)}
    finally{if(request.current===controller){request.current=null;if(!controller.signal.aborted)setBusy(false)}}
  },[sessionId,preparation,resourceApi,resourceInput,work,validateTask])
  useEffect(()=>{
    let active=true
    // 等本次效果提交后认领意图，StrictMode 的试挂载不会消耗唯一自动尝试。
    void Promise.resolve().then(()=>{
      if(!active)return
      const ready=!busy&&!request.current&&binding.status==='ready'&&binding.sessionId===sessionId
      for(const row of preparation.getSnapshot())if(preparation.claimAutomaticInsert(row.id,sessionId,{...input,running:session.running},ready)){void insert(row);break}
    })
    return()=>{active=false}
  },[rows,sessionId,session.running,input.draft,input.draftRev,input.phase,input.attachmentIds,busy,binding,preparation,insert])
  const errorText=(error:unknown)=>isPreparationIssue(error)?t(error.kind==='skill'?'p6.preparedPrompt.skillUnavailable':'p6.preparedPrompt.inputUnavailable'):localizeWorkError(locale,error)
  if(!current.length)return null
  const aria=t(current.every(row=>row.sourceKind==='task')?'p6.preparedPrompt.aria.task':current.every(row=>row.sourceKind==='home')?'p6.preparedPrompt.aria.home':'p6.preparedPrompt.aria.market')
  return <section className={css.panel} aria-label={aria}><div className={css.body}><p><strong>{t('p6.preparedPrompt.title')}</strong></p><p className={css.muted}>{t('p6.preparedPrompt.description')}</p>{current.map(row=><div key={row.id} className={css.message}><strong>{t(row.sourceKind==='home'?'p6.preparedPrompt.homeSource':'p6.preparedPrompt.versionedSource',{title:row.title,version:row.sourceVersion})}</strong>{preparation.insertionFailure(row.id)&&<p role="alert">{errorText(preparation.insertionFailure(row.id)!.error)}</p>}<details><summary>{t('p6.preparedPrompt.review')}</summary><pre>{row.text}</pre></details>{row.skills&&<ul>{row.skills.map(skill=><li key={skill.name}>/{skill.name} · {t(row.transfer?.textInserted?'p6.preparedPrompt.inserted':'p6.preparedPrompt.reviewNeeded')}{!row.transfer?.textInserted&&<ToolbarIconButton className={css.removeReference} label={t('p6.preparedPrompt.removeSkill',{name:skill.name})} icon={X} disabled={busy} onClick={()=>preparation.removeSkill(row.id,skill.name)}/>}</li>)}</ul>}{row.resources&&<ul>{row.resources.map(resource=><li key={resource.id}>{resource.title} · v{resource.version} · {t(row.transfer?.resourceIds.includes(resource.id)?'p6.preparedPrompt.inserted':'p6.preparedPrompt.reviewNeeded')}{!row.transfer?.resourceIds.includes(resource.id)&&<ToolbarIconButton className={css.removeReference} label={t('p6.preparedPrompt.removeResource',{title:resource.title})} icon={X} disabled={busy} onClick={()=>preparation.removeResource(row.id,resource.id)}/>}</li>)}</ul>}{row.transfer?.textInserted&&<p>{t('p6.preparedPrompt.partial')}</p>}{row.status==='stale'&&<p>{t('p6.preparedPrompt.stale')}</p>}<div className={css.actions}><button type="button" className={css.button} disabled={busy||row.status!=='pending'||session.running||input.phase!=='plain'||(!row.transfer?.textInserted&&input.draft.length>0)||input.attachmentIds.length>0} onClick={()=>void insert(row)}>{t('p6.preparedPrompt.insert')}</button><button type="button" className={css.button} disabled={busy} onClick={()=>openSource(row.sourceId,row.sourceKind)}>{t(row.sourceKind==='task'?'p6.preparedPrompt.backTask':row.sourceKind==='home'?'p6.preparedPrompt.backHome':'p6.preparedPrompt.backSource')}</button><button type="button" className={css.button} disabled={busy} onClick={()=>preparation.dismiss(row.id)}>{t('p6.preparedPrompt.dismiss')}</button></div></div>)}</div></section>
}
