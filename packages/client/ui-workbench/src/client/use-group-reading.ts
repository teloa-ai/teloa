import {useEffect,useLayoutEffect,useMemo,useReducer,useRef,type RefObject} from 'react'
import type {GroupMessage,GroupReadCursor,GroupReadingState} from '@teloa/contract'
import type {GroupApi} from './group-api.js'

type Position={top:number;bottom:boolean;anchor?:{id:string;offset:number}|undefined}
type ReadingSession={position:Position|undefined;initialized:boolean;ready:boolean;reading:GroupReadingState|undefined;failed:boolean;request:number;marking:boolean;marked:GroupReadCursor|null}
// 只在同一认证 API 实例内恢复位置；换本人不会消费另一身份的界面位置。
const positions=new WeakMap<GroupApi,Map<string,Position>>()
const order=(left:GroupReadCursor,right:GroupReadCursor)=>left.createdAt.localeCompare(right.createdAt)||left.messageId.localeCompare(right.messageId)
const shown=(log:HTMLDivElement)=>{
 const bounds=log.getBoundingClientRect()
 if(!log.clientHeight||!bounds.width||document.visibilityState==='hidden'||getComputedStyle(log).visibility==='hidden'||log.closest('[hidden]'))return []
 return Array.from(log.querySelectorAll<HTMLElement>('[data-teloa-message-id]')).filter(node=>{const rect=node.getBoundingClientRect();return rect.bottom>bounds.top&&rect.top<bounds.bottom})
}

/** 位置是界面状态，已读水位来自服务端；只有当前可见窗口能推进水位。 */
export function useGroupReading({api,groupId,rootId,active,messages,log}:{api:GroupApi;groupId:string|undefined;rootId?:string|undefined;active:boolean;messages:readonly GroupMessage[]|undefined;log:RefObject<HTMLDivElement>}){
 const [,render]=useReducer((n:number)=>n+1,0),current=useRef<ReadingSession>()
 const key=groupId+':'+(rootId??'main')
 const session=useMemo<ReadingSession>(()=>({position:positions.get(api)?.get(key),initialized:false,ready:false,reading:undefined,failed:false,request:0,marking:false,marked:null}),[api,key])
 current.current=session
 const activeRef=useRef(active);activeRef.current=active
 const mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false}},[])
 const messagesRef=useRef(messages);messagesRef.current=messages
 const isCurrent=()=>mounted.current&&current.current===session&&activeRef.current
 const capture=()=>{
  const node=log.current;if(!node||!shown(node).length)return
  const anchor=shown(node)[0],top=node.getBoundingClientRect().top
  session.position={top:node.scrollTop,bottom:node.scrollHeight-node.clientHeight-node.scrollTop<=80,anchor:anchor?.dataset.teloaMessageId?{id:anchor.dataset.teloaMessageId,offset:anchor.getBoundingClientRect().top-top}:undefined}
  let cache=positions.get(api);if(!cache){cache=new Map();positions.set(api,cache)}cache.set(key,session.position)
 }
 const accept=(state:GroupReadingState)=>{
  // 迟到的读取不能覆盖刚推进的水位；同一水位以最新一次读取的未读数为准。
  const cursor=session.reading?.cursor
  if(cursor&&(!state.cursor||order(state.cursor,cursor)<0))return
  const latest=session.reading?.latest
  if(latest&&(!state.latest||order(state.latest,latest)<0))return
  session.reading=state;session.failed=false
  if(state.cursor&&(!session.marked||order(state.cursor,session.marked)>0))session.marked=state.cursor
 }
 const refresh=async()=>{
  if(!groupId||!isCurrent())return
  const request=++session.request
  try{if(api.reading){const state=await api.reading(groupId,rootId);if(isCurrent()&&request===session.request)accept(state)}}
  catch{if(isCurrent()&&request===session.request)session.failed=true}
  finally{if(isCurrent()&&request===session.request){session.ready=true;render()}}
 }
 const markVisible=async()=>{
  const node=log.current
  if(!groupId||!node||!isCurrent()||!session.initialized||session.marking||!api.markRead)return
  const bottom=node.getBoundingClientRect().bottom
  const ids=new Set(shown(node).filter(item=>item.getBoundingClientRect().bottom<=bottom+1).flatMap(item=>item.dataset.teloaMessageId?[item.dataset.teloaMessageId]:[]))
  const last=(messagesRef.current??[]).filter(message=>ids.has(message.id)).at(-1)
  if(!last)return
  const cursor={messageId:last.id,createdAt:last.createdAt}
  if(session.marked&&order(cursor,session.marked)<=0)return
  session.marking=true
  try{const state=await api.markRead(groupId,last.id,rootId);if(isCurrent()){accept(state);render()}}
  catch{if(isCurrent()){session.failed=true;render()}}
  finally{session.marking=false}
 }
 const markRef=useRef(markVisible);markRef.current=markVisible
 useEffect(()=>{if(active&&messages!==undefined)void refresh()},[session,active,messages])
 useLayoutEffect(()=>{
  const node=log.current
  if(!active||!node||messages===undefined||!session.ready||!shown(node).length)return
  const position=session.position
  const restore=(saved:Position)=>{
   if(saved.bottom){node.scrollTop=node.scrollHeight;return}
   const anchor=saved.anchor&&Array.from(node.querySelectorAll<HTMLElement>('[data-teloa-message-id]')).find(item=>item.dataset.teloaMessageId===saved.anchor?.id)
   if(anchor&&saved.anchor)node.scrollTop+=anchor.getBoundingClientRect().top-node.getBoundingClientRect().top-saved.anchor.offset
   else node.scrollTop=saved.top
  }
  if(!session.initialized){
   if(position)restore(position)
   else{
    const cursor=session.reading?.cursor,anchor=cursor&&session.reading?.unreadCount?Array.from(node.querySelectorAll<HTMLElement>('[data-teloa-message-id]')).find(item=>item.dataset.teloaMessageId===cursor.messageId):undefined
    if(anchor)node.scrollTop+=anchor.getBoundingClientRect().top-node.getBoundingClientRect().top
    else node.scrollTop=node.scrollHeight
   }
   session.initialized=true
  }else if(position)restore(position)
  capture()
  const frame=requestAnimationFrame(()=>void markRef.current())
  return ()=>cancelAnimationFrame(frame)
 },[session,active,messages,session.ready])
 useEffect(()=>{
  if(!active)return
  const visible=()=>{if(document.visibilityState!=='hidden'){void refresh();void markRef.current()}}
  document.addEventListener('visibilitychange',visible)
  return ()=>document.removeEventListener('visibilitychange',visible)
 },[session,active])
 const timer=useRef<ReturnType<typeof setTimeout>>()
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current)},[session,active])
 const onScroll=()=>{
  if(!isCurrent()||!session.initialized)return
  capture();render()
  if(timer.current)clearTimeout(timer.current)
  timer.current=setTimeout(()=>void markRef.current(),120)
 }
 const latest=()=>{
  const node=log.current;if(!node||!isCurrent())return
  node.scrollTop=node.scrollHeight;capture();render();void markRef.current()
 }
 const preserve=()=>{capture();if(session.position)session.position={...session.position,bottom:false}}
 const retry=()=>{session.marked=session.reading?.cursor??null;void refresh().then(()=>markRef.current())}
 return {unread:session.reading?.unreadCount,away:session.initialized&&session.position?.bottom===false,failed:session.failed,onScroll,latest,retry,preserve}
}
