import {useEffect,useState} from 'react'
import type {BusinessChangeSet,BusinessObjectReference,BusinessObjectWorkLink,BusinessWorkResultVersion,BusinessWorkCursor,BusinessResultCursor} from '@teloa/contract'
import type {BusinessWorkResultsApi} from './business-work-results-api.js'
import {BusinessChangeSetPreview} from './BusinessChangeSetPreview.js'
import {useI18n} from './i18n/provider.js'
import {businessWorkCopy} from './business-work-copy.js'
import css from './BusinessRecordPage.module.css'
export function BusinessPendingChanges({scope,api}:{scope:string;api:BusinessWorkResultsApi}){
 const {locale}=useI18n(),copy=businessWorkCopy(locale)
 const [drafts,setDrafts]=useState<BusinessChangeSet[]>([]),[selected,setSelected]=useState<BusinessChangeSet>(),[failed,setFailed]=useState(false),[revision,setRevision]=useState(0),[history,setHistory]=useState(false),[cursor,setCursor]=useState<BusinessWorkCursor>(),[nextCursor,setNextCursor]=useState<BusinessWorkCursor>(),[loading,setLoading]=useState(false)
 useEffect(()=>{setSelected(undefined);setCursor(undefined);setHistory(false)},[scope])
 useEffect(()=>{
  let active=true;let abort:AbortController|undefined
  const read=()=>{if(document.hidden)return;abort?.abort();abort=new AbortController();setLoading(true);void api.listChanges(scope,abort.signal,{history,cursor}).then(page=>{if(active){setDrafts(old=>cursor?[...old.filter(item=>!page.items.some(newItem=>newItem.id===item.id)),...page.items]:page.items);setNextCursor(page.nextCursor);setFailed(false)}}).catch(e=>{if(active&&e.name!=='AbortError')setFailed(true)}).finally(()=>{if(active)setLoading(false)})}
  read();const interval=cursor?undefined:setInterval(read,15000)
  return()=>{active=false;abort?.abort();clearInterval(interval)}
 },[api,scope,revision,history,cursor])
 const refresh=()=>{setCursor(undefined);setRevision(r=>r+1)}
 return <section className={[css.page,css.detail].join(' ')} aria-label={copy.changes}>
  <header className={css.header}><h3>{copy.changes}</h3><div className={css.actions}><button type="button" onClick={()=>{setCursor(undefined);setHistory(value=>!value)}}>{history?copy.pendingList:copy.history}</button><button type="button" disabled={loading} onClick={refresh}>{copy.retry}</button></div></header>
  {failed&&<p role="alert">{copy.failure}</p>}{!drafts.length&&!failed&&!loading&&<p>{copy.noChanges}</p>}
  <div className={css.list}>{drafts.map(draft=><button type="button" key={draft.id} onClick={()=>setSelected(draft)}><strong>{draft.preview.operations[0]?.title}</strong><span> · {copy.states[draft.state]} · {draft.batch.operations.length}</span></button>)}</div>
  {nextCursor&&<button type="button" disabled={loading} onClick={()=>setCursor(nextCursor)}>{copy.more}</button>}
  {selected&&<BusinessChangeSetPreview key={selected.id} draft={selected} api={api} close={()=>setSelected(undefined)} changed={refresh}/>}
 </section>
}
export function BusinessWorkResults({reference,title,api,openTask}:{reference:BusinessObjectReference;title:string;api:BusinessWorkResultsApi;openTask?:((id:string)=>void)|undefined}){
 const {locale,dateTime}=useI18n(),copy=businessWorkCopy(locale)
 const [works,setWorks]=useState<BusinessObjectWorkLink[]>([]),[results,setResults]=useState<Record<string,BusinessWorkResultVersion[]>>({}),[resultCursors,setResultCursors]=useState<Record<string,BusinessResultCursor|undefined>>({}),[tasks,setTasks]=useState<{taskId:string;runId:string;mappingId:string;createdAt:string}[]>([]),[failed,setFailed]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[cursor,setCursor]=useState<BusinessWorkCursor>(),[nextCursor,setNextCursor]=useState<BusinessWorkCursor>()
 const key=JSON.stringify(reference)
 useEffect(()=>{setCursor(undefined)},[key])
 useEffect(()=>{
  let active=true;const abort=new AbortController();setLoading(true)
  void api.list({...reference,cursor},abort.signal).then(async page=>{
   const entries=await Promise.all(page.items.map(async work=>[work.id,await api.results(work.id,abort.signal)] as const))
   if(active){setWorks(old=>cursor?[...old.filter(work=>!page.items.some(item=>item.id===work.id)),...page.items]:page.items);setTasks(page.taskResults);setResults(old=>({...cursor?old:{},...Object.fromEntries(entries.map(([id,result])=>[id,result.items]))}));setResultCursors(old=>({...cursor?old:{},...Object.fromEntries(entries.map(([id,result])=>[id,result.nextCursor]))}));setNextCursor(page.nextCursor);setFailed(false)}
  }).catch(()=>{if(active)setFailed(true)}).finally(()=>{if(active)setLoading(false)})
  return()=>{active=false;abort.abort()}
 },[api,key,revision,cursor])
 const act=async(work?:BusinessObjectWorkLink)=>{setBusy(true);setFailed(false);try{if(work)await api.openWork(work);else await api.startWork(reference,title)}catch{setFailed(true)}finally{setBusy(false)}}
 const moreResults=async(id:string)=>{setBusy(true);try{const page=await api.results(id,undefined,resultCursors[id]);setResults(old=>({...old,[id]:[...(old[id]??[]).filter(item=>!page.items.some(next=>next.slot===item.slot&&next.revision===item.revision)),...page.items]}));setResultCursors(old=>({...old,[id]:page.nextCursor}));setFailed(false)}catch{setFailed(true)}finally{setBusy(false)}}
 return <section aria-label={copy.work}><header className={css.header}><h3>{copy.work}</h3><div className={css.actions}><button type="button" disabled={busy} onClick={()=>void act()}>{copy.start}</button><button type="button" disabled={busy||loading} onClick={()=>{setCursor(undefined);setRevision(r=>r+1)}}>{copy.retry}</button></div></header>
  {failed&&<p role="alert">{copy.failure}</p>}{!works.length&&!tasks.length&&!failed&&!loading&&<p>{copy.empty}</p>}
  {works.map(work=><section key={work.id}><h4>{work.title}</h4><small>{dateTime(work.createdAt)} · {work.reference.version}</small>{results[work.id]?.map(result=><article key={result.slot+result.revision}><p>{copy.progress[result.state]} · {result.revision}</p><p>{result.summary}</p>{result.artifactVersions.length>0&&<p>{copy.artifacts}</p>}</article>)}{resultCursors[work.id]&&<button type="button" disabled={busy} onClick={()=>void moreResults(work.id)}>{copy.more}</button>}<button type="button" disabled={busy} onClick={()=>void act(work)}>{copy.open}</button></section>)}
  {nextCursor&&<button type="button" disabled={busy||loading} onClick={()=>setCursor(nextCursor)}>{copy.more}</button>}
  {tasks.map(task=><section key={task.runId+task.mappingId}><p>{copy.taskResult} · {dateTime(task.createdAt)}</p>{openTask&&<button type="button" onClick={()=>openTask(task.taskId)}>{copy.open}</button>}</section>)}
 </section>
}
