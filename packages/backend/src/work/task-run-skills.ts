import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {WorkError,promptFullTextMaxBytes,taskInput} from '@teloa/contract'
export type TaskRunSkillDatabase=PoolClient
export type ManagedRunSkillFile={path:string;hash:string;size:number}
export type ManagedRunSkill={installationId:string;bundleHash:string;files:ManagedRunSkillFile[]}
export type RunSkill={name:string;provider:string;source:string;description:string;content:string;sha256:string;resourceBase?:{kind:'directory';path:string}|{kind:'url';url:string}|{kind:'opaque';description:string};managed?:ManagedRunSkill}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const digest=(files:readonly Pick<ManagedRunSkillFile,'path'|'hash'>[])=>createHash('sha256').update(JSON.stringify(files.map(file=>[file.path,file.hash]))).digest('hex')
const order=(a:string,b:string)=>a<b?-1:a>b?1:0
export function readManagedRunSkill(value:unknown):ManagedRunSkill{
 const row=taskInput(value,['installationId','bundleHash','files'])
 if(!uuid(row.installationId)||!hex(row.bundleHash)||!Array.isArray(row.files)||!row.files.length||row.files.length>500)throw Error()
 const portableNames=new Set<string>();let total=0,previous:string|undefined
 const files=row.files.map(value=>{
  const file=taskInput(value,['path','hash','size'])
  if(typeof file.path!=='string'||file.path.length>500||file.path!==file.path.trim()||file.path.startsWith('/')||/[\\:?%#\u0000-\u001f\u007f]/.test(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..')||!hex(file.hash)||!Number.isSafeInteger(file.size)||(file.size as number)<0||(file.size as number)>2*1024*1024)throw Error()
  if(previous!==undefined&&order(previous,file.path)>=0)throw Error();previous=file.path
  const portable=file.path.normalize('NFC').toLowerCase();if(portableNames.has(portable))throw Error();portableNames.add(portable)
  total+=file.size as number;if(total>20*1024*1024)throw Error()
  return {path:file.path,hash:file.hash,size:file.size as number}
 })
 if(files.filter(file=>file.path.split('/').at(-1)==='SKILL.md').length!==1||!files.some(file=>file.path==='SKILL.md')||digest(files)!==row.bundleHash)throw Error()
 for(const name of portableNames){const parts=name.split('/');while(parts.length>1){parts.pop();if(portableNames.has(parts.join('/')))throw Error()}}
 return {installationId:row.installationId.toLowerCase(),bundleHash:row.bundleHash,files}
}
export function readRunSkills(value:unknown):RunSkill[]{
 try{
  if(!Array.isArray(value)||value.length>30)throw Error()
  let bytes=0
  const rows=value.map(item=>{
   const r=taskInput(item,['name','provider','source','description','content','sha256','resourceBase','managed'])
   if(typeof r.name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.name)||typeof r.provider!=='string'||!r.provider||typeof r.source!=='string'||!r.source||typeof r.description!=='string'||typeof r.content!=='string'||!r.content.trim()||typeof r.sha256!=='string'||createHash('sha256').update(r.content).digest('hex')!==r.sha256)throw Error()
   bytes+=Buffer.byteLength(r.content)
   if(bytes>promptFullTextMaxBytes)throw Error()
   if(r.resourceBase!==undefined){
    const b=taskInput(r.resourceBase,['kind','path','url','description'])
    const key=b.kind==='directory'?'path':b.kind==='url'?'url':b.kind==='opaque'?'description':null
    if(!key||typeof b[key]!=='string'||!b[key]||Object.keys(b).some(k=>k!=='kind'&&k!==key))throw Error()
   }
   const b=r.resourceBase as RunSkill['resourceBase']
   const resourceBase=b?.kind==='directory'?{kind:b.kind,path:b.path}:b?.kind==='url'?{kind:b.kind,url:b.url}:b?{kind:b.kind,description:b.description}:undefined
   if((r.provider==='teloa-market')!==(r.managed!==undefined))throw Error()
   const managed=r.managed===undefined?undefined:readManagedRunSkill(r.managed)
   return {name:r.name,provider:r.provider,source:r.source,description:r.description,content:r.content,sha256:r.sha256,...(resourceBase?{resourceBase}:{}),...(managed?{managed}:{})} as RunSkill
  })
  if(new Set(rows.map(row=>row.name)).size!==rows.length)throw Error()
  return rows
 }catch{throw new WorkError('teloa/storage-corrupt','执行技能快照不完整或摘要不一致。')}
}
