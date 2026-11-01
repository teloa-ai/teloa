import {createElement,useMemo,type ComponentType} from 'react'
import type {SlotRegistry} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {StoredEntry} from '@deepseek-ai/dsh-client-ui-slots'
import {verifiedProcessGroup} from './native-process-outcome.ts'

type Group=Parameters<typeof verifiedProcessGroup>[0]
type Snapshot={readonly nodes:{get:(key:string)=>unknown}}
type NativeFlowProps={
 useChat:<T>(select:(snapshot:Snapshot)=>T)=>T
 useChatGroup:<T>(key:string,select:(group:Group)=>T)=>T
}
type FlowLease={original:unknown;wrapped:ComponentType<NativeFlowProps>;references:number;notify:()=>void}
const leases=new WeakMap<StoredEntry,FlowLease>()
type FlowSlots=Pick<SlotRegistry,'entries'|'register'|'subscribe'>

/**
 * 固定 DSH 0.2.1-rc.2 的公开 flow/reader 适配：上游没有独立过程标题 slot。
 * 委托同一原生组件，既有行、展开、定位、调用检查和错误均原样保留。
 */
export function wrapNativeProcessOutcomeFlow(Native:ComponentType<NativeFlowProps>){
 return function NativeProcessOutcomeFlow(props:NativeFlowProps){
  const useChatGroup=useMemo(()=>function useVerifiedGroup<T>(key:string,select:(group:Group)=>T):T{
   const group=props.useChatGroup(key,value=>value)
   // nodes 是稳定读口；订阅完整快照，使迟到的结果仍能更新已关闭组，而不只等待类别计数改变。
   const snapshot=props.useChat(value=>value)
   const verified=useMemo(()=>verifiedProcessGroup(group,id=>snapshot.nodes.get(id)),[group,snapshot])
   return select(verified)
  },[props.useChat,props.useChatGroup])
  return createElement(Native,{...props,useChatGroup})
 }
}

function retainNativeProcessOutcome(slots:FlowSlots,native:StoredEntry){
 if(native.locale!=='chat'||!native.component||!native.store||!native.inject||!native.children?.['conversation.chat.node'])return ()=>{}
 let lease=leases.get(native)
 if(!lease){
  const original=native.component,wrapped=wrapNativeProcessOutcomeFlow(original as ComponentType<NativeFlowProps>)
  // 上游没有组标题扩展点，且子 slot 只能声明一次。固定版本适配公开 StoredEntry 的组件字段；
  // 原注册身份、子 slot 授权、注入与 store 不动。低优先级空位只发注册通知，不接管渲染。
  native.component=wrapped
  const occupied=new Set(slots.entries('conversation.chat.flow').map(entry=>entry.options.priority??0))
  let priority=Number.MAX_SAFE_INTEGER
  while(occupied.has(priority))priority--
  let notify:()=>void
  try{notify=slots.register({name:'conversation.chat.flow',priority},()=>null)}
  catch(error){if(native.component===wrapped)native.component=original;throw error}
  lease={original,wrapped,references:0,notify};leases.set(native,lease)
 }
 const owned=lease;owned.references++;let released=false
 return ()=>{
  if(released)return
  released=true
  if(--owned.references!==0)return
  if(native.component===owned.wrapped)native.component=owned.original
  leases.delete(native);owned.notify()
 }
}

/** 声明可能先于原生 entry 到达；跟随 entry 变化处理晚到注册与插件重载。 */
export function registerNativeProcessOutcomes(slots:FlowSlots){
 let current:StoredEntry|undefined,release=()=>{},stopped=false
 const reconcile=()=>{
  if(stopped)return
  const native=slots.entries('conversation.chat.flow').find(entry=>(entry.options.priority??0)===0)
  if(native===current)return
  release();current=native
  release=native?retainNativeProcessOutcome(slots,native):()=>{}
 }
 const off=slots.subscribe('conversation.chat.flow',reconcile)
 reconcile()
 return ()=>{if(stopped)return;stopped=true;off();release()}
}
