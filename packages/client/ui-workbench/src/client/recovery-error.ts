import {WorkError} from '@teloa/contract'

export type RecoveryJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}

export function recoveryStorageError():WorkError{
 return Object.assign(new WorkError('teloa/storage-corrupt','Recovery journal is unreadable or corrupt.'),{origin:'browser-recovery' as const})
}

export type RecoveryGate<T>={
 pending:()=>T|undefined
 recoveryMessage:()=>WorkError|undefined
 discard:()=>boolean
 accept:(value:T|undefined)=>void
}

/**
 * 恢复记录的统一读闸。
 *
 * 读坏时**保留**原始记录而不是静默清掉：用户可能还需要知道"上一次确实发起过一个请求"。
 * 代价是这条坏记录会一直卡着这条业务线——所以丢弃必须是一个显式的、界面上看得见的动作，
 * 而不是藏在读闸里。丢弃只清本地，不通知服务端（规格 §二 D4）：账本按 requestId 索引，
 * 客户端丢掉 requestId 之后本来就没有可靠的撤销面，再调一次只会造出"半撤销"的新状态。
 */
export function createRecoveryGate<T>(journal:RecoveryJournal|undefined,parse:(raw:string)=>T,maxCharacters:number):RecoveryGate<T>{
 let pending:T|undefined,error:WorkError|undefined
 try{
  const raw=journal?.read()
  if(raw!==null&&raw!==undefined){
   if(raw.length>maxCharacters)throw Error()
   pending=parse(raw)
  }
 }catch{error=recoveryStorageError()}
 return {
  pending:()=>pending,
  recoveryMessage:()=>error,
  discard(){
   const had=pending!==undefined||error!==undefined
   // 清不掉就吞掉：存储已经坏到这个程度，再抛一次只会把用户堵在同一处。
   try{journal?.clear()}catch{/* 本地记录清不掉不该变成第二道墙 */}
   pending=undefined;error=undefined
   return had
  },
  accept(value){pending=value},
 }
}
