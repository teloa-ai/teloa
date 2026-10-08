import { isKnowledgeResourceRevision,isKnowledgeTree,isKnowledgeTreeMutation,isKnowledgeVersion,isKnowledgeVersionSummary,isResourceDirectory,isResourceDraft,isWorkResource,isSourceReference,isResourceHistoryPage,type KnowledgeResourceRestoreInput,type KnowledgeResourceReviseInput,type KnowledgeResourceRevision,type KnowledgeTree,type KnowledgeTreeMutation,type KnowledgeVersion,type KnowledgeVersionSummary,type ResourceHistoryPage,type ResourceSpec,type ResourceDirectory,type ResourceDraft,type WorkResource,type SourceReference } from '@teloa/contract'
import { isResourceRecoveryPage,type ResourceRecoveryPage } from '@teloa/contract'
import {createLocalMaterialRegistration,readLocalMaterialInput,isLocalMaterialReference,isLocalMaterialSourceId,type LocalMaterialRegistrationInput,type LocalMaterialRegistration} from './local-material-registration.ts'
export type ResourceApi={
  registerLocalMaterial?:(input:LocalMaterialRegistrationInput)=>Promise<SourceReference>;
  localMaterialRequests?:LocalMaterialRegistration;
  readContent?:(resource:WorkResource,signal:AbortSignal)=>Promise<{resource:WorkResource;text:string}>;
  directory():Promise<ResourceDirectory>;sources():Promise<SourceReference[]>;
  create(input:ResourceSpec & {requestId:string}):Promise<ResourceDraft>;
  update(input:ResourceSpec & {draftId:string;expectedVersion:number}):Promise<ResourceDraft>;
  apply(draft:ResourceDraft):Promise<WorkResource>;withdraw(resource:WorkResource):Promise<WorkResource>;
  candidates(sessionId:string,signal:AbortSignal):Promise<WorkResource[]>;
  history(sessionId:string,beforeSeq:number|undefined,signal:AbortSignal):Promise<ResourceHistoryPage>;
  recovery(sessionId:string,beforeSeq:number|undefined,signal:AbortSignal):Promise<ResourceRecoveryPage>;
  listKnowledgeVersions(knowledgeId:string):Promise<KnowledgeVersionSummary[]>;
  readKnowledgeVersion(knowledgeId:string,version:number):Promise<KnowledgeVersion>;
  reviseKnowledgeResource(input:KnowledgeResourceReviseInput):Promise<KnowledgeResourceRevision>;
  restoreKnowledgeResource(input:KnowledgeResourceRestoreInput):Promise<KnowledgeResourceRevision>;
  knowledgeTree():Promise<KnowledgeTree>;
  createKnowledgeFolder(input:{requestId:string;parentId:string;title:string;expectedDirectoryRevision:number;position?:number}):Promise<KnowledgeTreeMutation>;
  renameKnowledgeNode(input:{requestId:string;nodeId:string;title:string;expectedDirectoryRevision:number}):Promise<KnowledgeTreeMutation>;
  moveKnowledgeNode(input:{requestId:string;nodeId:string;parentId:string;expectedDirectoryRevision:number;position?:number}):Promise<KnowledgeTreeMutation>;
}
type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
export function createResourceApi(call:Call,journal?:{read:()=>string|null;write:(value:string)=>void;clear:()=>void}):ResourceApi {
  const invalid=()=>Error('工作资料服务返回的内容格式不正确。')
  const api:ResourceApi={
    async registerLocalMaterial(input){const request=readLocalMaterialInput(input),value=await call('resources/register-local-material',request);if(!isLocalMaterialReference(value,request))throw invalid();return value},
    async readContent(resource,signal){
      signal.throwIfAborted()
      if(!isWorkResource(resource)||resource.status!=='active'||!isLocalMaterialSourceId(resource.sourceId))throw invalid()
      const value=await call('resources/read-content',{resourceId:resource.id,expectedVersion:resource.version,sourceVersion:resource.sourceVersion},signal)
      signal.throwIfAborted()
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!('resource' in value)||!('text' in value)||!isWorkResource(value.resource)||typeof value.text!=='string')throw invalid()
      const current=value.resource,keys=['id','ownerId','title','sourceId','sourceVersion','scopeIds','version','status','createdAt','updatedAt'] as const
      if(Object.keys(current).length!==keys.length||keys.some(key=>key==='scopeIds'?JSON.stringify(current.scopeIds)!==JSON.stringify(resource.scopeIds):current[key]!==resource[key]))throw invalid()
      const bytes=new TextEncoder().encode(value.text)
      if(bytes.byteLength>128*1024)throw invalid()
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')
      signal.throwIfAborted()
      if(hash!==resource.sourceVersion)throw invalid()
      return {resource:current,text:value.text}
    },
    async directory(){const value=await call('resources/list',{});if(!isResourceDirectory(value))throw invalid();return value},
    async sources(){const value=await call('resources/sources',{});if(!Array.isArray(value)||!value.every(isSourceReference))throw invalid();return value},
    async create(input){const value=await call('resources/create',input);if(!isResourceDraft(value))throw invalid();return value},
    async update(input){const value=await call('resources/update',input);if(!isResourceDraft(value))throw invalid();return value},
    async apply(draft){const value=await call('resources/apply',{draftId:draft.id,expectedVersion:draft.version});if(!isWorkResource(value))throw invalid();return value},
    async withdraw(resource){const value=await call('resources/withdraw',{resourceId:resource.id,expectedVersion:resource.version});if(!isWorkResource(value))throw invalid();return value},
    async candidates(sessionId,signal){const value=await call('resources/candidates',{sessionId},signal);if(!Array.isArray(value)||!value.every(isWorkResource))throw invalid();return value},
    async history(sessionId,beforeSeq,signal){const value=await call('resources/history',{sessionId,...(beforeSeq===undefined?{}:{beforeSeq})},signal);if(!isResourceHistoryPage(value)||value.sessionId!==sessionId)throw invalid();return value},
    async recovery(sessionId,beforeSeq,signal){const value=await call('resources/recovery',{sessionId,...(beforeSeq===undefined?{}:{beforeSeq})},signal);if(!isResourceRecoveryPage(value)||value.sessionId!==sessionId)throw invalid();return value},
    async listKnowledgeVersions(knowledgeId){const value=await call('knowledge/list-versions',{knowledgeId});if(!Array.isArray(value)||!value.every(isKnowledgeVersionSummary))throw invalid();return value},
    async readKnowledgeVersion(knowledgeId,version){const value=await call('knowledge/read-version',{knowledgeId,version});if(!isKnowledgeVersion(value)||value.knowledgeId!==knowledgeId||value.version!==version)throw invalid();return value},
    async reviseKnowledgeResource(input){const value=await call('knowledge/revise-resource',input);if(!isKnowledgeResourceRevision(value)||value.knowledge.item.id!==input.knowledgeId)throw invalid();return value},
    async restoreKnowledgeResource(input){const value=await call('knowledge/restore-resource',input);if(!isKnowledgeResourceRevision(value)||value.knowledge.item.id!==input.knowledgeId)throw invalid();return value},
    async knowledgeTree(){const value=await call('knowledge/tree',{});if(!isKnowledgeTree(value))throw invalid();return value},
    async createKnowledgeFolder(input){const value=await call('knowledge/create-folder',input);if(!isKnowledgeTreeMutation(value)||value.node.type!=='folder')throw invalid();return value},
    async renameKnowledgeNode(input){const value=await call('knowledge/rename-node',input);if(!isKnowledgeTreeMutation(value)||value.node.id!==input.nodeId)throw invalid();return value},
    async moveKnowledgeNode(input){const value=await call('knowledge/move-node',input);if(!isKnowledgeTreeMutation(value)||value.node.id!==input.nodeId||value.node.parentId!==input.parentId)throw invalid();return value},
  }
  api.localMaterialRequests=createLocalMaterialRegistration(api,journal)
  return api
}
