import type {Context} from '@deepseek-ai/cordis'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import type {NativeJobCompletion} from './native-work-causality.ts'
import {requireNativeInputProvider} from './native-input-provider.ts'
import {WorkError} from '@teloa/contract'

type PatchedTools=typeof JobTools&{completionAdmissionVersion:1;apply:(ctx:Context,config:JobTools.Config,options:{requireCompletionAdmission:true;admitCompletion:(candidate:NativeJobCompletion,dispatch:()=>void)=>Promise<void>;observeCompletionDecision:(job:NativeJobCompletion['job'],notify:boolean)=>void})=>void}
/** 官方工具、完成事件与 owner 仍由固定服务负责；这里只装配最终通知准入。 */
export function createManagedToolJobs(base:typeof JobTools){
 const patched=base as PatchedTools
 return {name:'teloa-managed-tool-jobs',inject:[...JobTools.inject,'teloaNativeInput'],Config:JobTools.Config,apply(ctx:Context,config:JobTools.Config){
  if(patched.completionAdmissionVersion!==1)throw new WorkError('teloa/unavailable','后台完成通知服务尚未就绪。')
  const provider=requireNativeInputProvider(ctx)
  patched.apply(ctx,config,{requireCompletionAdmission:true,admitCompletion:(candidate,dispatch)=>provider.input.withJobCompletion(candidate,dispatch),observeCompletionDecision:provider.input.jobCompletionDecision})
 }}
}
const managed=createManagedToolJobs(JobTools)
export const name=managed.name,inject=managed.inject,Config=managed.Config,apply=managed.apply
