import {useEffect,useState} from 'react'
import type {TaskRunSourceFollowupCandidate} from '@teloa/contract'
import type {RunView,TaskRunApi} from './task-run-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {sourceFollowupCopy} from './task-run-source-followup-copy.js'
import css from './TaskPage.module.css'
import followup from './TaskRunSourceFollowup.module.css'

export function TaskRunSourceFollowup({run,api,close,prepared}:{run:RunView;api:TaskRunApi;close:()=>void;prepared:(run:RunView)=>void}){
 const {locale}=useI18n(),text=sourceFollowupCopy(locale,run.state==='submission_unknown'?'unknown-verification':'result-verification'),[candidate,setCandidate]=useState<TaskRunSourceFollowupCandidate>(),[instruction,setInstruction]=useState(()=>api.sourceFollowup.draft(run.taskId,run.id)),[busy,setBusy]=useState(false),[error,setError]=useState<string>()
 useEffect(()=>{let live=true;setCandidate(undefined);void api.sourceFollowup.get(run).then(value=>{if(live)setCandidate(value)},cause=>{if(live)setError(localizeWorkError(locale,cause))});return()=>{live=false}},[run.id,api,locale])
 const submit=async()=>{if(!candidate||busy)return;setBusy(true);setError(undefined);try{const saved=await api.sourceFollowup.prepare(candidate,instruction);prepared(saved);close()}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}
 const recover=async()=>{if(busy)return;setBusy(true);setError(undefined);try{const saved=await api.sourceFollowup.recover();prepared(saved);close()}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}
 return <ContextDrawer title={text.title} close={close} padded className={css.dialog??''}><div className={css.form}><p>{text.warning}</p>{candidate&&<p>{candidate.reference.id} · {text.version} {candidate.reference.version}</p>}<label>{text.prompt}<textarea aria-label={text.prompt} rows={8} maxLength={8000} value={instruction} placeholder={text.example} onChange={event=>{const value=event.target.value;setInstruction(value);try{api.sourceFollowup.saveDraft(run.taskId,run.id,value)}catch(cause){setError(localizeWorkError(locale,cause))}}}/></label><p>{text.example}</p>{error&&<p role="alert">{error}</p>}{api.sourceFollowup.recoveryError()&&<p role="alert">{localizeWorkError(locale,api.sourceFollowup.recoveryError())}</p>}<div className={css.buttons}>{api.sourceFollowup.pending()?.command.runId===run.id?<button type="button" className={followup.primary} disabled={busy} onClick={()=>void recover()}>{text.recover}</button>:<button type="button" className={followup.primary} disabled={busy||!candidate||!instruction.trim()||!!api.sourceFollowup.pending()||!!api.sourceFollowup.recoveryError()} onClick={()=>void submit()}>{text.confirm}</button>}<button type="button" onClick={close}>{text.cancel}</button></div></div></ContextDrawer>
}
