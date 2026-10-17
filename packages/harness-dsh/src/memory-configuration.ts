import {readFileSync,statSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import {WorkError} from '@teloa/contract'
import type {HindsightMemoryOptions} from '@teloa/backend'

/** 调用方只传启动快照的 process 层，不从工作区 .env 解析授权。 */
export function readMemoryConfiguration(env:Readonly<Record<string,string|undefined>>):HindsightMemoryOptions|null{
 if(!env.TELOA_MEMORY_API_URL)return null
 try{
  const timeout=env.TELOA_MEMORY_TIMEOUT_MS===undefined?4000:Number(env.TELOA_MEMORY_TIMEOUT_MS)
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>60000||env.TELOA_MEMORY_ALLOW_HTTP!==undefined&&!['0','1'].includes(env.TELOA_MEMORY_ALLOW_HTTP))throw Error()
  let token=env.TELOA_MEMORY_API_TOKEN
  const file=env.TELOA_MEMORY_API_TOKEN_FILE
  if(file){if(token||!isAbsolute(file)||!statSync(file).isFile()||statSync(file).size>8192)throw Error();token=readFileSync(file,'utf8').trim();if(!token)throw Error()}
  return {endpoint:env.TELOA_MEMORY_API_URL,timeoutMs:timeout,allowHttp:env.TELOA_MEMORY_ALLOW_HTTP==='1',...(token?{token}:{})}
 }catch{throw new WorkError('teloa/invalid-input','经验记忆服务配置无法读取，请核对宿主启动配置。')}
}
