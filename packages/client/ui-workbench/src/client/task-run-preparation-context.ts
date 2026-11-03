import type {WorkBudgetExhaustion} from '@teloa/contract'
import {createContext} from 'react'

/** 详情主按钮复用已挂载运行面的准备动作，不另建请求或执行入口。 */
export type TaskRunPreparation={taskId:string;taskVersion:number;disabled:boolean;reason?:string;refresh?:()=>void;prepare:()=>void;budgetExhaustion?:Partial<WorkBudgetExhaustion>;control?:{tone:'info'|'warn'|'muted';sentence:string;hint:string;actionLabel:string;disabled:boolean;act:()=>void}}
export const TaskRunPreparationContext=createContext<((preparation:TaskRunPreparation|null)=>void)|undefined>(undefined)

/** 已修改目标的原任务在本轮控制核对/明确恢复前不开始准备。 */
export const TaskOwnerReworkBlockContext=createContext(false)
