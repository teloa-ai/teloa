import {createHash} from 'node:crypto'

/** 工作事件正文与事实的规范序列化：键按字典序递归排序，数组保序；与 `teloa_work_events.payload_hash` 的落库口径一致。 */
export const canonicalWorkEventValue=(value:unknown):unknown=>Array.isArray(value)?value.map(canonicalWorkEventValue):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonicalWorkEventValue(v)])):value
/** 事件身份与事实摘要共用的 sha256；独立成模块供事件服务与计划领取复核共用，不让两者互相导入。 */
export const workEventDigest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(canonicalWorkEventValue(value))).digest('hex')
