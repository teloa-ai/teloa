import type {ArtifactApi} from './artifact-api.js'
import type {RoleArtifactSummary} from '@teloa/contract'
import {useEffect,useRef,useState} from 'react'
import {BookOpen,ChevronRight,FileText,Puzzle,RefreshCw} from 'lucide-react'
import {employeeCopy} from './employee-copy.js'
import {employeeResults} from './employee-work-presentation.js'
import {EmployeeComputerLink} from './EmployeeDevices.js'
import type {PreviewRole} from './role-preview.js'
import {taskHistoryText,taskStates,type PreviewTask,type TaskPreview} from './task-preview.js'
import type {RunView,TaskRunApi} from './task-run-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TeamPage.module.css'

export type EmployeeArtifactOpen=(output:RoleArtifactSummary,current:()=>boolean)=>Promise<void>

export function EmployeeWorkOverview({active:workVisible=true,artifacts,openArtifact,role,tasks,state,runs,scopeName,openTask,resources}:{active?:boolean;artifacts?:Pick<ArtifactApi,'listByRole'>|undefined;openArtifact?:EmployeeArtifactOpen|undefined;role:PreviewRole;tasks:readonly PreviewTask[];state:TaskPreview;runs?:TaskRunApi|undefined;scopeName:(scope:string)=>string;openTask:(id:string)=>void;resources:()=>void}){
 const {locale,t,dateTime}=useI18n(),copy=(key:Parameters<typeof employeeCopy>[1])=>employeeCopy(locale,key)
 const ordered=[...tasks].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),active=ordered.filter(task=>task.state==='running'),latest=active[0]??ordered[0]
 const results=employeeResults(tasks,state.artifacts)
 const [outputs,setOutputs]=useState<{api:typeof artifacts;roleId:string;rows?:readonly RoleArtifactSummary[];error?:string}>(),[outputRevision,retryOutputs]=useState(0)
 const outputLocation=useRef({artifacts,roleId:role.id,version:role.version,active:workVisible});outputLocation.current={artifacts,roleId:role.id,version:role.version,active:workVisible}
 useEffect(()=>{outputLocation.current.active=workVisible;return()=>{outputLocation.current.active=false}},[workVisible])
 const mayOpenOutput=()=>outputLocation.current.active&&outputLocation.current.artifacts===artifacts&&outputLocation.current.roleId===role.id&&outputLocation.current.version===role.version
 const outputRead=outputs&&outputs.api===artifacts&&outputs.roleId===role.id?outputs:undefined
 useEffect(()=>{let active=true;if(role.storage!=='persistent'||!artifacts)return;setOutputs(undefined);void artifacts.listByRole(role.id).then(rows=>{if(active)setOutputs({api:artifacts,roleId:role.id,rows})},cause=>{if(active)setOutputs({api:artifacts,roleId:role.id,error:localizeWorkError(locale,cause)})});return()=>{active=false}},[artifacts,role.id,role.version,outputRevision,locale])
 const [run,setRun]=useState<RunView>(),[error,setError]=useState<string>(),[revision,setRevision]=useState(0)
 useEffect(()=>{let live=true;setRun(undefined);setError(undefined);if(!runs||!latest||latest.storage!=='persistent')return;void runs.list(latest.id).then(rows=>{if(live)setRun(rows.filter(row=>row.roleId===role.id||row.roleSnapshot?.id===role.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0])}).catch(error=>{if(live)setError(localizeWorkError(locale,error))});return()=>{live=false}},[runs,latest?.id,latest?.version,role.id,revision,locale])
 const taskRows=(rows:readonly PreviewTask[])=>rows.map(task=><button type="button" key={task.id} className={css.profileRow} onClick={()=>openTask(task.id)}><span><strong>{task.title}</strong><small>{scopeName(task.scope)}</small></span><span className={css.profileState}>{t(taskStates[task.state])}</span><ChevronRight size={14}/></button>)
 return <div className={css.profileSections}>
  <section><header><h3>{copy('profileProgress')}</h3>{latest&&<small>{latest.title}</small>}</header>{latest?.history.length?<ol className={css.profileTimeline}>{latest.history.slice(-4).map((entry,i)=><li key={i}><span>{taskHistoryText(entry,t)}</span><small>{dateTime(entry.at,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</small></li>)}</ol>:latest?<ol className={css.profileTimeline}><li><span>{copy('profileProgressSnapshot')} · {t(taskStates[latest.state])}</span><small>{dateTime(latest.updatedAt,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</small></li></ol>:<p className={css.muted}>{copy('profileNoProgress')}</p>}</section>
  <section aria-label={copy('profileRunning')}><header><h3>{copy('profileRunning')}</h3><small>{active.length||''}</small></header>{active.length?taskRows(active):<p className={css.muted}>{copy('profileNoRunning')}</p>}</section>
  <section><header><h3>{copy('profileResults')}</h3><small>{role.storage==='persistent'?outputRead?.rows?.length||'':results.length||''}</small></header>{role.storage==='persistent'?(outputRead?.error?<p role="alert">{outputRead.error}<button type="button" onClick={()=>retryOutputs(n=>n+1)}>{t('common.retry')}</button></p>:!artifacts?<p className={css.muted}>{copy('profileResultsUnavailable')}</p>:!outputRead?.rows?<p role="status">{t('knowledge.ui.085')}</p>:outputRead.rows.length?outputRead.rows.map(output=><button type="button" className={css.profileRow} key={output.artifactId} disabled={!openArtifact} onClick={()=>{void openArtifact?.(output,mayOpenOutput).catch(cause=>{if(mayOpenOutput())setOutputs({api:artifacts,roleId:role.id,rows:outputRead.rows!,error:localizeWorkError(locale,cause)})})}}><FileText size={16}/><span><strong>{output.title}</strong><small>v{output.number}</small></span><ChevronRight size={14}/></button>):<p className={css.muted}>{copy('profileNoResults')}</p>):results.length?results.map(({artifact,version,task})=><button type="button" className={css.profileRow} key={artifact.id} onClick={()=>openTask(task.id)}><FileText size={16}/><span><strong>{version.title}</strong><small>v{version.number}</small></span><ChevronRight size={14}/></button>):<p className={css.muted}>{copy('profileNoResults')}</p>}</section>
  {(run||error)&&<section><header><h3>{copy('profileInputs')}</h3>{error&&<button type="button" aria-label={t('common.retry')} onClick={()=>setRevision(n=>n+1)}><RefreshCw size={14}/></button>}</header>{error?<p role="alert">{error}</p>:run&&<><p className={css.muted}>{copy('profileInputHint')}</p><div className={css.resourceChips}>{run.knowledge.map(resource=><button type="button" key={resource.id} onClick={resources}><BookOpen size={13}/>{resource.title}<small>v{resource.version}</small></button>)}{run.skills.map(skill=><span key={skill.name}><Puzzle size={13}/>{skill.name}</span>)}</div></>}</section>}
  <section><header><h3>{copy('computer')}</h3></header><EmployeeComputerLink role={role} variant="preview"/></section>
  <section aria-label={copy('profileAllTasks')}><header><h3>{copy('profileAllTasks')}</h3><small>{tasks.length}</small></header>{ordered.length?taskRows(ordered):<p className={css.muted}>{t('team.work.empty')}</p>}</section>
 </div>
}
