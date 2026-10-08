import type {ConversationWorkspace} from './work-presentation.js'
import {applicationPresentation} from './application-presentation.ts'

/** 宿主经应用桥声明执行位置由宿主分配；没有应用桥或未声明时由用户选择。 */
const placedByHost=()=>applicationPresentation.getExecutionPlacement()==='host-assigned'

export type ConversationWorkspaceDecision=
  |{kind:'create';workspaceId:undefined|string}
  |{kind:'select';reason:'requested'|'missing'|'ambiguous'|'recovery'|'unavailable';initialWorkspaceId?:string;staleWorkspaceId?:string}

type ResolveInput={
  workspaces:readonly ConversationWorkspace[]
  registryReady?:boolean
  scope:string|undefined
  preferredWorkspaceId?:string|undefined
  recovering?:boolean
  pendingWorkspaceId?:string|undefined
  chooseOther?:boolean
  hostAssigned?:boolean
}

/**
 * 全局会话把当前或默认执行位置交给 DSH 决定；业务空间只复用已登记的明确绑定。
 * 登记列表的第一项不代表 DSH 当前执行位置，不能据此猜测。
 * 宿主分配执行位置时一律交给宿主，不读业务绑定也不弹出选择；待恢复的创建仍由本人决定重试或另建。
 */
export function resolveConversationWorkspace({workspaces,registryReady=true,scope,preferredWorkspaceId,recovering=false,pendingWorkspaceId,chooseOther=false,hostAssigned=placedByHost()}:ResolveInput):ConversationWorkspaceDecision{
  if(recovering)return {kind:'select',reason:'recovery',...(pendingWorkspaceId!==undefined?{initialWorkspaceId:pendingWorkspaceId}:{})}
  if(hostAssigned)return {kind:'create',workspaceId:undefined}
  if(chooseOther)return {kind:'select',reason:'requested'}
  if(scope===undefined||scope==='general')return {kind:'create',workspaceId:undefined}
  if(!registryReady)return {kind:'select',reason:'unavailable'}
  if(preferredWorkspaceId){
    if(workspaces.some(row=>row.workspaceId===preferredWorkspaceId))return {kind:'create',workspaceId:preferredWorkspaceId}
    return {kind:'select',reason:workspaces.length?'ambiguous':'missing',staleWorkspaceId:preferredWorkspaceId}
  }
  if(workspaces.length===1)return {kind:'create',workspaceId:workspaces[0]!.workspaceId}
  return {kind:'select',reason:workspaces.length?'ambiguous':'missing'}
}

type HomeWorkspaceInput={
  remembered:string|null|undefined
  currentWorkspaceId:string|undefined
  workspaces:readonly Pick<ConversationWorkspace,'workspaceId'>[]
  hostAssigned?:boolean
}

/**
 * 首页待用会话的执行位置：同一待用会话沿用已发出的位置；用户选择时再取当前会话所在或唯一登记的位置，
 * 都没有就要求先选择。宿主分配时不替宿主挑选，交给宿主落位。
 */
export function resolveHomeNativeWorkspace({remembered,currentWorkspaceId,workspaces,hostAssigned=placedByHost()}:HomeWorkspaceInput):string|undefined{
  const workspaceId=remembered??(hostAssigned?undefined:currentWorkspaceId??(workspaces.length===1?workspaces[0]!.workspaceId:undefined))
  if(workspaceId)return workspaceId
  if(hostAssigned)return undefined
  throw Object.assign(Error('请先在新建会话中选择执行位置。'),{code:'teloa/home-location-required'})
}

type StorageLike={getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
type PreferenceStore={read(scope:string):string|undefined;write(scope:string,workspaceId:string):void;remove(scope:string):void}
const storageKey='teloa.conversation-workspace-preferences.v1'
const validValue=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value)

export function createConversationWorkspacePreferenceStore(storage:StorageLike|undefined):PreferenceStore{
  const readAll=():Record<string,string>=>{
    if(!storage)return {}
    try{
      const raw=storage.getItem(storageKey)
      if(!raw)return {}
      const parsed:unknown=JSON.parse(raw)
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {}
      const bindings=(parsed as {bindings?:unknown}).bindings
      if(!bindings||typeof bindings!=='object'||Array.isArray(bindings))return {}
      return Object.fromEntries(Object.entries(bindings).filter(([scope,id])=>validValue(scope)&&validValue(id)))
    }catch{return {}}
  }
  const writeAll=(bindings:Record<string,string>)=>{
    if(!storage)return
    try{
      if(Object.keys(bindings).length)storage.setItem(storageKey,JSON.stringify({bindings}))
      else storage.removeItem(storageKey)
    }catch{/* 本机偏好不可用时仍可由选择器完成本次创建。 */}
  }
  return {
    read(scope){return validValue(scope)?readAll()[scope]:undefined},
    write(scope,workspaceId){if(!validValue(scope)||!validValue(workspaceId))return;writeAll({...readAll(),[scope]:workspaceId})},
    remove(scope){if(!validValue(scope))return;const bindings=readAll();delete bindings[scope];writeAll(bindings)},
  }
}

export function browserConversationWorkspacePreferenceStore():PreferenceStore{
  let storage:StorageLike|undefined
  try{storage=globalThis.localStorage}catch{/* 受限浏览器环境回退为本次选择。 */}
  return createConversationWorkspacePreferenceStore(storage)
}
