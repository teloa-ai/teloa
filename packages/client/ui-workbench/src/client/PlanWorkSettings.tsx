import {useEffect,useState} from 'react'
import type {WorkResource} from '@teloa/contract'
import type {PlanWorkConfiguration} from '@teloa/contract'
import type {PlanApi,SavedPlan} from './plan-api.js'
import type {PreviewRole} from './role-preview.js'
import type {ResourceApi} from './resource-api.js'
import {canReceiveTask} from './role-preview.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
export function currentPlanWorkDelegation(plan:Pick<SavedPlan,'scope'|'roleId'|'roleVersion'>,role:PreviewRole|undefined){
 const access=role?.workAccess;if(!role||role.id!==plan.roleId||role.storage!=='persistent'||!canReceiveTask(role,plan.scope)||!access||access.roleId!==role.id||access.roleVersion!==role.version)return undefined
 const rows=access.delegations.filter(d=>d.roleId===role.id&&d.roleVersion===role.version&&d.scope===plan.scope&&d.state==='active'&&d.allowedTools.length>0)
 return rows.length===1?rows[0]:undefined
}
export function PlanWorkSettings({plan,api,role,resources,changed,openRole}:{plan:SavedPlan;api:PlanApi;role:PreviewRole|undefined;resources:ResourceApi|undefined;changed:(row:SavedPlan)=>void;openRole:(id:string)=>void}){
 const {t,locale}=useI18n(),delegation=currentPlanWorkDelegation(plan,role),work=plan.workDefinition
 const [materials,setMaterials]=useState<WorkResource[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false)
 const [fields,setFields]=useState({title:plan.title,goal:plan.goal,dataScope:plan.dataScope,delivery:plan.delivery})
 const [kind,setKind]=useState<'schedule'|'material'>(work?.triggers.some(v=>v.kind==='local-event'&&v.eventKind==='material-version')?'material':'schedule')
 const [source,setSource]=useState(work?.triggers.find((v):v is Extract<typeof v,{kind:'local-event'}>=>v.kind==='local-event'&&v.eventKind==='material-version')?.sourceId??'')
 const [verified,setVerified]=useState(work?.completion.kind==='verified'),[rounds,setRounds]=useState(work?.budget.maxGoalRounds??32),[tokens,setTokens]=useState(work?.budget.maxTokens??2_000_000),[concurrent,setConcurrent]=useState(work?.budget.maxConcurrent??1)
 const [elapsed,setElapsed]=useState((work?.budget.maxElapsedMs??21_600_000)/60000),[retries,setRetries]=useState(work?.budget.maxRetries??3),[stagnation,setStagnation]=useState(work?.budget.stagnationRounds??3)
 useEffect(()=>{let live=true;if(!resources)return;void resources.directory().then(dir=>{if(live)setMaterials(dir.resources.filter(r=>r.ownerId===plan.ownerId&&r.status==='active'&&delegation?.knowledgeIds.includes(r.id)))},cause=>{if(live)setError(localizeWorkError(locale,cause))});return()=>{live=false}},[resources,plan.id,plan.version,delegation?.id,delegation?.version,locale])
 const valid=!!delegation&&plan.state==='paused'&&(kind==='schedule'||materials.some(r=>r.id===source))&&[rounds,tokens,concurrent,elapsed*60000,retries,stagnation].every(v=>Number.isSafeInteger(v)&&v>0)&&(!verified||kind==='material')
 return <details className={css.block} data-teloa-anchor="plan-work"><summary>{t('planWork.title')}{work?' · '+t('planWork.version',{version:work.definitionVersion}):''}</summary><p>{t('planWork.boundary')}</p>
  {plan.state!=='paused'?<p>{t('planWork.pauseFirst')}</p>:!delegation?<><p>{t('planWork.delegation')}</p><button type="button" onClick={()=>openRole(plan.roleId)}>{t('planWork.configureRole')}</button></>:<form className={css.form} onSubmit={event=>{event.preventDefault();if(!confirmed||!valid||busy)return;setBusy(true);setError('');const configuration:PlanWorkConfiguration={completion:verified?{kind:'verified',verifier:'material-version-summary',verifierVersion:1,authorizationVersion:1}:{kind:'manual'},triggers:kind==='material'?[{kind:'local-event',eventKind:'material-version',sourceId:source,coalesce:'latest'}]:[{kind:'schedule',schedule:plan.trigger}],budget:{maxGoalRounds:rounds,maxTokens:tokens,maxConcurrent:concurrent,maxElapsedMs:elapsed*60000,maxRetries:retries,stagnationRounds:stagnation,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:work?.safeRecovery??false};void api.configureWorkConfirmed(plan,configuration,fields).then(row=>{changed(row);setConfirmed(false)},cause=>setError(localizeWorkError(locale,cause))).finally(()=>setBusy(false))}}>
   {(['title','goal','dataScope','delivery'] as const).map(key=><label key={key}>{t(({title:'continuous.form.name',goal:'continuous.detail.goal',dataScope:'continuous.detail.dataScope',delivery:'continuous.detail.delivery'} as const)[key])}<textarea required maxLength={key==='title'?120:8000} rows={key==='title'?1:3} value={fields[key]} onChange={event=>{setFields(value=>({...value,[key]:event.target.value}));setConfirmed(false)}}/></label>)}
   <label>{t('planWork.trigger')}<select value={kind} onChange={event=>{setKind(event.target.value as typeof kind);setConfirmed(false);if(event.target.value==='schedule')setVerified(false)}}><option value="schedule">{t('planWork.schedule')}</option><option value="material">{t('planWork.material')}</option></select></label>
   {kind==='material'&&<label>{t('planWork.source')}<select required value={source} onChange={event=>{setSource(event.target.value);setConfirmed(false)}}><option value="">{t('planWork.source')}</option>{materials.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label>}
   <label><input type="checkbox" checked={verified} disabled={kind!=='material'} onChange={event=>{setVerified(event.target.checked);setConfirmed(false)}}/>{t(verified?'planWork.verified':'planWork.manual')}</label>{verified&&<p>{t('planWork.checkBoundary')}</p>}
   <label>{t('planWork.rounds')}<input required type="number" min={1} value={rounds} onChange={event=>{setRounds(Number(event.target.value));setConfirmed(false)}}/></label><label>{t('planWork.tokens')}<input required type="number" min={1} value={tokens} onChange={event=>{setTokens(Number(event.target.value));setConfirmed(false)}}/></label><label>{t('planWork.concurrent')}<input required type="number" min={1} value={concurrent} onChange={event=>{setConcurrent(Number(event.target.value));setConfirmed(false)}}/></label>
   <details><summary>{t('planWork.budget.advanced')}</summary><label>{t('planWork.elapsed')}<input required type="number" min={1} step={1} value={elapsed} onChange={event=>{setElapsed(Number(event.target.value));setConfirmed(false)}}/></label><label>{t('planWork.retries')}<input required type="number" min={1} step={1} value={retries} onChange={event=>{setRetries(Number(event.target.value));setConfirmed(false)}}/></label><label>{t('planWork.stagnation')}<input required type="number" min={1} step={1} value={stagnation} onChange={event=>{setStagnation(Number(event.target.value));setConfirmed(false)}}/></label></details>
   <label><input required type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{t('planWork.confirm')}</label><button type="submit" disabled={busy||!confirmed||!valid}>{t(busy?'continuous.common.saving':'planWork.save')}</button>
  </form>}{error&&<p className={css.error} role="alert">{error}</p>}
 </details>
}
