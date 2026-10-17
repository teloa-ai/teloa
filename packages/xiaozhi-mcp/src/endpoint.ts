import {WorkError} from '@teloa/contract'
/** 官方接入点规则归插件；错误不带秘密，完整 URL 只交凭据服务和出站连接。 */
export function readXiaozhiEndpoint(value:unknown):string{
 const bad=()=>new WorkError('teloa/invalid-input','请填写官方小智的有效 MCP 接入点。')
 if(typeof value!=='string'||value.length>4096||value!==value.trim()||/[\s\x00-\x1f\x7f]/.test(value))throw bad()
 try{
  const url=new URL(value)
  if(url.protocol!=='wss:'||url.hostname!=='api.xiaozhi.me'||url.port&&url.port!=='443'||url.username||url.password||url.hash||!/^\/mcp\/(?:[A-Za-z0-9_-]+)?\/?$/.test(url.pathname))throw bad()
 }catch{throw bad()}
 return value
}
