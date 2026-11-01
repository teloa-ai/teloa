const phases=new Set(['submission','resolve','check','background','tools','model','attachments','native-input','publication'])
export type SubmissionPhase='submission'|'resolve'|'check'|'background'|'tools'|'model'|'attachments'|'native-input'|'publication'
const failures=new WeakMap<object,SubmissionPhase>()
const categories=new Set(['Error','WorkError','TaskRunPresetError','TypeError','RangeError','AbortError','TimeoutError'])
export function markSubmissionFailure(error:unknown,phase:SubmissionPhase):void{
 if(error!==null&&(typeof error==='object'||typeof error==='function')&&phases.has(phase))failures.set(error,phase)
}
/** 只导出固定枚举和合法契约码；原始message/stack/code/参数绝不进入日志。 */
export function submissionFailureDiagnostic(error:unknown):{phase:SubmissionPhase;category:string;code:string}{
 if(error===null||typeof error!=='object')return {phase:'submission',category:'NonError',code:'teloa/execution-pending'}
 let category='OtherError',code='teloa/execution-pending'
 try{const name=Reflect.get(error,'name'),value=Reflect.get(error,'code');if(typeof name==='string'&&categories.has(name))category=name;if(typeof value==='string'&&value.length<=128&&/^teloa\/[a-z-]+$/.test(value))code=value}catch{/* 诊断读取不能改变执行异常。 */}
 return {phase:failures.get(error)??'submission',category,code}
}
