/**
 * IM 账号绑定与群绑定存储（规格 §5.1）：`<dir>/im-bindings.json`、`<dir>/im-groups.json`，目录 0o700、文件 0o600。
 * 只存身份映射、会话指向与配对时的私聊 chatId（出站据此重建回复路由；旧记录缺该字段照常读），不含凭据与配对码。主键 (channelId,imUserId)；群主键 (channelId,chatId)，一个 Teloa 群只绑一个 IM 群。
 */
import {join} from 'node:path'
import {WorkError,type ImDefaultTarget} from '@teloa/contract'
import {createJsonStore} from './store.ts'

export type ImBinding={channelId:string;imUserId:string;ownerId:string;displayName:string;boundAt:string;target:ImDefaultTarget;chatId?:string;assistantSessionId?:string;roleSessionIds?:Record<string,string>}
export type ImGroupBinding={channelId:string;chatId:string;groupId:string;boundAt:string}

/** 绑定当前对话对象的会话：助理取 assistantSessionId，同事取该同事在 roleSessionIds 里的会话。 */
export const currentSessionId=(binding:ImBinding):string|undefined=>binding.target.kind==='assistant'?binding.assistantSessionId:binding.roleSessionIds?.[binding.target.roleId]

const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const isString=(value:unknown):value is string=>typeof value==='string'
const invalid=():never=>{throw new Error('bad shape')}

function parseTarget(value:unknown):ImDefaultTarget{
 if(isRecord(value)&&value.kind==='assistant')return {kind:'assistant'}
 if(isRecord(value)&&value.kind==='role'&&isString(value.roleId))return {kind:'role',roleId:value.roleId}
 return invalid()
}

function parseBinding(value:unknown):ImBinding{
 if(!isRecord(value)||![value.channelId,value.imUserId,value.ownerId,value.displayName,value.boundAt].every(isString))return invalid()
 const row:ImBinding={channelId:value.channelId as string,imUserId:value.imUserId as string,ownerId:value.ownerId as string,displayName:value.displayName as string,boundAt:value.boundAt as string,target:parseTarget(value.target)}
 if(value.chatId!==undefined)row.chatId=isString(value.chatId)?value.chatId:invalid()
 if(value.assistantSessionId!==undefined)row.assistantSessionId=isString(value.assistantSessionId)?value.assistantSessionId:invalid()
 if(value.roleSessionIds!==undefined){
  if(!isRecord(value.roleSessionIds)||!Object.values(value.roleSessionIds).every(isString))return invalid()
  row.roleSessionIds={...value.roleSessionIds as Record<string,string>}
 }
 return row
}

function parseGroup(value:unknown):ImGroupBinding{
 if(!isRecord(value)||![value.channelId,value.chatId,value.groupId,value.boundAt].every(isString))return invalid()
 return {channelId:value.channelId as string,chatId:value.chatId as string,groupId:value.groupId as string,boundAt:value.boundAt as string}
}

const parseBindings=(value:unknown):{bindings:ImBinding[]}=>isRecord(value)&&Array.isArray(value.bindings)?{bindings:value.bindings.map(parseBinding)}:invalid()
const parseGroups=(value:unknown):{groups:ImGroupBinding[]}=>isRecord(value)&&Array.isArray(value.groups)?{groups:value.groups.map(parseGroup)}:invalid()

export function createBindingStore(dir:string,limits:{perChannel:number},now:()=>Date=()=>new Date()){
 const bindingFile=createJsonStore(join(dir,'im-bindings.json'),parseBindings,{bindings:[]})
 const groupFile=createJsonStore(join(dir,'im-groups.json'),parseGroups,{groups:[]})
 const readBindings=async()=>(await bindingFile.read()).bindings
 const writeBindings=(fn:(rows:ImBinding[])=>ImBinding[])=>bindingFile.update(cur=>({bindings:fn(cur.bindings)}))
 const readGroups=async()=>(await groupFile.read()).groups
 const writeGroups=(fn:(rows:ImGroupBinding[])=>ImGroupBinding[])=>groupFile.update(cur=>({groups:fn(cur.groups)}))
 return {
  async list(channelId?:string):Promise<ImBinding[]>{
   const rows=await readBindings()
   return channelId===undefined?rows:rows.filter(row=>row.channelId===channelId)
  },
  async find(channelId:string,imUserId:string):Promise<ImBinding|undefined>{
   return (await readBindings()).find(row=>row.channelId===channelId&&row.imUserId===imUserId)
  },
  async bind(input:Omit<ImBinding,'ownerId'|'boundAt'|'target'>&{ownerId:string}):Promise<ImBinding>{
   const row:ImBinding={...input,boundAt:now().toISOString(),target:{kind:'assistant'}}
   await writeBindings(rows=>{
    if(rows.some(b=>b.channelId===row.channelId&&b.imUserId===row.imUserId))throw new WorkError('teloa/conflict','该 IM 账号已绑定。')
    if(rows.filter(b=>b.channelId===row.channelId).length>=limits.perChannel)throw new WorkError('teloa/forbidden','该渠道绑定人数已达上限，请先解绑。')
    return [...rows,row]
   })
   return row
  },
  async remove(channelId:string,imUserId:string):Promise<void>{
   await writeBindings(rows=>{
    const next=rows.filter(b=>!(b.channelId===channelId&&b.imUserId===imUserId))
    if(next.length===rows.length)throw new WorkError('teloa/not-found','没有找到该绑定。')
    return next
   })
  },
  async change(channelId:string,imUserId:string,patch:Partial<Pick<ImBinding,'target'|'assistantSessionId'|'roleSessionIds'>>):Promise<ImBinding>{
   let changed:ImBinding|undefined
   await writeBindings(rows=>rows.map(b=>{
    if(b.channelId!==channelId||b.imUserId!==imUserId)return b
    changed={...b,...patch}
    return changed
   }))
   if(!changed)throw new WorkError('teloa/not-found','没有找到该绑定。')
   return changed
  },
  groups:{
   async list(channelId?:string):Promise<ImGroupBinding[]>{
    const rows=await readGroups()
    return channelId===undefined?rows:rows.filter(row=>row.channelId===channelId)
   },
   async bind(input:Omit<ImGroupBinding,'boundAt'>):Promise<ImGroupBinding>{
    const row:ImGroupBinding={...input,boundAt:now().toISOString()}
    await writeGroups(rows=>{
     if(rows.some(g=>(g.channelId===row.channelId&&g.chatId===row.chatId)||g.groupId===row.groupId))throw new WorkError('teloa/conflict','该群或该 IM 群聊已有绑定。')
     return [...rows,row]
    })
    return row
   },
   async unbind(channelId:string,chatId:string):Promise<void>{
    await writeGroups(rows=>{
     const next=rows.filter(g=>!(g.channelId===channelId&&g.chatId===chatId))
     if(next.length===rows.length)throw new WorkError('teloa/not-found','没有找到该群绑定。')
     return next
    })
   },
   async byChat(channelId:string,chatId:string):Promise<ImGroupBinding|undefined>{
    return (await readGroups()).find(g=>g.channelId===channelId&&g.chatId===chatId)
   },
  },
 }
}
