import {isKnowledgeVersionSummary,resourceId,type KnowledgeVersionSummary,type KnowledgeReviseInput,type KnowledgeRestoreInput} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

export type KnowledgeEditPending={kind:'revise';input:KnowledgeReviseInput}|{kind:'restore';input:KnowledgeRestoreInput}
export type KnowledgeEditDraft={base:KnowledgeVersionSummary;markdown:string;requestId:string;pending?:KnowledgeEditPending}
const memory=new WeakMap<ResourceApi,WeakMap<object,Map<string,KnowledgeEditDraft|null>>>()
/** 存储已由工作台按宿主隔离；本人和原知识身份继续固定在键及正文中。 */
export function createKnowledgeEditJournal(api:ResourceApi,ownerId:string,knowledgeId:string,storage:WorkbenchNavigationStorage|undefined){
 const key='teloa.knowledge-edit/v1/'+encodeURIComponent(ownerId)+'/'+knowledgeId
 let spaces=memory.get(api);if(!spaces){spaces=new WeakMap();memory.set(api,spaces)}
 const storageIdentity=storage??api
 let drafts=spaces.get(storageIdentity);if(!drafts){drafts=new Map();spaces.set(storageIdentity,drafts)}
 let warning=!storage
 const parse=(raw:string):KnowledgeEditDraft=>{
  const value=JSON.parse(raw)
  if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['schema','ownerId','knowledgeId','base','markdown','requestId','pending'].includes(key))||value.schema!=='teloa.knowledge-edit/v1'||value.ownerId!==ownerId||value.knowledgeId!==knowledgeId||!isKnowledgeVersionSummary(value.base)||value.base.ownerId!==ownerId||value.base.knowledgeId!==knowledgeId||!resourceId(value.requestId)||typeof value.markdown!=='string'||new TextEncoder().encode(value.markdown).byteLength>2*1024*1024)throw Error('Invalid knowledge edit draft')
  if(value.pending){
   const {kind,input}=value.pending
   if(Object.keys(value.pending).some(key=>!['kind','input'].includes(key))||!['revise','restore'].includes(kind)||!input||Object.keys(input).some(key=>!['requestId','knowledgeId','expectedVersion',kind==='revise'?'markdown':'version'].includes(key))||input.requestId!==value.requestId||input.knowledgeId!==knowledgeId||input.expectedVersion!==value.base.version||kind==='revise'&&input.markdown!==value.markdown||kind==='restore'&&(!Number.isSafeInteger(input.version)||input.version<1||input.version>value.base.version))throw Error('Invalid knowledge edit request')
  }
  return {base:value.base,markdown:value.markdown,requestId:value.requestId,...(value.pending?{pending:value.pending}:{})}
 }
 const read=()=>{
  if(drafts.has(key))return drafts.get(key)??undefined
  const raw=storage?.getItem(key);if(!raw)return undefined
  const value=parse(raw);drafts.set(key,value);return value
 }
 return {
  read,
  write(value:KnowledgeEditDraft){drafts.set(key,value);try{storage?.setItem(key,JSON.stringify({schema:'teloa.knowledge-edit/v1',ownerId,knowledgeId,...value}))}catch{warning=true}},
  clear(requestId:string){if(read()?.requestId!==requestId)return;drafts.set(key,null);try{storage?.removeItem(key)}catch{warning=true}},
  warning:()=>warning,
 }
}
