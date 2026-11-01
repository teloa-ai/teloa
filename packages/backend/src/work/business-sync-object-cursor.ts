import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {WorkError} from '@teloa/contract'

export type ObjectTimestamp={value:string;time:number}
type Content={title:string;summary:string;fields:unknown;deletedAt?:string}

/** 只认来源显式声明的时间值，不用接收时间、全局水位或本地版本推测。 */
export function objectTimestamp(value:unknown):ObjectTimestamp|undefined{
 if(typeof value!=='string'&&typeof value!=='number')return undefined
 const text=String(value),time=Date.parse(text)
 return text.length>0&&text.length<=512&&text===text.trim()&&Number.isFinite(time)?{value:text,time}:undefined
}
export const objectCursorConflict=()=>new WorkError('teloa/source-conflict','来源对象的时间顺序无法核实；请以新映射绑定本人来源，原映射的记录与成果仍保留。')

/** 删除位与物质内容同判；同一删除事实不依赖 tombstone 附带的字段是否完整。 */
export function sameObjectContent(current:Content,deleted:boolean,next:Content):boolean{
 if((current.deletedAt!==undefined)!==deleted)return false
 return deleted||current.title===next.title&&current.summary===next.summary&&isDeepStrictEqual(current.fields,next.fields)
}

/** 口径绑定来源授权、时间声明与实际快照头，不能把别的头或旧口径当作时间基线。 */
export function objectCursorBasis(sourceKey:string,basis:string,head:{version:number;hash:string}):string{
 return createHash('sha256').update(JSON.stringify(['teloa.business-sync-object-cursor/v1',sourceKey,basis,head.version,head.hash])).digest('hex')
}
export function trustedObjectTimestamp(row:{source_cursor:unknown;source_cursor_basis:unknown},expectedBasis:string):ObjectTimestamp|undefined{
 if(row.source_cursor===null&&row.source_cursor_basis===null)return undefined
 const cursor=objectTimestamp(row.source_cursor)
 if(!cursor||typeof row.source_cursor_basis!=='string'||!/^[a-f0-9]{64}$/.test(row.source_cursor_basis))throw new WorkError('teloa/storage-corrupt','来源对象的时间记录损坏，已停止同步。')
 return row.source_cursor_basis===expectedBasis?cursor:undefined
}
