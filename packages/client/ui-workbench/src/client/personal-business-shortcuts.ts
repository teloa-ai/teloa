import type {BusinessTarget} from './business-preview.js'

/** 左栏只固定稳定的业务范围与面板位置；对象和单条记录会失效，不作为快捷入口。看板有固定地址，可按看板标识单独固定。 */
export type BusinessShortcutTarget=Pick<BusinessTarget,'scope'|'section'|'dashboardId'>
export type BusinessShortcut={target:BusinessShortcutTarget}

const key='teloa.personal-business-shortcuts/v1'
export const businessShortcutLimit=8
const sections=new Set<BusinessShortcutTarget['section']>(['overview','projects','data','work','analysis','execution','dashboards'])
const dashboardIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/

/** 没有看板标识时键形与旧版逐字相同，旧存储值照读、照去重。 */
export const businessShortcutKey=(target:BusinessShortcutTarget)=>JSON.stringify(target.dashboardId===undefined?[target.scope,target.section]:[target.scope,target.section,target.dashboardId])

export function normalizeBusinessShortcutTarget(value:unknown):BusinessShortcutTarget|undefined{
  if(!value||typeof value!=='object')return undefined
  const scope=Reflect.get(value,'scope'),section=Reflect.get(value,'section')
  if(typeof scope!=='string'||!scope.trim()||typeof section!=='string'||!sections.has(section as BusinessShortcutTarget['section']))return undefined
  // 看板标识只随看板栏目走，且形如声明标识；其余栏目带来的一律丢弃，不作废整条。
  const dashboardId=Reflect.get(value,'dashboardId')
  const keep=section==='dashboards'&&typeof dashboardId==='string'&&dashboardIdPattern.test(dashboardId)
  return {scope:scope.trim(),section:section as BusinessShortcutTarget['section'],...(keep?{dashboardId}:{})}
}

export function normalizeBusinessShortcuts(value:unknown):BusinessShortcut[]{
  if(!Array.isArray(value))return []
  const seen=new Set<string>(),shortcuts:BusinessShortcut[]=[]
  for(const row of value){
    const target=normalizeBusinessShortcutTarget(row&&typeof row==='object'&&'target' in row?Reflect.get(row,'target'):row)
    if(!target||seen.has(businessShortcutKey(target))||shortcuts.length===businessShortcutLimit)continue
    seen.add(businessShortcutKey(target));shortcuts.push({target})
  }
  return shortcuts
}

export type BusinessShortcutChange={type:'pin';target:BusinessShortcutTarget}|{type:'unpin';target:BusinessShortcutTarget}

export function changeBusinessShortcuts(current:readonly BusinessShortcut[],change:BusinessShortcutChange):BusinessShortcut[]{
  const shortcuts=normalizeBusinessShortcuts(current),target=normalizeBusinessShortcutTarget(change.target)
  if(!target)return shortcuts
  const targetKey=businessShortcutKey(target),index=shortcuts.findIndex(shortcut=>businessShortcutKey(shortcut.target)===targetKey)
  if(change.type==='unpin')return index<0?shortcuts:shortcuts.filter((_,itemIndex)=>itemIndex!==index)
  if(index>=0||shortcuts.length===businessShortcutLimit)return shortcuts
  return [...shortcuts,{target}]
}

function read():BusinessShortcut[]{
  if(typeof window==='undefined')return []
  try{return normalizeBusinessShortcuts(JSON.parse(window.localStorage.getItem(key)??'null'))}catch{return []}
}

let snapshot=read()
const listeners=new Set<()=>void>()
const emit=()=>{for(const listener of listeners)listener()}
const refresh=()=>{const next=read();if(JSON.stringify(next)===JSON.stringify(snapshot))return;snapshot=next;emit()}
const write=(next:BusinessShortcut[])=>{if(typeof window!=='undefined')window.localStorage.setItem(key,JSON.stringify(next));snapshot=next;emit()}

export const personalBusinessShortcuts={
  subscribe(listener:()=>void){
    listeners.add(listener)
    if(listeners.size===1&&typeof window!=='undefined')window.addEventListener('storage',refresh)
    return ()=>{listeners.delete(listener);if(!listeners.size&&typeof window!=='undefined')window.removeEventListener('storage',refresh)}
  },
  getSnapshot:()=>snapshot,
  pin(target:BusinessShortcutTarget){write(changeBusinessShortcuts(snapshot,{type:'pin',target}))},
  unpin(target:BusinessShortcutTarget){write(changeBusinessShortcuts(snapshot,{type:'unpin',target}))},
  toggle(target:BusinessShortcutTarget){
    const normalized=normalizeBusinessShortcutTarget(target)
    if(!normalized)return
    const exists=snapshot.some(shortcut=>businessShortcutKey(shortcut.target)===businessShortcutKey(normalized))
    write(changeBusinessShortcuts(snapshot,{type:exists?'unpin':'pin',target:normalized}))
  },
}
