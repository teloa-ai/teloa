import type {BusinessSpaceRecord,BusinessSpaceChange} from './business-directory.js'

type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>

/** 改名只提交请求身份、期望版本、名称与说明；空间身份与 `kind` 一律由宿主判定。 */
export type BusinessSpaceRenameInput={requestId:string;expectedVersion:number;name:string;description:string}

const recordKeys=['id','name','description','version','kind','createdAt','updatedAt'] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const exact=(value:unknown,keys:readonly string[])=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw Error()
 return value as Record<string,unknown>
}

/** 严格读取：键集必须完全一致，`kind` 只接受 `'personal'`，其余形状一律按宿主回包格式不正确处理。 */
export function readBusinessSpaceRecord(value:unknown):BusinessSpaceRecord{
 try{
  const row=exact(value,recordKeys)
  if(!uuid(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>80)throw Error()
  if(typeof row.description!=='string'||row.description.length>2000)throw Error()
  if(!positive(row.version)||row.kind!=='personal'||!stamp(row.createdAt)||!stamp(row.updatedAt))throw Error()
  return {id:row.id,name:row.name,description:row.description,version:row.version,kind:'personal',createdAt:row.createdAt,updatedAt:row.updatedAt}
 }catch{throw Error('工作空间记录格式不正确。')}
}

function renameRequest(value:BusinessSpaceRenameInput):BusinessSpaceRenameInput{
 const name=value.name.trim(),description=value.description.trim()
 if(!uuid(value.requestId)||!positive(value.expectedVersion))throw Error('工作空间改名请求格式不正确。')
 if(!name||name.length>80||description.length>2000)throw Error('业务名称需为1～80字，说明不能超过2000字。')
 return {requestId:value.requestId,expectedVersion:value.expectedVersion,name,description}
}

/** 改名带 `requestId`，宿主自身幂等；客户端不留恢复记录，失败即由界面重试。 */
export function createBusinessSpaceApi(call:Call){
 return {
  async current(signal?:AbortSignal):Promise<BusinessSpaceRecord>{
   return readBusinessSpaceRecord(await call('business-spaces/current',{},signal))
  },
  async rename(input:BusinessSpaceRenameInput,signal?:AbortSignal):Promise<BusinessSpaceRecord>{
   const request=renameRequest(input)
   const record=readBusinessSpaceRecord(await call('business-spaces/rename',request,signal))
   if(record.version<=request.expectedVersion)throw Error('工作空间改名回包与原请求不一致。')
   return record
  },
 }
}

export type BusinessSpaceApi=ReturnType<typeof createBusinessSpaceApi>
export type {BusinessSpaceRecord,BusinessSpaceChange}
