import type {ConversationWorkspace} from './work-presentation.js'

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
}

/**
 * 全局会话把当前或默认执行位置交给 DSH 决定；业务空间只复用已登记的明确绑定。
 * 登记列表的第一项不代表 DSH 当前执行位置，不能据此猜测。
 */
export function resolveConversationWorkspace({workspaces,registryReady=true,scope,preferredWorkspaceId,recovering=false,pendingWorkspaceId,chooseOther=false}:ResolveInput):ConversationWorkspaceDecision{
  if(recovering)return {kind:'select',reason:'recovery',...(pendingWorkspaceId!==undefined?{initialWorkspaceId:pendingWorkspaceId}:{})}
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
