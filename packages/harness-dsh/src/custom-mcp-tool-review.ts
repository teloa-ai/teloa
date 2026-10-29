import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {mcpToolFullName} from '@teloa/contract'

export type CustomMcpToolReview={name:string;fullName:string;readOnly:boolean;description?:string;inputSchema?:Record<string,unknown>;annotations?:{readOnlyHint?:boolean;destructiveHint?:boolean;idempotentHint?:boolean;openWorldHint?:boolean}}
/** DSH 的工具注册会丢弃原始名称与 annotations；只读取目录供本人核对，绝不执行工具。 */
export async function readCustomMcpToolReview(serverName:string,url:string,headers:Record<string,string>,readOnlyTools:readonly string[]):Promise<CustomMcpToolReview[]>{
 const client=new Client({name:'teloa-tool-review',version:'1'},{capabilities:{}}),transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers}})
 const signal=AbortSignal.timeout(30_000),tools:CustomMcpToolReview[]=[],cursors=new Set<string>()
 try{
  // SDK 的 Transport 将 sessionId 标为可选，HTTP 实现为 string|undefined；运行时是同一官方实现。
  await client.connect(transport as unknown as Parameters<Client['connect']>[0],{signal,timeout:30_000})
  let cursor:string|undefined
  do{
   const result=await client.listTools(cursor?{cursor}:undefined,{signal,timeout:30_000})
   for(const tool of result.tools){
    if(tools.some(row=>row.name===tool.name)||tools.length>=1000)throw Error('Invalid MCP tool directory')
    const annotations=tool.annotations===undefined?undefined:Object.fromEntries((['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'] as const).flatMap(key=>typeof tool.annotations?.[key]==='boolean'?[[key,tool.annotations[key]]]:[]))
    tools.push({name:tool.name,fullName:mcpToolFullName(serverName,tool.name),readOnly:readOnlyTools.includes(tool.name),...(tool.description?{description:tool.description.slice(0,32_768)}:{}),...(JSON.stringify(tool.inputSchema).length<=131_072?{inputSchema:tool.inputSchema}:{}),...(annotations?{annotations}:{})})
   }
   cursor=result.nextCursor
   if(cursor){if(cursors.has(cursor))throw Error('Invalid MCP tool pagination');cursors.add(cursor)}
  }while(cursor)
  return tools
 }finally{await client.close().catch(()=>{});await transport.close().catch(()=>{})}
}
