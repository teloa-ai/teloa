import {createContext} from 'react'

/** 详情主按钮复用已挂载运行面的准备动作，不另建请求或执行入口。 */
export type TaskRunPreparation={taskId:string;taskVersion:number;disabled:boolean;prepare:()=>void;control?:{tone:'info'|'warn'|'muted';sentence:string;hint:string;actionLabel:string;disabled:boolean;act:()=>void}}
export const TaskRunPreparationContext=createContext<((preparation:TaskRunPreparation|null)=>void)|undefined>(undefined)
