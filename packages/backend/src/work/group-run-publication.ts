import {WorkError} from '@teloa/contract'

/** 只记录发布事实，不改原 Run 的结束证据、输入、谱系或执行权限。 */
export type GroupRunPublication={state:'retrying'|'blocked';code:string;attempts:number;at:string}
export const groupPublicationBlocked=(code:string):boolean=>['teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/invalid-input','teloa/storage-corrupt','teloa/file-too-large','teloa/source-unavailable'].includes(code)

export function readGroupRunPublication(value:unknown):GroupRunPublication|undefined{
 if(value===null||value===undefined)return undefined
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==4)throw corrupt()
 const row=value as Record<string,unknown>
 if(!['retrying','blocked'].includes(String(row.state))||typeof row.code!=='string'||!/^teloa\/[a-z-]{1,100}$/.test(row.code)||!Number.isSafeInteger(row.attempts)||Number(row.attempts)<0||row.state==='blocked'&&row.attempts===0||typeof row.at!=='string'||!Number.isFinite(Date.parse(row.at)))throw corrupt()
 return row as GroupRunPublication
}
const corrupt=()=>new WorkError('teloa/storage-corrupt','群结果发布记录损坏，请查看原工作。')
