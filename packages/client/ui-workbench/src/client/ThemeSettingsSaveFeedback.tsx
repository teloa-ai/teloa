import {Fragment,createElement,useSyncExternalStore,type ComponentType} from 'react'
import {createSnapshotStore} from '@deepseek-ai/dsh-client-store'
import type {Context} from '@deepseek-ai/cordis'
import type {StoredEntry} from '@deepseek-ai/dsh-client-ui-slots'
import type {ThemeSettings,FontRole,ThemePreference} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {themeSettingsSaveCopy} from './theme-settings-save-copy.js'

type Failure='unknown'|null
type RowId='appearance'|'font-size'
type Pending={id:RowId;token:object}|null
// 固定版公开 ThemeSettings 字段；角色不能变成任意配置路径。
const sizeFields={text:'fontSize',code:'codeFontSize',terminal:'terminalFontSize'} as const
const familyFields={text:'textFontFamily',code:'codeFontFamily',terminal:'terminalFontFamily'} as const
const genericFamilies=new Set(['serif','sans-serif','monospace','cursive','fantasy','system-ui','ui-serif','ui-sans-serif','ui-monospace','ui-rounded','emoji','math','fangsong','-apple-system','blinkmacsystemfont'])

/** rc.2 公开 normalizeFontFamily 契约的窄兼容；发布包未导出该函数的值入口。 */
function normalizedFamily(value:string):string{
 return value.split(',').flatMap(part=>{
  const name=part.replace(/["'\\<>\u0000-\u001f\u007f]/gu,'').replace(/\s+/gu,' ').trim()
  return name?[genericFamilies.has(name.toLowerCase())?name:`"${name}"`]:[]
 }).join(', ')
}

/** 复用官方控件与共享 store；只让显式保存回调消费官方布尔回执。 */
export function installThemeSettingsSaveFeedback(ctx:Context):()=>void{
 return ctx.slots.inject('settings.general.item',()=>{
  const form=ctx.configForms.get<ThemeSettings>('ui-theme')
  const pending=createSnapshotStore<Pending>(null)
  const installed=new Map<RowId,{source:StoredEntry;dispose:()=>void}>()
  let live=true
  const entries=()=>ctx.slots.entries('settings.general.item')
  const install=(id:RowId,source:StoredEntry)=>{
   const Native=source.component as ComponentType<object>,failure=createSnapshotStore<Failure>(null)
   let active=true,operation=0
   const current=()=>{
    if(!live||!active||!entries().includes(source))return false
    try{return ctx.configForms.get<ThemeSettings>('ui-theme')===form}catch{return false}
   }
   const save=async(field:keyof ThemeSettings,value:string|number)=>{
    if(!current()||pending.getSnapshot()||form.getSnapshot().value?.[field]===value)return
    const own=++operation,token={};failure.set(null);pending.set({id,token})
    // 公开布尔回执已折叠Host拒绝和传输失败；false不能证明原写入没有生效。
    try{const accepted=await form.set(field,value);if(current()&&own===operation)failure.set(accepted?null:'unknown')}
    catch{if(current()&&own===operation)failure.set('unknown')}
    finally{if(live&&pending.getSnapshot()?.token===token)pending.set(null)}
   }
   const localeSubscribe=(notify:()=>void)=>ctx.locale.subscribe(notify),localeSnapshot=()=>ctx.locale.getSnapshot().active
   // View 与原组件引用在同一注册期间保持稳定，错误回执不重挂展开区或输入框。
   const View=(props:object)=>{
    const error=useSyncExternalStore(failure.subscribe,failure.getSnapshot)
    const locale=useSyncExternalStore(localeSubscribe,localeSnapshot)
    const saving=useSyncExternalStore(pending.subscribe,pending.getSnapshot),copy=themeSettingsSaveCopy(locale)
    return createElement(Fragment,null,
     createElement('fieldset',{disabled:saving!==null,'aria-busy':saving!==null,style:{border:0,padding:0,margin:0,minWidth:0}},createElement(Native,props)),
     saving?.id===id?createElement('p',{role:'status'},copy.saving):null,
     error?createElement('p',{role:'alert'},copy[error]):null)
   }
   const remove=ctx.slots.register({name:'settings.general.item',id,priority:-100,...(source.options.order===undefined?{}:{order:source.options.order}),store:source.store!,locale:'settings.theme',inject:(actions:unknown)=>{
    // 原 inject 绑定主题插件的 bound/fontBound，必须使用同一 store 的真实 actions。
    const face=source.inject!(actions as never)
    if(id==='appearance'){
     if(typeof face.setTheme!=='function')throw Error('原生外观设置接口暂不可用。')
     return {...face,setTheme:(value:ThemePreference)=>{if(['light','dark','system'].includes(value))void save('preference',value)}}
    }
    if(typeof face.setFontSize!=='function'||typeof face.setFontFamily!=='function')throw Error('原生字体设置接口暂不可用。')
    return {...face,
     setFontSize:(role:FontRole,value:number)=>{if(Object.hasOwn(sizeFields,role))void save(sizeFields[role],value)},
     setFontFamily:(role:FontRole,value:string)=>{if(Object.hasOwn(familyFields,role))void save(familyFields[role],normalizedFamily(value))},
    }
   }},View)
   return ()=>{active=false;operation++;remove()}
  }
  const refresh=()=>{
   if(!live)return
   const rows=entries()
   for(const id of ['appearance','font-size'] as const){
    const next=rows.find(entry=>entry.options.id===id&&(entry.options.priority??0)===0&&entry.locale==='settings.theme'&&typeof entry.component==='function'&&entry.inject&&entry.store&&!entry.children)
    const previous=installed.get(id)
    if(previous?.source===next)continue
    previous?.dispose();installed.delete(id)
    if(next)installed.set(id,{source:next,dispose:install(id,next)})
   }
  }
  const off=ctx.slots.subscribe('settings.general.item',refresh);refresh()
  return ()=>{live=false;off();for(const row of installed.values())row.dispose();installed.clear()}
 })
}
