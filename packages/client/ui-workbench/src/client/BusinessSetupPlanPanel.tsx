import {useRef,useState,useSyncExternalStore} from 'react'
import {businessSetupSelectionState} from '@teloa/contract'
import type {BusinessBuilderFlow} from './business-builder-flow.js'
import {BusinessBuilderLeaveDialog} from './BusinessBuilderLeaveDialog.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessBuilderPanel.module.css'
function ChangeValue({value,t}:{value:unknown;t:(key:string)=>string}){
 if(value===null||value===undefined)return <span>{t('business.plan.noValue')}</span>
 if(typeof value!=='object')return <span>{typeof value==='boolean'?t(value?'business.plan.yes':'business.plan.no'):String(value)}</span>
 if(Array.isArray(value))return <ul>{value.map((item,i)=><li key={i}><ChangeValue value={item} t={t}/></li>)}</ul>
 const labels:Record<string,string>={title:'business.manual.pageTitle',label:'business.manual.fieldName',type:'business.manual.fieldType',values:'business.manual.options',required:'business.plan.required',fields:'business.manual.fields',duty:'business.manual.duty',responsibility:'business.manual.employees',triggers:'business.manual.triggers',autonomousActions:'business.manual.autonomousActions',confirmationPoints:'business.manual.confirmationPoints',escalationRules:'business.manual.escalationRules',deliveryChecks:'business.manual.deliveryChecks',allowCreate:'business.manual.allowCreate',allowEdit:'business.manual.allowEdit',allowArchive:'business.manual.allowArchive',x:'business.manual.layout.x',y:'business.manual.layout.y',w:'business.manual.layout.w',h:'business.manual.layout.h'}
 return <dl className={css.changeValues}>{Object.entries(value).map(([key,v])=><div key={key}><dt>{labels[key]?t(labels[key]!):key}</dt><dd>{key==='type'&&typeof v==='string'?t('business.plan.type.'+v):<ChangeValue value={v} t={t}/>}</dd></div>)}</dl>
}
function changeSummary(value:unknown,t:(key:string)=>string):string{
 if(value===null||value===undefined)return t('business.plan.noValue')
 if(typeof value!=='object')return String(value)
 if(Array.isArray(value))return value.map(item=>changeSummary(item,t)).join(' · ')
 const row=value as Record<string,unknown>
 if(row.definition)return changeSummary(row.definition,t)
 if(typeof row.duty==='string'){const responsibility=row.responsibility&&typeof row.responsibility==='object'?Object.values(row.responsibility).flat().filter(v=>typeof v==='string'):[];return [row.duty,...responsibility].join(' · ')}
 const parts=[typeof row.label==='string'?row.label:typeof row.title==='string'?row.title:'']
 if(typeof row.type==='string')parts.push(t('business.plan.type.'+row.type))
 if(typeof row.required==='boolean')parts.push(t(row.required?'business.plan.required':'business.plan.optional'))
 if(Array.isArray(row.values))parts.push(row.values.join(' / '))
 if(Array.isArray(row.fields))parts.push(row.fields.map(v=>typeof v==='string'?v:changeSummary(v,t)).join('、'))
 return parts.filter(Boolean).join(' · ')||t('business.plan.definitionChange')
}

/** 原方案就地审阅；这里只提交决定和真实预览身份，不构造授权或运行状态。 */
export function BusinessSetupPlanPanel({flow,openConnections,onContinueEditing}:{flow:BusinessBuilderFlow;openConnections?:(scope:string,loadId:string)=>void;onContinueEditing?:()=>void}){
 const state=useSyncExternalStore(flow.subscribe,flow.getSnapshot,flow.getSnapshot),{t}=useI18n(),[busy,setBusy]=useState(false),[error,setError]=useState(false),flight=useRef(false)
 const plan=state.setupPlan,preview=state.setupPreview
 const selection=plan&&preview?businessSetupSelectionState(plan,preview):undefined,empty=selection==='empty'||selection==='rejected'
 const act=async(run:()=>Promise<unknown>)=>{if(flight.current)return;flight.current=true;setBusy(true);setError(false);try{await run()}catch{setError(true)}finally{flight.current=false;setBusy(false)}}
 const sections=[['role','business.plan.employees'],['work-template','business.plan.workflow'],['mcp','business.plan.connections'],['data-source','business.plan.sources'],['plugin','business.plan.apps'],['plan','business.plan.automation']] as const
 let pending=false,recoveryError=false;try{pending=!!flow.pendingSetupSave()}catch{pending=true;recoveryError=true}
 return <>
  {recoveryError&&<p role="alert" className={css.error}>{t('business.plan.recoveryError')}</p>}
  {plan&&<section className={css.plan} aria-label={t('business.plan.title')}>
   <h3>{t('business.plan.title')}</h3><p>{plan.description}</p>
   {sections.map(([kind,label])=>{const rows=plan.resources.filter(r=>r.kind===kind);return rows.length>0&&<section key={kind}><h4>{t(label)} <span>{rows.length}</span></h4>{rows.map(row=>{const step=plan.adoption?.steps.find(s=>s.id===row.id);return <div key={row.id} className={css.resource}><div><strong>{row.title}</strong> <small>v{row.version}</small><p>{row.description}</p></div><span>{t(step?'business.plan.state.'+step.state:'business.plan.candidate')}</span></div>})}</section>})}
   {plan.roleEdits.length>0&&<section><h4>{t('business.plan.roleChanges',{count:plan.roleEdits.length})}</h4>{plan.roleEdits.map(edit=><div className={css.resource} key={edit.roleId}><div><strong>{plan.roleNames?.[edit.roleId]??t('business.plan.roleCandidate')}</strong><p>{edit.duty}</p><details><summary>{t('business.plan.compare')}</summary><p>{changeSummary({duty:edit.duty,responsibility:edit.responsibility},t)}</p></details></div><span>{t('business.plan.candidate')}</span></div>)}</section>}
   <p className={css.notice}>{t(plan.state==='applied'?'business.plan.appliedNote':'business.plan.draftNote')}</p>
   {!recoveryError&&(pending||state.setupUnknown)&&<div role="status"><p>{t('business.plan.unknown')}</p><button disabled={busy} onClick={()=>void act(()=>flow.adoptSetup(true))}>{t('business.builder.check')}</button></div>}
   {error&&!empty&&<p role="alert" className={css.error}>{t('business.plan.error')}</p>}
   {plan.state==='draft'&&!pending&&!state.setupUnknown&&<>
    <p>{t('business.plan.continueNote')}</p>{onContinueEditing&&<button disabled={busy} onClick={onContinueEditing}>{t('business.plan.continueEditing')}</button>}
    <button disabled={busy} onClick={()=>void act(()=>flow.previewSetup(plan.rejected))}>{t('business.plan.review')}</button>
    {preview&&<section aria-label={t('business.plan.changes')}><h4>{t('business.plan.changes')}</h4>{preview.changes.map(change=>{const rejected=preview.rejected.includes(change.id);return <div className={css.change} key={change.id}><div><strong>{change.label}</strong><p>{t(change.before===null?'business.plan.add':change.after===null?'business.plan.remove':'business.plan.modify')}</p><details><summary>{t('business.plan.compare')}</summary><div><strong>{t('business.plan.before')}</strong><ChangeValue value={change.before} t={t}/></div><div><strong>{t('business.plan.after')}</strong><ChangeValue value={change.after} t={t}/></div></details></div><button aria-pressed={!rejected} disabled={busy} onClick={()=>void act(()=>flow.previewSetup(rejected?preview.rejected.filter(id=>id!==change.id):[...preview.rejected,change.id]))}>{t(rejected?'business.plan.rejected':'business.plan.accepted')}</button></div>})}{selection&&selection!=='changes'&&<p role="status">{t(selection==='empty'?'business.plan.noChanges':selection==='rejected'?'business.plan.allRejected':'business.plan.resourcesOnly')}</p>}<p>{t('business.plan.atomicNote')}</p><button className={css.primary} disabled={busy||preview.blocked||empty} onClick={()=>void act(()=>flow.adoptSetup())}>{t('business.plan.apply')}</button></section>}
   </>}
   {plan.state==='applied'&&<>
    {plan.adoption?.preparation?.state==='unknown'&&<p role="status">{t('business.plan.preparationUnknown')}</p>}
    <button disabled={busy} onClick={()=>void act(()=>flow.prepareSetup())}>{t('business.plan.readPreparation')}</button>
    {state.setupReadiness&&<section><h4>{t('business.plan.preparation')}</h4>{state.setupReadiness.rows.map(row=><div className={css.resource} key={row.itemInstanceId}><strong>{row.title}</strong><span>{t('business.plan.ready.'+row.state)}</span></div>)}<p>{t('business.plan.prepareNote')}</p><button disabled={busy} onClick={()=>void act(()=>flow.prepareSetup(true))}>{t('business.plan.prepare')}</button></section>}
    {plan.adoption?.loadId&&openConnections&&<button onClick={()=>openConnections(plan.scope,plan.adoption!.loadId!)}>{t('business.plan.manageResources')}</button>}
   </>}
  </section>}
  {state.leaveConfirmation&&<BusinessBuilderLeaveDialog flow={flow} disabled={busy||pending}/>}
 </>
}
