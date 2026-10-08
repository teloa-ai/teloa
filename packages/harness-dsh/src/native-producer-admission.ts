import {createHash} from 'node:crypto'
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol'
import {WorkError} from '@teloa/contract'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {UserMessage} from '@deepseek-ai/dsh-session'
import type {createNativeWorkInput,NativeInputContext} from './native-work-input.ts'

declare module '@deepseek-ai/dsh-typert-protocol'{
 interface RemoteErrorDetailsMap{
  'teloa/forbidden':Record<string,never>
  'teloa/unavailable':Record<string,never>
 }
}

export type ControllerInputCandidate=
 |Readonly<{kind:'prompt';agent:Agent;message:UserMessage;requestId:string;mode:'queue'|'steer'}>
 |Readonly<{kind:'queue-edit';agent:Agent;message:UserMessage;itemId:string;target:'next-turn'|'next-step';previousMessage:UserMessage}>
export type SubagentInputCandidate=Readonly<{agent:Agent;message:UserMessage;sender:Agent;delivery:'queue'|'steer';signal?:AbortSignal;kind?:'initial'|'live'|'resume'}>
export type ScheduleInputCandidate=Readonly<{agent:Agent;message:UserMessage;occurrences:readonly Readonly<{scheduleId:string;occurrenceAt:string}>[]}>
export type GoalInputCandidate=Readonly<{agent:Agent;message:UserMessage;goal:Readonly<{id:string;revision:number}>;round:number}>
type Publisher=()=>void
type Input=Pick<ReturnType<typeof createNativeWorkInput>,'withNewInput'>&Partial<Pick<ReturnType<typeof createNativeWorkInput>,'withSubagentInput'>>

function context(producer:NativeInputContext['producer'],identity:readonly unknown[]):NativeInputContext{
 // 仅绑定官方发布者已解析的上下文；实际许可仍由 WorkAccess 与最终 Session 验证。
 return Object.freeze({producer,identity:createHash('sha256').update(JSON.stringify(identity)).digest('hex')})
}

/**
 * 官方补口的薄装配：全部发布者共享宿主已有的一个 NativeWorkInput。
 * 仅首次新输入；旧回执由 Controller 核对，seed/fork 与受理任务续作另行接入。
 * 返回固定函数供各服务在启动前安装，不自行创建第二个 guard 或决定业务身份。
 */
export function createNativeProducerAdmissions(input:Input,goalAdmission?:(candidate:GoalInputCandidate,dispatch:Publisher)=>Promise<void>){
 return Object.freeze({
  async controller(candidate:ControllerInputCandidate,dispatch:Publisher):Promise<void>{
   const binding=candidate.kind==='prompt'
    ?context('prompt',['controller/prompt',candidate.agent.id,candidate.requestId,candidate.mode])
    :context('queue',['controller/queue-edit',candidate.agent.id,candidate.itemId,candidate.target,candidate.previousMessage.id])
   try{await input.withNewInput(candidate.agent,candidate.message,binding,dispatch)}
   catch(error){
    // 内部准入仍抛业务错误；只有官方 Controller 的传输边界显式转换已知拒绝。
    if(error instanceof WorkError&&(error.code==='teloa/forbidden'||error.code==='teloa/unavailable'))throw new RemoteError(error.code,error.message,{}, {cause:error})
    throw error
   }
  },
  subagent(candidate:SubagentInputCandidate,dispatch:Publisher):Promise<void>{
   const binding=context('subagent',['subagent/input',candidate.kind??'live',candidate.sender.id,candidate.agent.id,candidate.delivery])
   if(candidate.kind&&input.withSubagentInput)return input.withSubagentInput({...candidate,kind:candidate.kind},binding,dispatch)
   return input.withNewInput(candidate.agent,candidate.message,binding,dispatch)
  },
  schedule(candidate:ScheduleInputCandidate,dispatch:Publisher):Promise<void>{
   const binding=context('schedule',['schedule/delivery',candidate.agent.id,candidate.occurrences.map(item=>[item.scheduleId,item.occurrenceAt])])
   return input.withNewInput(candidate.agent,candidate.message,binding,dispatch)
  },
  goal(candidate:GoalInputCandidate,dispatch:Publisher):Promise<void>{
   // Goal 必须先有持久业务票据；通用 producer 标记不能变成免票据的另一条发布入口。
   if(!goalAdmission)throw new WorkError('teloa/unavailable','Goal 持久续轮准入尚未装配。')
   return goalAdmission(candidate,dispatch)
  },
 })
}
