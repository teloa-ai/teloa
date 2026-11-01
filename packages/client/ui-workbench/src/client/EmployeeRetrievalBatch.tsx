import type {RetrievalBatchSnapshot} from './employee-retrieval-batch.ts'
import {employeeRetrievalBatchCopy} from './employee-retrieval-batch-copy.ts'
import {localizeWorkError} from './i18n/errors.js'
import css from './EmployeeRetrievalBatch.module.css'

export function EmployeeRetrievalBatch({snapshot,locale,cancel,review}:{snapshot:RetrievalBatchSnapshot;locale:string;cancel:()=>void;review:()=>void}){
 const copy=employeeRetrievalBatchCopy(locale),counts=Object.fromEntries(Object.keys(copy.states).map(state=>[state,snapshot.items.filter(row=>row.state===state).length]))
 const unknown=snapshot.items.some(row=>row.state==='unknown')
 return <section className={css.batch} aria-label={copy.title(snapshot.roleName)} data-retrieval-batch>
  <header><strong>{copy.title(snapshot.roleName)}</strong>{snapshot.running&&!snapshot.cancelRequested&&<button type="button" onClick={cancel}>{copy.cancel}</button>}</header>
  <p role="status" aria-live="polite">{snapshot.running?(snapshot.cancelRequested?copy.cancelling:copy.running):copy.done}</p>
  <p>{copy.summary(counts)}</p><p className={css.hint}>{copy.boundary}</p>
  {snapshot.restored&&<p role="status">{copy.restored}</p>}
  {snapshot.storageBlocked&&<p role="alert">{copy.storage}</p>}
  {snapshot.needsModel&&<p role="status">{copy.model}</p>}
  {snapshot.error!==undefined&&<p role="alert">{localizeWorkError(locale,snapshot.error)}</p>}
  <ul aria-label={copy.done}>{snapshot.items.map(row=><li key={row.sourceId} data-batch-state={row.state}><strong>{row.title}</strong><span>{copy.states[row.state]}</span>{row.error!==undefined&&<small>{localizeWorkError(locale,row.error)}</small>}</li>)}</ul>
  {unknown&&<p role="alert">{copy.unknown}</p>}
  {(unknown||snapshot.storageBlocked&&snapshot.items.length>0)&&<button type="button" disabled={snapshot.running||snapshot.reviewing} onClick={review}>{snapshot.reviewing?copy.reviewing:copy.review}</button>}
 </section>
}
