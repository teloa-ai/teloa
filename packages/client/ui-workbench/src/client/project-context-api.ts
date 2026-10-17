import {WorkError,projectContextMutation,projectUuid,readProjectContext,readProjectContextReceipt,type ProjectContextChange,type ProjectContextMutation} from '@teloa/contract'
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
export type ProjectContextDraft={expectedVersion:number;change:Extract<ProjectContextChange,{kind:'save-brief'|'save-entry'}>}
function validateDraft(projectId:string,d:ProjectContextDraft){
 const c=d?.change
 if(!Number.isSafeInteger(d?.expectedVersion)||d.expectedVersion<0||!c||!['save-brief','save-entry'].includes(c.kind))throw new WorkError('teloa/invalid-input','项目上下文草稿格式不正确。')
 // 草稿允许空白，但持久化与恢复必须遵循同一校验，避免本人输入损坏恢复记录。
 if(c.kind==='save-entry'&&(typeof c.topic!=='string'||typeof c.markdown!=='string'||c.topic.length>120||c.markdown.length>16000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c.topic+c.markdown)))throw new WorkError('teloa/invalid-input','项目上下文草稿包含不支持的字符或格式。')
 projectContextMutation({projectId,requestId:projectId,expectedVersion:d.expectedVersion,change:c.kind==='save-brief'?c:{...c,topic:c.topic.trim()||'draft',markdown:c.markdown.trim()||'draft'}})
}
export function createProjectContextApi(call:(endpoint:string,input:unknown)=>Promise<unknown>,journal?:Journal){
 let pending=new Map<string,ProjectContextMutation>(),drafts=new Map<string,ProjectContextDraft>(),recoveryError:unknown
 const busy=new Set<string>()
 const persist=()=>{if(!pending.size&&!drafts.size)journal?.clear();else journal?.write(JSON.stringify({pending:[...pending.values()],drafts:[...drafts.entries()]}))}
 const sync=()=>{
  if(!journal)return
  try{
   const raw=journal.read(),value=raw?JSON.parse(raw):{pending:[],drafts:[]},nextPending=new Map<string,ProjectContextMutation>(),nextDrafts=new Map<string,ProjectContextDraft>()
   if(!value||!Array.isArray(value.pending)||!Array.isArray(value.drafts)||value.pending.length>100||value.drafts.length>100)throw Error()
   for(const item of value.pending){const request=projectContextMutation(item);if(nextPending.has(request.projectId))throw Error();nextPending.set(request.projectId,request)}
   // 未完成草稿允许空白，但限制字段、类型、长度和控制字符；保存才要求正文非空。
   for(const pair of value.drafts){
    if(!Array.isArray(pair)||pair.length!==2||!projectUuid(pair[0])||nextDrafts.has(pair[0]))throw Error()
    const d=pair[1];validateDraft(pair[0],d)
    nextDrafts.set(pair[0],d)
   }
   pending=nextPending;drafts=nextDrafts;recoveryError=undefined
  }catch(error){recoveryError=error}
 }
 const update=(change:()=>void)=>{sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','上下文恢复记录不可读。');change();persist()}
 const sameDraft=(draft:ProjectContextDraft|undefined,request:ProjectContextMutation)=>{
  if(!draft)return false
  try{return JSON.stringify(projectContextMutation({...draft,projectId:request.projectId,requestId:request.requestId}))===JSON.stringify(request)}catch{return false}
 }
 const run=async(request:ProjectContextMutation)=>{
  if(busy.has(request.projectId))throw new WorkError('teloa/conflict','上下文操作仍在处理中。')
  busy.add(request.projectId)
  try{
   const result=readProjectContextReceipt(await call('project-context/mutate',request))
   if(result.projectId!==request.projectId||result.requestId!==request.requestId||result.version!==request.expectedVersion+1)throw new WorkError('teloa/invalid-host-response','上下文回执与请求不一致。')
   update(()=>{
    if(pending.get(request.projectId)?.requestId===request.requestId)pending.delete(request.projectId)
    // 旧回执只能清理原草稿，不吞掉断线后本人继续编辑的新内容。
    if(sameDraft(drafts.get(request.projectId),request))drafts.delete(request.projectId)
   })
   return result
  }catch(error){
   if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/not-found','teloa/conflict','teloa/version-conflict'].includes(String(error.code)))update(()=>{if(pending.get(request.projectId)?.requestId===request.requestId)pending.delete(request.projectId)})
   throw error
  }finally{busy.delete(request.projectId)}
 }
 sync()
 return {
  recoveryError:()=>{sync();return recoveryError},
  pending:(projectId:string)=>{sync();return pending.has(projectId)},
  draft:(projectId:string)=>{sync();const value=drafts.get(projectId);return value?structuredClone(value):undefined},
  setDraft(projectId:string,draft:ProjectContextDraft|undefined){if(draft)validateDraft(projectId,draft);update(()=>{if(draft)drafts.set(projectId,structuredClone(draft));else drafts.delete(projectId)})},
  async get(projectId:string){const result=readProjectContext(await call('project-context/get',{projectId}));if(result.projectId!==projectId)throw new WorkError('teloa/invalid-host-response','项目身份不一致。');return result},
  async mutate(projectId:string,expectedVersion:number,change:ProjectContextChange){
   sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','上下文恢复记录不可读。')
   const saved=pending.get(projectId),request=projectContextMutation({projectId,expectedVersion,change,requestId:saved?.requestId??crypto.randomUUID()})
   if(saved&&JSON.stringify(saved)!==JSON.stringify(request))throw new WorkError('teloa/conflict','请先核对此项目上次操作的结果。')
   update(()=>pending.set(projectId,request));return run(request)
  },
  async recover(projectId:string){sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','上下文恢复记录不可读。');const request=pending.get(projectId);if(!request)throw new WorkError('teloa/not-found','没有待恢复的操作。');return run(request)},
  discard(projectId:string){update(()=>pending.delete(projectId))},
  resetRecovery(){journal?.clear();pending.clear();drafts.clear();recoveryError=undefined},
 }
}
