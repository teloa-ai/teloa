import type {GroupMessage,MessageReference} from '@teloa/contract'

export type GroupSharedResult={reference:MessageReference;message:GroupMessage;historical:boolean}
/** 只汇总群消息实际引用的固定版本，不查员工私人输出或全局最新成果。 */
export function groupSharedResults(groupId:string,messages:readonly GroupMessage[]):GroupSharedResult[]{
 const versions=new Map<string,GroupSharedResult>(),latest=new Map<string,number>()
 for(const message of [...messages].filter(row=>row.groupId===groupId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){
  for(const reference of message.references){
   if(reference.kind!=='artifact')continue
   versions.set(JSON.stringify([reference.id,reference.version]),{reference,message,historical:false})
   latest.set(reference.id,Math.max(latest.get(reference.id)??0,reference.version))
  }
 }
 return [...versions.values()].map(row=>({...row,historical:row.reference.version!==latest.get(row.reference.id)})).sort((a,b)=>Number(a.historical)-Number(b.historical)||b.message.createdAt.localeCompare(a.message.createdAt)||a.reference.id.localeCompare(b.reference.id)||b.reference.version-a.reference.version)
}

/** 群身份仅定位本人的已共享引用白名单，不作为跨 owner 授权。 */
export function groupHasSharedArtifactReference(groupId:string,messages:readonly GroupMessage[],reference:MessageReference):boolean{
 return reference.kind==='artifact'&&messages.some(message=>message.groupId===groupId&&message.references.some(row=>row.kind==='artifact'&&row.id===reference.id&&row.version===reference.version))
}
