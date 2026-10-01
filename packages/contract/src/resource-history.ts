import { isRecord,isResourceSpec,resourceId,resourceVersion,type ResourceSpec,type ResourceReference } from './resources.ts'
export type ResourceHistoryReference=ResourceReference & {metadata?:ResourceSpec}
export type ResourceHistoryItem={seq:number;messageId:string;turn:number|null;at:string;references:ResourceHistoryReference[];issue?:string}
export type ResourceHistoryPage={sessionId:string;items:ResourceHistoryItem[];nextBeforeSeq:number|null}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const seq=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
export function isResourceHistoryPage(value:unknown):value is ResourceHistoryPage{
  if(!isRecord(value)||!id(value.sessionId)||!Array.isArray(value.items)||value.items.length>10)return false
  let previous=Number.MAX_SAFE_INTEGER
  const messages=new Set<string>()
  for(const item of value.items){
    if(!isRecord(item)||!seq(item.seq)||item.seq>=previous||!id(item.messageId)||messages.has(item.messageId)||!(item.turn===null||resourceVersion(item.turn))||typeof item.at!=='string'||!Number.isFinite(Date.parse(item.at))||!Array.isArray(item.references)||item.references.length>8||(item.issue!==undefined&&(typeof item.issue!=='string'||!item.issue)))return false
    if(!item.references.length&&!item.issue)return false
    const refs=new Set<string>()
    for(const ref of item.references){
      if(!isRecord(ref)||!resourceId(ref.id)||!resourceVersion(ref.version)||(ref.metadata!==undefined&&!isResourceSpec(ref.metadata)))return false
      const key=ref.id+'@'+ref.version;if(refs.has(key))return false;refs.add(key)
    }
    messages.add(item.messageId);previous=item.seq
  }
  return value.nextBeforeSeq===null||(value.items.length>0&&seq(value.nextBeforeSeq)&&value.nextBeforeSeq===previous)
}
