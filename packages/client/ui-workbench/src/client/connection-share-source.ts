import {readMcpConnectionSetup,type McpConnectionSetup,type CustomMcpDefinition,type MarketCatalogConnectorEntry} from '@teloa/contract'
import type {ShareConnectionSource} from './share-package-plan.ts'

const unique=(names:readonly string[])=>[...new Map(names.map(name=>[name.toLowerCase(),name])).values()]
/** 运行 URL 可能在主机、路径里含私人信息；默认只保留协议，绝不猜测哪一段可公开。 */
export function customConnectionShareSource(definition:CustomMcpDefinition,tools:readonly {name:string}[]):ShareConnectionSource{
 const urlTemplate=definition.url.startsWith('http:')?'http://{host}/{path}':'https://{host}/{path}'
 return {serverName:definition.serverName,title:definition.title,tools:tools.map(tool=>tool.name),setup:readMcpConnectionSetup({urlTemplate,configurationKeys:unique(['url',...(definition.auth?.headers.map(header=>header.name)??[])])})}
}

/** 目录配方是已公开的静态声明，不从本人连接或凭据服务读取任何值。 */
export function catalogConnectionShareSetup(entry:MarketCatalogConnectorEntry):McpConnectionSetup{
 const {recipe,auth}=entry.connector
 const names=auth.kind==='secret'?auth.vars.flatMap(item=>item.target==='env'?[item.envVarName]:item.target==='header'?[item.name]:item.target==='basic'?['username','password']:item.target==='url-path'?['secret']:['Authorization']):auth.kind==='oauth'&&auth.supported&&auth.requiresUserClientId?['oauth_client_id']:[]
 const address=recipe.transport==='stdio'?undefined:recipe.transport==='streamable-http'?recipe.url:recipe.urlTemplate
 let urlTemplate=address
 if(address){try{readMcpConnectionSetup({urlTemplate:address,configurationKeys:[]})}catch{urlTemplate='https://{host}/{path}'}}
 const placeholders=urlTemplate?[...urlTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g)].map(match=>match[1]!):[]
 return readMcpConnectionSetup({...urlTemplate?{urlTemplate}:{},configurationKeys:unique([...(urlTemplate?['url']:[]),...names,...placeholders])})
}
