import type {Context} from '@deepseek-ai/cordis'
import {createElement,type ComponentType} from 'react'
import type {HostObservable,InjectFace,OwnerOf,SessionIdOf,StoredEntry,Translate} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {isOwnedStandardMode,singleStandardModeOptions,standardModeName,standardModeDescription} from './standard-mode-options.js'

type Locale=HostObservable<{active:string}>&{bind:(namespace:string)=>Translate}
export type StandardPresetOption=Readonly<{id:string;name?:string;description?:string;broken?:string}>
type PresetRoster=Readonly<{options:readonly StandardPresetOption[]}>
export type StandardPresetSeat=PresetRoster&Readonly<{current:string;error:unknown;busy:boolean;introduce:boolean}>
type NativeFace={hooks:{agentPresetSeat:HostObservable<StandardPresetSeat>;developerTools:HostObservable<boolean>};load:()=>Promise<void>;select:(id:string)=>Promise<string|undefined>;dismissRefusal:(error:unknown)=>void;introduced:()=>void}
type NativeProps=OwnerOf<'conversation.hero.agentPreset'>&InjectFace<NativeFace&{t:Translate}>
type NativeLabelFace={hooks:{agentPresets:HostObservable<PresetRoster>};load:()=>Promise<void>}
type NativeLabelProps=OwnerOf<'conversation.session.header.actions'>&InjectFace<NativeLabelFace&{t:Translate}>
type PresetSection=Readonly<{status:'idle'|'loading'|'ready'|'error';saving:boolean;error:string|null;rows:readonly (StandardPresetOption&{isDefault:boolean})[]}>
type NativeSectionFace={hooks:{agentPresetSection:HostObservable<PresetSection>;developerTools:HostObservable<boolean>};load:()=>Promise<void>;view:(id:string)=>Promise<void>;closeView:()=>void;makeDefault:(id:string)=>Promise<void>;startCreatorDraft?:()=>void}
type NativeSectionProps=OwnerOf<'settings.section'>&InjectFace<NativeSectionFace&{t:Translate}>

function translatedOption<T extends StandardPresetOption>(option:T,active:string):T{
  if(!isOwnedStandardMode(option))return option
  const name=standardModeName(active)
  const description=standardModeDescription(option,active)
  return {...option,...(name?{name}:{}),...(description===undefined?{}:{description})}
}
/** 只读选择投影：旧 standard 在芯片上使用同一品牌名称，不写回其真实会话配置。 */
export function projectStandardPresetSeat<T extends PresetRoster>(state:T,active:string,selection=true):T{
 const visible=selection?singleStandardModeOptions(state.options):state.options
 const legacy=selection&&'current'in state&&state.current==='standard'&&!visible.some(option=>option.id==='standard')
 return {...state,...(legacy?{current:'teloa-standard'}:{}),options:visible.map(option=>translatedOption(option,active))}
}
export function projectStandardPresetSection<T extends PresetSection>(state:T,active:string):T{
 return {...state,rows:singleStandardModeOptions(state.rows).map(option=>translatedOption(option,active))}
}
function projectedObservable<T>(source:HostObservable<T>,locale:Locale,project:(value:T,active:string)=>T):HostObservable<T>{
 let previous:T|undefined,active:string|undefined,snapshot:T|undefined
 return {getSnapshot:()=>{const value=source.getSnapshot(),language=locale.getSnapshot().active;if(value!==previous||language!==active||!snapshot){previous=value;active=language;snapshot=project(value,language)}return snapshot},subscribe:notify=>{const sourceOff=source.subscribe(notify),localeOff=locale.subscribe(notify);return()=>{sourceOff();localeOff()}}}
}
export function standardPresetObservable<T extends PresetRoster>(source:HostObservable<T>,locale:Locale,selection=true):HostObservable<T>{
 return projectedObservable(source,locale,(state,active)=>projectStandardPresetSeat(state,active,selection))
}
const observable=(value:unknown):value is HostObservable<unknown>=>!!value&&typeof value==='object'&&'getSnapshot'in value&&typeof value.getSnapshot==='function'&&'subscribe'in value&&typeof value.subscribe==='function'
function nativeFace(source:StoredEntry,sessionId:SessionIdOf|undefined):NativeFace{
 const face=source.inject?.(sessionId as never),hooks=face?.hooks
 if(!face||!hooks||typeof hooks!=='object'||!('agentPresetSeat'in hooks)||!observable(hooks.agentPresetSeat)||!('developerTools'in hooks)||!observable(hooks.developerTools)||typeof face.load!=='function'||typeof face.select!=='function'||typeof face.dismissRefusal!=='function'||typeof face.introduced!=='function')throw Error('原生模式展示接口暂不可用。')
 return face as NativeFace
}
function nativeLabelFace(source:StoredEntry,sessionId:SessionIdOf):NativeLabelFace{
 const face=source.inject?.(sessionId as never),hooks=face?.hooks
 if(!face||!hooks||typeof hooks!=='object'||!('agentPresets'in hooks)||!observable(hooks.agentPresets)||typeof face.load!=='function')throw Error('原生会话模式展示接口暂不可用。')
 return face as NativeLabelFace
}
function nativeSectionFace(source:StoredEntry):NativeSectionFace{
 const face=source.inject?.(),hooks=face?.hooks
 if(!face||!hooks||typeof hooks!=='object'||!('agentPresetSection'in hooks)||!observable(hooks.agentPresetSection)||!('developerTools'in hooks)||!observable(hooks.developerTools)||typeof face.load!=='function'||typeof face.view!=='function'||typeof face.closeView!=='function'||typeof face.makeDefault!=='function')throw Error('模式目录展示接口暂不可用。')
 return face as NativeSectionFace
}

/** 复用公开 slot 和控制器统一目录及新任务默认，保留已有会话配置与原动作。 */
export function installStandardPresetPresentation(ctx:Context,locale:Locale):void{
 let loadStandardDefault:()=>Promise<void>=async()=>{}
 ctx.slots.inject('conversation.hero.agentPreset',()=>{
  let source:StoredEntry|undefined,remove:(()=>void)|undefined
  const projections=new WeakMap<HostObservable<StandardPresetSeat>,HostObservable<StandardPresetSeat>>()
  const refresh=()=>{
   const next=ctx.slots.entries('conversation.hero.agentPreset').find(entry=>(entry.options.priority??0)===0&&entry.locale==='settings.agentPreset'&&typeof entry.component==='function'&&entry.inject&&!entry.children&&!entry.store)
   if(next===source)return
   remove?.();remove=undefined;source=next
   if(!next)return
   const Native=next.component as ComponentType<NativeProps>
   // 原生 Host 负责会话及 Owner 份额；完整 props 原样转发，展示适配仅声明自己的注入面。
   const View=(props:NativeProps)=>createElement(Native,props)
   remove=ctx.slots.register({name:'conversation.hero.agentPreset',priority:-100,inject:(sessionId:SessionIdOf|undefined)=>{
    const face=nativeFace(next,sessionId),original=face.hooks.agentPresetSeat
    let projected=projections.get(original);if(!projected){projected=standardPresetObservable(original,locale);projections.set(original,projected)}
    // 同原词典绑定；显式注入 t 避免为上游 namespace 再声明或注册一个兼容类型。
    return {...face,load:async()=>{await loadStandardDefault();await face.load()},t:locale.bind('settings.agentPreset'),hooks:{...face.hooks,agentPresetSeat:projected}}
   }},View)
  }
  const off=ctx.slots.subscribe('conversation.hero.agentPreset',refresh);refresh()
  return()=>{off();remove?.()}
 })
 ctx.slots.inject('conversation.session.header.actions',()=>{
  let source:StoredEntry|undefined,remove:(()=>void)|undefined
  const projections=new WeakMap<HostObservable<PresetRoster>,HostObservable<PresetRoster>>()
  const refresh=()=>{
   const next=ctx.slots.entries('conversation.session.header.actions').find(entry=>entry.options.id==='agent-preset'&&(entry.options.priority??0)===0&&entry.locale==='settings.agentPreset'&&typeof entry.component==='function'&&entry.inject&&!entry.children&&!entry.store)
   if(next===source)return
   remove?.();remove=undefined;source=next
   if(!next)return
   const Native=next.component as ComponentType<NativeLabelProps>,View=(props:NativeLabelProps)=>createElement(Native,props)
   remove=ctx.slots.register({name:'conversation.session.header.actions',id:'agent-preset',...(next.options.order!==undefined?{order:next.options.order}:{}),priority:-100,inject:(sessionId:SessionIdOf)=>{
    const face=nativeLabelFace(next,sessionId),original=face.hooks.agentPresets
    let projected=projections.get(original);if(!projected){projected=standardPresetObservable(original,locale,false);projections.set(original,projected)}
    return {...face,load:async()=>{await loadStandardDefault();await face.load()},t:locale.bind('settings.agentPreset'),hooks:{...face.hooks,agentPresets:projected}}
   }},View)
  }
  const off=ctx.slots.subscribe('conversation.session.header.actions',refresh);refresh()
  return()=>{off();remove?.()}
 })
 ctx.slots.inject('settings.section',()=>{
  let source:StoredEntry|undefined,remove:(()=>void)|undefined
  let releaseSource=()=>{}
  const projections=new WeakMap<HostObservable<PresetSection>,HostObservable<PresetSection>>()
  const refresh=()=>{
   const next=ctx.slots.entries('settings.section').find(entry=>entry.options.id==='agent-presets'&&(entry.options.priority??0)===0&&entry.locale==='settings.agentPreset'&&typeof entry.component==='function'&&entry.inject&&!entry.children&&!entry.store)
   if(next===source)return
   releaseSource();remove?.();remove=undefined;source=next
   if(!next)return
   const face=nativeSectionFace(next),original=face.hooks.agentPresetSection
   let disposed=false,pending:Promise<void>|undefined,lastRows:PresetSection['rows']|undefined
   const migrate=():Promise<void>=>{
    const state=original.getSnapshot(),legacy=state.rows.find(row=>row.id==='standard'&&row.isDefault&&isOwnedStandardMode(row))
    if(disposed||state.status!=='ready'||state.saving||state.error||!legacy||!state.rows.some(row=>row.id==='teloa-standard'&&row.broken===undefined))return Promise.resolve()
    if(pending)return pending
    if(lastRows===state.rows)return Promise.resolve()
    lastRows=state.rows
    // 使用官方默认写入口；它只同步当前空白会话，不改写已有内容的会话。
    pending=Promise.resolve().then(async()=>{
     const current=original.getSnapshot()
     if(!disposed&&!current.saving&&!current.error&&current.rows===state.rows)await face.makeDefault('teloa-standard')
    }).finally(()=>{pending=undefined})
    return pending
   }
   loadStandardDefault=async()=>{await face.load();await migrate()}
   // 上游关闭开发者工具时会自动退到 standard；跟随真实目录回执迁移新任务默认。
   // 官方控制器将失败保留在原 error 状态；这里不重复发起或另造恢复记录。
   const stop=original.subscribe(()=>{void migrate().catch(()=>{})})
   releaseSource=()=>{disposed=true;stop();loadStandardDefault=async()=>{}}
   void migrate().catch(()=>{})
   const Native=next.component as ComponentType<NativeSectionProps>,View=(props:NativeSectionProps)=>createElement(Native,props)
   remove=ctx.slots.register({name:'settings.section',id:'agent-presets',...(next.options.order!==undefined?{order:next.options.order}:{}),priority:-100,label:()=>locale.bind('settings.agentPreset')('nav'),inject:()=>{
    let projected=projections.get(original);if(!projected){projected=projectedObservable(original,locale,projectStandardPresetSection);projections.set(original,projected)}
    return {...face,load:loadStandardDefault,t:locale.bind('settings.agentPreset'),hooks:{...face.hooks,agentPresetSection:projected}}
   }},View)
  }
  const off=ctx.slots.subscribe('settings.section',refresh);refresh()
  return()=>{off();releaseSource();remove?.()}
 })
}
