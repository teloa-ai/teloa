import {isKnowledgeVersionSummary,resourceId,type KnowledgeVersionSummary,type KnowledgeResourceReviseInput,type KnowledgeResourceRestoreInput} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
export type ManagedKnowledgePending={kind:'revise';input:KnowledgeResourceReviseInput}|{kind:'restore';input:KnowledgeResourceRestoreInput}
export type ManagedKnowledgeDraft={base:KnowledgeVersionSummary;resourceVersion:number;markdown:string;requestId:string;pending?:ManagedKnowledgePending}
const memory=new WeakMap<ResourceApi,Map<string,ManagedKnowledgeDraft|null>>()
export function createManagedKnowledgeEditJournal(api:ResourceApi,ownerId:string,knowledgeId:string,resourceIdValue:string,storage:WorkbenchNavigationStorage|undefined){
 const key='teloa.managed-knowledge-edit/v1/'+[ownerId,knowledgeId,resourceIdValue].map(encodeURIComponent).join('/')
 let drafts=memory.get(api);if(!drafts){drafts=new Map();memory.set(api,drafts)}let warning=!storage
 const read=():ManagedKnowledgeDraft|undefined=>{
  if(drafts.has(key))return drafts.get(key)??undefined
  const raw=storage?.getItem(key);if(!raw)return undefined
  const row=JSON.parse(raw)
  if(!row||row.schema!=='teloa.managed-knowledge-edit/v1'||row.ownerId!==ownerId||row.knowledgeId!==knowledgeId||row.resourceId!==resourceIdValue||!isKnowledgeVersionSummary(row.base)||row.base.ownerId!==ownerId||row.base.knowledgeId!==knowledgeId||!resourceId(row.requestId)||!Number.isSafeInteger(row.resourceVersion)||row.resourceVersion<1||typeof row.markdown!=='string'||new TextEncoder().encode(row.markdown).byteLength>2*1024*1024)throw Error('Invalid managed knowledge draft')
  if(row.pending){const {kind,input}=row.pending;if(!['revise','restore'].includes(kind)||!input||input.requestId!==row.requestId||input.knowledgeId!==knowledgeId||input.resourceId!==resourceIdValue||input.expectedKnowledgeVersion!==row.base.version||input.expectedResourceVersion!==row.resourceVersion||kind==='revise'&&input.markdown!==row.markdown||kind==='restore'&&(!Number.isSafeInteger(input.restoreVersion)||input.restoreVersion<1||input.restoreVersion>row.base.version))throw Error('Invalid managed knowledge request')}
  const {base,resourceVersion,markdown,requestId,pending}=row,value={base,resourceVersion,markdown,requestId,...(pending?{pending}:{})};drafts.set(key,value);return value
 }
 return {read,write(value:ManagedKnowledgeDraft){drafts.set(key,value);try{storage?.setItem(key,JSON.stringify({schema:'teloa.managed-knowledge-edit/v1',ownerId,knowledgeId,resourceId:resourceIdValue,...value}))}catch{warning=true}},clear(requestId:string){if(read()?.requestId!==requestId)return;drafts.set(key,null);try{storage?.removeItem(key)}catch{warning=true}},warning:()=>warning}
}
