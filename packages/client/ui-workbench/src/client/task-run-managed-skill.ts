import {taskInput} from '@teloa/contract'
export type ManagedRunSkillView={installationId:string;bundleHash:string;files:{path:string;hash:string;size:number}[]}
export function readManagedRunSkill(value:unknown):ManagedRunSkillView|undefined{
 if(value===undefined)return undefined
 const row=taskInput(value,['installationId','bundleHash','files']),hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
 if(typeof row.installationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.installationId)||!hash(row.bundleHash)||!Array.isArray(row.files)||row.files.length<1||row.files.length>500)throw Error('执行受管技能身份不完整。')
 const seen=new Set<string>();let previous='',total=0,entries=0
 const files=row.files.map(value=>{
  const file=taskInput(value,['path','hash','size'])
  if(typeof file.path!=='string'||!file.path||file.path!==file.path.trim()||file.path.length>500||file.path<=previous||file.path.startsWith('/')||/[\\:?%#\u0000-\u001f\u007f]/.test(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..')||!hash(file.hash)||!Number.isSafeInteger(file.size)||Number(file.size)<0||Number(file.size)>2*1024*1024)throw Error('执行受管技能文件清单不正确。')
  const key=file.path.normalize('NFC').toLowerCase()
  if(seen.has(key)||[...seen].some(path=>key.startsWith(path+'/')||path.startsWith(key+'/')))throw Error('执行受管技能文件路径冲突。')
  seen.add(key);previous=file.path;total+=Number(file.size)
  if(file.path.split('/').at(-1)==='SKILL.md')entries++
  return {path:file.path,hash:file.hash as string,size:file.size as number}
 })
 if(total>20*1024*1024||entries!==1||!files.some(file=>file.path==='SKILL.md'))throw Error('执行受管技能文件清单不完整。')
 return {installationId:row.installationId,bundleHash:row.bundleHash as string,files}
}
