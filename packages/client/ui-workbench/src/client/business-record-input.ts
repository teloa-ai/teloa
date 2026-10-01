import {WorkError,businessObjectReference,type BusinessObjectReference} from '@teloa/contract'
import type {InputState,InsertReferenceRequest} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {checkBusinessBuilderSwitch,switchDecision,type BusinessBuilderSwitchPort} from './business-builder-flow.ts'
import {businessRecordReferenceInsert} from './business-record-reference-source.ts'
type Port={switching:BusinessBuilderSwitchPort;isCurrent:()=>boolean;verify:()=>Promise<BusinessObjectReference&{title:string}>;state:{getSnapshot:()=>InputState;subscribe:(fn:()=>void)=>()=>void};insert:(request:InsertReferenceRequest)=>true|undefined}
const failure=()=>new WorkError('teloa/conflict','请保留现有输入，核对当前会话后重新带入记录。',{reason:'record-input'})
/** 只操作已打开的空原生输入；不迁移草稿、不拥有正文，不发送消息。 */
export async function insertBusinessRecordInput(value:BusinessObjectReference,sessionId:string,port:Port):Promise<void>{
 const reference=businessObjectReference(value),initial=port.switching.read(),input=port.state.getSnapshot()
 const current=()=>{const s=port.switching.read();return port.isCurrent()&&s.mainSessionId===sessionId&&s.bindingSessionId===sessionId&&s.input===port.state.getSnapshot()}
 if(!current()||initial.input!==input||await checkBusinessBuilderSwitch(port.switching)!=='ready')throw failure()
 const snapshot=await port.verify()
 if(JSON.stringify(businessObjectReference({scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash}))!==JSON.stringify(reference)||!current()||port.state.getSnapshot()!==input||switchDecision(port.switching.read(),false)!=='ready')throw failure()
 const chip=businessRecordReferenceInsert(reference,snapshot.title)
 await new Promise<void>((resolve,reject)=>{
  let settled=false,applied=false,off=()=>{}
  const finish=(error?:Error)=>{if(settled)return;settled=true;off();clearTimeout(timer);error?reject(error):resolve()}
  const check=()=>{
   if(!applied||settled)return
   const next=port.state.getSnapshot()
   if(next===input)return
   if(!current()||switchDecision(port.switching.read(),true)!=='ready'||next.draftRev!==input.draftRev+1||next.phase!=='plain'||next.attachmentIds.length||next.queue.length||next.occurrences.length!==1||!next.occurrences.some(row=>row.source===chip.source&&row.ref===chip.ref&&!row.invalid))finish(failure())
   else finish()
  }
  // 超时仅报告未知插入结果，不重试或猜测原生输入就绪。
  const timer=setTimeout(()=>finish(failure()),3000)
  off=port.state.subscribe(check)
  try{applied=port.insert({reference:chip,span:{start:0,end:0,draftRev:input.draftRev}})===true;if(!applied)finish(failure());else check()}catch(error){finish(error instanceof Error?error:failure())}
  if(settled)off()
 })
}
