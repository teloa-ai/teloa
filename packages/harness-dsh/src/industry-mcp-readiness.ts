import {mcpToolFullName} from '@teloa/contract'
import type {IndustryMcpConnectionReadiness} from '@teloa/backend'

/** 只观察 DSH 全局工具注册表里的完整工具名，不猜测服务器、不发起调用。 */
export function createIndustryMcpReadiness(observe:()=>readonly {name:string}[],now:()=>string):IndustryMcpConnectionReadiness{
 return {async ready(definition,signal){
  signal.throwIfAborted()
  const names=new Set(observe().map(tool=>tool.name)),missing=definition.tools.map(tool=>mcpToolFullName(definition.serverName,tool)).filter(name=>!names.has(name))
  if(missing.length)return {ready:false,reason:'缺少工具：'+missing.join('、')}
  return {ready:true,observedAt:now()}
 }}
}
