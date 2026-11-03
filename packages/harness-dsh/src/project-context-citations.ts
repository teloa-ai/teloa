import {createHash} from 'node:crypto'
import {projectContextCitationInput,projectCitationSelector,projectCitationMatches,projectCitationTurnSources,WorkError,type ProjectContextCitation,type ProjectCitationEvent} from '@teloa/contract'
import type {ProjectRuntimeService} from '@teloa/backend'

export type ProjectCitationSnapshot={events:readonly ProjectCitationEvent[];inheritedEventCount:number}
export type ProjectCitationLog=(sessionId:string)=>Promise<ProjectCitationSnapshot>
const unavailable=()=>new WorkError('teloa/source-unavailable','此引用来源暂不可用，请返回原会话重新核对。')
/** 只读原轮次的官方快照；别名必须唯一匹配，不能按当前目录或模型提供的正文反查。 */
export async function readProjectContextCitation(owner:string,runtime:ProjectRuntimeService,readLog:ProjectCitationLog,input:unknown,signal?:AbortSignal):Promise<ProjectContextCitation>{
 const request=projectContextCitationInput(input),actor=await runtime.ports.inspect(owner,request.sessionId)
 if(actor.sessionId!==request.sessionId||!['ordinary','employee'].includes(actor.kind))throw unavailable()
 signal?.throwIfAborted();const log=await readLog(request.sessionId);signal?.throwIfAborted()
 const selector='reference'in request?projectCitationSelector(request.reference)!:request,{messageIds,rows}=projectCitationTurnSources(log.events,request.sessionId,request.turn,log.inheritedEventCount)
 const matches=rows.filter(row=>projectCitationMatches(row.source,selector))
 if(!messageIds.length||matches.length!==1)throw unavailable()
 const {projectId,generation,source,markdown}=matches[0]!
 if(createHash('sha256').update(markdown).digest('hex')!==source.hash)throw unavailable()
 const fixed=await runtime.readCitation(owner,{sessionId:request.sessionId,messageIds,projectId,generation,source,markdown,...signal?{signal}:{}})
 signal?.throwIfAborted();return {sessionId:request.sessionId,turn:request.turn,kind:source.kind,id:source.id,...fixed}
}
