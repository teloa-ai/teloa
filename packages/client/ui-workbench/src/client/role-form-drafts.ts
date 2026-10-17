import {useSyncExternalStore} from 'react'

type Snapshot<T>={value:T|undefined;pending:Promise<void>|undefined;error:unknown}
function draftSlot<T>(){
 let state:Snapshot<T>={value:undefined,pending:undefined,error:undefined}
 const listeners=new Set<()=>void>(),publish=()=>{for(const listener of listeners)listener()}
 return {
  read:()=>state,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
  set(value:T|undefined){if(state.pending||state.value===value)return;state={...state,value,error:undefined};publish()},
  run(expected:T|undefined,operation:()=>Promise<unknown>){
   if(state.pending)return state.pending
   const pending=Promise.resolve().then(operation).then(()=>{if(state.value===expected)state={...state,value:undefined}},error=>{state={...state,error};throw error}).finally(()=>{state={...state,pending:undefined};publish()})
   state={...state,pending,error:undefined};publish();return pending
  },
 }
}
/** 只在同一存活本人 API 内保留输入；每个入口独立建缓存，不保存确认或自动重发。 */
export function createRoleFormDrafts<T>(){
 const owners=new WeakMap<object,Map<string,ReturnType<typeof draftSlot<T>>>>()
 return {for(owner:object,key:string){let slots=owners.get(owner);if(!slots){slots=new Map();owners.set(owner,slots)}let slot=slots.get(key);if(!slot){slot=draftSlot<T>();slots.set(key,slot)}return slot}}
}
export function useRoleFormDraft<T>(cache:ReturnType<typeof createRoleFormDrafts<T>>,owner:object,key:string){
 const slot=cache.for(owner,key),snapshot=useSyncExternalStore(slot.subscribe,slot.read,slot.read)
 return [slot,snapshot] as const
}
