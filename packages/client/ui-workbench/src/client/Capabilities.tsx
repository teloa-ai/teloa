import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, ChevronRight, FileText, Layers, Library, LockKeyhole, Plug, RefreshCw, ScrollText, Search, X } from 'lucide-react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BindingClient } from './binding-client.js'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { isCapabilitySnapshot, type CapabilitySnapshot } from '@teloa/contract'
import css from './Capabilities.module.css'
import {ComposerPopover,ComposerSubmenu} from './ComposerPopover.js'
import menuCss from './ComposerPopover.module.css'
import type { HomeResourceSelection } from './home-resource-selection.js'
import type { HomeSkillSelection } from './prompt-preparation.js'
import type {TeloaI18n} from './i18n/index.js'
import {formatDateTime} from './i18n/format.js'
import {localizeWorkError} from './i18n/errors.js'

export type WorkInjected={work:BindingClient}
type I18nInjected={i18n:TeloaI18n}

export const capabilityTabs=['knowledge','skill','connection'] as const
export type CapabilityTab=typeof capabilityTabs[number]
const tabLabelKeys={knowledge:'capabilities.picker.tab.knowledge',skill:'capabilities.picker.tab.skill',connection:'capabilities.picker.tab.connection'} as const
const manageKeys={knowledge:'capabilities.picker.manage.knowledge',skill:'capabilities.picker.manage.skill',connection:'capabilities.picker.manage.connection'} as const
/** 一次带入的上限由 PromptPreparation 定死，这里先拦住，避免用户勾完才拿到通用错误。 */
const SELECTION_LIMIT=8

export type CapabilityCandidate={key:string;id:string;title:string;description:string;detail:string;blocked:boolean}

/** 候选项只来自本次会话的能力快照：知识取 knowledge.resources，技能取 skills，连接取 connections.tools。 */
export function capabilityCandidates(snapshot:CapabilitySnapshot|undefined,tab:CapabilityTab,category:string,query:string):CapabilityCandidate[]{
  if(!snapshot)return []
  const rows:CapabilityCandidate[]=tab==='knowledge'
    ?(snapshot.knowledge.status==='ready'?snapshot.knowledge.resources:[]).map(resource=>({key:'knowledge:'+resource.id,id:resource.id,title:resource.title,description:'',detail:category+' · v'+resource.version,blocked:false}))
    :tab==='skill'
      ?snapshot.skills.map(skill=>({key:'skill:'+skill.name,id:skill.name,title:skill.name,description:skill.description,detail:category+' · '+skill.source+' · '+skill.provider,blocked:!skill.userInvocable}))
      :(snapshot.connections.status==='observed'?snapshot.connections.tools:[]).map(tool=>({key:'connection:'+tool.name,id:tool.name,title:tool.name,description:tool.description,detail:category,blocked:true}))
  const needle=query.trim().toLowerCase()
  return needle?rows.filter(row=>(row.title+row.description+row.detail).toLowerCase().includes(needle)):rows
}

export type CapabilitySelection={sessionId:string;title:string;skills:HomeSkillSelection[];resources:HomeResourceSelection[]}
let selectionHandler:((input:CapabilitySelection)=>void)|undefined
/** 选择器挂在原生会话插槽里，拿不到工作台外壳的注入；由外壳登记带入通道（preparation.prepare）。 */
export function registerCapabilitySelection(handler:(input:CapabilitySelection)=>void){selectionHandler=handler;return ()=>{if(selectionHandler===handler)selectionHandler=undefined}}
export const capabilitySelectionHandler=()=>selectionHandler

export function Capabilities({sessionId,work,i18n,openResources,openTeamCapabilities,openMcpConnections}:PropsRuntime<'conversation.input.left'> & WorkInjected & I18nInjected & {openResources:()=>void;openTeamCapabilities:()=>void;openMcpConnections?:()=>void}) {
  const {locale}=useSyncExternalStore(i18n.subscribe,i18n.getSnapshot),t=i18n.t
  const [open,setOpen]=useState(false)
  const [tab,setTab]=useState<CapabilityTab|null>(null),[focusRequest,setFocusRequest]=useState(0)
  const [query,setQuery]=useState('')
  const [ids,setIds]=useState<string[]>([])
  const [error,setError]=useState('')
  const anchor=useRef<HTMLButtonElement>(null),knowledgeAnchor=useRef<HTMLButtonElement>(null),skillAnchor=useRef<HTMLButtonElement>(null),connectionAnchor=useRef<HTMLButtonElement>(null),id=useId()
  const anchors={knowledge:knowledgeAnchor,skill:skillAnchor,connection:connectionAnchor}
  const icons={knowledge:FileText,skill:ScrollText,connection:Plug}
  const state=useSyncExternalStore(work.subscribe,work.getSnapshot)
  const active=state.sessionId===sessionId
  const snapshot=active?state.capabilities:undefined
  useEffect(()=>{setIds([]);setOpen(false);setTab(null)},[sessionId])
  const expand=(key:CapabilityTab,focus=false)=>{if(key!==tab)setQuery('');setTab(key);setFocusRequest(value=>focus?Math.max(1,value+1):0)}
  const close=()=>{setOpen(false);setError('')}
  const category=t(tabLabelKeys[tab??'knowledge'])
  const rows=capabilityCandidates(snapshot,tab??'knowledge',category,query)
  const toggle=(key:string)=>setIds(old=>old.includes(key)?old.filter(value=>value!==key):[...old,key])
  const skills=(snapshot?.skills??[]).filter(skill=>skill.userInvocable&&ids.includes('skill:'+skill.name)).map(skill=>({name:skill.name,source:skill.source,provider:skill.provider}))
  const resources=(snapshot?.knowledge.status==='ready'?snapshot.knowledge.resources:[]).filter(resource=>ids.includes('knowledge:'+resource.id)).map(resource=>({id:resource.id,version:resource.version,title:resource.title}))
  const chosen=skills.length+resources.length
  const overLimit=skills.length>SELECTION_LIMIT||resources.length>SELECTION_LIMIT
  const apply=()=>{
    const handler=capabilitySelectionHandler()
    if(!handler){setError(t('capabilities.picker.unavailable'));return}
    try{handler({sessionId,title:t('capabilities.title'),skills,resources});close()}
    catch(caught){setError(localizeWorkError(locale,caught))}
  }
  return <div className={css.anchor}>
    <button ref={anchor} type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>{setOpen(value=>!value);setTab(null);setError('');if(active)void work.readCatalog()}}><Library size={16}/>{t('capabilities.title')}</button>
    {open&&<ComposerPopover cascade anchor={anchor} id={id} label={t('capabilities.title')} width={280} close={close}>
      <div className={menuCss.contextMenu}>
        <header className={menuCss.contextHeader}><strong>{t('capabilities.title')}</strong><button type="button" aria-label={t('capabilities.catalog.refresh')} disabled={!active||state.status!=='ready'||state.catalogStatus==='loading'} onClick={()=>void work.readCatalog()}><RefreshCw size={15}/></button><button type="button" aria-label={t('capabilities.close')} onClick={()=>{close();anchor.current?.focus()}}><X size={16}/></button></header>
        {error&&<p role="alert">{error}</p>}
        {!active||state.status==='loading'?<p role="status">{t('capabilities.binding.loading')}</p>:state.status==='failed'?<div role="alert"><p>{localizeWorkError(locale,state.error)}</p><button type="button" onClick={()=>void work.retry()}>{t('capabilities.binding.retry')}</button></div>:<>
          {capabilityTabs.map(key=>{const Icon=icons[key];return <button ref={anchors[key]} key={key} type="button" aria-expanded={tab===key} aria-controls={tab===key?id+'-list':undefined} onPointerEnter={event=>{if(event.pointerType==='mouse'&&window.innerWidth>740)expand(key)}} onKeyDown={event=>{if(event.key==='ArrowRight'){event.preventDefault();expand(key,true)}}} onClick={()=>expand(key,true)}><Icon size={17}/><span>{t(tabLabelKeys[key])}</span><ChevronRight size={15}/></button>})}
          <hr/>
          <button type="button" onPointerEnter={()=>setTab(null)} onClick={()=>{close();openTeamCapabilities()}}><Layers size={17}/><span>{t('home.manageCapabilities')}</span></button>
          <button type="button" onPointerEnter={()=>setTab(null)} onClick={()=>{close();openResources()}}><FileText size={17}/><span>{t('home.openLibrary')}</span></button>
        </>}
        <p className={css.scope}>{t('conversationStatus.capabilityScope')}</p>
        {chosen>0&&<footer className={css.footer}><span aria-live="polite">{t('capabilities.picker.selected',{count:chosen})}</span><button type="button" className={css.apply} disabled={overLimit} onClick={apply}>{t('capabilities.picker.apply')}</button></footer>}
        {overLimit&&<p role="alert">{t('capabilities.picker.limit')}</p>}
      </div>
      {tab&&<ComposerSubmenu key={tab} anchor={anchors[tab]} id={id+'-list'} label={category} back={()=>setTab(null)} focusRequest={focusRequest}>
        <div className={css.picker}>
          <header className={menuCss.contextHeader}><button type="button" aria-label={t('home.contextBack')} onClick={()=>{setTab(null);anchors[tab].current?.focus()}}><ArrowLeft size={16}/></button><strong>{category}</strong></header>
          <label className={css.search}><Search size={15}/><input aria-label={t('capabilities.picker.searchAria')} value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('capabilities.picker.searchPlaceholder')}/></label>
          {state.catalogStatus==='loading'&&<p role="status">{t('capabilities.catalog.loading')}</p>}
          {state.catalogStatus==='failed'&&<p role="alert">{localizeWorkError(locale,state.catalogError)}</p>}
          {tab==='knowledge'&&snapshot&&snapshot.knowledge.status==='unavailable'&&<p role="alert">{localizeWorkError(locale,snapshot.knowledge.message)}</p>}
          <div className={css.options} aria-label={t('capabilities.picker.listAria',{category})}>
            {rows.map(row=><label key={row.key} className={css.option} data-selected={ids.includes(row.key)} data-unavailable={row.blocked}>
              <span className={css.optionText}><strong>{row.title}</strong>{row.description&&<span title={row.description}>{row.description}</span>}<small>{row.detail}</small>{row.blocked&&<span className={css.blocked}><LockKeyhole size={12}/>{t(tab==='connection'?'capabilities.picker.connectionBlocked':'capabilities.skill.agent')}</span>}</span>
              <input type="checkbox" aria-label={t('capabilities.picker.selectAria',{title:row.title})} checked={ids.includes(row.key)} disabled={row.blocked} onChange={()=>toggle(row.key)}/>
            </label>)}
            {rows.length===0&&<p className={css.empty}>{t('capabilities.picker.empty',{category})}</p>}
          </div>
          <div className={css.management}><button type="button" className={css.link} onClick={()=>{close();if(tab==='knowledge')openResources();else openTeamCapabilities()}}>{t(manageKeys[tab])}</button>{tab==='connection'&&openMcpConnections&&<button type="button" className={css.link} onClick={()=>{close();openMcpConnections()}}>{t('market.catalog.connector.manageMcpConnections' as Parameters<typeof t>[0])}</button>}</div>
        </div>
      </ComposerSubmenu>}
    </ComposerPopover>}
  </div>
}

function ConnectionCatalog({connections,i18n}:Pick<CapabilitySnapshot,'connections'>&I18nInjected){
  const t=i18n.t
  return <div className={css.notConnected}><strong>{t('capabilities.connections.title')}</strong>
    {connections.status==='not-connected'?<p>{t('capabilities.connections.missing')}</p>:connections.tools.length===0?<p>{t('capabilities.connections.empty')}</p>:<ul className={css.list}>{connections.tools.map(tool=><li key={tool.name}><strong>{tool.name}</strong><p>{tool.description}</p></li>)}</ul>}
    <small className={css.muted}>{t('capabilities.connections.boundary')}</small>
  </div>
}

export function BindingStatus({sessionId,useInput,work,i18n}:PropsRuntime<'conversation.input.dock'> & WorkInjected & I18nInjected) {
  useSyncExternalStore(i18n.subscribe,i18n.getSnapshot)
  const t=i18n.t
  const state=useSyncExternalStore(work.subscribe,work.getSnapshot)
  const pendingAttachments=useInput(input=>input.attachmentIds.length)
  if(state.sessionId!==sessionId||state.status==='idle')return null
  if(state.status==='ready'&&pendingAttachments===0)return null
  return <div className={css.binding} role={state.status==='failed'?'alert':'status'}>
    {state.status!=='ready'&&<span>{state.status==='loading'?t('capabilities.binding.loadingDetailed'):localizeWorkError(i18n.getSnapshot().locale,state.error)}</span>}
    {state.status==='failed'&&<button type="button" className={css.trigger} onClick={()=>void work.retry()}>{t('capabilities.binding.retry')}</button>}
    {pendingAttachments>0&&<span>{t('capabilities.attachments.pending',{count:pendingAttachments})}</span>}
  </div>
}

export function CapabilitiesToolCard({block,inspect,work,i18n}:ToolCallViewProps & WorkInjected & I18nInjected) {
  const {locale}=useSyncExternalStore(i18n.subscribe,i18n.getSnapshot),t=i18n.t
  const settled='kind' in block
  const content=settled?block.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'):undefined
  const [openError,setOpenError]=useState<string>()
  let snapshot:CapabilitySnapshot|undefined
  if(content&&settled&&!block.isError){try{const value:unknown=JSON.parse(content);if(isCapabilitySnapshot(value))snapshot=value}catch{/* 不把不完整或旧格式误当作空目录。 */}}
  const open=async()=>{if(!snapshot)return;setOpenError(undefined);try{await work.openConversation(snapshot.conversation)}catch(error){setOpenError(localizeWorkError(locale,error))}}
  return <section className={css.toolCard} aria-label={t('capabilities.tool.aria')}>
    <strong>{t(!settled?'capabilities.tool.loading':block.isError?'capabilities.tool.failed':'capabilities.tool.result')}</strong>
    {snapshot?<>
      <p>{t('capabilities.tool.summary',{count:snapshot.skills.length})}</p>
      {snapshot.skills.length>0&&<ul>{snapshot.skills.map(skill=><li key={skill.name}>{skill.name} · {skill.description}</li>)}</ul>}
      <p className={css.muted}>{t('capabilities.tool.observed',{time:formatDateTime(locale,snapshot.observedAt,{dateStyle:'medium',timeStyle:'short'})})}</p>
      <ConnectionCatalog connections={snapshot.connections} i18n={i18n}/>
      <button type="button" className={css.trigger} onClick={()=>void open()}>{t('capabilities.tool.open')}</button>
    </>:content&&<details><summary>{t(settled&&block.isError?'capabilities.tool.failureDetails':'capabilities.tool.raw')}</summary><pre>{content}</pre></details>}
    {openError&&<p role="alert">{openError}</p>}
    {inspect&&<button type="button" className={css.trigger} onClick={inspect}>{t('capabilities.tool.inspect')}</button>}
  </section>
}
