import {WorkError} from '@teloa/contract'

export type BusinessSourceScopeSupport='enforced'|'unsupported'
export type BusinessSourceAuthority=Readonly<{
 serverName:string
 toolName?:string
 bindingId:string
 bindingKey?:string
 bindingRevision:number
 definitionHash:string
 resourceScopeHash:string
 connectionEpoch:string
 scopeSupport:BusinessSourceScopeSupport
}>
type Current=Omit<BusinessSourceAuthority,'serverName'|'toolName'>
type Ports={
 exclusive:<T>(serverName:string,run:()=>Promise<T>)=>Promise<T>
 read:(serverName:string,toolName?:string)=>Promise<Current>
}
const changed=()=>new WorkError('teloa/source-unavailable','来源连接或授权已变化，请重新核对来源后再试。',{sourceState:'changed'})
/** 与凭据/连接管理共用协调器；派发只持起点锁，落库许可持提交锁。 */
export class BusinessSourceAuthorityController{
 private readonly ports:Ports
 private readonly captured=new WeakMap<BusinessSourceAuthority,string>()
 constructor(ports:Ports){this.ports=ports}
 async capture(serverName:string,toolName?:string):Promise<BusinessSourceAuthority>{
  return this.ports.exclusive(serverName,async()=>{
   const authority=Object.freeze({...await this.ports.read(serverName,toolName),serverName,...(toolName===undefined?{}:{toolName})})
   this.captured.set(authority,JSON.stringify(authority));return authority
  })
 }
 private async verify(authority:BusinessSourceAuthority,signal?:AbortSignal){
  signal?.throwIfAborted()
  const expected=this.captured.get(authority)
  if(expected===undefined)throw changed()
  let current:Current
  try{current=await this.ports.read(authority.serverName,authority.toolName)}catch{throw changed()}
  if(JSON.stringify({...current,serverName:authority.serverName,...(authority.toolName===undefined?{}:{toolName:authority.toolName})})!==expected)throw changed()
  signal?.throwIfAborted()
 }
 async dispatch<T>(authority:BusinessSourceAuthority,start:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const parked=await this.ports.exclusive(authority.serverName,async()=>{await this.verify(authority,signal);return {pending:start()}})
  const result=await parked.pending
  await this.ports.exclusive(authority.serverName,()=>this.verify(authority,signal))
  return result
 }
 async commit<T>(authority:BusinessSourceAuthority,write:(assertCurrent:()=>Promise<void>)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  return this.ports.exclusive(authority.serverName,async()=>{const verify=()=>this.verify(authority,signal);await verify();return write(verify)})
 }
}
