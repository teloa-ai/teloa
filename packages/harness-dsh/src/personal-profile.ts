import {readFile} from 'node:fs/promises'
import {writeFileAtomic} from '@deepseek-ai/dsh-atomic-write'
import {WorkError,readPersonalDisplayProfile,usablePersonalName,type PersonalDisplayProfile} from '@teloa/contract'

export const personalProfileEndpoints=['profile/get','profile/initialize','profile/save'] as const

/** 本人浏览器的显示资料保存在原宿主；不提供模型写入口，不改变群或任务身份。 */
export function createPersonalProfileHost(path:string,ownerId:string,onReadError?:(code:string)=>void){
 let queue:Promise<unknown>=Promise.resolve()
 const read=async():Promise<PersonalDisplayProfile>=>{
  let content:string
  try{content=await readFile(path,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {displayName:''};throw new WorkError('teloa/unavailable','无法读取个人资料，请重试。')}
  let row:Record<string,unknown>
  try{row=JSON.parse(content)}catch{throw new WorkError('teloa/storage-corrupt','个人资料无法读取，请核对后重新保存。')}
  if(row&&typeof row==='object'&&'ownerId' in row&&row.ownerId!==ownerId)throw new WorkError('teloa/forbidden','个人资料不属于当前用户。')
  if(!row||typeof row!=='object'||Array.isArray(row)||row.schema!=='teloa.personal-profile/v1'||Object.keys(row).length!==3||row.ownerId!==ownerId)throw new WorkError('teloa/storage-corrupt','个人资料格式不正确。')
  try{return readPersonalDisplayProfile({displayName:row.displayName})}catch{throw new WorkError('teloa/storage-corrupt','个人资料格式不正确。')}
 }
 const handler=async(endpoint:string,payload:unknown):Promise<PersonalDisplayProfile>=>{
  if(endpoint==='profile/get'){
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length)throw new WorkError('teloa/invalid-input','读取个人资料不接受额外字段。')
   await queue;return read()
  }
  if(endpoint!=='profile/initialize'&&endpoint!=='profile/save')throw new WorkError('teloa/not-found','未提供此个人资料操作。')
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==1||!('displayName' in payload)||typeof payload.displayName!=='string')throw new WorkError('teloa/invalid-input','个人资料只接受显示名称。')
  const input=readPersonalDisplayProfile({displayName:usablePersonalName(payload.displayName)})
  if(!input.displayName)throw new WorkError('teloa/invalid-input','显示名称不能为空或使用邮箱。')
  const next=queue.then(async()=>{
   let current:PersonalDisplayProfile
   try{current=await read()}catch(error){
    // 只允许本人明确保存修复损坏的显示资料；首次迁移不覆盖，已知的他人资料始终拒绝。
    if(endpoint!=='profile/save'||!(error instanceof WorkError)||error.code!=='teloa/storage-corrupt')throw error
    current={displayName:''}
   }
   // 旧浏览器的自动迁移只能填空，不能覆盖已在其它窗口保存的姓名。
   if(endpoint==='profile/initialize'&&current.displayName)return current
   await writeFileAtomic(path,JSON.stringify({schema:'teloa.personal-profile/v1',ownerId,...input})+'\n',{mode:0o600,dirMode:0o700})
   return input
  })
  queue=next.catch(()=>{});return next
 }
 return {read,handler,async displayName(){
  try{return (await read()).displayName}catch(error){
   if(!(error instanceof WorkError))throw error
   onReadError?.(error.code)
   // 姓名只作展示；读取失败不能阻止群发言、路由或岗位工作，也不会扩大访问范围。
   return ''
  }
 }}
}
