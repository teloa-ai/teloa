import {useEffect,useMemo,useRef,useState} from 'react'
import type {ArtifactAvailability} from '@teloa/contract'
import type {ArtifactApi} from './artifact-api.ts'

export type ArtifactWithdrawalApi=Pick<ArtifactApi,'availability'|'withdraw'|'recoverWithdrawal'|'withdrawalPending'>
/** 状态读取可以重试；撤回只来自本人确认或明确核对原请求。关闭和切换对象不取消已发送请求。 */
export function useArtifactWithdrawal(id:string|undefined,api:ArtifactWithdrawalApi|undefined,head:number|undefined){
 const owner=useMemo(()=>({id,api}),[id,api]),current=useRef(owner),sequence=useRef(0)
 current.current=owner
 const [view,setView]=useState<{owner:typeof owner;value?:ArtifactAvailability;error?:unknown;loading:boolean}>({owner,loading:true})
 const [failure,setFailure]=useState<{owner:typeof owner;error:unknown}|null>(null)
 const [,update]=useState(0),operation=useRef<typeof owner|null>(null),reload=useRef<()=>Promise<void>>(async()=>{})
 const refresh=async()=>{
  if(!id||!api)return
  const request=++sequence.current
  setView(previous=>({owner,...(previous.owner===owner&&previous.value?{value:previous.value}:{}),loading:true}))
  try{const value=await api.availability(id);if(current.current===owner&&sequence.current===request)setView({owner,value,loading:false})}
  catch(error){if(current.current===owner&&sequence.current===request)setView(previous=>({owner,...(previous.owner===owner&&previous.value?{value:previous.value}:{}),error,loading:false}))}
 }
 reload.current=refresh
 useEffect(()=>{
  void refresh()
  const focus=()=>{if(!operation.current)void refresh()}
  window.addEventListener('focus',focus)
  return()=>{sequence.current++;window.removeEventListener('focus',focus)}
 },[owner,head])
 const run=async(recover:boolean)=>{
  if(!id||!api||operation.current)return
  operation.current=owner;setFailure(null);update(n=>n+1)
  try{
   const withdrawal=await (recover?api.recoverWithdrawal(id):api.withdraw(id))
   if(current.current===owner)setView({owner,value:{artifactId:id,state:'withdrawn',withdrawal},loading:false})
  }catch(error){if(current.current===owner)setFailure({owner,error})}
  finally{
   operation.current=null;update(n=>n+1)
   // 已关闭再打开同一对象时也刷新状态；不将旧对象的回执写入新对象或其草稿。
   if(current.current.id===id&&current.current.api===api)void reload.current()
  }
 }
 const visible=view.owner===owner?view:undefined,pending=!!id&&!!api?.withdrawalPending(id),working=!!operation.current&&operation.current.id===id&&operation.current.api===api
 const enabled=!!id&&!!api,state=visible?.value?.state
 return {enabled,state,pending,working,error:visible?.error,actionError:failure?.owner===owner?failure.error:undefined,loading:enabled&&(!visible||visible.loading),blocked:enabled&&(!visible||visible.loading||!!visible.error||state!=='available'||pending||working),refresh,withdraw:()=>run(false),recover:()=>run(true)}
}
export type ArtifactWithdrawalControl=ReturnType<typeof useArtifactWithdrawal>
