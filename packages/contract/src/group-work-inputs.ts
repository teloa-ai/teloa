import {WorkError} from './work-error.ts'

/**
 * 群对原工作的追加与停止（规格 §4.4、§6.7）。回执绑定原 taskId 与期望任务版本，分阶段可恢复：
 * reserved＝已保存，等待原运行收敛；continued＝同一 taskId 已升新版本，新 Run 准备/送达中（仍可被恢复拾取）；
 * accepted＝已核实送达（续办 Run 已被原生受理，或停止已提交原工作控制）；unknown＝提交结果未知，只按原身份核对；
 * rejected＝原工作已变化、已取消或已停止，需本人核对后重新发起。
 */
export type GroupWorkInputOperation='continue'|'stop'
export type GroupWorkInputState='reserved'|'continued'|'accepted'|'unknown'|'rejected'
/** 合法状态迁移（服务端 SQL 条件与测试替身共用这一张表）。accepted／rejected 为终态。 */
export const groupWorkInputTransitions:Readonly<Record<GroupWorkInputState,readonly GroupWorkInputState[]>>={reserved:['reserved','continued','accepted','unknown','rejected'],continued:['continued','accepted','unknown','rejected'],unknown:['unknown','continued','accepted','rejected'],accepted:[],rejected:[]}
export type GroupWorkInput={requestId:string;groupId:string;messageId:string;taskId:string;expectedTaskVersion:number;operation:GroupWorkInputOperation}
/** 恰 8 键。acceptedSeq 只在核对原生记录后写入，不由受理布尔值推造；续办没有原生序号时为 null。 */
export type GroupWorkInputReceipt={requestId:string;taskId:string;taskVersion:number;runId:string|null;state:GroupWorkInputState;nativeRequestId:string|null;acceptedSeq:number|null;operation:GroupWorkInputOperation}

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const fail=():never=>{throw new WorkError('teloa/invalid-input','群工作追加请求包含未知字段或格式不正确。')}

export function groupWorkInput(value:unknown):GroupWorkInput{
 if(!record(value)||Object.keys(value).length!==6||!uuid(value.requestId)||!uuid(value.groupId)||!uuid(value.messageId)||!uuid(value.taskId)||!positive(value.expectedTaskVersion)||value.operation!=='continue'&&value.operation!=='stop')fail()
 const row=value as Record<string,unknown>
 return {requestId:row.requestId as string,groupId:row.groupId as string,messageId:row.messageId as string,taskId:row.taskId as string,expectedTaskVersion:row.expectedTaskVersion as number,operation:row.operation as GroupWorkInputOperation}
}

export function isGroupWorkInputReceipt(value:unknown):value is GroupWorkInputReceipt{
 return record(value)&&Object.keys(value).length===8&&uuid(value.requestId)&&uuid(value.taskId)&&positive(value.taskVersion)&&(value.runId===null||uuid(value.runId))&&['reserved','continued','accepted','unknown','rejected'].includes(String(value.state))&&(value.nativeRequestId===null||typeof value.nativeRequestId==='string'&&value.nativeRequestId.length<=200)&&(value.acceptedSeq===null||Number.isSafeInteger(value.acceptedSeq)&&(value.acceptedSeq as number)>=0)&&(value.operation==='continue'||value.operation==='stop')
}
