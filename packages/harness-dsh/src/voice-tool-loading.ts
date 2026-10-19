import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import {acquireToolLoading,toolLoaderName} from './tool-loading.ts'

/** 语音与普通会话共用同一加载器；保留旧导出名供既有调用方使用。 */
export const voiceToolsName=toolLoaderName
/** 语音入口：只延后完整参数的加载，按轮次重置；每次装配重新取原许可工具集，不注册或执行任何业务能力。 */
export function createVoiceToolLoading(ctx:Context){
 const {engine,release}=acquireToolLoading(ctx)
 let closed=false
 return Object.freeze({
  refine(agent:Agent,assembly:PromptAssembly,input:Readonly<{voice:boolean;turn?:number}>):PromptAssembly{
   return engine.refineVoice(agent,assembly,closed?{voice:false}:input)
  },
  dispose(){if(closed)return;closed=true;release()},
 })
}
