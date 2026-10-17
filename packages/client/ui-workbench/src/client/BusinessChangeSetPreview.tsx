import {useEffect,useState} from 'react'
import type {BusinessChangeSet} from '@teloa/contract'
import type {BusinessWorkResultsApi} from './business-work-results-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {businessWorkCopy} from './business-work-copy.js'
import css from './BusinessRecordPage.module.css'
export function BusinessChangeSetPreview({draft:initial,api,close,changed}:{draft:BusinessChangeSet;api:BusinessWorkResultsApi;close:()=>void;changed:()=>void}){
 const {locale}=useI18n(),copy=businessWorkCopy(locale),[draft,setDraft]=useState(initial),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[verified,setVerified]=useState(false)
 useEffect(()=>{let active=true;const abort=new AbortController();void api.getChangeSet(initial.id,abort.signal).then(value=>{if(active){setDraft(value);setVerified(true)}}).catch(()=>{if(active)setFailed(true)});return()=>{active=false;abort.abort()}},[api,initial.id])
 const act=async(kind:'apply'|'reject')=>{setBusy(true);setFailed(false);try{if(kind==='reject')setDraft(await api.rejectChangeSet({changeSetId:draft.id,expectedRevision:draft.revision}));else await api.requestApply({changeSetId:draft.id,expectedRevision:draft.revision,expectedDigest:draft.digest},draft.sessionId);changed();if(kind==='apply')close()}catch{setFailed(true)}finally{setBusy(false)}}
 return <ContextDrawer title={copy.review} close={close} canClose={!busy}><section className={[css.page,css.detail].join(' ')}>
  <p role="status">{copy.states[draft.state]} · {draft.revision}</p>
  {draft.state==='stale'?<p>{copy.stale}</p>:draft.state!=='applied'&&<p>{copy.pending}</p>}
  {failed&&<p role="alert">{copy.failure}</p>}
  {draft.preview.operations.map((op,index)=><section key={index}><h3>{op.title} · {op.operation==='create'?(locale==='en'?'Create':'新增'):op.operation==='edit'?(locale==='en'?'Update':'修改'):(locale==='en'?'Archive':'归档')}</h3>
   {op.before&&<><h4>{copy.before}</h4><p>{op.before.title}</p><p>{op.before.summary}</p><dl>{op.before.fields.map(f=><div key={f.label}><dt>{f.label}</dt><dd>{f.value||'—'}</dd></div>)}</dl></>}
   {op.fields&&<><h4>{copy.after}</h4><p>{op.summary}</p><dl>{op.fields.map(f=><div key={f.name}><dt>{f.label??f.name}</dt><dd>{f.value||'—'}</dd></div>)}</dl></>}
  </section>)}
  <div className={css.actions}>{['draft','awaiting-approval'].includes(draft.state)&&<button type="button" disabled={busy||!verified||failed} onClick={()=>void act('apply')}>{copy.apply}</button>}{draft.state!=='applied'&&draft.state!=='rejected'&&<button type="button" disabled={busy||!verified} onClick={()=>void act('reject')}>{copy.reject}</button>}</div>
 </section></ContextDrawer>
}
