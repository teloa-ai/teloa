import {WorkError} from './work-error.ts'

/**
 * 停止意图的时间戳。停止只是「请求」，它不伪造终态，只把请求本身留痕，
 * 于是刷新后仍能看到「停止中」，宿主也有了可判别的重发依据。
 * 旧记录没有这一位：缺字段与 null 一律回落 null，只接受规范化 ISO 串。
 */
export function taskRunStopRequestedAt(value:unknown):string|null{
 if(value===undefined||value===null)return null
 if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new WorkError('teloa/invalid-input','停止请求时间不正确。')
 return value
}

export type TaskRunOriginSource={kind:'conversation-work';sessionId:string;requestId:string;messageId:string;messageSeq:number;title:string;stopped:boolean}
export type TaskRunOrigin={taskId:string;runId:string|null;source:TaskRunOriginSource|null}
const originUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const originRecord=(value:unknown,keys:readonly string[])=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','交办来源格式不正确。')
 return value as Record<string,unknown>
}
export function taskRunOriginInput(value:unknown):{taskId?:string;runId?:string}{
 const row=originRecord(value,['taskId','runId'])
 if((row.taskId===undefined)===(row.runId===undefined)||row.taskId!==undefined&&!originUuid(row.taskId)||row.runId!==undefined&&!originUuid(row.runId))throw new WorkError('teloa/invalid-input','任务或执行身份不正确。')
 return row.taskId!==undefined?{taskId:String(row.taskId).toLowerCase()}:{runId:String(row.runId).toLowerCase()}
}
/** 来源只用于返回本人原交办；不包含可用于执行或提交的父授权。 */
export function readTaskRunOrigin(value:unknown):TaskRunOrigin{
 const row=originRecord(value,['taskId','runId','source'])
 if(!originUuid(row.taskId)||row.runId!==null&&!originUuid(row.runId))throw new WorkError('teloa/invalid-input','交办来源身份不正确。')
 if(row.source===null)return {taskId:row.taskId,runId:row.runId,source:null}
 const source=originRecord(row.source,['kind','sessionId','requestId','messageId','messageSeq','title','stopped'])
 // 与原交办持久契约一致：messageId 是不透明身份，标题允许原有换行；读来源不改写历史字段。
 const messageId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200
 const title=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=120
 if(source.kind!=='conversation-work'||typeof source.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(source.sessionId)||!originUuid(source.requestId)||!messageId(source.messageId)||!Number.isSafeInteger(source.messageSeq)||Number(source.messageSeq)<0||!title(source.title)||typeof source.stopped!=='boolean')throw new WorkError('teloa/invalid-input','原交办来源不可核对。')
 return {taskId:row.taskId,runId:row.runId,source:{kind:'conversation-work',sessionId:source.sessionId,requestId:source.requestId,messageId:source.messageId,messageSeq:Number(source.messageSeq),title:source.title,stopped:source.stopped}}
}


/** 只读准备检查不发放执行许可；实际准备与启动始终重新核验。 */
export type TaskRunReadiness={schema:'teloa.task-run-readiness/v1';taskId:string;taskVersion:number;ready:true}
export function taskRunReadinessInput(value:unknown):{taskId:string;expectedTaskVersion:number}{
 const row=originRecord(value,['taskId','expectedTaskVersion'])
 if(!originUuid(row.taskId)||!Number.isSafeInteger(row.expectedTaskVersion)||Number(row.expectedTaskVersion)<1)throw new WorkError('teloa/invalid-input','任务身份或版本不正确。')
 return {taskId:row.taskId.toLowerCase(),expectedTaskVersion:Number(row.expectedTaskVersion)}
}
export function readTaskRunReadiness(value:unknown):TaskRunReadiness{
 const row=originRecord(value,['schema','taskId','taskVersion','ready'])
 if(row.schema!=='teloa.task-run-readiness/v1'||!originUuid(row.taskId)||!Number.isSafeInteger(row.taskVersion)||Number(row.taskVersion)<1||row.ready!==true)throw new WorkError('teloa/invalid-input','执行条件检查响应不正确。')
 return {schema:'teloa.task-run-readiness/v1',taskId:row.taskId,taskVersion:Number(row.taskVersion),ready:true}
}
