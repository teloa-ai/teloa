import {roleDefinition,roleInput,roleWriteDefinition,type DigitalRole,type RoleDefinition} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'
type Call=(endpoint:string,input:unknown)=>Promise<unknown>
const roleFields=(value:DigitalRole):RoleDefinition=>roleDefinition({name:value.name,kind:value.kind,scopes:value.scopes,duty:value.duty,dataScope:value.dataScope,executionScope:value.executionScope,skills:value.skills,knowledge:value.knowledge,...(value.responsibility===undefined?{}:{responsibility:value.responsibility}),...(value.runtimeConfig===undefined?{}:{runtimeConfig:value.runtimeConfig})})
const sameFields=(value:DigitalRole,fields:RoleDefinition)=>JSON.stringify(roleFields(value))===JSON.stringify(fields)
const withoutResponsibility=(fields:RoleDefinition)=>{const {responsibility:_responsibility,...rest}=fields;return JSON.stringify(rest)}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const iso=(value:unknown):value is string=>{if(typeof value!=='string')return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value}
const emptyResponsibility=()=>({triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]})
const requestError=(code:string,message:string,cause?:unknown)=>Object.assign(Error(message),{code,...(cause===undefined?{}:{cause})})
// 仅首次可信业务拒绝能证明本次岗位事务未写入；重递送的拒绝不能证明更早一次未受理。
const createRejected=(error:unknown)=>!!error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&typeof error.code==='string'&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'].includes(error.code)
export type RoleApi=ReturnType<typeof createRoleApi>
export function readSavedRole(value:unknown):DigitalRole{
 try{
  const row=roleInput(value,['id','ownerId','version','state','createdAt','updatedAt','name','kind','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig'])
  const {id,ownerId,version,state,createdAt,updatedAt,...fields}=row
  if(!uuid(id)||typeof ownerId!=='string'||!ownerId||!Number.isSafeInteger(version)||(version as number)<1||!['active','paused','retired'].includes(String(state))||!iso(createdAt)||!iso(updatedAt)||updatedAt<createdAt)throw Error()
  return {...roleDefinition(fields),id,ownerId,version:version as number,state:state as DigitalRole['state'],createdAt,updatedAt}
 }catch{throw requestError('teloa/invalid-host-response','员工服务返回的内容格式不正确。')}
}
const read=readSavedRole
export type RoleRequestJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
export function createRoleApi(call:Call,journal?:RoleRequestJournal,newId=()=>crypto.randomUUID()){
 let pending:{requestId:string;fields:RoleDefinition;key:string;legacy:boolean;attempted:boolean}|undefined
 let recoveryError:ReturnType<typeof recoveryStorageError>|undefined,creating=false
 try{
  const content=journal?.read()
  if(content){const row=roleInput(JSON.parse(content),['schema','requestId','fields']);if(row.schema!=='teloa.role-create/v1'||!uuid(row.requestId))throw Error();const fields=roleDefinition(row.fields),legacy=fields.responsibility===undefined,draft=legacy?roleWriteDefinition({...fields,responsibility:emptyResponsibility()}):roleWriteDefinition(fields);pending={requestId:row.requestId,fields,key:JSON.stringify(draft),legacy,attempted:true}}
 }catch{recoveryError=recoveryStorageError()}
 const write=()=>{try{journal?.write(JSON.stringify({schema:'teloa.role-create/v1',requestId:pending!.requestId,fields:pending!.fields}))}catch(error){throw requestError('teloa/recovery-write-failed',error instanceof Error?error.message:'恢复记录保存失败。',error)}}
 const clear=()=>{try{journal?.clear()}catch(error){throw requestError('teloa/recovery-clear-failed',error instanceof Error?error.message:'恢复记录清理失败。',error)}}
 return {
  recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  pendingFields:()=>pending?roleWriteDefinition(pending.legacy?{...pending.fields,responsibility:emptyResponsibility()}:pending.fields):undefined,
  async list(){const value=await call('roles/list',{});if(!Array.isArray(value))throw Error('员工目录格式不正确。');const rows=value.map(read);if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('员工目录格式不正确：重复身份。');return rows},
  async create(input:RoleDefinition){
   if(recoveryError)throw recoveryError
   if(creating)throw requestError('teloa/role-create-busy','员工创建正在核对，请等待当前请求结束。')
   const fields=roleWriteDefinition(input),key=JSON.stringify(fields)
   if(pending&&(pending.legacy?withoutResponsibility(pending.fields)!==withoutResponsibility(fields):pending.key!==key))throw requestError('teloa/role-create-pending','上次创建结果尚待核对，请先用原内容重试，避免重复创建员工。')
   pending??={requestId:newId(),fields,key,legacy:false,attempted:false}
   creating=true
   try{
    write()
    const firstAttempt=!pending.attempted;pending.attempted=true
    let response:unknown
    try{response=await call('roles/create',{requestId:pending.requestId,fields:pending.fields})}
    catch(error){
     if(firstAttempt&&createRejected(error)){clear();pending=undefined;throw error}
     throw requestError('teloa/role-create-pending',error instanceof Error?error.message:'员工创建结果尚待核对。',error)
    }
    const result=read(response)
    // “让它上班”走的用户招聘路径由服务端固定创建为在岗；暂停只用于行业模板等非手动创建路径。
    if(result.version!==1||result.state!=='active'||!sameFields(result,pending.fields))throw requestError('teloa/invalid-host-response','员工创建响应与原请求不一致，请刷新核对。')
    clear();pending=undefined;return result
   }finally{creating=false}
  },
  async edit(id:string,version:number,fields:RoleDefinition){const normalized=roleWriteDefinition(fields),row=read(await call('roles/edit',{roleId:id,expectedVersion:version,fields:normalized}));if(row.id!==id||row.version!==version+1||!sameFields(row,normalized))throw Error('员工保存响应与目标、版本或字段不一致，请刷新核对。');return row}
 }
}
