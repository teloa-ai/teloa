import {useEffect,useReducer,useRef,useState} from 'react'
import type {SkillInstallationRecord} from './skill-install-api.js'
import type {SkillAvailabilityApi,SkillAvailabilityReceipt,SkillAvailabilityImpact} from './skill-availability-api.js'
import {reduceAvailabilityView,type AvailabilityAction} from './skill-availability-state.js'
import css from './RealSkillInstallations.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

export function SkillAvailabilityPanel({api,record,onChanged,onOpenInstallation}:{api:SkillAvailabilityApi;record:SkillInstallationRecord;onChanged:()=>void;onOpenInstallation:(id:string)=>void}){
 const {locale,t,dateTime}=useI18n()
 const label=(action:AvailabilityAction)=>action==='disable'?t('market.skill.availability.disable'):t('market.skill.availability.enable')
 const errorText=()=>t('market.skill.availability.failed')
 const [view,dispatch]=useReducer(reduceAvailabilityView,{installationId:record.id,generation:0,loading:true,error:''}),[receipt,setReceipt]=useState<SkillAvailabilityReceipt>(),[reason,setReason]=useState(''),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[discarded,setDiscarded]=useState(false)
 const generation=useRef(0),operation=useRef(false)
 useEffect(()=>{const token=++generation.current;dispatch({type:'select',installationId:record.id,generation:token});void api.get(record.id).then(value=>{if(token===generation.current)dispatch({type:'loaded',generation:token,value})},error=>{if(token===generation.current)dispatch({type:'error',generation:token,error:errorText()})});return()=>{generation.current++}},[api,record.id,record.version,record.bundleHash,revision])
 const pending=api.pending(),recoveryError=api.recoveryMessage(),pendingHere=pending?.installationId===record.id,current=view.current,preview=view.preview,action=view.action
 const start=()=>{const token=++generation.current;dispatch({type:'select',installationId:record.id,generation:token});return token}
 const inspect=async(next:AvailabilityAction)=>{if(operation.current)return;const token=start();try{const value=await api.preview(record.id);if(token===generation.current)dispatch({type:'preview',generation:token,value,action:next})}catch(error){if(token===generation.current)dispatch({type:'error',generation:token,error:errorText()})}}
 const validPreview=!!preview&&!!action&&preview.installation.id===record.id&&preview.installation.version===record.version&&preview.installation.bundleHash===record.bundleHash&&preview.availability.version===current?.version&&!preview.blockers.length
 const submit=async(recover=false)=>{
  if(operation.current||!recover&&(!validPreview||!preview||!action||pending))return
  operation.current=true;setBusy(true)
  const spec=!recover&&preview&&action?{requestId:crypto.randomUUID(),installationId:record.id,expectedVersion:preview.availability.version,expectedBundleHash:preview.installation.bundleHash,expectedImpactDigest:preview.impactDigest,action,...(reason.trim()?{reason:reason.trim()}:{})}:undefined
  const token=start()
  try{const result=recover?await api.recover(record.id):await api.change(spec!);if(token!==generation.current)return;setReceipt(result.receipt);dispatch({type:'loaded',generation:token,value:result.current});onChanged()}
  catch(error){if(token===generation.current)dispatch({type:'error',generation:token,error:errorText()})}
  finally{operation.current=false;setBusy(false)}
 }
 return <section className={css.sheet} aria-label={t('market.skill.availability.aria')}><h3>{t('market.skill.availability.title')}</h3>
  <p>{current?t('market.skill.availability.stateVersion',{state:current.availability==='enabled'?t('market.skill.availability.enabled'):t('market.skill.availability.disabled'),version:current.version}):t('market.skill.availability.unverified')}</p>
  <p>{t('market.skill.availability.boundary')}</p>
  {view.loading&&<p role="status">{t('market.skill.availability.loading')}</p>}
  {(view.error||recoveryError)&&<p role="alert">{view.error||localizeWorkError(locale,recoveryError)}{recoveryError&&' '+t('recovery.nextStep')}</p>}
  {recoveryError&&<button type="button" onClick={()=>{api.discard();setDiscarded(true)}}>{t('recovery.discard')}</button>}
  {discarded&&<p role="status">{t('recovery.discarded')}</p>}
  <div className={css.buttons}><button type="button" disabled={busy||view.loading} onClick={()=>setRevision(v=>v+1)}>{t('market.skill.availability.refresh')}</button>
   {current&&!pending&&!recoveryError&&<button type="button" disabled={busy||view.loading} onClick={()=>void inspect(current.availability==='enabled'?'disable':'enable')}>{current.availability==='enabled'?t('market.skill.availability.previewDisable'):t('market.skill.availability.previewEnable')}</button>}
   {pendingHere&&<button type="button" disabled={busy} onClick={()=>void submit(true)}>{t('market.skill.availability.reviewOriginal',{action:label(pending.action)})}</button>}
   {pending&&!pendingHere&&<button type="button" onClick={()=>onOpenInstallation(pending.installationId)}>{t('market.skill.availability.openPending')}</button>}
  </div>
  {pendingHere&&<p role="status">{t('market.skill.availability.pendingDetail',{action:label(pending.action),id:pending.requestId})}</p>}
  {preview&&action&&<section aria-label={t('market.skill.availability.previewAria')}><h4>{t('market.skill.availability.previewTitle',{action:label(action)})}</h4><dl><dt>{t('market.skill.availability.installation')}</dt><dd>{preview.installation.id}</dd><dt>{t('market.skill.availability.bundleHash')}</dt><dd>{preview.installation.bundleHash}</dd><dt>{t('market.skill.availability.version')}</dt><dd>{preview.availability.version}</dd></dl>
   <AvailabilityImpact impact={preview.impact}/>
   {preview.blockers.length>0&&<p role="alert">{t('market.skill.availability.installIncomplete')}</p>}
   {!validPreview&&!preview.blockers.length&&<p role="alert">{t('market.skill.availability.changed')}</p>}
   <label>{t('market.skill.availability.reason')}<textarea aria-label={t('market.skill.availability.reasonAria')} maxLength={4000} value={reason} onChange={event=>setReason(event.target.value)}/></label>
   <div className={css.buttons}><button type="button" disabled={!validPreview||busy||!!pending||!!view.error} onClick={()=>void submit()}>{t('market.skill.availability.confirm',{action:label(action)})}</button><button type="button" disabled={busy} onClick={()=>setRevision(v=>v+1)}>{t('market.skill.availability.cancelPreview')}</button></div>
  </section>}
  {receipt&&<section aria-label={t('market.skill.availability.receiptAria')}><h4>{t('market.skill.availability.receiptTitle')}</h4><p>{t('market.skill.availability.receiptState',{action:label(receipt.action),version:receipt.result.version})}</p><p>{t('market.skill.availability.request',{id:receipt.requestId})}</p><p>{dateTime(receipt.createdAt)}</p>{receipt.reason&&<p>{receipt.reason}</p>}<p>{t('market.skill.availability.receiptBoundary')}</p></section>}
 </section>
}
function AvailabilityImpact({impact}:{impact:SkillAvailabilityImpact}){
 const {t}=useI18n()
 const groups=[{name:t('market.skill.availability.groupIndustry'),items:impact.industryUsages.map(v=>({id:v.loadId+':'+v.itemInstanceId,text:t('market.skill.availability.industryUse',{load:v.loadId,item:v.itemInstanceId})}))},{name:t('market.skill.availability.groupRoles'),items:impact.roles.map(v=>({id:v.roleId,text:v.name+' · '+v.state+' · '+v.roleId}))},{name:t('market.skill.availability.groupPlans'),items:impact.plans.map(v=>({id:v.planId,text:t('market.skill.availability.planUse',{plan:v.planId,state:v.state,role:v.roleId})}))},{name:t('market.skill.availability.groupTasks'),items:impact.tasks.map(v=>({id:v.taskId,text:v.taskId+' · '+v.state}))},{name:t('market.skill.availability.groupRuns'),items:impact.runs.map(v=>({id:v.runId,text:t('market.skill.availability.runUse',{run:v.runId,state:v.state,task:v.taskId})}))}]
 return <><p>{t('market.skill.availability.impactIntro')}</p>{groups.map(group=><div key={group.name}><h4>{t('market.skill.availability.groupCount',{name:group.name,count:group.items.length})}</h4>{group.items.length?<ul>{group.items.map(item=><li key={item.id}>{item.text}</li>)}</ul>:<p>{t('market.skill.availability.none')}</p>}</div>)}<p>{t('market.skill.availability.nativeBoundary')}</p></>
}
