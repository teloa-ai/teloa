import {isGroupMessage,type GroupMessage,type MessageReference} from '@teloa/contract'
import type {GroupApi} from './group-api.js'
import type {GroupAttachmentApi} from './group-attachment-api.js'

export type DashboardShareGroups=Pick<GroupApi,'list'|'get'|'send'|'pending'|'recover'>
export type DashboardShareAttachments=Pick<GroupAttachmentApi,'upload'>
type Input={scope:string;snapshotHash:string;groupId:string;text:string;files:readonly File[]}
type Intent={scope:string;snapshotHash:string;groupId:string;text:string;files:readonly File[];identities:string[];expectedVersion:number;requestIds:string[];references:MessageReference[];sent?:GroupMessage}
const fail=(code:string)=>Object.assign(Error(code),{code})
async function fileIdentity(file:File):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer())
 return JSON.stringify([file.name,file.type,file.size,Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')])
}
/** 同一明确分享意图保留附件 requestId 与原群消息 journal；未知回执只核对原请求。 */
export function createDashboardGroupShare(groups:DashboardShareGroups,attachments:DashboardShareAttachments,newId:()=>string=()=>crypto.randomUUID()){
 let intent:Intent|undefined,busy=false
 const matchesPending=()=>{
  const pending=groups.pending()
  return !!intent&&pending?.kind==='send'&&pending.request.groupId===intent.groupId&&pending.request.expectedVersion===intent.expectedVersion&&pending.request.text===intent.text&&JSON.stringify(pending.request.references??[])===JSON.stringify(intent.references)
 }
 const checkGroup=async(input:Pick<Input,'groupId'|'scope'>)=>{
  const {group}=await groups.get(input.groupId)
  if(group.scope!==input.scope||group.archived)throw fail('teloa/dashboard-share-group-changed')
  return group
 }
 return {
  locked:()=>intent!==undefined,
  canRestart:()=>!busy&&!groups.pending(),
  sent:()=>intent?.sent,
  async send(input:Input):Promise<GroupMessage>{
   if(busy)throw fail('teloa/dashboard-share-busy')
   busy=true
   try{
    if(!input.files.length||input.files.length>2||input.files.some(file=>!['image/png','text/csv'].includes(file.type)))throw fail('teloa/invalid-input')
    const identities=await Promise.all(input.files.map(fileIdentity))
    if(intent){
     if(intent.scope!==input.scope||intent.groupId!==input.groupId||intent.snapshotHash!==input.snapshotHash||intent.text!==input.text||JSON.stringify(intent.identities)!==JSON.stringify(identities))throw fail('teloa/dashboard-share-intent-changed')
     if(intent.sent)return intent.sent
    }else{
     if(groups.pending())throw fail('teloa/dashboard-share-pending')
     const group=await checkGroup(input)
     intent={...input,identities,expectedVersion:group.version,requestIds:input.files.map(()=>newId()),references:[]}
    }
    if(groups.pending()){
     if(!matchesPending())throw fail('teloa/dashboard-share-pending')
     const result=await groups.recover()
     if(!isGroupMessage(result))throw fail('teloa/invalid-host-response')
     intent.sent=result;return result
    }
    const group=await checkGroup(intent)
    if(group.version!==intent.expectedVersion)throw fail('teloa/dashboard-share-group-changed')
    for(let index=intent.references.length;index<intent.files.length;index++){
     const attachment=await attachments.upload(intent.groupId,intent.expectedVersion,intent.files[index]!,intent.requestIds[index]!)
     intent.references.push({kind:'attachment',id:attachment.attachmentId,version:attachment.version})
    }
    const current=await checkGroup(intent)
    if(current.version!==intent.expectedVersion)throw fail('teloa/dashboard-share-group-changed')
    const result=await groups.send(intent.groupId,intent.expectedVersion,intent.text,undefined,intent.references)
    intent.sent=result;return result
   }finally{busy=false}
  },
 }
}
