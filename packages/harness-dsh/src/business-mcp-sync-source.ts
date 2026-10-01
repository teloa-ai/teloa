import {WorkError,evaluateJsonPath} from '@teloa/contract'
import type {BusinessSyncSourcePort,BusinessSyncSourceResolver} from '@teloa/backend'

export type ManagedMcpToolInvoker=(input:{serverName:string;tool:string;arguments:Record<string,unknown>;signal?:AbortSignal})=>Promise<unknown>

const unavailable=(reason:string)=>new WorkError('teloa/source-unavailable',reason)
/**
 * 声明式分页的上限（只对声明了 `pagination` 的来源生效；未声明时与一期相同只拉一页）。页数上限在同步器（`maxPages`=1000），条数上限是每页 `pageSize`（≤100）。
 * - 单页 4 MiB：限的是每页计入累计的份额，防少数几页把正文、附件整段塞进结果就把整链额度吃满；每页 ≤100 条，4 MiB 即平均每条 40 KiB，远够告警、工单这类记录。
 *   它在结果已解析之后才判（DSH 交回结果时内容已在内存里，`callTool` 是一期共用路径、不知道分页），所以不压单次回包的内存峰值——单次回包只受 DSH 与每次调用时限约束。
 * - 整条分页链累计 64 MiB：同步器在写库前把整条链的条目都留在内存里，防 1000 页 × 4 MiB 的最坏情形；64 MiB 序列化后在进程里约数百 MiB，宿主可承受，再大应改增量水位。
 * - 整条分页链耗时 10 分钟：单次调用另有 `timeoutMs`（60 秒），但 1000 页逐页都慢时一次同步会跑十几个小时、一直占着该映射的同步锁；10 分钟够正常工具翻数百页。
 */
const paginationLimits={pageBytes:4*1024*1024,chainBytes:64*1024*1024,chainMs:10*60_000}
/** 下一页游标取值：非空字符串（≤1024 字、无控制字符、无首尾空白，与同步器的游标判据一致）或安全整数（转字符串）；null / 缺失 / 空串表示结束。 */
const cursorText=(value:string)=>value.length<=1024&&value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value)
function nextPageCursor(raw:unknown,path:string):string|undefined{
 const value=evaluateJsonPath(raw,path)
 if(value===undefined||value===null||value==='')return undefined
 if(typeof value==='string'&&cursorText(value))return value
 if(typeof value==='number'&&Number.isSafeInteger(value))return String(value)
 throw unavailable('受管 MCP 工具结果里的下一页游标不合法；未写入。')
}

/** 受管 MCP 连接的两道门：连接是否已建立、某工具是否目录声明为只读（两者都由 `managed-mcp-connections.ts` 给出）。 */
export type McpSyncToolState={connected(serverName:string):boolean;readOnly(serverName:string,tool:string):boolean}

/**
 * `mcp-tool` 来源适配（看板同步 / 映射预览试拉共用）。只允许 `managed-mcp-connections.ts` 已连接且目录声明 `readOnly===true`
 * 的工具。两道门分开判：连接未建立 → `teloa/source-unavailable` 带 `details:{sourceState:'disconnected'}`（预览据此说「先接上连接」）；
 * 已连接但工具不存在或不是只读 → `teloa/forbidden` 带 `details:{toolGate:true}`（草案点名了一个不能用于同步的工具；预览只把带这个标记的 forbidden
 * 原文上屏）。两者任一判否，工具一次也不调。
 * 每次调用的参数 = 声明参数 + 水位（参数 `cursor`，只在映射声明了 `incrementalCursor` 时带；工具不支持增量时声明应写全量 + compare）+ 续页（声明了 `pagination` 时为 `[cursorArgument]:pageToken`）；
 * `itemsPath` 取出数组即本页，条数超过每页上限即拒绝（不截断、不丢条目）。声明了 `pagination` 才按 `nextCursorPath` 给出下一页游标，
 * 游标来自不可信的外部回包：类型与长度不合法即拒绝，循环由同步器按「游标不前进」与页数上限拦住；单页与整条分页链另有字节、耗时上限（`paginationLimits`）。
 * 结果优先取 MCP 官方 `structuredContent`（由 `callTool` 决定），这里只按 JSONPath 取值。
 * 工具报错与回包不符一律 `teloa/source-unavailable`，原错误不进 reason；唯一例外是调用时连接已断开（`callTool` 带 `sourceState:'disconnected'`），
 * 换成固定句并保留该标记，预览据此仍说「没接上」而不是「调用失败」。
 * 每次调用另加 `timeoutMs`（缺省 60 秒）时限，与调用方信号取先到者；超时不等工具自己理会中止信号，直接放手（同步锁随之释放）。
 */
export function createMcpSyncSource(invoke:ManagedMcpToolInvoker,tools:McpSyncToolState,options:{timeoutMs?:number;maxPageBytes?:number;maxChainBytes?:number;maxChainMs?:number;now?:()=>number}={}):BusinessSyncSourceResolver{
 const timeoutMs=options.timeoutMs??60_000,now=options.now??Date.now
 const maxPageBytes=options.maxPageBytes??paginationLimits.pageBytes,maxChainBytes=options.maxChainBytes??paginationLimits.chainBytes,maxChainMs=options.maxChainMs??paginationLimits.chainMs
 return async mapping=>{
  const source=mapping.source
  if(source.kind!=='mcp-tool')throw unavailable('数据源映射不是受管 MCP 工具来源。')
  if(!tools.connected(source.serverName))throw new WorkError('teloa/source-unavailable','受管连接 '+source.serverName+' 连接未建立。',{sourceState:'disconnected'})
  if(!tools.readOnly(source.serverName,source.tool))throw new WorkError('teloa/forbidden','看板同步只允许只读工具：'+source.serverName+'/'+source.tool+' 不存在或不是只读工具。',{toolGate:true})
  const pagination=source.pagination
  // 当前这条分页链的起点与累计字节：不带 pageToken 的首页开一条新链。
  let chain={startedAt:0,bytes:0}
  const port:BusinessSyncSourcePort={
   key:source.serverName+'/'+source.tool,
   async fetch(input){
    input.signal?.throwIfAborted()
    if(input.pageToken===undefined)chain={startedAt:now(),bytes:0}
    else if(pagination&&now()-chain.startedAt>maxChainMs)throw unavailable('受管 MCP 工具分页耗时超过 '+Math.round(maxChainMs/60_000)+' 分钟；未写入。')
    // 映射没有 incrementalCursor 就没有水位：同步器给出的只可能是改版前残留的旧值，不发给工具（续页参数也可能正叫 cursor）。
    const args={...source.arguments,...(input.cursor===undefined||!mapping.incrementalCursor?{}:{cursor:input.cursor}),...(pagination&&input.pageToken!==undefined?{[pagination.cursorArgument]:input.pageToken}:{})}
    const timeout=AbortSignal.timeout(timeoutMs)
    const signal=input.signal?AbortSignal.any([input.signal,timeout]):timeout
    let raw:unknown
    try{
     raw=await new Promise<unknown>((resolve,reject)=>{
      const stop=()=>reject(signal.reason)
      signal.addEventListener('abort',stop,{once:true})
      invoke({serverName:source.serverName,tool:source.tool,arguments:args,signal})
       .then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop))
     })
    }catch(error){
     if(input.signal?.aborted)throw error
     if(error instanceof WorkError&&error.details?.sourceState==='disconnected')throw new WorkError('teloa/source-unavailable','受管连接 '+source.serverName+' 连接未建立或已断开。',{sourceState:'disconnected'})
     throw unavailable(timeout.aborted?'受管 MCP 工具超时（超过 '+Math.round(timeoutMs/1000)+' 秒未返回）。':'受管 MCP 工具暂不可读。')
    }
    const items=evaluateJsonPath(raw,source.itemsPath)
    if(!Array.isArray(items))throw unavailable('受管 MCP 工具结果里按 itemsPath 取不到记录数组；未写入。')
    if(items.length>input.pageSize)throw unavailable('受管 MCP 工具一次返回 '+items.length+' 条，超过每页上限 '+input.pageSize+'；请调大映射的 pageSize（≤ 100）或收窄工具参数。')
    if(!pagination)return {items,capturedAt:new Date().toISOString()}
    const bytes=Buffer.byteLength(JSON.stringify(raw)??'')
    if(bytes>maxPageBytes)throw unavailable('受管 MCP 工具单页结果超过 '+maxPageBytes+' 字节；未写入。')
    chain.bytes+=bytes
    if(chain.bytes>maxChainBytes)throw unavailable('受管 MCP 工具分页结果累计超过 '+maxChainBytes+' 字节；未写入。')
    const nextCursor=nextPageCursor(raw,pagination.nextCursorPath)
    return {items,capturedAt:new Date().toISOString(),...(nextCursor===undefined?{}:{nextCursor})}
   },
  }
  return port
 }
}
