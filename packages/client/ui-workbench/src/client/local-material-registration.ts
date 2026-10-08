import {isSourceReference,resourceId,resourceScopes,resourceTitle,taskInput,type ResourceDraft,type ResourceSpec,type SourceReference} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'
export type LocalMaterialRegistrationInput={requestId:string;title:string;path:string;scopeIds:string[]}
type Fields=Omit<LocalMaterialRegistrationInput,'requestId'>
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type Ports={registerLocalMaterial?:(input:LocalMaterialRegistrationInput)=>Promise<SourceReference>;create:(input:ResourceSpec&{requestId:string})=>Promise<ResourceDraft>}
type Command=LocalMaterialRegistrationInput&{draftRequestId:string;source?:SourceReference}
export const isLocalMaterialSourceId=(id:string)=>id.startsWith('local_material_')&&resourceId(id.slice('local_material_'.length))
export function readLocalMaterialInput(value:unknown):LocalMaterialRegistrationInput{
 const row=taskInput(value,['requestId','title','path','scopeIds'])
 if(!resourceId(row.requestId)||!resourceTitle(row.title)||row.title!==row.title.trim()||!resourceScopes(row.scopeIds)||typeof row.path!=='string'||!row.path||row.path!==row.path.trim()||row.path.length>4096||row.path.startsWith('/')||row.path.includes('\\')||row.path.includes('\0')||/^[a-z]:/i.test(row.path)||row.path.split('/').some(part=>!part||part==='.'||part==='..')||!(/\.(md|markdown)$/i.test(row.path)))throw Error('本机文件登记输入格式不正确。')
 return row as LocalMaterialRegistrationInput
}
export function isLocalMaterialReference(value:unknown,input:LocalMaterialRegistrationInput):value is SourceReference{
 return isSourceReference(value)&&isLocalMaterialSourceId(value.id)&&value.knowledge===undefined&&value.title===input.title&&value.source===input.path
}
function readCommand(value:unknown):Command{
 const row=taskInput(value,['requestId','draftRequestId','title','path','scopeIds','source']),{draftRequestId,source,...fields}=row,input=readLocalMaterialInput(fields)
 if(!resourceId(draftRequestId)||draftRequestId===input.requestId||source!==undefined&&!isLocalMaterialReference(source,input))throw Error('本机文件恢复记录格式不正确。')
 return {...input,draftRequestId,...(source===undefined?{}:{source:source as SourceReference})}
}
/** 登记和资料草稿是两个既有回执；未知重试始终沿用原身份、原文件与登记时版本。 */
export function createLocalMaterialRegistration(api:Ports,journal?:Journal,newId:()=>string=()=>crypto.randomUUID()){
 let pending:Command|undefined,error:Error|undefined,busy=false
 try{const raw=journal?.read();if(raw){const value=taskInput(JSON.parse(raw),['schema','request']);if(value.schema!=='teloa.local-material-command/v1')throw Error();pending=readCommand(value.request)}}catch{error=recoveryStorageError()}
 const persist=()=>journal?.write(JSON.stringify({schema:'teloa.local-material-command/v1',request:pending})),clear=()=>{journal?.clear();pending=undefined}
 const send=async()=>{
  if(error)throw error;if(!pending||busy||!api.registerLocalMaterial)throw Error('请先核对原本机文件登记请求。')
  busy=true
  try{
   persist();const command=pending
   if(!command.source){const {draftRequestId:_,source:__,...request}=command,source=await api.registerLocalMaterial(request);if(!isLocalMaterialReference(source,request))throw Error('本机来源回执格式不正确。');command.source=source;persist()}
   const source=command.source!,draft=await api.create({requestId:command.draftRequestId,title:command.title,sourceId:source.id,sourceVersion:source.version,scopeIds:command.scopeIds})
   if(draft.requestId!==command.draftRequestId||draft.title!==command.title||draft.sourceId!==source.id||draft.sourceVersion!==source.version||JSON.stringify(draft.scopeIds)!==JSON.stringify(command.scopeIds))throw Error('本机文件草稿回执与原请求不一致。')
   clear();return draft
  }catch(cause){if(cause&&typeof cause==='object'&&'rejected'in cause&&cause.rejected===true)clear();throw cause}finally{busy=false}
 }
 return {pending:()=>pending?structuredClone(pending):undefined,recoveryMessage:()=>error,recover:send,discard(){clear();error=undefined},begin(fields:Fields){if(pending||error)throw Error('请先核对原本机文件登记请求。');pending=readCommand({...fields,requestId:newId(),draftRequestId:newId()});return send()}}
}
export type LocalMaterialRegistration=ReturnType<typeof createLocalMaterialRegistration>
