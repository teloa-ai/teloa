import {WorkError} from './work-error.ts'

/**
 * 停止意图的时间戳。停止只是「请求」，它不伪造终态，只把请求本身留痕，
 * 于是刷新后仍能看到「停止中」，宿主也有了可判别的重发依据。
 * 旧记录没有这一位：缺字段与 null 一律回落 null，只接受规范化 ISO 串。
 */
export function taskRunStopRequestedAt(value:unknown):string|null{
 if(value===undefined||value===null)return null
 if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new WorkError('teloa/invalid-input','停止请求时间不正确。')
 return value
}
