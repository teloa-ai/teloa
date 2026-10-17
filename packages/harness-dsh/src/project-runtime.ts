import {WorkError,projectInput,projectRuntimeUuid,projectRuntimeSession,projectRuntimeVersion} from '@teloa/contract'
import {ProjectPersonalMemoryService,type ProjectRuntimeService,type ProjectMemoryExtractionService} from '@teloa/backend'
export const projectRuntimeEndpoints=['project-runtime/settings','project-runtime/configure','project-runtime/bind','project-runtime/binding','project-runtime/members','project-runtime/conversations','project-runtime/uses','project-runtime/history','project-runtime/candidates','project-runtime/resolve','project-runtime/failures','project-runtime/retry','project-runtime/personal','project-runtime/save-personal','project-runtime/publish-personal','project-runtime/withdraw-personal'] as const
export function createProjectRuntimeHandler(owner:string,get:()=>Promise<{runtime:ProjectRuntimeService;memory:ProjectMemoryExtractionService}>):(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>{
 return async(endpoint:string,payload:unknown,signal?:AbortSignal)=>{
  if(!(projectRuntimeEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此项目运行接口。')
  signal?.throwIfAborted();const {runtime,memory}=await get();signal?.throwIfAborted()
  const personal=new ProjectPersonalMemoryService(runtime.pool,runtime.identity)
  if(endpoint==='project-runtime/personal'){projectInput(payload,[]);return personal.get(owner)}
  if(endpoint==='project-runtime/save-personal')return personal.save(owner,payload,signal)
  if(endpoint==='project-runtime/publish-personal')return personal.publishProjectExperience(owner,payload,signal)
  if(endpoint==='project-runtime/withdraw-personal')return personal.withdraw(owner,payload,signal)
  if(endpoint==='project-runtime/settings')return runtime.settings(owner,payload)
  if(endpoint==='project-runtime/configure')return runtime.configure(owner,payload,signal)
  if(endpoint==='project-runtime/bind')return runtime.bind(owner,payload,signal)
  if(endpoint==='project-runtime/binding'){const r=projectInput(payload,['sessionId']);return runtime.getBinding(owner,projectRuntimeSession(r.sessionId))}
  if(endpoint==='project-runtime/members')return runtime.members(owner,payload)
  if(endpoint==='project-runtime/conversations')return runtime.conversations(owner,payload)
  if(endpoint==='project-runtime/uses')return runtime.uses(owner,payload)
  if(endpoint==='project-runtime/history')return runtime.history(owner,payload)
  if(endpoint==='project-runtime/failures'){const r=projectInput(payload,['projectId']),projectId=projectRuntimeUuid(r.projectId);await runtime.settings(owner,{projectId});return {rows:await memory.listFailures(owner,{projectId})}}
  if(endpoint==='project-runtime/retry'){const r=projectInput(payload,['projectId','eventId','requestId']),projectId=projectRuntimeUuid(r.projectId),eventId=projectRuntimeUuid(r.eventId),requestId=projectRuntimeUuid(r.requestId);await runtime.settings(owner,{projectId});await memory.retryEvent(owner,{eventId,requestId,expectedProjectId:projectId});return {ok:true}}
  if(endpoint==='project-runtime/candidates'){
   const r=projectInput(payload,['projectId']),projectId=projectRuntimeUuid(r.projectId);await runtime.settings(owner,{projectId})
   const rows=await memory.listCandidates(owner,{projectId});return {rows:rows.filter(c=>c.status==='candidate'||c.status==='conflict').map(c=>({id:c.id,projectId:c.projectId,topic:c.proposal.topic,markdown:c.proposal.markdown,kind:c.proposal.kind,status:c.status,reason:c.reason,version:1,...(c.source?{source:c.source}:{}),...(c.evidence?{evidence:c.evidence}:{})}))}
  }
  const r=projectInput(payload,['projectId','candidateId','requestId','expectedVersion','decision']),projectId=projectRuntimeUuid(r.projectId),candidateId=projectRuntimeUuid(r.candidateId),requestId=projectRuntimeUuid(r.requestId),version=projectRuntimeVersion(r.expectedVersion)
  if(r.decision!=='accept'&&r.decision!=='reject')throw new WorkError('teloa/invalid-input','请选择采用或拒绝候选。')
  await runtime.settings(owner,{projectId})
  await memory.resolveCandidate(owner,{candidateId,action:r.decision,expectedContextVersion:version,requestId,expectedProjectId:projectId},signal);return {ok:true}
 }
}
