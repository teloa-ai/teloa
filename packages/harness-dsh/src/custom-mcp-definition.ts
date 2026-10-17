import {createHash} from 'node:crypto'
import {WorkError,taskInput,pageCreateCanonicalBody} from '@teloa/contract'

/** 无凭据的自定义服务定义。认证参数不进入会话、连接回包或配置文件。 */
export type CustomMcpDefinition={schema:'teloa.mcp-server/v1';serverName:string;title:string;transport:'streamable-http';url:string}
export function readCustomMcpDefinition(value:unknown):CustomMcpDefinition{
 const row=taskInput(value,['schema','serverName','title','transport','url'])
 const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
 if(row.schema!=='teloa.mcp-server/v1'||typeof row.serverName!=='string'||!/^[A-Za-z0-9_-]{1,32}$/.test(row.serverName)||typeof row.title!=='string'||!row.title.trim()||row.title!==row.title.trim()||row.title.length>120||/[\x00-\x1f\x7f]/.test(row.title))throw bad('自定义 MCP 服务名或标题不正确。')
 if(row.transport!=='streamable-http')throw bad('自定义 MCP 当前只支持 Streamable HTTP；本入口不启动命令或安装程序。')
 if(typeof row.url!=='string'||row.url.length>2048||row.url!==row.url.trim()||/[\x00-\x20\x7f]/.test(row.url))throw bad('MCP 服务地址不正确。')
 let url:URL
 try{url=new URL(row.url)}catch{throw bad('MCP 服务地址不正确。')}
 if(url.username||url.password||url.search||url.hash)throw bad('MCP 地址不能携带账号、密码、查询参数或片段；凭据请通过本人安全认证入口管理。')
 const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname)
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw bad('远程 MCP 地址必须使用 HTTPS；本机回环地址可以使用 HTTP。')
 return {schema:'teloa.mcp-server/v1',serverName:row.serverName,title:row.title,transport:'streamable-http',url:url.href}
}
export function customMcpDefinitionHash(value:CustomMcpDefinition):string{return createHash('sha256').update(pageCreateCanonicalBody(value)).digest('hex')}
