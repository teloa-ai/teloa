import type {Context} from '@deepseek-ai/cordis'
import * as official from '@deepseek-ai/dsh-goal-round-driver'
import {WorkError} from '@teloa/contract'
import type {createTaskRunGoal} from './task-run-goal.ts'
import type {GoalInputCandidate} from './native-producer-admission.ts'

declare module '@deepseek-ai/cordis'{interface Context{readonly teloaTaskRunGoal:ReturnType<typeof createTaskRunGoal>}}
export const name='teloa-managed-goal-round-driver'
export const inject=['agents','goals','sessions','teloaTaskRunGoal']
/** 仅固定官方补口的启动装配；不复制 Goal domain 或模型 loop。 */
export function apply(ctx:Context):void{
 const provider=ctx.get('teloaTaskRunGoal')
 const patched=official as unknown as {apply:(ctx:Context,options:{requireInputAdmission:true;admitInput:(candidate:GoalInputCandidate,dispatch:()=>void)=>Promise<void>})=>void;requireGoalInputAdmission:(ctx:Context)=>void;installGoalInputAdmission:(ctx:Context,provider:unknown)=>void}
 if(!provider||typeof provider.admit!=='function'||typeof patched.requireGoalInputAdmission!=='function'||typeof patched.installGoalInputAdmission!=='function')throw new WorkError('teloa/unavailable','Goal 受控续轮补口或本人执行服务尚未装配。')
 patched.apply(ctx,{requireInputAdmission:true,admitInput:provider.admit})
 ctx.provide('teloaManagedGoalRoundDriver' as never,Object.freeze({version:1,goal:provider}) as never)
}
