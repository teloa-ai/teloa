import type {Group} from '@teloa/contract'
import type {GroupApi} from './group-api.js'

type RecoveryRequest=ReturnType<GroupApi['pending']>
export type RecoveryGroupDirectory={requestId:string;items:readonly Group[];status:'found'|'missing'}

export async function readRecoveryGroupDirectory(api:GroupApi,request:RecoveryRequest=api.pending()):Promise<RecoveryGroupDirectory|undefined>{
 if(!request||request.kind==='create')return undefined
 const requestId=request.request.requestId,groupId=request.request.groupId,directory=await api.list()
 return {requestId,items:directory.items,status:directory.items.some(item=>item.id===groupId&&!item.archived)?'found':'missing'}
}
