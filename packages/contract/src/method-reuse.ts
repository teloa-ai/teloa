import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {artifactContent,savedArtifactSource,type SavedArtifactVersion} from './artifacts.ts'
import {industryUpdateCanonical} from './industry-update-compare.ts'

export type MethodReuseSource={artifactId:string;version:number;basisHash:string;taskId?:string}
export type MethodReuseAcceptedSource={sessionId:string;messageId:string;messageSeq:number;requestId:string}
export type MethodReuseTarget='skill'|'plan'
export type MethodReuseIntent='save-paused'|'create-and-enable'
const bad=()=>new WorkError('teloa/invalid-input','方法复用的来源、版本或本人消息身份不正确。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const identity=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value&&value===value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)
const object=(value:unknown,required:readonly string[],optional:readonly string[]=[])=>{
 if(!isRecord(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))throw bad()
 return value
}
export function readMethodReuseSource(value:unknown):MethodReuseSource{
 const row=object(value,['artifactId','version','basisHash'],['taskId'])
 if(!uuid(row.artifactId)||!Number.isSafeInteger(row.version)||Number(row.version)<1||typeof row.basisHash!=='string'||!/^[a-f0-9]{64}$/.test(row.basisHash)||Object.hasOwn(row,'taskId')&&!uuid(row.taskId))throw bad()
 return {artifactId:row.artifactId,version:Number(row.version),basisHash:row.basisHash,...row.taskId===undefined?{}:{taskId:row.taskId as string}}
}
export function readMethodReuseAcceptedSource(value:unknown):MethodReuseAcceptedSource{
 const row=object(value,['sessionId','messageId','messageSeq','requestId'])
 if(!identity(row.sessionId,128)||!/^[-\w]+$/.test(row.sessionId)||!identity(row.messageId,256)||!Number.isSafeInteger(row.messageSeq)||Number(row.messageSeq)<0||!uuid(row.requestId))throw bad()
 return {sessionId:row.sessionId,messageId:row.messageId,messageSeq:Number(row.messageSeq),requestId:row.requestId}
}
function methodTextLines(text:string,stripQuotes=false):string[]{
 const action=/(?:保存|儲存|储存|存为|存為|沉淀|沉澱|制作|製作|创建|創建|建立|转为|轉為)|\b(?:save|preserve|turn|convert|create|make)\b/iu
 const quotes=/“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"\n]*)"/g
 let fence:string|undefined
 const lines:string[]=[]
 for(const raw of text.split(/\r?\n/)){
  const mark=/^\s*(`{3,}|~{3,})/.exec(raw)?.[1]
  if(mark){if(!fence)fence=mark[0];else if(mark[0]===fence)fence=undefined;continue}
  if(fence||/^(?: {4}|\t)|^\s*[>#]/.test(raw))continue
  const line=raw.replace(/`[^`]*`/g,'').replace(quotes,(_all,...parts:string[])=>{const content=parts.slice(0,4).find(item=>typeof item==='string')??'';return stripQuotes||action.test(content)?'':content}).replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s*)/,'').trim()
  if(line)lines.push(line)
 }
 return lines
}
export function methodReuseReference(value:Pick<MethodReuseSource,'artifactId'|'version'>):string{
 if(!uuid(value.artifactId)||!Number.isSafeInteger(value.version)||value.version<1)throw bad()
 return '[teloa-method-source:'+value.artifactId.toLowerCase()+':v'+value.version+']'
}
/** 引用只定位成果；不代替原本人消息及明确保存意图。 */
export function readMethodReuseReference(text:unknown):Pick<MethodReuseSource,'artifactId'|'version'>|null{
 if(typeof text!=='string'||text.length>16000)return null
 const matches=[...methodTextLines(text,true).join('\n').matchAll(/\[teloa-method-source:([a-f0-9-]{36}):v([1-9][0-9]*)\]/gi)]
 if(matches.length!==1||!uuid(matches[0]?.[1]))return null
 const version=Number(matches[0]![2]);if(!Number.isSafeInteger(version))return null
 return {artifactId:matches[0]![1]!.toLowerCase(),version}
}
/** 只认原本人正文中的明确命令；含糊、提问、否定保存或引用均交回原会话补充，不从模型结论推授权。 */
export function readMethodReuseIntent(text:unknown,target:MethodReuseTarget):MethodReuseIntent|null{
 if(typeof text!=='string'||!text.trim()||text.length>16000||!['skill','plan'].includes(target))return null
 const lines=methodTextLines(text)
 const action=/(?:保存|儲存|储存|存为|存為|沉淀|沉澱|制作|製作|创建|創建|建立|转为|轉為)|\b(?:save|preserve|turn|convert|create|make)\b/iu
 const wanted=target==='skill'?/(?:方法|技能|\b(?:skill|method)s?\b)/iu:/(?:计划|計劃|計畫|\bplans?\b)/iu
 const reference=/(?:这份|這份|该份|該份|这次|這次|上述|当前|當前|此|这|這).{0,8}(?:成果|结果|結果|交付|报告|報告|方案)|\b(?:this|the)\s+(?:result|artifact|deliverable|report|outcome)\b/iu
 const command=/^(?:请|請)?\s*(?:将|將|把|按|保存|儲存|储存|存为|存為|整理|沉淀|沉澱|制作|製作|建立|创建|創建|轉為|转为)|^(?:please\s+)?(?:save|preserve|turn|convert|create|make)\b/iu
 const denySave=/^(?:(?:请|請|先|暂时|暫時)\s*)?(?:不要|不必|不需|不能|别|別|不想|不应|不應|不).{0,14}(?:保存|儲存|储存|存为|存為|沉淀|沉澱|制作|製作|建立|创建|創建|轉為|转为)|^(?:please\s+)?(?:do\s+not|don't|never|avoid)\s+(?:save|create|make|preserve|convert|turn)\b/iu
 const denyEnable=/^(?:(?:请|請|先)\s*)?(?:不|勿|别|別|不要|暂不|暫不|无需|無需).{0,5}(?:启用|啟用|启动|啟動)|^(?:do\s+not|don't|not|never|without)\s+(?:enable|enabling|start|starting|activate|activating)\b/iu
 const enable=/(?:并|並|且|同时|同時).{0,4}(?:启用|啟用)|\b(?:and\s+(?:immediately\s+)?(?:enable|activate)|enable\s+it|activate\s+it)\b/iu
 let saved=false,enabled=false,disabled=false
 for(const line of lines)for(const sentence of line.split(/[。；;.!！]/u)){
  const clauses=sentence.trim().split(/[,，]/u).map(part=>part.trim()).filter(Boolean),first=clauses[0]??''
  if(denySave.test(first)||command.test(first)&&/(?:不|不要|勿|别|別|暂不|暫不).{0,6}(?:保存|儲存|储存|存为|存為|创建|創建)|\b(?:do\s+not|don't|never)\s+(?:save|create)\b/iu.test(first))return null
  if(denyEnable.test(first)){disabled=true;continue}
  if(!command.test(first)||!reference.test(first)||!wanted.test(first)||!action.test(first)||/[?？]/.test(first))continue
  saved=true
  if(/(?:不要|不|勿|别|別|暂不|暫不).{0,5}(?:启用|啟用|启动|啟動)|\b(?:do\s+not|don't|not|never|without)\s+(?:enable|enabling|activate|activating)\b/iu.test(first))disabled=true
  if(enable.test(first))enabled=true
  for(const clause of clauses.slice(1)){
   const directive=clause.replace(/^(?:并|並|且|同时|同時|and\b)\s*/iu,'')
   if(denySave.test(directive))return null
   if(denyEnable.test(directive))disabled=true
   else if(/^(?:并|並|且|同时|同時|and\b|enable\b|activate\b)/iu.test(clause)&&enable.test(clause))enabled=true
  }
 }
 if(!saved)return null
 return enabled&&!disabled?target==='plan'?'create-and-enable':null:'save-paused'
}
/** 成果稳定快照的唯一摘要口径，不含捕获时间、界面称呼或请求身份。 */
export function methodReuseBasisText(value:Pick<SavedArtifactVersion,'source'|'content'>):string{return industryUpdateCanonical({source:savedArtifactSource(value.source),content:artifactContent(value.content)})}
export async function methodReuseBasisHash(value:Pick<SavedArtifactVersion,'source'|'content'>):Promise<string>{
 const basis=methodReuseBasisText(value)
 const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(basis))
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
}
