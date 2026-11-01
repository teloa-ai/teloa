import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore,SessionId,SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry,type ProjectionDefinition} from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {TaskRun} from '@teloa/backend'
import {patchedNativePackage} from './native-patched-package.ts'

type Cleanup={after:(action:()=>unknown)=>void}
export async function quiescenceFixture(t:Cleanup){
 const pkg=await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent-loop')&{inboxProjectionDefinition:ProjectionDefinition<'inbox'>&{wire:NonNullable<ProjectionDefinition<'inbox'>['wire']>}}>(t,{packageName:'@deepseek-ai/dsh-agent-loop',compatBasename:'dsh-agent-loop-0.2.1-rc.2-work-admission'})
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-quiescence-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(Jsonl,{root,compression:'none'});ctx.sessionProjections.register(pkg.namespace.inboxProjectionDefinition)
 ctx.provide('workingDirectory',{defaultDirectory:root} as never);ctx.provide('agents',{get:()=>undefined} as never)
 const sessionId=SessionId('quiescent-'+randomUUID()),writer=await ctx.sessionPersistence.create({id:sessionId,version:4,createdAt:1,cwd:root,agentPreset:'worker',isSeeded:false})
 const base={taskId:randomUUID(),roleId:randomUUID(),roleVersion:1,linkVersion:1,sessionId,agentPresetId:'worker',allowedTools:[],skills:[],knowledge:[],memory:[],inputText:'{}',createdAt:'2026-10-25T00:00:00.000Z'}
 const a1:TaskRun={...base,id:randomUUID(),taskVersion:1,nativeRequestId:randomUUID(),state:'ended',stopRequestedAt:null,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}}
 const events:SessionEvent[]=[{type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},{type:'user/message',seq:SessionSeq(1),time:2,surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:a1.nativeRequestId},content:[{type:'text',text:'原输入'}]})},{type:'turn/end',seq:SessionSeq(2),time:3,data:{turn:1,reason:{kind:'completed'}}}]
 const nativeRequestId=randomUUID(),unknownId=randomUUID(),unknown:TaskRun={...base,id:unknownId,taskVersion:2,nativeRequestId,state:'submission_unknown',stopRequestedAt:base.createdAt,evidence:null,submissionDisposition:{schema:'teloa.task-run-submission-disposition/v1',requestId:randomUUID(),runId:unknownId,sessionId,nativeRequestId,inputSha256:createHash('sha256').update(base.inputText).digest('hex'),runtimeId:randomUUID(),logCut:2,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex'),acknowledgedUnknown:true,closedAt:base.createdAt}}
 await writer.append(events);await writer.flush();await writer.close()
 const path=await Reflect.get(ctx.sessionPersistence,'resolveCurrentLog').call(ctx.sessionPersistence,sessionId)
 const appendF1=async()=>{
  const f1:TaskRun={...base,id:randomUUID(),taskVersion:3,nativeRequestId:randomUUID(),state:'ended',stopRequestedAt:null,evidence:{state:'ended',turn:2,messageSeq:4,endSeq:5,reason:'completed'}}
  const more:SessionEvent[]=[{type:'turn/start',seq:SessionSeq(3),time:4,data:{turn:2}},{type:'user/message',seq:SessionSeq(4),time:5,surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:f1.nativeRequestId},content:[{type:'text',text:'本人新核验'}]})},{type:'turn/end',seq:SessionSeq(5),time:6,data:{turn:2,reason:{kind:'completed'}}}]
  const handle=await ctx.sessionPersistence.open(sessionId,'write');await handle.append(more);await handle.flush();await handle.close();events.push(...more);return f1
 }
 return {ctx,path,events,a1,unknown,appendF1}
}
