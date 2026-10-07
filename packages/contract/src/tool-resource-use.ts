/** 实际工具执行的稳定来源；不会把安装、可用或审批请求当作使用。 */
export type RecordedToolResourceUse={
 readonly schema:'teloa.resource-use/v1'
 readonly kind:'mcp'|'plugin'|'skill'|'web'
 readonly providerId:string
 readonly name:string
 readonly toolName:string
 readonly rawToolName?:string
 readonly state:'used'|'read'|'injected'
}
export type RecordedNestedToolResourceUse=RecordedToolResourceUse&{
 readonly callId:string
 readonly rootCallId:string
 readonly queries?:readonly string[]
 readonly sources?:readonly {readonly url:string;readonly title?:string;readonly snippet?:string;readonly publishedAt?:string}[]
 readonly truncated?:boolean
 readonly answer?:string
}
/** 与原生 parent call / PTC dispatch 双重核对，保持来源事实独立于模型消息。 */
export type ToolResourceUseSnapshot={
 readonly schema:'teloa.resource-use-snapshot/v1'
 readonly sessionId:string
 readonly parentCallSeq:number
 readonly startSeq:number
 readonly parentCallId:string
 readonly use:RecordedNestedToolResourceUse
}

/** RPC 读边界的形状核对；来源归属仍须与原生调用及 PTC 终态匹配。 */
export function isToolResourceUseSnapshot(value:unknown):value is ToolResourceUseSnapshot{
 const object=(item:unknown):item is Record<string,unknown>=>item!==null&&typeof item==='object'&&!Array.isArray(item)
 const text=(item:unknown):item is string=>typeof item==='string'&&item.trim().length>0&&!item.includes('\0')
 if(!object(value)||value.schema!=='teloa.resource-use-snapshot/v1'||!text(value.sessionId)||!Number.isSafeInteger(value.parentCallSeq)||!Number.isSafeInteger(value.startSeq)||(value.parentCallSeq as number)<0||(value.startSeq as number)<=(value.parentCallSeq as number)||!text(value.parentCallId)||!object(value.use))return false
 const use=value.use
 if(use.schema!=='teloa.resource-use/v1'||!['mcp','plugin','skill','web'].includes(String(use.kind))||!text(use.providerId)||!text(use.name)||!text(use.toolName)||!text(use.callId)||use.rootCallId!==value.parentCallId||(use.rawToolName!==undefined&&!text(use.rawToolName)))return false
 if(use.kind==='skill'?!['read','injected'].includes(String(use.state)):use.state!=='used')return false
 if(use.kind!=='web'&&['queries','sources','truncated','answer'].some(key=>use[key]!==undefined))return false
 if(use.queries!==undefined&&(!Array.isArray(use.queries)||!use.queries.every(text)))return false
 if(use.sources!==undefined&&(!Array.isArray(use.sources)||!use.sources.every(source=>object(source)&&text(source.url)&&['title','snippet','publishedAt'].every(key=>source[key]===undefined||typeof source[key]==='string'))))return false
 return (use.truncated===undefined||typeof use.truncated==='boolean')&&(use.answer===undefined||typeof use.answer==='string')
}
