import {createHash} from 'node:crypto'
import {WorkError} from '@teloa/contract'

type Cursor={kind:'ordinary'|'managed'|'role-run';snapshot:string;offset:number;inner?:string}
export function readConversationPageRequest(value:unknown):{limit:number;cursor?:Cursor}{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['limit','cursor'].includes(key)))throw new WorkError('teloa/invalid-input','会话目录分页请求无效。')
 const row=value as {limit?:unknown;cursor?:unknown},limit=row.limit??16
 if(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>32)throw new WorkError('teloa/invalid-input','会话目录页大小无效。')
 if(row.cursor===undefined)return {limit:Number(limit)}
 if(typeof row.cursor!=='string'||row.cursor.length<1||row.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(row.cursor))throw new WorkError('teloa/invalid-input','会话目录游标无效。')
 let c:unknown
 try{c=JSON.parse(Buffer.from(row.cursor,'base64url').toString('utf8'))}catch{throw new WorkError('teloa/invalid-input','会话目录游标无效。')}
 if(!c||typeof c!=='object'||Array.isArray(c))throw new WorkError('teloa/invalid-input','会话目录游标无效。')
 const cursor=c as Cursor
 if(Object.keys(c).some(key=>!['kind','snapshot','offset','inner'].includes(key))||!['ordinary','managed','role-run'].includes(cursor.kind)||typeof cursor.snapshot!=='string'||!/^[a-f0-9]{64}$/.test(cursor.snapshot)||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.kind==='managed'&&cursor.offset!==0||cursor.inner!==undefined&&(cursor.kind!=='managed'||typeof cursor.inner!=='string'||cursor.inner.length>1024))throw new WorkError('teloa/invalid-input','会话目录游标无效。')
 return {limit:Number(limit),cursor}
}
export const conversationPageFingerprint=(owner:string,kind:string,rows:unknown)=>createHash('sha256').update(JSON.stringify([owner,kind,rows])).digest('hex')
export const conversationPageCursor=(cursor:Cursor)=>Buffer.from(JSON.stringify(cursor)).toString('base64url')
export function assertConversationPageSnapshot(cursor:Cursor|undefined,snapshot:string,kinds:Cursor['kind'][]):void{
 if(cursor&&(cursor.snapshot!==snapshot||!kinds.includes(cursor.kind)))throw new WorkError('teloa/conflict','会话目录已变化，请刷新后继续读取。')
}
