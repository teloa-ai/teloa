import {WorkError,isMessageReference,groupReferenceMaxFiles,groupDeliveryRecoveryCommand,groupDeliveryRecoveryTarget,type GroupDeliveryRecoveryTarget,type GroupDeliveryRecoveryCandidate,type GroupDeliveryRecoveryCommand,type GroupDeliveryRecoveryReceipt,type GroupDeliveryRecoveryCheck} from '@teloa/contract'
type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type GroupDeliveryRecoveryJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
function candidate(value:unknown,target:GroupDeliveryRecoveryTarget):GroupDeliveryRecoveryCandidate{
 const row=value as GroupDeliveryRecoveryCandidate
 if(!row||row.schema!=='teloa.group-delivery-recovery-candidate/v1'||!['text-capability-required','text-capability-reconfirmation-required','analysis-capability-required','analysis-capability-reconfirmation-required'].includes(row.reason)||JSON.stringify(groupDeliveryRecoveryTarget(row.target))!==JSON.stringify(target)||!uuid(row.taskId)||typeof row.taskTitle!=='string'||!row.taskTitle.trim()||!Array.isArray(row.materials)||row.materials.length>groupReferenceMaxFiles)throw Error('原工作恢复依据不完整。')
 groupDeliveryRecoveryCommand({...target,requestId:row.itemId,itemId:row.itemId,expectedBasisSha256:row.basisSha256,capability:row.reason.startsWith('analysis-')?'analysis':'text'})
 if(row.materials.some(item=>!item||!uuid(item.id)||typeof item.title!=='string'||!item.title.trim()||!Number.isSafeInteger(item.version)||item.version<1||!/^[a-f0-9]{64}$/.test(item.sha256))||new Set(row.materials.map(item=>item.id)).size!==row.materials.length)throw Error('固定资料版本不可核对。')
 if(row.controlRebinding!==undefined&&(!row.controlRebinding||Object.keys(row.controlRebinding).length!==2||row.controlRebinding.kind!=='planned-restart'||!Number.isSafeInteger(row.controlRebinding.restartCount)||row.controlRebinding.restartCount<1))throw Error('升级后的原工作确认依据不完整。')
 const analysis=row.reason.startsWith('analysis-'),files=row.files
 if(analysis&&(!Array.isArray(files)||files.length>groupReferenceMaxFiles||files.some(f=>!f||!['artifact','attachment'].includes(f.kind)||!isMessageReference({kind:f.kind,id:f.id,version:f.version})||typeof f.title!=='string'||!f.title.trim()||!Number.isSafeInteger(f.version)||f.version<1||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^([a-f0-9]{64})$/.test(f.sha256)||typeof f.mime!=='string')||new Set(files.map(f=>JSON.stringify([f.kind,f.id,f.version,f.title,f.sha256]))).size!==files.length)||!analysis&&files!==undefined)throw Error('固定分析附件不可核对。')
 const reconfirm=row.reason.endsWith('-reconfirmation-required'),previous=row.reconfirmation
 if(reconfirm!==(previous!==undefined)||reconfirm&&(!previous||Object.keys(previous).length!==2||!uuid(previous.previousRecoveryId)||typeof previous.previousConfirmedAt!=='string'||!Number.isFinite(Date.parse(previous.previousConfirmedAt))||new Date(previous.previousConfirmedAt).toISOString()!==previous.previousConfirmedAt||!analysis&&!row.controlRebinding))throw Error('再次确认缺少可核对的原确认及正式重启依据。')
 return structuredClone(row)
}
function receipt(value:unknown,command:GroupDeliveryRecoveryCommand,taskId:string|undefined):GroupDeliveryRecoveryReceipt{
 const row=value as GroupDeliveryRecoveryReceipt
 if(!row||row.schema!=='teloa.group-delivery-recovery-receipt/v1'||row.requestId!==command.requestId||row.itemId!==command.itemId||row.groupId!==command.groupId||row.messageId!==command.messageId||row.capability!==command.capability||row.state!=='pending'||row.taskId!==taskId||!uuid(row.recoveryId)||!uuid(row.dispatchRequestId)||typeof row.confirmedAt!=='string'||!Number.isFinite(Date.parse(row.confirmedAt))||new Date(row.confirmedAt).toISOString()!==row.confirmedAt)throw Error('原恢复请求已提交，但回执不能核对；请保留原请求继续核对。')
 return structuredClone(row)
}
function checkedResult(value:unknown,command:GroupDeliveryRecoveryCommand,taskId:string|undefined):GroupDeliveryRecoveryCheck{
 const row=value as GroupDeliveryRecoveryCheck
 if(!row||row.schema!=='teloa.group-delivery-recovery-check/v1')throw Error('原请求核对结果不可读取，请保留原请求。')
 if(row.state==='accepted')return {schema:row.schema,state:row.state,receipt:receipt(row.receipt,command,taskId)}
 if(!['not-accepted','unobserved'].includes(row.state)||JSON.stringify(groupDeliveryRecoveryCommand(row.command))!==JSON.stringify(command))throw Error('原请求核对结果的身份不一致，请保留原请求。')
 if(row.state==='not-accepted'){
  if(!['teloa/conflict','teloa/forbidden','teloa/version-conflict'].includes(row.reason)||typeof row.recordedAt!=='string'||!Number.isFinite(Date.parse(row.recordedAt))||new Date(row.recordedAt).toISOString()!==row.recordedAt)throw Error('未受理回执不完整，请保留原请求。')
  return {schema:row.schema,state:row.state,command,recordedAt:row.recordedAt,reason:row.reason}
 }
 return {schema:row.schema,state:'unobserved',command}
}
export type GroupDeliveryRecoveryApi=ReturnType<typeof createGroupDeliveryRecoveryApi>
export function createGroupDeliveryRecoveryApi(call:Call,journal:GroupDeliveryRecoveryJournal|undefined,newId:()=>string=()=>crypto.randomUUID()){
 let pending:GroupDeliveryRecoveryCommand|undefined,taskId:string|undefined,failure:unknown,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>6000)throw Error();const saved=JSON.parse(raw);if(saved.schema!=='teloa.group-delivery-recovery/v1'||!uuid(saved.taskId))throw Error();pending=groupDeliveryRecoveryCommand(saved.command);taskId=saved.taskId}}catch{failure=new WorkError('teloa/recovery-write-failed','原工作恢复记录不可读取，请保留当前页面核对原请求。')}
 const submit=async()=>{
  if(failure)throw failure
  if(!pending||busy)throw new WorkError('teloa/conflict','原恢复请求正在核对，请等待当前结果。')
  if(!journal)throw new WorkError('teloa/recovery-write-failed','原恢复请求无法可靠保存，尚未提交。')
  busy=true
  try{
   journal.write(JSON.stringify({schema:'teloa.group-delivery-recovery/v1',command:pending,taskId}))
   const value=receipt(await call('groups/delivery/recover',pending),pending,taskId)
   journal.clear();pending=undefined;taskId=undefined;return value
  }finally{busy=false}
 }
 const verify=async():Promise<GroupDeliveryRecoveryCheck>=>{
  if(failure)throw failure
  if(!pending||busy)throw new WorkError('teloa/conflict','原恢复请求正在核对，请等待当前结果。')
  if(!journal)throw new WorkError('teloa/recovery-write-failed','原恢复请求无法可靠保存，请保留原请求。')
  busy=true
  try{
   const result=checkedResult(await call('groups/delivery/receipt',pending),pending,taskId)
   if(result.state!=='unobserved'){journal.clear();pending=undefined;taskId=undefined}
   return result
  }finally{busy=false}
 }
 return {
  pending:()=>pending?structuredClone(pending):undefined,
  failure:()=>failure,
  async inspect(input:GroupDeliveryRecoveryTarget){const target=groupDeliveryRecoveryTarget(input);return candidate(await call('groups/delivery/inspect',target),target)},
  async confirm(value:GroupDeliveryRecoveryCandidate){
   if(failure)throw failure
   const checked=candidate(value,value.target)
   if(pending&&(pending.capability!==(checked.reason.startsWith('analysis-')?'analysis':'text')||pending.itemId!==checked.itemId||pending.expectedBasisSha256!==checked.basisSha256||JSON.stringify({groupId:pending.groupId,messageId:pending.messageId,roleId:pending.roleId})!==JSON.stringify(checked.target)||taskId!==checked.taskId))throw new WorkError('teloa/conflict','请先核对原工作恢复请求，不能换另一份依据重新提交。')
   if(!pending){pending=groupDeliveryRecoveryCommand({...checked.target,requestId:newId(),itemId:checked.itemId,expectedBasisSha256:checked.basisSha256,capability:checked.reason.startsWith('analysis-')?'analysis':'text'});taskId=checked.taskId}
   return submit()
  },
  recover:verify,
  retry:submit,
 }
}
