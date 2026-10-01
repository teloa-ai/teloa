import {WorkError,isRecord} from './index.ts'

/** 空间归属：个人版只会出现 `personal`；`team` 是企业版的团队空间，个人版只读存量行。 */
export type BusinessSpaceKind='personal'|'team'
/** 业务空间行的公开形状；范围标签（`scopes`）属于后续任务，本任务只交付空间本身。 */
export type BusinessSpaceRecord={id:string;name:string;description:string;version:number;kind:BusinessSpaceKind;createdAt:string;updatedAt:string}
/** 改名入参：客户端只能提交这四个字段，`kind` 与 `spaceId` 一律由服务端固定为本人空间。 */
export type BusinessSpaceRenameInput={requestId:string;expectedVersion:number;name:string;description:string}

const keys:readonly string[]=['requestId','expectedVersion','name','description']
const invalid=()=>new WorkError('teloa/invalid-input','业务空间改名请求格式不正确。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&(empty||!!value.trim())&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)

/** 严格读改名入参：多一个字段（例如 `kind`、`spaceId`）即拒绝，名称 1–80、描述 ≤2000。 */
export function readBusinessSpaceRenameInput(value:unknown):BusinessSpaceRenameInput{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!(key in value)))throw invalid()
 if(!uuid(value.requestId)||!Number.isSafeInteger(value.expectedVersion)||Number(value.expectedVersion)<1||Number(value.expectedVersion)>2147483647||!text(value.name,80)||!text(value.description,2000,true))throw invalid()
 return {requestId:(value.requestId as string).toLowerCase(),expectedVersion:value.expectedVersion as number,name:(value.name as string).trim(),description:(value.description as string).trim()}
}
