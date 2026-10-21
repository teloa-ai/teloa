import {useEffect,useRef,useState} from 'react'
import {businessFieldTypes,readBusinessConfigurationCandidateV2,type BusinessSetupManual,type BusinessConfigurationCandidateV2} from '@teloa/contract'
import type {BusinessBuilderFlow} from './business-builder-flow.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessSetupManualEditor.module.css'

type Edit=Pick<BusinessSetupManual,'candidate'|'description'|'roleEdits'>
type Cached={snapshot:BusinessSetupManual;edit:Edit}
type ObjectDefinition=Extract<BusinessConfigurationCandidateV2['definitions'][number],{kind:'object-type'}>['definition']
type Field=ObjectDefinition['fields'][number]
const drafts=new WeakMap<BusinessBuilderFlow,Map<string,Cached>>()
const failedPersistence=new WeakMap<BusinessBuilderFlow,Set<string>>()
const dutyKeys=['triggers','autonomousActions','confirmationPoints','escalationRules','deliveryChecks'] as const
const lines=(text:string)=>text.split('\n')
function completeEdit(input:Edit):Edit{
 const edit=structuredClone(input),clean=(values:string[])=>values.map(value=>value.trim()).filter(Boolean)
 for(const d of edit.candidate.definitions)if(d.kind==='object-type')for(const field of d.definition.fields)if(field.type==='enum'||field.type==='multi-enum')field.values=clean(field.values??[])
 for(const role of edit.roleEdits)for(const key of dutyKeys)role.responsibility[key]=clean(role.responsibility[key])
 return edit
}
function localId(prefix:string,used:readonly string[]){let n=1;while(used.includes(prefix+n))n++;return prefix+n}

/** 本人静态候选编辑；关闭保留局部输入，保存后仍回原方案逐项预览，不写运行资源。 */
export function BusinessSetupManualEditor({flow,onClose,onReview,current}:{flow:BusinessBuilderFlow;onClose:()=>void;onReview?:()=>void;current?:()=>boolean}){
 const {t}=useI18n(),[loaded,setLoaded]=useState<Cached>(),[busy,setBusy]=useState(false),[error,setError]=useState(false),[stale,setStale]=useState(false),[unpersisted,setUnpersisted]=useState(false),[advanced,setAdvanced]=useState<string>()
 const mounted=useRef(true),flight=useRef(false)
 const valid=()=>mounted.current&&current?.()!==false
 const load=async(reset=false)=>{if(flight.current)return;flight.current=true;setBusy(true);setError(false);try{const snapshot=await flow.readManual();if(!valid())return;let cache=drafts.get(flow)?.get(snapshot.draftId);if(!cache&&!reset)try{cache=flow.readManualInput(snapshot)??undefined}catch{setUnpersisted(true)}const same=cache&&cache.snapshot.revision===snapshot.revision&&cache.snapshot.configurationRevision===snapshot.configurationRevision&&cache.snapshot.configurationHash===snapshot.configurationHash;const next=!reset&&cache?cache:{snapshot,edit:{candidate:structuredClone(snapshot.candidate),description:snapshot.description,roleEdits:structuredClone(snapshot.roleEdits)}};setLoaded(next);setUnpersisted(failedPersistence.get(flow)?.has(snapshot.draftId)??false);if(reset){drafts.get(flow)?.delete(snapshot.draftId);try{flow.writeManualInput(next);failedPersistence.get(flow)?.delete(next.snapshot.draftId);setUnpersisted(false)}catch{let failed=failedPersistence.get(flow);if(!failed){failed=new Set();failedPersistence.set(flow,failed)}failed.add(next.snapshot.draftId);setUnpersisted(true)}}setStale(!reset&&!!cache&&!same);setAdvanced(undefined)}catch{if(valid())setError(true)}finally{flight.current=false;if(valid())setBusy(false)}}
 useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false}},[flow])
 const update=(run:(edit:Edit)=>void)=>{if(!loaded||busy)return;const next={snapshot:loaded.snapshot,edit:structuredClone(loaded.edit)};run(next.edit);let byId=drafts.get(flow);if(!byId){byId=new Map();drafts.set(flow,byId)}byId.set(next.snapshot.draftId,next);setLoaded(next);try{flow.writeManualInput(next);failedPersistence.get(flow)?.delete(next.snapshot.draftId);setUnpersisted(false)}catch{let failed=failedPersistence.get(flow);if(!failed){failed=new Set();failedPersistence.set(flow,failed)}failed.add(next.snapshot.draftId);setUnpersisted(true)}}
 const mutate=(run:(candidate:BusinessConfigurationCandidateV2)=>void)=>update(edit=>run(edit.candidate))
 const save=async()=>{if(!loaded||flight.current||stale)return;flight.current=true;setBusy(true);setError(false);try{const edit=completeEdit(loaded.edit);readBusinessConfigurationCandidateV2(edit.candidate);await flow.saveManual(loaded.snapshot,edit);drafts.get(flow)?.delete(loaded.snapshot.draftId);try{flow.clearManualInput(loaded.snapshot)}catch{}if(valid()){onReview?.();onClose()}}catch{if(valid())setError(true)}finally{flight.current=false;if(valid())setBusy(false)}}
 const candidate=loaded?.edit.candidate,objects=candidate?.definitions.filter(d=>d.kind==='object-type')??[],widgets=candidate?.definitions.filter(d=>d.kind==='widget')??[]
 const fieldEdit=(objectId:string,index:number,run:(field:Field)=>Field)=>mutate(c=>{const object=c.definitions.find(d=>d.kind==='object-type'&&d.definition.id===objectId);if(object?.kind==='object-type')object.definition.fields[index]=run(object.definition.fields[index]!)})
 return <section className={css.editor} aria-label={t('business.manual.title')}>
  <h3>{t('business.manual.title')}</h3><p>{t('business.manual.note')}</p>
  {busy&&!loaded&&<p role="status">{t('business.manual.loading')}</p>}
  {error&&<p role="alert">{t('business.manual.error')}</p>}
  {stale&&<p role="alert">{t('business.manual.stale')}</p>}
  {unpersisted&&<p role="alert">{t('business.manual.unpersisted')}</p>}
  {(!loaded||stale)&&<button disabled={busy} onClick={()=>void load(true)}>{t('business.manual.reload')}</button>}
  {loaded&&candidate&&<fieldset disabled={busy||stale}>
   <label>{t('business.manual.name')}<input maxLength={80} value={candidate.title} onChange={e=>mutate(c=>{c.title=e.target.value})}/></label>
   <label>{t('business.manual.description')}<textarea aria-label={t('business.manual.description')} maxLength={2000} value={loaded.edit.description} onChange={e=>update(edit=>{edit.description=e.target.value})}/></label>
   <h4>{t('business.manual.fields')}</h4>
   {objects.map(({definition:object})=><details key={object.id} open><summary>{object.title}</summary>
    <label>{t('business.manual.recordName')}<input maxLength={80} value={object.title} onChange={e=>mutate(c=>{const d=c.definitions.find(d=>d.kind==='object-type'&&d.definition.id===object.id);if(d)d.definition.title=e.target.value})}/></label>
    {object.fields.map((field,index)=><div className={css.item} key={field.name}><label>{t('business.manual.fieldName')}<input maxLength={80} value={field.label} onChange={e=>fieldEdit(object.id,index,f=>({...f,label:e.target.value}))}/></label>
     <label>{t('business.manual.fieldType')}<select value={field.type} disabled={'format'in field} onChange={e=>fieldEdit(object.id,index,f=>{if('format'in f)return f;const {values:_,referenceType:__,...rest}=f;const type=e.target.value as typeof businessFieldTypes[number];return {...rest,type,...(type==='enum'?{values:[]}:{ }),...(type==='reference'?{referenceType:objects[0]?.definition.id??object.id}:{})} as Field})}>{[...new Set([...businessFieldTypes,field.type])].map(type=><option key={type} value={type}>{t('business.plan.type.'+type)}</option>)}</select></label>
     <label className={css.check}><input type="checkbox" checked={field.required} onChange={e=>fieldEdit(object.id,index,f=>({...f,required:e.target.checked}))}/>{t('business.plan.required')}</label>
     {(field.type==='enum'||field.type==='multi-enum')&&<label>{t('business.manual.options')}<textarea aria-label={t('business.manual.options')} value={(field.values??[]).join('\n')} onChange={e=>fieldEdit(object.id,index,f=>({...f,values:lines(e.target.value)} as Field))}/></label>}
     {(field.type==='reference'||field.type==='multi-reference')&&<label>{t('business.manual.reference')}<select value={field.referenceType} onChange={e=>fieldEdit(object.id,index,f=>({...f,referenceType:e.target.value} as Field))}>{objects.map(({definition:d})=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label>}
     <button onClick={()=>mutate(c=>{const d=c.definitions.find(d=>d.kind==='object-type'&&d.definition.id===object.id);if(d?.kind==='object-type')d.definition.fields.splice(index,1)})}>{t('business.manual.removeField')}</button>
    </div>)}
    <button onClick={()=>mutate(c=>{const d=c.definitions.find(d=>d.kind==='object-type'&&d.definition.id===object.id);if(d?.kind==='object-type'){const name=localId('field_',d.definition.fields.map(f=>f.name)),label=t('business.manual.newField')+' '+(d.definition.fields.length+1);d.definition.fields.push({name,label,from:label,type:'text',required:false})}})}>{t('business.manual.addField')}</button>
   </details>)}
   <h4>{t('business.manual.employees')}</h4>
   {loaded.snapshot.employees.length===0&&<p>{t('business.manual.noEmployees')}</p>}
   {loaded.snapshot.employees.map(employee=>{const proposed=loaded.edit.roleEdits.find(e=>e.roleId===employee.roleId),role=proposed??employee;return <details key={employee.roleId}><summary>{employee.name}</summary>{employee.state==='active'&&<p>{t('business.manual.pauseRole')}</p>}
    <label className={css.check}><input type="checkbox" checked={!!proposed} onChange={e=>update(edit=>{edit.roleEdits=edit.roleEdits.filter(r=>r.roleId!==employee.roleId);if(e.target.checked)edit.roleEdits.push({roleId:employee.roleId,expectedVersion:employee.expectedVersion,duty:employee.duty,responsibility:structuredClone(employee.responsibility)})})}/>{t('business.manual.includeRole')}</label>
    <label>{t('business.manual.duty')}<textarea aria-label={t('business.manual.duty')} disabled={!proposed} value={role.duty} onChange={e=>update(edit=>{edit.roleEdits.find(r=>r.roleId===employee.roleId)!.duty=e.target.value})}/></label>
    {dutyKeys.map(key=><label key={key}>{t('business.manual.'+key)}<textarea aria-label={t('business.manual.'+key)} disabled={!proposed} value={role.responsibility[key].join('\n')} onChange={e=>update(edit=>{edit.roleEdits.find(r=>r.roleId===employee.roleId)!.responsibility[key]=lines(e.target.value)})}/></label>)}
   </details>})}
   <h4>{t('business.manual.pages')}</h4>
   {candidate.pages.map((page,index)=><details key={page.id} open><summary>{page.title}</summary>
    <label>{t('business.manual.pageTitle')}<input maxLength={80} value={page.title} onChange={e=>mutate(c=>{c.pages[index]!.title=e.target.value})}/></label>
    <label className={css.check}><input type="radio" name="setup-home" checked={candidate.homePageId===page.id} onChange={()=>mutate(c=>{c.homePageId=page.id})}/>{t('business.manual.home')}</label>
    {page.kind==='records'?<><label>{t('business.manual.recordName')}<select value={page.objectType} onChange={e=>mutate(c=>{const p=c.pages[index],object=objects.find(d=>d.definition.id===e.target.value)?.definition;if(p?.kind==='records'&&object){p.objectType=object.id;p.fields=object.fields.slice(0,1).map(f=>f.name)}})}>{objects.map(({definition:d})=><option value={d.id} key={d.id}>{d.title}</option>)}</select></label>
     <div>{objects.find(d=>d.definition.id===page.objectType)?.definition.fields.map(field=><label key={field.name} className={css.check}><input type="checkbox" checked={page.fields.includes(field.name)} onChange={e=>mutate(c=>{const p=c.pages[index];if(p?.kind==='records')p.fields=e.target.checked?[...p.fields,field.name]:p.fields.filter(name=>name!==field.name)})}/>{field.label}</label>)}</div>
     {(['allowCreate','allowEdit','allowArchive'] as const).map(key=><label key={key} className={css.check}><input type="checkbox" checked={page[key]} onChange={e=>mutate(c=>{const p=c.pages[index];if(p?.kind==='records')p[key]=e.target.checked})}/>{t('business.manual.'+key)}</label>)}
    </>:<label>{t('business.manual.dashboard')}<select value={page.dashboardId} onChange={e=>mutate(c=>{const p=c.pages[index];if(p?.kind==='dashboard')p.dashboardId=e.target.value})}>{candidate.definitions.filter(d=>d.kind==='dashboard').map(({definition:d})=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label>}
    <div className={css.actions}><button disabled={index===0} onClick={()=>mutate(c=>{const row=c.pages.splice(index,1)[0]!;c.pages.splice(index-1,0,row)})}>{t('business.manual.moveUp')}</button><button onClick={()=>mutate(c=>{c.pages.splice(index,1);if(c.homePageId===page.id){if(c.pages[0])c.homePageId=c.pages[0].id;else delete c.homePageId}})}>{t('business.manual.removePage')}</button></div>
   </details>)}
   <div className={css.actions}><button disabled={!objects.length} onClick={()=>mutate(c=>{const object=objects[0]!.definition,id=localId('records-',c.pages.map(p=>p.id));c.pages.push({id,title:object.title,kind:'records',objectType:object.id,fields:object.fields.slice(0,1).map(f=>f.name),allowCreate:false,allowEdit:false,allowArchive:false});c.homePageId??=id})}>{t('business.manual.addPage')}</button>
    <button disabled={!widgets.length} onClick={()=>mutate(c=>{const id=localId('dashboard-',c.definitions.map(d=>d.definition.id)),widget=widgets[0]!.definition.id;c.definitions.push({kind:'dashboard',definition:{format:'teloa.business-dashboard/v1',id,version:'1.0.0',domain:c.scope,title:t('business.manual.dashboard'),widgets:[widget],layout:[{widget,x:0,y:0,w:12,h:4}],refresh:{kind:'hourly',minute:0},acknowledgeShortInterval:false}});const pageId=localId('dashboard-page-',c.pages.map(p=>p.id));c.pages.push({id:pageId,title:t('business.manual.dashboard'),kind:'dashboard',dashboardId:id});c.homePageId??=pageId})}>{t('business.manual.addDashboard')}</button></div>
   {candidate.definitions.filter(d=>d.kind==='dashboard').map(({definition:dashboard})=><details key={dashboard.id}><summary>{dashboard.title}</summary>
    <label>{t('business.manual.dashboardTitle')}<input value={dashboard.title} maxLength={80} onChange={e=>mutate(c=>{const d=c.definitions.find(d=>d.kind==='dashboard'&&d.definition.id===dashboard.id);if(d)d.definition.title=e.target.value})}/></label>
    {widgets.map(({definition:widget})=><label className={css.check} key={widget.id}><input type="checkbox" checked={dashboard.widgets.includes(widget.id)} onChange={e=>mutate(c=>{const d=c.definitions.find(d=>d.kind==='dashboard'&&d.definition.id===dashboard.id);if(d?.kind==='dashboard'){d.definition.widgets=e.target.checked?[...d.definition.widgets,widget.id]:d.definition.widgets.filter(id=>id!==widget.id);d.definition.layout=d.definition.widgets.map((widget,i)=>({widget,x:0,y:i*4,w:12,h:4}))}})}/>{widget.title}</label>)}
    {dashboard.layout.map((layout,i)=><div key={layout.widget} className={css.grid}><strong>{widgets.find(w=>w.definition.id===layout.widget)?.definition.title}</strong>{(['x','y','w','h'] as const).map(key=><label key={key}>{t('business.manual.layout.'+key)}<input type="number" min={key==='w'||key==='h'?1:0} max={key==='x'?11:key==='w'||key==='h'?12:undefined} value={layout[key]} onChange={e=>mutate(c=>{const d=c.definitions.find(d=>d.kind==='dashboard'&&d.definition.id===dashboard.id);if(d?.kind==='dashboard')d.definition.layout[i]![key]=Number(e.target.value)})}/></label>)}</div>)}
   </details>)}
   <details onToggle={e=>{if(e.currentTarget.open&&advanced===undefined)setAdvanced(JSON.stringify(candidate,null,2))}}><summary>{t('business.manual.advanced')}</summary><p>{t('business.manual.advancedNote')}</p><textarea className={css.code} aria-label={t('business.manual.advanced')} value={advanced??''} onChange={e=>setAdvanced(e.target.value)}/><button onClick={()=>{try{const parsed=readBusinessConfigurationCandidateV2(JSON.parse(advanced??''));update(edit=>{edit.candidate=parsed});setError(false)}catch{setError(true)}}}>{t('business.manual.useAdvanced')}</button></details>
  </fieldset>}
  <footer className={css.actions}><button onClick={onClose} disabled={busy}>{t('business.manual.close')}</button><button disabled={busy||!loaded||stale} onClick={()=>void save()}>{t('business.manual.review')}</button></footer>
 </section>
}
