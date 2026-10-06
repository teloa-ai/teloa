export type ApplicationPresentation=Readonly<{schema:'teloa.application-presentation/v1';product:'Free'|'Pro'|'Enterprise';account:Readonly<{displayName:string;email:string}>|null}>
import {readWorkbenchNavigationStorageScope} from './workbench-navigation-storage.ts'

import type {WorkCapability} from '@teloa/contract'
export type {WorkCapability} from '@teloa/contract'
export type ApplicationCapabilities=Readonly<{schema:'teloa.application-capabilities/v1';capabilities:Readonly<Record<WorkCapability,boolean>>;reason:null|'subscription-required'|'subscription-expired'|'checking'|'unavailable'}>
export type ApplicationBridge={presentation:()=>Promise<unknown>;openAccount:()=>Promise<unknown>;navigationStorageScope?:()=>Promise<string>;capabilities?:()=>Promise<unknown>;subscribeCapabilities?:(listener:(value:unknown)=>void)=>()=>void;openSubscription?:()=>Promise<unknown>}
declare global{interface Window{teloaApplication?:ApplicationBridge}}

const free:ApplicationPresentation=Object.freeze({schema:'teloa.application-presentation/v1',product:'Free',account:null})
const invalid=()=>Error('应用身份信息不可用。')
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)
const capabilityNames:readonly WorkCapability[]=['general-agent','parallel-agents','groups','people','automation']
const capabilitySnapshot=(advanced:boolean,reason:ApplicationCapabilities['reason']):ApplicationCapabilities=>Object.freeze({schema:'teloa.application-capabilities/v1',capabilities:Object.freeze({'general-agent':true,'parallel-agents':advanced,groups:advanced,people:advanced,automation:advanced}),reason})
const communityCapabilities=capabilitySnapshot(true,null)

// 仅使用宿主公开能力投影；业务准入仍由后端复验，不接受许可或私有账号上下文。
export function readApplicationCapabilities(value:unknown):ApplicationCapabilities{
 if(!exact(value,['schema','capabilities','reason'])||value.schema!==communityCapabilities.schema||!exact(value.capabilities,capabilityNames)||![null,'subscription-required','subscription-expired','checking','unavailable'].includes(value.reason as ApplicationCapabilities['reason']))throw invalid()
 const flags=value.capabilities
 if(capabilityNames.some(name=>typeof flags[name]!=='boolean'))throw invalid()
 return Object.freeze({schema:communityCapabilities.schema,capabilities:Object.freeze({...flags}) as ApplicationCapabilities['capabilities'],reason:value.reason as ApplicationCapabilities['reason']})
}

// 仅为宿主展示身份；版本名称不能授予业务权益或执行许可。
export function readApplicationPresentation(value:unknown):ApplicationPresentation{
 if(!exact(value,['schema','product','account'])||value.schema!==free.schema||typeof value.product!=='string'||!['Free','Pro','Enterprise'].includes(value.product))throw invalid()
 if(value.product==='Free'){if(value.account!==null)throw invalid();return free}
 if(!exact(value.account,['displayName','email'])||typeof value.account.displayName!=='string'||value.account.displayName.length>320||/[\u0000-\u001f\u007f]/.test(value.account.displayName)||!text(value.account.email,320))throw invalid()
 return Object.freeze({schema:free.schema,product:value.product as ApplicationPresentation['product'],account:Object.freeze({displayName:value.account.displayName.trim(),email:value.account.email})})
}

export function createApplicationPresentationStore(){
 let snapshot=free,capabilities=communityCapabilities,bridge:ApplicationBridge|undefined,navigationStorageScope:string|undefined,generation=0,identityRevision=0,releaseCapabilities:(()=>void)|undefined,refreshCapabilities:(()=>Promise<void>)|undefined
 const listeners=new Set<()=>void>(),publish=()=>{for(const listener of listeners)listener()}
 const refresh=async()=>{
  const current=bridge,owner=generation,revision=++identityRevision
  if(!current||snapshot.product==='Free')return
  try{
   const next=readApplicationPresentation(await current.presentation())
   if(owner!==generation||revision!==identityRevision)return
   // 同一实例只能刷新本人姓名；换号由宿主销毁并重新装配，不借旧导航范围切换归属。
   if(next.product!==snapshot.product||next.account?.email!==snapshot.account?.email)throw invalid()
   if(next.account?.displayName!==snapshot.account?.displayName){snapshot=next;publish()}
  }catch{if(owner===generation&&revision===identityRevision){capabilities=capabilitySnapshot(false,'unavailable');publish()}}
 }
 return {
  getSnapshot:()=>snapshot,
  getCapabilitySnapshot:()=>capabilities,
  can:(capability:WorkCapability)=>capabilities.capabilities[capability],
  async refresh(){const owner=generation;await refreshCapabilities?.();if(owner===generation)await refresh()},
  getNavigationStorageScope:()=>navigationStorageScope,
  subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener)}},
  async configure(candidate?:ApplicationBridge){
   const owner=++generation
   releaseCapabilities?.();releaseCapabilities=undefined;refreshCapabilities=undefined
   bridge=undefined;navigationStorageScope=undefined;snapshot=free;capabilities=candidate===undefined?communityCapabilities:capabilitySnapshot(false,'checking');publish()
   if(candidate!==undefined&&(!candidate||typeof candidate.presentation!=='function'||typeof candidate.openAccount!=='function'||candidate.navigationStorageScope!==undefined&&typeof candidate.navigationStorageScope!=='function'))throw invalid()
   const next=candidate?readApplicationPresentation(await candidate.presentation()):free
   const scope=next.product!=='Free'&&candidate?.navigationStorageScope?readWorkbenchNavigationStorageScope(await candidate.navigationStorageScope()):undefined
   if(generation!==owner)throw invalid()
   bridge=candidate;navigationStorageScope=scope;snapshot=next
   capabilities=next.product==='Free'?communityCapabilities:capabilitySnapshot(false,typeof candidate?.capabilities==='function'?'checking':'unavailable');publish()
   if(next.product!=='Free'&&candidate){
    let revision=0
    const apply=(value:unknown)=>{if(generation!==owner)return;revision++;const previous=capabilities.reason;try{capabilities=readApplicationCapabilities(value)}catch{capabilities=capabilitySnapshot(false,'unavailable')}publish();if((previous==='checking'||previous==='unavailable')&&capabilities.reason!=='checking'&&capabilities.reason!=='unavailable')void refresh()}
    if(typeof candidate.subscribeCapabilities==='function')try{const release=candidate.subscribeCapabilities(apply);if(typeof release!=='function')throw invalid();releaseCapabilities=release}catch{apply(undefined)}
    if(typeof candidate.capabilities==='function'){
     const read=async()=>{const reading=revision;try{const value=await candidate.capabilities!();if(generation===owner&&revision===reading)apply(value)}catch{if(generation===owner&&revision===reading)apply(undefined)}}
     refreshCapabilities=read;await read()
    }
   }
   if(generation!==owner)throw invalid()
   return ()=>{if(generation!==owner)return;generation++;releaseCapabilities?.();releaseCapabilities=undefined;refreshCapabilities=undefined;bridge=undefined;navigationStorageScope=undefined;snapshot=free;capabilities=communityCapabilities;publish()}
  },
  async openAccount(){if(!bridge||!snapshot.account)throw invalid();await bridge.openAccount()},
  async openSubscription(){if(!bridge||!snapshot.account)throw invalid();if(bridge.openSubscription!==undefined){if(typeof bridge.openSubscription!=='function')throw invalid();await bridge.openSubscription()}else await bridge.openAccount()},
 }
}
export const applicationPresentation=createApplicationPresentationStore()
