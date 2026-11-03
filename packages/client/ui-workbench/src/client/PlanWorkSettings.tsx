import type {PlanReportGroupOption} from './ContinuousPage.js'
import {useEffect,useId,useState} from 'react'
import {Pencil,ChevronUp} from 'lucide-react'
import type {WorkResource} from '@teloa/contract'
import {readWorkBudgetPolicy} from '@teloa/contract'
import type {PlanWorkConfiguration,WorkBudgetPolicy} from '@teloa/contract'
import {WorkBudgetFields,isWorkBudgetPolicyValid} from './WorkBudgetFields.js'
import type {PlanApi,SavedPlan,PlanWorkEditFields} from './plan-api.js'
import type {PreviewRole} from './role-preview.js'
import type {ResourceApi} from './resource-api.js'
import type {PlanBusinessSource,PlanBusinessSources} from './plan-work-business-sources.js'
import {canReceiveTask} from './role-preview.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import layout from './PlanWorkSettings.module.css'
export function currentPlanWorkDelegation(plan:Pick<SavedPlan,'scope'|'roleId'|'roleVersion'>,role:PreviewRole|undefined){
 const access=role?.workAccess;if(!role||role.id!==plan.roleId||role.storage!=='persistent'||!canReceiveTask(role,plan.scope)||!access||access.roleId!==role.id||access.roleVersion!==role.version)return undefined
 const rows=access.delegations.filter(d=>d.roleId===role.id&&d.roleVersion===role.version&&d.scope===plan.scope&&d.state==='active'&&d.allowedTools.length>0)
 return rows.length===1?rows[0]:undefined
}
export function PlanWorkSettings({groups=[],plan,api,role,resources,businessSources,changed,openRole}:{groups?:readonly PlanReportGroupOption[]|undefined;plan:SavedPlan;api:PlanApi;role:PreviewRole|undefined;resources:ResourceApi|undefined;businessSources?:PlanBusinessSources|undefined;changed:(row:SavedPlan)=>void;openRole:(id:string)=>void}){
 const {t,locale}=useI18n(),owner=plan.executor?.kind==='owner',delegation=currentPlanWorkDelegation(plan,role),work=plan.workDefinition,id=useId()
 const original=work?.triggers[0],originalBusiness=original?.kind==='local-event'&&'sourceRef'in original&&original.eventKind==='business-object-version'&&original.sourceRef.kind!=='business-sync'?original:undefined
 const unsupportedObservation=!!work&&(work.triggers.length!==1||original?.kind==='local-event'&&original.eventKind!=='material-version'&&!originalBusiness)
 const [editing,setEditing]=useState(false)
 const [materials,setMaterials]=useState<WorkResource[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false)
 const [fields,setFields]=useState<PlanWorkEditFields>({title:plan.title,goal:plan.goal,dataScope:plan.dataScope,delivery:plan.delivery,...(Object.hasOwn(plan,'groupId')?{groupId:plan.groupId}:{})})
 const [kind,setKind]=useState<'schedule'|'material'|'business'|'unsupported'>(unsupportedObservation?'unsupported':originalBusiness?'business':work?.triggers.some(v=>v.kind==='local-event'&&v.eventKind==='material-version')?'material':'schedule')
 const [businesses,setBusinesses]=useState<PlanBusinessSource[]>([]),[businessStatus,setBusinessStatus]=useState<'loading'|'ready'|'failed'>('loading'),[businessError,setBusinessError]=useState('')
 const [businessSelection,setBusinessSelection]=useState(originalBusiness?.sourceRef.kind==='business-object'?'original-record':originalBusiness&&'type'in originalBusiness.sourceRef?'type:'+originalBusiness.sourceRef.type:'')
 const [independent,setIndependent]=useState(originalBusiness?work?.overlap==='independent':true)
 const [source,setSource]=useState(work?.triggers.find((v):v is Extract<typeof v,{eventKind:'material-version'|'group-message'|'child-completed'|'approval-result'}>=>v.kind==='local-event'&&v.eventKind==='material-version')?.sourceId??'')
 const [verified,setVerified]=useState(work?.completion.kind==='verified'),[budget,setBudget]=useState<WorkBudgetPolicy>(()=>work?.budget??{maxGoalRounds:32,maxTokens:2_000_000,maxConcurrent:1,maxElapsedMs:21_600_000,maxRetries:3,stagnationRounds:3,money:null}),[savedVersion,setSavedVersion]=useState<number>()
 useEffect(()=>{let live=true;if(!resources||owner)return;void resources.directory().then(dir=>{if(live)setMaterials(dir.resources.filter(r=>r.ownerId===plan.ownerId&&r.status==='active'&&delegation?.knowledgeIds.includes(r.id)))},cause=>{if(live)setError(localizeWorkError(locale,cause))});return()=>{live=false}},[resources,plan.id,plan.version,delegation?.id,delegation?.version,locale,owner])
 useEffect(()=>{
  if(!editing||kind!=='business'||owner||!delegation||!businessSources||plan.scope==='general')return
  const abort=new AbortController();setBusinessStatus('loading');setBusinessError('');setConfirmed(false)
  void businessSources.list(plan.scope,abort.signal).then(rows=>{
   if(abort.signal.aborted)return
   if(rows.some(row=>row.sourceRef.kind!=='business-object-type'||row.sourceRef.scope!==plan.scope)||new Set(rows.map(row=>row.sourceRef.type)).size!==rows.length)throw Object.assign(Error('业务触发来源与当前业务不一致。'),{code:'teloa/invalid-host-response'})
   setBusinesses(rows);setBusinessStatus('ready');setConfirmed(false);const named=rows.filter(row=>row.title);if(!originalBusiness&&named.length===1)setBusinessSelection(value=>value||'type:'+named[0]!.sourceRef.type)
  }).catch(cause=>{if(!abort.signal.aborted){setBusinesses([]);setBusinessStatus('failed');setBusinessError(localizeWorkError(locale,cause))}})
  return()=>abort.abort()
 },[editing,kind,businessSources,plan.id,plan.version,plan.scope,delegation?.id,delegation?.version,locale,owner])
 const originalRecord=originalBusiness?.sourceRef.kind==='business-object'&&originalBusiness.sourceRef.scope===plan.scope?originalBusiness.sourceRef:undefined
 const originalType=originalRecord&&businesses.find(row=>row.sourceRef.type===originalRecord.type)
 const visibleBusinesses=businesses.filter(row=>row.title||originalBusiness&&'type'in originalBusiness.sourceRef&&row.sourceRef.type===originalBusiness.sourceRef.type)
 const selectedBusiness=businessSelection==='original-record'&&originalType?originalRecord:visibleBusinesses.find(row=>'type:'+row.sourceRef.type===businessSelection)?.sourceRef
 // 当前入口不编辑费用上限；合法旧策略的费用限制必须原样保留，不能因此阻止其他字段修改。
 let budgetValid=false
 try{if(work)readWorkBudgetPolicy(work.budget);readWorkBudgetPolicy(budget);budgetValid=isWorkBudgetPolicyValid({...budget,money:null})&&JSON.stringify(budget.money)===JSON.stringify(work?.budget.money??null)}catch{/* 非法原策略或本次字段仍不能保存。 */}
 const valid=!unsupportedObservation&&(owner||!!delegation)&&plan.state==='paused'&&(kind==='schedule'||kind==='material'&&materials.some(r=>r.id===source)||kind==='business'&&businessStatus==='ready'&&!!selectedBusiness)&&budgetValid&&(!verified||kind==='material')
 return <section className={layout.settings} data-teloa-anchor="plan-work"><header><strong>{t('planWork.title')}</strong>{work&&<small>{t('planWork.version',{version:work.definitionVersion})}</small>}{plan.state==='paused'&&(owner||delegation)&&<button type="button" className={layout.edit} aria-expanded={editing} aria-controls={id} onClick={()=>setEditing(value=>!value)}>{editing?<ChevronUp size={14} aria-hidden="true"/>:<Pencil size={14} aria-hidden="true"/>}{t(editing?'planWork.closeEdit':'planWork.edit')}</button>}</header>
  {plan.state!=='paused'?<p>{t('planWork.pauseFirst')}</p>:!owner&&!delegation?<><p>{t('planWork.delegation')}</p><button type="button" onClick={()=>plan.roleId&&openRole(plan.roleId)}>{t('planWork.configureRole')}</button></>:<div id={id} className={layout.editBody} hidden={!editing}><p className={layout.hint}>{t(owner?'planWork.ownerBoundary':'planWork.boundary')}</p>{unsupportedObservation&&<p role="status">{t('planWork.unsupported')}</p>}<form className={css.form} onSubmit={event=>{event.preventDefault();if(!confirmed||!valid||busy)return;setBusy(true);setError('');setSavedVersion(undefined);const configuration:PlanWorkConfiguration={completion:verified?{kind:'verified',verifier:'material-version-summary',verifierVersion:1,authorizationVersion:1}:{kind:'manual'},triggers:kind==='business'&&selectedBusiness?[{kind:'local-event',eventKind:'business-object-version',sourceRef:selectedBusiness,coalesce:originalBusiness&&JSON.stringify(originalBusiness.sourceRef)===JSON.stringify(selectedBusiness)?originalBusiness.coalesce:'latest'}]:kind==='material'?[{kind:'local-event',eventKind:'material-version',sourceId:source,coalesce:original?.kind==='local-event'&&'sourceId'in original&&original.sourceId===source?original.coalesce:'latest'}]:[{kind:'schedule',schedule:plan.trigger}],budget,overlap:kind==='business'?(independent?'independent':'forbid'):(work?.overlap??'forbid'),missed:'coalesce',safeRecovery:work?.safeRecovery??false};void api.configureWorkConfirmed(plan,configuration,fields).then(row=>{changed(row);setConfirmed(false);setSavedVersion(row.workDefinition?.definitionVersion)},cause=>setError(localizeWorkError(locale,cause))).finally(()=>setBusy(false))}}>
   <fieldset className={layout.content}><legend>{t('planWork.content')}</legend>{(['title','goal','dataScope','delivery'] as const).map(key=><label key={key}>{t(({title:'continuous.form.name',goal:'continuous.detail.goal',dataScope:'continuous.detail.dataScope',delivery:'continuous.detail.delivery'} as const)[key])}<textarea required maxLength={key==='title'?120:8000} rows={key==='title'?1:2} value={fields[key]} onChange={event=>{setFields(value=>({...value,[key]:event.target.value}));setConfirmed(false)}}/></label>)}</fieldset>
   <div className={layout.fields}><label>{t('planWork.trigger')}<select disabled={busy||unsupportedObservation} value={kind} onChange={event=>{setKind(event.target.value as typeof kind);setConfirmed(false);if(event.target.value!=='material')setVerified(false)}}>{unsupportedObservation&&<option value="unsupported">{t('planWork.unsupportedCurrent')}</option>}<option value="schedule">{t('planWork.schedule')}</option>{!owner&&<><option value="material">{t('planWork.material')}</option>{(plan.scope!=='general'&&businessSources||originalBusiness)&&<option value="business">{t('planWork.businessObject')}</option>}</>}</select></label>
   {!owner&&<><label>{t('continuous.report.group')}<select disabled={busy} value={fields.groupId??''} onChange={event=>{setFields(value=>({...value,groupId:event.target.value||null}));setConfirmed(false)}}><option value="">{t('continuous.report.none')}</option>{fields.groupId&&!groups.some(group=>group.id===fields.groupId&&(group.scope==='general'||group.scope===plan.scope))&&<option value={fields.groupId} disabled>{t('continuous.report.unavailable')}</option>}{groups.filter(group=>group.scope==='general'||group.scope===plan.scope).map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label><p>{t('continuous.report.description')}</p></>}</div>
   {kind==='material'&&<label>{t('planWork.source')}<select required value={source} onChange={event=>{setSource(event.target.value);setConfirmed(false)}}><option value="">{t('planWork.source')}</option>{materials.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label>}
   {kind==='business'&&<><label>{t('planWork.businessRecords')}<select required disabled={busy||businessStatus!=='ready'} value={businessSelection} onChange={event=>{setBusinessSelection(event.target.value);setConfirmed(false)}}><option value="">{t('planWork.chooseBusinessRecords')}</option>{businessSelection&&!selectedBusiness&&<option value={businessSelection} disabled>{t('planWork.businessUnavailable')}</option>}{originalRecord&&originalType&&<option value="original-record">{t('planWork.originalRecord',{title:originalType.title??t('planWork.originalRecordType')})}</option>}{visibleBusinesses.map(row=><option key={row.sourceRef.type} value={'type:'+row.sourceRef.type}>{row.title??t('planWork.originalRecordType')}</option>)}</select></label><p className={layout.hint}>{t('planWork.businessBoundary')}</p>{businessError&&<p className={css.error} role="alert">{businessError}</p>}{businessStatus==='ready'&&!selectedBusiness&&<p role="status">{t('planWork.businessUnavailable')}</p>}<label><input type="checkbox" checked={independent} disabled={busy} onChange={event=>{setIndependent(event.target.checked);setConfirmed(false)}}/>{t('planWork.independentRecords')}</label>{!independent&&<p className={layout.hint}>{t('planWork.serialRecords')}</p>}</>}
   <label><input type="checkbox" checked={verified} disabled={kind!=='material'} onChange={event=>{setVerified(event.target.checked);setConfirmed(false)}}/>{t(verified?'planWork.verified':'planWork.manual')}</label>{verified&&<p>{t('planWork.checkBoundary')}</p>}
   <WorkBudgetFields value={budget} disabled={busy} onChange={next=>{setBudget(next);setConfirmed(false);setSavedVersion(undefined)}}/><p className={layout.hint}>{t('planWork.budget.unlimitedBoundary')}</p>
   <label><input required type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{t(owner?'planWork.ownerConfirm':'planWork.confirm')}</label><button type="submit" disabled={busy||!confirmed||!valid}>{t(busy?'continuous.common.saving':'planWork.save')}</button>
  </form></div>}{error&&<p className={css.error} role="alert">{error}</p>}
 {savedVersion!==undefined&&<p role="status">{t('planWork.budget.definitionSaved',{version:savedVersion})}</p>}
 </section>
}
