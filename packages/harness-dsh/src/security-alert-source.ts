import {lstat,readFile} from 'node:fs/promises'
import {WorkError,isRecord} from '@teloa/contract'
import type {BusinessDataQuery,BusinessDataSourcePort} from '@teloa/backend'

type SecurityAlertSourceConfig={url:string;bearerToken?:string}
const maxBytes=2*1024*1024

/**
 * 配置文件存在却读不了（JSON 损坏、格式不正确、权限过宽、读取出错、不是普通文件）：带 `sourceState:'config-unreadable'`，
 * 映射预览据此说「配置文件无法读取」，而不是「没接上」或「调用失败」。只有配置文件不存在才是 `disconnected`（待配置凭据）。
 */
const unreadable=(message:string)=>new WorkError('teloa/source-unavailable',message,{sourceState:'config-unreadable'})
const unreadableFile='安全告警来源配置文件无法读取，请检查配置文件。'

function configuration(value:unknown):SecurityAlertSourceConfig{
 if(!isRecord(value)||Object.keys(value).some(key=>!['url','bearerToken'].includes(key))||typeof value.url!=='string'||value.url.length>2048||(value.bearerToken!==undefined&&(typeof value.bearerToken!=='string'||!value.bearerToken||value.bearerToken.length>8192)))throw unreadable('安全告警来源配置格式不正确。')
 let url:URL
 try{url=new URL(value.url)}catch{throw unreadable('安全告警来源地址不正确。')}
 const local=['127.0.0.1','localhost','::1'].includes(url.hostname)
 if(url.username||url.password||url.hash||url.search||url.protocol!=='https:'&&!local||local&&!['http:','https:'].includes(url.protocol))throw unreadable('安全告警来源必须使用 HTTPS，或指向本机 HTTP 测试服务。')
 return {url:url.toString(),...(value.bearerToken===undefined?{}:{bearerToken:value.bearerToken})}
}

export class SecurityAlertHttpSource implements BusinessDataSourcePort{
 readonly id='security-alert-http'
 readonly scopes=['SOC'] as const
 private readonly configPath:string
 private readonly request:typeof fetch
 constructor(configPath:string,request:typeof fetch=fetch){this.configPath=configPath;this.request=request}
 private async config():Promise<SecurityAlertSourceConfig>{
  let entry
  // 配置文件不存在是来源没接上（待配置凭据），带 sourceState:'disconnected'，映射预览据此说「接上并配置好凭据后再预览」。
  try{entry=await lstat(this.configPath)}
  catch(error){if((error as {code?:unknown}).code==='ENOENT')throw new WorkError('teloa/source-unavailable','安全告警来源尚未配置。',{sourceState:'disconnected'});throw unreadable(unreadableFile)}
  if(entry.isSymbolicLink()||!entry.isFile())throw unreadable(unreadableFile)
  if((entry.mode&0o077)!==0)throw unreadable('安全告警来源配置文件权限过宽，已停止读取。')
  let value:unknown
  try{value=JSON.parse(await readFile(this.configPath,'utf8'))}catch{throw unreadable(unreadableFile)}
  return configuration(value)
 }
 async query(input:BusinessDataQuery,signal?:AbortSignal):Promise<unknown>{
  signal?.throwIfAborted()
  const config=await this.config(),url=new URL(config.url)
  url.searchParams.set('scope',input.scope);url.searchParams.set('limit',String(input.limit))
  if(input.text!==undefined)url.searchParams.set('text',input.text)
  if(input.source!==undefined)url.searchParams.set('source',input.source)
  if(input.quality!==undefined)url.searchParams.set('quality',input.quality)
  if(input.observedAfter!==undefined)url.searchParams.set('observedAfter',input.observedAfter)
  if(input.cursor!==undefined)url.searchParams.set('cursor',input.cursor)
  let response:Response
  try{response=await this.request(url,{method:'GET',headers:{accept:'application/json',...(config.bearerToken?{authorization:'Bearer '+config.bearerToken}:{})},redirect:'error',...(signal?{signal}:{})})}catch(error){if(signal?.aborted)throw error;throw new WorkError('teloa/source-unavailable','安全告警来源请求失败。')}
  if(!response.ok)throw new WorkError('teloa/source-unavailable','安全告警来源未返回成功状态。')
  const declared=Number(response.headers.get('content-length'))
  if(Number.isFinite(declared)&&declared>maxBytes)throw new WorkError('teloa/source-invalid','安全告警来源回包超过大小限制。')
  if(!response.body)throw new WorkError('teloa/source-invalid','安全告警来源没有返回响应正文。')
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
  while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maxBytes){await reader.cancel();throw new WorkError('teloa/source-invalid','安全告警来源回包超过大小限制。')}chunks.push(chunk.value)}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes))}catch{throw new WorkError('teloa/source-invalid','安全告警来源没有返回合法 UTF-8 JSON。')}
 }
 /** 就绪核验：配置可读且一次 limit=1 的有界探测成功；不缓存，不写入。 */
 async ready(scope:string,signal:AbortSignal):Promise<{ready:true;probedAt:string}|{ready:false;reason:string}>{
  signal.throwIfAborted()
  try{await this.config()}catch(error){return {ready:false,reason:error instanceof WorkError?error.message:'安全告警来源配置不可读取。'}}
  try{await this.query({scope,limit:1},signal);return {ready:true,probedAt:new Date().toISOString()}}
  catch(error){if(signal.aborted)throw error;return {ready:false,reason:error instanceof WorkError?error.message:'安全告警来源探测失败。'}}
 }
}

export {configuration as readSecurityAlertSourceConfig}
