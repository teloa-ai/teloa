import {WorkError} from '@teloa/contract'
import type {ArtifactSaveJournal} from './artifact-api.ts'
import {createJournalStorage} from './journal-storage.ts'

/** 保留既有共享键；来源校验和原nonce恢复仍由API处理，存储事务不跨网络持锁。 */
export function createArtifactSaveJournal(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,locks:Pick<LockManager,'request'>|undefined):ArtifactSaveJournal{
 const key='teloa.artifact-save/v1'
 return {...createJournalStorage(key,storage),exclusive:update=>{
  if(!locks)return Promise.reject(new WorkError('teloa/dependency-unavailable','当前浏览器无法安全保存共享请求，请使用支持此功能的浏览器后继续。'))
  return locks.request(key,update)
 }}
}
