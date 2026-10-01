import {WorkError,isRecord,readBusinessSpaceRenameInput,type BusinessSpaceRecord} from '@teloa/contract'
import type {BusinessSpaceService,Edition} from '@teloa/backend'

export const businessSpaceEndpoints=['app/edition','business-spaces/current','business-spaces/rename'] as const
const recordKeys:readonly string[]=['id','name','description','version','kind','createdAt','updatedAt']
const invalid=()=>new WorkError('teloa/invalid-host-response','业务空间回包的归属、版本或字段不正确。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&(empty||!!value.trim())&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!(key in value)))throw invalid();return value}

/** 个人版只认本人空间：`kind` 必须是 `personal`，缺字段或多字段一律拒绝。 */
export function readBusinessSpaceRecord(value:unknown):BusinessSpaceRecord{
 const row=exact(value,recordKeys)
 if(!uuid(row.id)||!text(row.name,80)||!text(row.description,2000,true)||!Number.isSafeInteger(row.version)||Number(row.version)<1||Number(row.version)>2147483647||row.kind!=='personal'||!stamp(row.createdAt)||!stamp(row.updatedAt))throw invalid()
 return row as unknown as BusinessSpaceRecord
}
/** 版本回包只有一个字段，且本阶段只可能是个人版。 */
export function readEditionInfo(value:unknown):{edition:Edition}{
 const row=exact(value,['edition'])
 if(row.edition!=='personal')throw invalid()
 return {edition:'personal'}
}

export function createBusinessSpaceHandler(owner:string,get:()=>Promise<BusinessSpaceService>,edition:()=>Edition){
 return async(endpoint:string,payload:unknown):Promise<unknown>=>{
  if(endpoint==='app/edition')return readEditionInfo({edition:edition()})
  if(endpoint==='business-spaces/current')return readBusinessSpaceRecord(await(await get()).current(owner))
  // 客户端只能提交 requestId、expectedVersion、name、description：`kind` 与 `spaceId` 在入口就被拒。
  if(endpoint==='business-spaces/rename')return readBusinessSpaceRecord(await(await get()).rename(owner,readBusinessSpaceRenameInput(payload)))
  throw new WorkError('teloa/not-found','未提供此业务空间接口。')
 }
}
