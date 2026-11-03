import type {ConnectionHandle} from '@deepseek-ai/dsh-client-connection/client'

export type SessionDiagnosticDownload={blob:Blob;filename:string;incomplete:boolean}
export type SessionDiagnosticDownloader=(sessionId:string,signal:AbortSignal)=>Promise<SessionDiagnosticDownload>
const schema='teloa.session-diagnostic/v1',maximumBytes=2*1024*1024
const nativeSessionId=/^[a-zA-Z0-9_-]{1,128}$/
const failure=(code:string)=>Object.assign(Error(),{code:'diagnostic/'+code})
const row=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined

export async function downloadSessionDiagnostic(sessionId:string,signal:AbortSignal,send:typeof fetch=fetch):Promise<SessionDiagnosticDownload>{
 signal.throwIfAborted();if(!nativeSessionId.test(sessionId))throw failure('invalid-session')
 const response=await send('/api/teloa/session-diagnostic?sessionId='+encodeURIComponent(sessionId),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{accept:'application/x-ndjson'},signal})
 if(signal.aborted){await response.body?.cancel();signal.throwIfAborted()}
 if(!response.ok){await response.body?.cancel();throw failure(response.status===403?'forbidden':response.status===404?'not-found':'unavailable')}
 if(!response.headers.get('content-type')?.startsWith('application/x-ndjson')||!response.body){await response.body?.cancel();throw failure('invalid-response')}
 const reader=response.body.getReader(),chunks:Uint8Array<ArrayBuffer>[]=[],cancel=()=>{void reader.cancel(signal.reason).catch(()=>{})}
 let bytes=0,complete=false
 signal.addEventListener('abort',cancel,{once:true})
 try{
  for(;;){const next=await reader.read();signal.throwIfAborted();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maximumBytes)throw failure('output-limit');chunks.push(new Uint8Array(next.value))}
  const blob=new Blob(chunks,{type:'application/x-ndjson'}),lines=(await blob.text()).trim().split('\n')
  let first:Record<string,unknown>|undefined,last:Record<string,unknown>|undefined
  try{first=row(JSON.parse(lines[0]!));last=row(JSON.parse(lines.at(-1)!))}catch{throw failure('invalid-response')}
  if(first?.kind!=='manifest'||first.schema!==schema||first.rootSessionId!==sessionId||last?.kind!=='summary'||last.schema!==schema||typeof last.complete!=='boolean'||typeof last.truncated!=='boolean')throw failure('invalid-response')
  signal.throwIfAborted();complete=true
  return {blob,filename:'teloa-session-diagnostic-'+sessionId+'.ndjson',incomplete:!last.complete||last.truncated}
 }finally{signal.removeEventListener('abort',cancel);if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock()}
}

/** 下载始终绑定发起时的本人连接 generation，不把旧响应保存到新上下文。 */
export function createSessionDiagnosticDownloader(connection:Pick<ConnectionHandle,'generation'|'state'>,send:typeof fetch=fetch):SessionDiagnosticDownloader{
 return async(sessionId,requested)=>{
  const generation=connection.generation.getSnapshot()
  if(!generation||connection.state.getSnapshot()!=='connected')throw failure('unavailable')
  const controller=new AbortController(),current=()=>connection.generation.getSnapshot()===generation&&connection.state.getSnapshot()==='connected'
  const changed=()=>{if(!current())controller.abort()}
  const offGeneration=connection.generation.subscribe(changed),offState=connection.state.subscribe(changed)
  try{
   changed();const signal=AbortSignal.any([requested,controller.signal]),result=await downloadSessionDiagnostic(sessionId,signal,send)
   signal.throwIfAborted();return result
  }finally{offGeneration();offState()}
 }
}
