import {useEffect,useState,useSyncExternalStore} from 'react'
import type {WorkAttentionApi} from './work-attention-api.js'
import {createWorkAttentionDirectory,emptyWorkAttentionDirectory,type WorkAttentionDirectory,type WorkAttentionDirectorySnapshot} from './work-attention-directory.js'

type OwnedDirectory={api:WorkAttentionApi;identity:unknown;directory:WorkAttentionDirectory}
const idleSnapshot=()=>emptyWorkAttentionDirectory,subscribeIdle=()=>()=>{},idleRead=async()=>{}
export type WorkAttentionState=WorkAttentionDirectorySnapshot&Pick<WorkAttentionDirectory,'reload'|'more'>

/** effect只拥有订阅生命周期；首次读取和后续刷新由消费页明确触发。 */
export function useWorkAttention(api:WorkAttentionApi,identity:unknown):WorkAttentionState{
 const [owned,setOwned]=useState<OwnedDirectory>()
 useEffect(()=>{
  // 每次effect建立独立实例，StrictMode的清理/重挂也不会复用已dispose的目录。
  const directory=createWorkAttentionDirectory(api)
  setOwned({api,identity,directory})
  return()=>directory.dispose()
 },[api,identity])
 const directory=owned?.api===api&&Object.is(owned.identity,identity)?owned.directory:undefined
 const snapshot=useSyncExternalStore(directory?.subscribe??subscribeIdle,directory?.getSnapshot??idleSnapshot,directory?.getSnapshot??idleSnapshot)
 return {...snapshot,reload:directory?.reload??idleRead,more:directory?.more??idleRead}
}
