const phases=new Set(['submission','resolve','check','background','tools','model','attachments','native-input','publication'])
export type SubmissionPhase='submission'|'resolve'|'check'|'background'|'tools'|'model'|'attachments'|'native-input'|'publication'
const modelStages=new Set(['approval-context','employee-prompt','run-methods','model-routing-install','model-routing-resolve'])
export type SubmissionModelStage='approval-context'|'employee-prompt'|'run-methods'|'model-routing-install'|'model-routing-resolve'
const failures=new WeakMap<object,{phase:SubmissionPhase;modelStage?:SubmissionModelStage}>()
const categories=new Set(['Error','WorkError','TaskRunPresetError','TypeError','RangeError','AbortError','TimeoutError'])
export function markSubmissionFailure(error:unknown,phase:SubmissionPhase,modelStage?:SubmissionModelStage):void{
 if(error!==null&&(typeof error==='object'||typeof error==='function')&&phases.has(phase))failures.set(error,{phase,...phase==='model'&&modelStage&&modelStages.has(modelStage)?{modelStage}:{}})
}
type Frame={module:string;line:number;column:number}
type Diagnostic={phase:SubmissionPhase;category:string;code:string;modelStage?:SubmissionModelStage;frames?:Frame[];causes?:{category:string;frames?:Frame[]}[]}
const knownLeaves='task-run-dsh|task-model-dsh|task-model-routing|model-default-effort|employee-system-prompt|task-run-approval-context|local-models|local-model-request'
/** 只保留已知公开模块及行列；不输出绝对路径、函数名或原始异常正文。 */
function frames(error:object):Frame[]{
 try{
  const stack=Reflect.get(error,'stack');if(typeof stack!=='string')return []
  const result:Frame[]=[]
  for(const line of stack.slice(0,16384).split('\n').slice(1,65)){
   if(!/^\s+at /.test(line))continue
   const known=line.match(new RegExp('(?:^|/)(packages/harness-dsh/(?:src|lib)/(?:'+knownLeaves+')\\.(?:ts|js)):(\\d{1,8}):(\\d{1,8})\\)?$'))??line.match(/(?:^|\/)(@deepseek-ai\/(?:dsh-llm|dsh-agent|dsh-system-prompt|cordis)\/lib\/(?:index|context|fiber)\.js):(\d{1,8}):(\d{1,8})\)?$/)
   if(known){result.push({module:known[1]!,line:Number(known[2]),column:Number(known[3])});if(result.length===6)break}
  }
  return result
 }catch{return []}
}
function safeCategory(error:object):string{
 try{const name=Reflect.get(error,'name');if(typeof name==='string'&&categories.has(name))return name}catch{/* 恶意 getter 不进入诊断。 */}
 return 'OtherError'
}
/** 固定阶段、合法码和有界脱敏定位信息；原始 message/stack/code/参数不进入日志。 */
export function submissionFailureDiagnostic(error:unknown):Diagnostic{
 if(error===null||typeof error!=='object')return {phase:'submission',category:'NonError',code:'teloa/execution-pending'}
 let category='OtherError',code='teloa/execution-pending'
 try{const name=Reflect.get(error,'name'),value=Reflect.get(error,'code');if(typeof name==='string'&&categories.has(name))category=name;if(typeof value==='string'&&value.length<=128&&/^teloa\/[a-z-]+$/.test(value))code=value}catch{/* 诊断读取不能改变执行异常。 */}
 const marked=failures.get(error),phase=marked?.phase??'submission'
 if(phase!=='model')return {phase,category,code}
 const location=frames(error),causes:NonNullable<Diagnostic['causes']>=[],seen=new Set<object>([error]);let current:object=error
 for(let i=0;i<3;i++){
  let cause:unknown;try{cause=Reflect.get(current,'cause')}catch{break}
  if(cause===null||typeof cause!=='object'||seen.has(cause))break
  seen.add(cause);const location=frames(cause);causes.push({category:safeCategory(cause),...location.length?{frames:location}:{}});current=cause
 }
 return {phase,category,code,...marked?.modelStage?{modelStage:marked.modelStage}:{},...location.length?{frames:location}:{},...causes.length?{causes}:{}}
}
/** 与宿主日志入口共用；调用方不能把原异常作为第二个日志参数透出。 */
export function submissionFailureLog(runId:string,error:unknown):string{
 const diagnostic=submissionFailureDiagnostic(error)
 return `Teloa 执行提交结果待核对：${runId}（${diagnostic.code}；phase=${diagnostic.phase}；category=${diagnostic.category}；diagnostic=${JSON.stringify(diagnostic)}）`
}
