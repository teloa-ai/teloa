import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
import {connectorHeaderName,connectorHeaderScheme,isForbiddenConnectorHeader} from './market-catalog.ts'

export type CustomMcpHeader={name:string;scheme?:string}
/** 定义只有认证声明；认证值只能通过本人的专用安全入口写入。 */
export type CustomMcpDefinition={schema:'teloa.mcp-server/v1';serverName:string;title:string;transport:'streamable-http';url:string;auth?:{kind:'headers';headers:CustomMcpHeader[];requirement?:'all'|'any'}}
export function readCustomMcpDefinition(value:unknown):CustomMcpDefinition{
 const row=taskInput(value,['schema','serverName','title','transport','url','auth'])
 const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
 if(row.schema!=='teloa.mcp-server/v1'||typeof row.serverName!=='string'||!/^[A-Za-z0-9_-]{1,32}$/.test(row.serverName)||typeof row.title!=='string'||!row.title.trim()||row.title!==row.title.trim()||row.title.length>120||/[\x00-\x1f\x7f]/.test(row.title))throw bad('自定义 MCP 服务名或标题不正确。')
 if(row.transport!=='streamable-http')throw bad('自定义 MCP 当前只支持 Streamable HTTP；本入口不启动命令或安装程序。')
 if(typeof row.url!=='string'||row.url.length>2048||row.url!==row.url.trim()||/[\x00-\x20\x7f]/.test(row.url))throw bad('MCP 服务地址不正确。')
 let url:URL
 try{url=new URL(row.url)}catch{throw bad('MCP 服务地址不正确。')}
 if(url.username||url.password||url.search||url.hash)throw bad('MCP 地址不能携带账号、密码、查询参数或片段；凭据请通过本人安全认证入口管理。')
 if(url.protocol!=='http:'&&url.protocol!=='https:')throw bad('MCP 服务地址必须使用 HTTP 或 HTTPS。')
 let auth:CustomMcpDefinition['auth']
 if(row.auth!==undefined){
  const source=taskInput(row.auth,['kind','headers','requirement'])
  if(source.kind!=='headers'||!Array.isArray(source.headers)||source.headers.length<1||source.headers.length>8)throw bad('静态认证需要1至8个请求头。')
  if(source.requirement!==undefined&&source.requirement!=='all'&&source.requirement!=='any')throw bad('认证请求头须声明全部填写或任选一项。')
  const names=new Set<string>()
  const headers=source.headers.map(item=>{
   const h=taskInput(item,['name','scheme'])
   if(typeof h.name!=='string'||!connectorHeaderName.test(h.name)||isForbiddenConnectorHeader(h.name)||names.has(h.name.toLowerCase()))throw bad('认证请求头名称不合法或重复。')
   if(h.scheme!==undefined&&(typeof h.scheme!=='string'||!connectorHeaderScheme.test(h.scheme)))throw bad('认证前缀不合法。')
   names.add(h.name.toLowerCase());return {name:h.name,...h.scheme===undefined?{}:{scheme:h.scheme as string}}
  })
  auth={kind:'headers',headers,...source.requirement===undefined?{}:{requirement:source.requirement as 'all'|'any'}}
 }
 return {schema:'teloa.mcp-server/v1',serverName:row.serverName,title:row.title,transport:'streamable-http',url:url.href,...auth?{auth}:{}}
}
