import {readSessionCapabilitySnapshot,type WorkCapability} from '@teloa/contract'
import {applicationPresentation,type createApplicationPresentationStore} from './application-presentation.ts'

export type SessionCapabilityPresentation=Readonly<{sessionId:string|undefined;status:'idle'|'checking'|'ready'|'unavailable';requiredCapabilities:readonly WorkCapability[]|null;deniedCapability:WorkCapability|undefined}>
type ApplicationStore=ReturnType<typeof createApplicationPresentationStore>

/** 分类只从同源宿主读；不从标题、对象关联或 UUID 推导执行要求。 */
export function createSessionCapabilityPresentation(read:(sessionId:string,signal:AbortSignal)=>Promise<unknown>,application:ApplicationStore=applicationPresentation){
 let snapshot:SessionCapabilityPresentation={sessionId:undefined,status:'idle',requiredCapabilities:null,deniedCapability:undefined},generation=0,disposed=false,pending:AbortController|undefined
 const listeners=new Set<()=>void>(),publish=(value:SessionCapabilityPresentation)=>{snapshot=Object.freeze(value);for(const listener of listeners)listener()}
 const refresh=async()=>{
  if(disposed)return
  pending?.abort();pending=undefined
  const sessionId=snapshot.sessionId,owner=++generation
  if(!sessionId){publish({sessionId,status:'idle',requiredCapabilities:null,deniedCapability:undefined});return}
  if(application.getSnapshot().product==='Free'){publish({sessionId,status:'ready',requiredCapabilities:[],deniedCapability:undefined});return}
  publish({sessionId,status:'checking',requiredCapabilities:null,deniedCapability:undefined})
  const controller=new AbortController();pending=controller
  try{
   const value=readSessionCapabilitySnapshot(await read(sessionId,controller.signal))
   if(disposed||owner!==generation)return
   if(value.sessionId!==sessionId)throw Error('会话能力分类不匹配。')
   if(value.status!=='ready')throw Error('会话能力分类暂不可用。')
   publish({sessionId,status:'ready',requiredCapabilities:value.requiredCapabilities,deniedCapability:value.requiredCapabilities.find(capability=>!application.can(capability))})
  }catch{if(!disposed&&owner===generation)publish({sessionId,status:'unavailable',requiredCapabilities:null,deniedCapability:undefined})}finally{if(pending===controller)pending=undefined}
 }
 const offApplication=application.subscribe(()=>{void refresh()})
 return {
  getSnapshot:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
  select(sessionId:string|undefined){if(disposed)return;generation++;snapshot={sessionId,status:'idle',requiredCapabilities:null,deniedCapability:undefined};void refresh()},
  refresh,
  dispose(){disposed=true;generation++;pending?.abort();offApplication();listeners.clear()},
 }
}
export type SessionCapabilityReader=ReturnType<typeof createSessionCapabilityPresentation>
