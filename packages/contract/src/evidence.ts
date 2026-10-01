import {WorkError} from './work-error.ts'

export const evidenceKinds=['text','log','command'] as const
export type EvidenceKind=typeof evidenceKinds[number]

/**
 * 依据条目的统一形状。`text` 的 body 是 Markdown，交给 MarkdownPreview 的固定子集渲染；
 * `log` 与 `command` 是外部系统原样产出，一律等宽直显，不做任何解释。
 */
export type EvidenceEntry={kind:EvidenceKind;title:string;body:string;source?:string;observedAt?:string}

const BODY_MAX=200000
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const filled=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0
// 只认规范化 ISO 串：来源系统的时间必须能原样回放，'2026-09-15T02:00:00Z' 这类等价写法一律拒绝。
const iso=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value

export function isEvidenceEntry(value:unknown):value is EvidenceEntry{
 if(!record(value))return false
 for(const key of Object.keys(value))if(!['kind','title','body','source','observedAt'].includes(key))return false
 if(!evidenceKinds.includes(value.kind as EvidenceKind))return false
 if(!filled(value.title)||value.title.length>200)return false
 if(typeof value.body!=='string'||value.body.length>BODY_MAX)return false
 // 来源常常直接是外部系统的回执号，上限与 SecurityExecutionReceipt.receiptId 对齐，免得合法回执号被拒。
 if(value.source!==undefined&&(!filled(value.source)||value.source.length>256))return false
 if(value.observedAt!==undefined&&!iso(value.observedAt))return false
 return true
}

export function readEvidenceEntry(value:unknown):EvidenceEntry{
 if(!isEvidenceEntry(value))throw new WorkError('teloa/invalid-input','依据条目格式不正确。')
 return value
}
