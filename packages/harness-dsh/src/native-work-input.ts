import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionSeq,snapshotSessionEvent,type SessionStore,type UserMessage} from '@deepseek-ai/dsh-session'
import {workAccess,type WorkAccess,type WorkAccessRequest} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {createNativeInputGuard,nativeInputIdentity} from './native-input-access.ts'

export type NativeInputProducer=Extract<WorkAccessRequest,{kind:'native-input'}>['producer']
// identity 由拥有实际发布点的 producer 构造。它只绑定上下文，不凭此标记授予许可。
export type NativeInputContext=Readonly<{producer:NativeInputProducer;identity:string}>
const producers=new Set<NativeInputProducer>(['prompt','queue','subagent','schedule','task-run'])
const denied=()=>new WorkError('teloa/forbidden','当前暂不能提交新输入，请核对运行许可后重试。')

/** 只负责首次原生输入；已有受理回执、续作和 seed 需要各 producer 的独立可信因果核对。 */
export function createNativeWorkInput(ctx:Context,access:WorkAccess=workAccess){
 const guard=createNativeInputGuard(ctx,{final:true})
 return Object.freeze({
  async withNewInput(agent:Agent,message:UserMessage,context:NativeInputContext,submit:()=>void,signal?:AbortSignal):Promise<void>{
   let producer:NativeInputProducer,contextIdentity:string,snapshot:UserMessage
   try{
    producer=context.producer;contextIdentity=context.identity
    if(!producers.has(producer)||typeof contextIdentity!=='string'||!contextIdentity||contextIdentity.length>16384||typeof submit!=='function'||submit.constructor?.name==='AsyncFunction')throw denied()
    snapshot=snapshotSessionEvent({type:'user/message',seq:SessionSeq(0),time:0,data:message,surfaceOp:'append'}).data
   }catch{throw denied()}
   const rpcId=Reflect.get(snapshot.source,'rpcId')
   if(rpcId!==undefined&&(typeof rpcId!=='string'||!rpcId))throw denied()
   const session=agent.session,identity=nativeInputIdentity(snapshot,rpcId)
   const contextSha256=createHash('sha256').update(JSON.stringify([producer,contextIdentity])).digest('hex')
   const assertTarget=()=>{signal?.throwIfAborted();if(ctx.agents.get(agent.id)!==agent||agent.session!==session||(Reflect.get(ctx,'sessions') as unknown as SessionStore).get(agent.id)!==session)throw denied()}
   assertTarget()
   const request:WorkAccessRequest={kind:'native-input',sessionId:agent.id,messageId:identity.messageId,nativeRequestId:rpcId??null,payloadSha256:identity.payloadSha256,producer,contextSha256}
   const lease=await access.authorize(request)
   const assertLease=lease.assertCurrent
   const fixed={assertCurrent:()=>{assertTarget();return assertLease.call(lease)}}
   guard.withSyncLease(session,identity,fixed,()=>{
    assertTarget()
    const returned:unknown=submit()
    if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw denied()}
   })
  },
  close():void{guard.close()},
 })
}
