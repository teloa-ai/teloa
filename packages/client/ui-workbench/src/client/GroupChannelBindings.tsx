import {useEffect,useState} from 'react'
import {RefreshCw} from 'lucide-react'
import type {ImChannelSummary,ImGroupBindingSummary} from '@teloa/contract'
import type {ImChannelsApi} from './im-channels-api.js'
import {useI18n} from './i18n/provider.js'
import css from './CollaborationPage.module.css'

export type GroupChannelContext={api:Pick<ImChannelsApi,'channels'|'groups'>;openSettings:()=>void}
type ChannelRead={groupId:string;channels:ImChannelSummary[];bindings:ImGroupBindingSummary[]}|{groupId:string;failed:true}

/** 只显示当前群的真实绑定。凭据、配对与绑定写入仍由原设置处理。 */
export function GroupChannelBindings({groupId,context}:{groupId:string;context?:GroupChannelContext|undefined}){
 const {t}=useI18n()
 const [read,setRead]=useState<ChannelRead>(),[revision,setRevision]=useState(0)
 useEffect(()=>{
  let active=true
  setRead(undefined)
  if(context)void Promise.all([context.api.channels(),context.api.groups()]).then(([channels,bindings])=>{
   if(active)setRead({groupId,channels,bindings:bindings.filter(binding=>binding.groupId===groupId)})
  },()=>{if(active)setRead({groupId,failed:true})})
  return ()=>{active=false}
 },[groupId,context?.api,revision])
 const current=read?.groupId===groupId?read:undefined
 return <section className={css.channelBindings}>
  <header><h3>{t('collaboration.form.tab.channels')}</h3>{context&&<button type="button" className={css.iconButton} aria-label={t('collaboration.action.refresh')} title={t('collaboration.action.refresh')} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={15}/></button>}</header>
  {!context?<p className={css.hint}>{t('collaboration.channels.unavailable')}</p>:!current?<p className={css.hint} role="status">{t('collaboration.state.loading')}</p>:'failed' in current?<p className={css.hint} role="alert">{t('collaboration.channels.failed')}</p>:current.bindings.length===0?<p className={css.hint}>{t('collaboration.channels.empty')}</p>:<div className={css.resourceList}>{current.bindings.map(binding=>{
   const channel=current.channels.find(item=>item.channelId===binding.channelId)
   const state=!channel?'unknown':!channel.enabled?'disabled':channel.status.error?'error':channel.status.connected?'connected':'disconnected'
   return <div className={css.resource} key={binding.channelId+':'+binding.chatId}><div><strong>{channel?t('imChannels.kind.'+channel.kind):binding.channelId}</strong><small>{t('collaboration.channels.externalGroup',{id:binding.chatId})}</small><small>{t('collaboration.channels.scope')}</small></div><span role="status">{t(state==='unknown'?'collaboration.channels.unknown':'imChannels.status.'+state)}</span></div>
  })}</div>}
  <p className={css.hint}>{t('collaboration.channels.settingsHint')}</p>
  {context&&<button type="button" className={css.secondary} onClick={context.openSettings}>{t('collaboration.channels.manage')}</button>}
 </section>
}
