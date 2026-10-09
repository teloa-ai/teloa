import type {CapabilityItem} from './capability-composition.js'

export type CapabilityCenterItem=CapabilityItem&{toolKeys?:readonly string[]}
const productNames:Readonly<Record<string,string>>={github:'GitHub',gitlab:'GitLab',figma:'Figma',notion:'Notion',gmail:'Gmail',slack:'Slack',linear:'Linear',lark:'飞书',feishu:'飞书',googledrive:'Google Drive','google-drive':'Google Drive',supabase:'Supabase',context7:'Context7'}
/** 会话内 MCP 名称由服务器唯一前缀定义；合并工具呈现，不推断账号授权状态。 */
export function groupCapabilityConnectors(items:readonly CapabilityItem[]):CapabilityCenterItem[]{
 const result:CapabilityCenterItem[]=[],servers=new Map<string,CapabilityCenterItem>()
 for(const item of items){
  const server=item.origin.kind==='studio'&&item.rowId==='source'?item.key.match(/^source:mcp__(.+?)__/i)?.[1]:undefined
  if(!server){result.push(item);continue}
  const previous=servers.get(server)
  if(previous){previous.toolKeys=[...previous.toolKeys!,item.key];continue}
  const connector={...item,key:'connector:'+server,title:productNames[server]??server,toolKeys:[item.key]}
  servers.set(server,connector);result.push(connector)
 }
 return result
}
