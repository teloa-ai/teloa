/** `refused` 只在删除回包里出现：本次请求中因是链接、与其他路径共用内容或无法覆写而未删除的个数。 */
/** `shared`：与其他路径共用内容（硬链接），服务端不会删除，只能手动处理。 */
export type CredentialStoreStatus={tier:'keyring'|'file'|'plaintext'|null;fault:string|null;copies:{id:string;label:string;shared:boolean}[];refused?:number}
export type CredentialStoreApi={status():Promise<CredentialStoreStatus>;deleteCopies(ids:readonly string[]):Promise<CredentialStoreStatus>}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function read(value:unknown):CredentialStoreStatus{
 if(!record(value)||![null,'keyring','file','plaintext'].includes(value.tier as string|null)||!(value.fault===null||typeof value.fault==='string')||!Array.isArray(value.copies))throw Error('密钥存储状态格式不正确。')
 if('refused' in value&&!(Number.isSafeInteger(value.refused)&&(value.refused as number)>=0))throw Error('密钥存储状态格式不正确。')
 const copies=value.copies.map(copy=>{if(!record(copy)||typeof copy.id!=='string'||!/^[0-9a-f]{32}$/.test(copy.id)||typeof copy.label!=='string'||('shared' in copy&&typeof copy.shared!=='boolean'))throw Error('密钥存储状态格式不正确。');return {id:copy.id,label:copy.label,shared:copy.shared===true}})
 return {tier:value.tier as CredentialStoreStatus['tier'],fault:value.fault as string|null,copies,...('refused' in value?{refused:value.refused as number}:{})}
}
export function createCredentialStoreApi(call:(endpoint:string,payload:unknown)=>Promise<unknown>):CredentialStoreApi{
 return {
  status:async()=>read(await call('credential-store/status',{})),
  deleteCopies:async ids=>read(await call('credential-store/plaintext-copies/delete',{ids:[...ids]})),
 }
}
