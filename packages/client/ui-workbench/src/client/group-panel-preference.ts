import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

/** closed 表示本人主动关闭；没有记录才是“此前无偏好”。 */
export type GroupPanelPreference={schema:'teloa.group-panel/v1';kind:'overview'|'materials'|'members'|'closed';tab:'work'|'members'}
export type GroupPanelViewport='wide'|'regular'|'narrow'
const key=(groupId:string)=>'teloa.group-panel/v1/'+groupId

/** 仅保存当前群的面板选择；正文、话题、资料和授权仍从各自原来源读取。 */
export function readGroupPanelPreference(storage:WorkbenchNavigationStorage|undefined,groupId:string):GroupPanelPreference|undefined{
 try{
  const raw=storage?.getItem(key(groupId))
  if(!raw)return
  const value:unknown=JSON.parse(raw)
  if(!value||typeof value!=='object')return
  const {schema,kind,tab}=value as {schema?:unknown;kind?:unknown;tab?:unknown}
  if(schema!=='teloa.group-panel/v1'||typeof kind!=='string'||typeof tab!=='string'||!['start','overview','materials','members','closed'].includes(kind)||!['work','members'].includes(tab))return
  return {schema,kind:kind==='start'?'overview':kind as GroupPanelPreference['kind'],tab:tab as GroupPanelPreference['tab']}
 }catch{/* 偏好不可读不影响原群会话。 */}
}

export function writeGroupPanelPreference(storage:WorkbenchNavigationStorage|undefined,groupId:string,value:Omit<GroupPanelPreference,'schema'>|undefined):void{
 try{
  if(value)storage?.setItem(key(groupId),JSON.stringify({schema:'teloa.group-panel/v1',...value}))
  else storage?.removeItem(key(groupId))
 }catch{/* 偏好不可写时仍允许当前面板正常打开或关闭。 */}
}

/** 宽屏允许默认并栏；目录是否让位由工作台按实际宽度派生。窄屏面板会盖住讨论，无窗口环境按常规宽度处理。 */
export function readGroupPanelViewport(view:{matchMedia?:(query:string)=>{matches:boolean}}|undefined=typeof window==='undefined'?undefined:window):GroupPanelViewport{
 try{
  if(!view?.matchMedia)return 'regular'
  if(view.matchMedia('(min-width: 1381px)').matches)return 'wide'
  return view.matchMedia('(max-width: 740px)').matches?'narrow':'regular'
 }catch{return 'regular'}
}

/** 进入群时的面板：本人保存的选择优先；无偏好时宽屏进入工作概览；窄屏不自动盖住讨论。 */
export function initialGroupPanel(preference:GroupPanelPreference|undefined,viewport:GroupPanelViewport):{open:boolean;kind:'overview'|'materials'|'members';tab:'work'|'members'}{
 const tab=preference?.tab??'work'
 if(preference?.kind==='closed')return {open:false,kind:'overview',tab}
 const kind=preference?.kind??'overview'
 return {open:viewport!=='narrow'&&(!!preference||viewport==='wide'),kind,tab}
}
