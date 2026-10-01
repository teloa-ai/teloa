import {WorkError,isRecord,type BusinessSourceMappingDefinition} from '@teloa/contract'
import type {BusinessDataSourcePort} from './business-data.ts'

/**
 * `cursor` 是增量水位（每页都带、整条分页链不变）；`pageToken` 是续页标记（首页不带，续页带上一页回包的 `nextCursor`）。
 * 两者分开是因为受管 MCP 工具的水位与续页走不同参数（规格 §7）；业务数据端口只有一个 `cursor` 参数，取 `pageToken ?? cursor`。
 */
export type BusinessSyncFetchInput={scope:string;cursor?:string;pageToken?:string;pageSize:number;signal?:AbortSignal}
export type BusinessSyncFetchPage={items:unknown[];nextCursor?:string;capturedAt:string}
/** 一次拉取一页；抛 WorkError('teloa/source-unavailable') 表示源不可读。实现方不落库。 */
export interface BusinessSyncSourcePort{readonly key:string;fetch(input:BusinessSyncFetchInput):Promise<BusinessSyncFetchPage>}
/**
 * 按映射声明给出同步源，由 harness 提供。`mcp-tool` 来源在 功能验证 接线：按 Spike A 第 8 项结论走
 * `ctx.tools.get(mcpToolFullName(serverName,tool)).execute(args,{signal})` 内部直调（不经 `ctx.tools.execute`，
 * 不进会话轮次与守卫链），只读判定查受管 MCP 连接的 `readOnly`。本模块不碰宿主。
 */
export type BusinessSyncSourceResolver=(mapping:BusinessSourceMappingDefinition)=>Promise<BusinessSyncSourcePort>

const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const cursorText=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=1024&&!/[\x00-\x1f\x7f]/.test(value)
const unavailable=(reason:string)=>new WorkError('teloa/source-unavailable',reason)

/**
 * 既有 BusinessDataSourcePort → 同步源：items = 端口回包 items（已是 BusinessObjectSnapshot 形状，映射为空即原样落库）。
 * 这里只核页壳（`teloa.data-source-page/v1`、来源与范围一致、条数不超页大小、游标合法）；
 * 条目本身由同步器按 `readBusinessObjectSnapshot` 逐条核对，与即时查询同一个读取器。
 * 端口自己抛的 WorkError 原样透出，其余一律 `teloa/source-unavailable`（原错误不进 reason）。
 */
export function businessDataPortSyncSource(port:BusinessDataSourcePort):BusinessSyncSourcePort{
 return {
  key:port.id,
  async fetch(input){
   input.signal?.throwIfAborted()
   let raw:unknown
   const cursor=input.pageToken??input.cursor
   try{raw=await port.query({scope:input.scope,limit:input.pageSize,...(cursor===undefined?{}:{cursor})},input.signal)}
   catch(error){if(input.signal?.aborted||error instanceof WorkError)throw error;throw unavailable('数据源暂不可读。')}
   const keys=['schema','sourceId','scope','capturedAt','items','nextCursor']
   if(!isRecord(raw)||Object.keys(raw).some(key=>!keys.includes(key))||raw.schema!=='teloa.data-source-page/v1'||raw.sourceId!==port.id||raw.scope!==input.scope||!stamp(raw.capturedAt)||!Array.isArray(raw.items)||raw.items.length>input.pageSize||(raw.nextCursor!==undefined&&!cursorText(raw.nextCursor)))
    throw unavailable('数据源返回了不符合约定的数据；未写入。')
   return {items:raw.items,capturedAt:raw.capturedAt,...(raw.nextCursor===undefined?{}:{nextCursor:raw.nextCursor as string})}
  },
 }
}
