import {useCallback,useEffect,useMemo,useState,type FormEvent} from 'react'
import clsx from 'clsx'
import type {BundledExtensionState,BundledExtensionView} from '@teloa/contract'
import {imChannelKinds,imCredentialFields,type ImBindingSummary,type ImChannelErrorCode,type ImChannelKind,type ImChannelSummary,type ImDefaultTarget,type ImGroupBindingSummary} from '@teloa/contract'
import type {ImChannelsApi} from './im-channels-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import tokens from './theme-tokens.module.css'
import css from './ImChannelsSettingsPage.module.css'

type Option={id:string;name:string}
type Pairing={channelId:string;code:string;expiresAt:string}
export type ImChannelsSettingsProps={api:ImChannelsApi;roles:()=>Promise<Option[]>;groups:()=>Promise<Option[]>;extension?:{read:()=>Promise<BundledExtensionView|undefined>}}

const kindLabel={feishu:'imChannels.kind.feishu',lark:'imChannels.kind.lark',telegram:'imChannels.kind.telegram',slack:'imChannels.kind.slack',stub:'imChannels.kind.stub'} as const
const fieldLabel={
 TELEGRAM_BOT_TOKEN:'imChannels.field.TELEGRAM_BOT_TOKEN',
 SLACK_BOT_TOKEN:'imChannels.field.SLACK_BOT_TOKEN',
 SLACK_APP_TOKEN:'imChannels.field.SLACK_APP_TOKEN',
 FEISHU_APP_ID:'imChannels.field.FEISHU_APP_ID',
 FEISHU_APP_SECRET:'imChannels.field.FEISHU_APP_SECRET',
 FEISHU_ENCRYPT_KEY:'imChannels.field.FEISHU_ENCRYPT_KEY',
 // Lark 与飞书同名字段，界面用同一组词条。
 LARK_APP_ID:'imChannels.field.FEISHU_APP_ID',
 LARK_APP_SECRET:'imChannels.field.FEISHU_APP_SECRET',
 LARK_ENCRYPT_KEY:'imChannels.field.FEISHU_ENCRYPT_KEY',
 STUB_TOKEN:'imChannels.field.STUB_TOKEN',
} as const
const statusLabel={connected:'imChannels.status.connected',disconnected:'imChannels.status.disconnected',error:'imChannels.status.error',disabled:'imChannels.status.disabled'} as const
/** 状态错误码 → 词条（审查 L4）：只按码本地化，码以外的值一律显示「未知问题」，不显示原文。 */
const errorLabel={
 'app-id-unsupported':'imChannels.statusError.appIdUnsupported',
 'another-host':'imChannels.statusError.anotherHost',
 'credentials-invalid':'imChannels.statusError.credentialsInvalid',
 'credentials-missing':'imChannels.statusError.credentialsMissing',
 reconnecting:'imChannels.statusError.reconnecting',
 'sdk-missing':'imChannels.statusError.sdkMissing',
 'sdk-install-failed':'imChannels.statusError.sdkInstallFailed',
 'start-failed':'imChannels.statusError.startFailed',
 unknown:'imChannels.statusError.unknown',
} as const satisfies Record<ImChannelErrorCode,string>
const errorKey=(code:string|undefined)=>Object.hasOwn(errorLabel,code??'')?errorLabel[code as ImChannelErrorCode]:errorLabel.unknown
const channelState=(channel:ImChannelSummary)=>channel.status.error?'error':!channel.enabled?'disabled':channel.status.connected?'connected':'disconnected'
const targetValue=(target:ImDefaultTarget)=>target.kind==='assistant'?'assistant':`role:${target.roleId}`
const clock=(ms:number)=>{const seconds=Math.ceil(ms/1000);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`}

/** 首次保存要下载飞书开发包（飞书与 Lark 共用）：下载或保存失败时按种类给白话提示。 */
const installFailedLabel={feishu:'imChannels.feishuInstallFailed',lark:'imChannels.larkInstallFailed'} as const
/** 保存失败的专门提示：App ID 已被另一渠道使用（宿主 details.reason）、飞书／Lark 开发包下载失败；其余返回 undefined 交给通用错误。 */
export function imSaveFailureKey(kind:ImChannelKind,cause:unknown){
 if(!cause||typeof cause!=='object')return undefined
 const details='details' in cause?cause.details:undefined
 if(details&&typeof details==='object'&&'reason' in details&&details.reason==='app-id-in-use')return 'imChannels.appIdInUse' as const
 if((kind==='feishu'||kind==='lark')&&'code' in cause&&cause.code==='teloa/dependency-unavailable')return installFailedLabel[kind]
 return undefined
}
/** Lark 开发者后台：固定官方地址，不来自任何输入。 */
const larkConsoleUrl='https://open.larksuite.com/app'

/** 添加渠道表单里按种类显示的准备说明：飞书提示首次下载开发包；Lark 另给开发者后台地址。 */
export function ImChannelKindNotes({kind}:{kind:ImChannelKind}){
 const {t}=useI18n()
 if(kind==='feishu')return <p className={css.muted}>{t('imChannels.feishuInstall')}</p>
 if(kind==='lark')return <>
  <p className={css.muted}>{t('imChannels.larkSetup')} <a href={larkConsoleUrl} target="_blank" rel="noreferrer">open.larksuite.com/app</a></p>
  <p className={css.muted}>{t('imChannels.larkInstall')}</p>
 </>
 return null
}

export const pairingRefreshMs=3000
/** 配对码有效期内定期刷新绑定列表，让 IM 侧配对成功后自动出现；到期或调用返回的停止函数即停，刷新失败静默等下一轮。 */
export function pollBindingsUntil(expiresAt:number,refresh:()=>Promise<unknown>):()=>void{
 const timer=setInterval(()=>{
  if(Date.now()>=expiresAt){clearInterval(timer);return}
  refresh().catch(()=>{})
 },pairingRefreshMs)
 return ()=>clearInterval(timer)
}

export type ImChannelsSettingsViewProps={
 channels:ImChannelSummary[]|undefined
 bindings:ImBindingSummary[]
 groupBindings:ImGroupBindingSummary[]
 roles:Option[]
 groups:Option[]
 pairing:Pairing|undefined
 /** 配对码倒计时到 0 已从状态中清掉。 */
 pairingExpired:boolean
 copied:boolean
 now:number
 busy:boolean
 savingKind:ImChannelKind|undefined
 error:string|undefined
 recovery:boolean
 discarded:boolean
 onSave:(kind:ImChannelKind,credentials:Record<string,string>)=>Promise<boolean>
 onToggle:(channel:ImChannelSummary)=>void
 onRemove:(channelId:string)=>void
 onPair:(channelId:string)=>void
 onCopy:()=>void
 onChangeTarget:(binding:ImBindingSummary,target:ImDefaultTarget)=>void
 onUnbind:(binding:ImBindingSummary)=>void
 onBindGroup:(channelId:string,chatId:string,groupId:string)=>Promise<boolean>
 onUnbindGroup:(row:ImGroupBindingSummary)=>void
 onRetry:()=>void
 onDiscard:()=>void
}

/** 纯展示：凭据输入框不受控（不进 React 状态、不写 value 属性），提交时读表单后立即重置。 */
export function ImChannelsSettingsView(props:ImChannelsSettingsViewProps){
 const {t}=useI18n()
 const {channels=[],busy}=props
 const [kind,setKind]=useState<ImChannelKind>('telegram')
 const [confirmRemove,setConfirmRemove]=useState<string>()
 const enabled=channels.filter(channel=>channel.enabled)
 // 正式三种之外的种类（验收桩）只在宿主已列出该渠道时出现：宿主仅在浏览器验收环境预置它。
 const kinds=[...imChannelKinds,...channels.map(channel=>channel.kind).filter(value=>!(imChannelKinds as readonly string[]).includes(value))]
 const [pairChannel,setPairChannel]=useState<string>()
 const pairTarget=enabled.find(channel=>channel.channelId===pairChannel)?.channelId??enabled[0]?.channelId
 const label=(channelId:string)=>{const row=channels.find(channel=>channel.channelId===channelId);return row?t(kindLabel[row.kind]):channelId}
 const remaining=props.pairing?Date.parse(props.pairing.expiresAt)-props.now:0

 const submitCredentials=async(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault()
  const form=event.currentTarget,data=new FormData(form),credentials:Record<string,string>={}
  for(const field of imCredentialFields[kind]){const value=String(data.get(field.key)??'').trim();if(value)credentials[field.key]=value}
  if(await props.onSave(kind,credentials))form.reset()
 }
 const submitGroup=async(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault()
  const form=event.currentTarget,data=new FormData(form)
  if(await props.onBindGroup(String(data.get('channelId')??''),String(data.get('chatId')??'').trim(),String(data.get('groupId')??'')))form.reset()
 }

 return <section aria-label={t('imChannels.title')} className={clsx(tokens.tokens,css.page)}>
  <p className={css.lead}>{t('imChannels.description')}</p>
  {props.recovery&&<div className={css.notice} role="status">
   <span>{t('imChannels.recovery.pending')} {t('recovery.nextStep')}</span>
   <span className={css.actions}>
    <button type="button" className={css.button} disabled={busy} onClick={props.onRetry}>{t('imChannels.recovery.retry')}</button>
    <button type="button" className={css.button} disabled={busy} onClick={props.onDiscard}>{t('recovery.discard')}</button>
   </span>
  </div>}
  {props.discarded&&<p className={css.muted} role="status">{t('recovery.discarded')}</p>}
  {props.error&&<p className={css.alert} role="alert">{props.error}</p>}

  <div className={css.section}>
   <h3 className={css.title}>{t('imChannels.channels.title')}</h3>
   {channels.length===0?<p className={css.muted}>{t('imChannels.channels.empty')}</p>:<ul className={css.list}>
    {channels.map(channel=>{const state=channelState(channel);return <li key={channel.channelId} className={css.row}>
     <span className={css.rowText}>
      <strong>{t(kindLabel[channel.kind])}</strong>
      <span className={css.status}><span className={clsx(css.dot,css[state])} aria-hidden="true"/>{t(statusLabel[state])}{state==='error'&&<span className={css.reason}>{t(errorKey(channel.status.error))}</span>}</span>
      {channel.credentialsSaved&&<span className={css.pill}>{t('imChannels.saved')}</span>}
     </span>
     <span className={css.actions}>
      <input className={css.switch} type="checkbox" role="switch" aria-label={channel.enabled?t('imChannels.disable'):t('imChannels.enable')} checked={channel.enabled} disabled={busy} onChange={()=>props.onToggle(channel)}/>
      {confirmRemove===channel.channelId
       ?<><button type="button" className={clsx(css.button,css.danger)} disabled={busy} onClick={()=>{setConfirmRemove(undefined);props.onRemove(channel.channelId)}}>{t('imChannels.removeConfirm')}</button>
        <button type="button" className={css.button} onClick={()=>setConfirmRemove(undefined)}>{t('imChannels.cancel')}</button></>
       :<button type="button" className={css.button} disabled={busy} onClick={()=>setConfirmRemove(channel.channelId)}>{t('imChannels.remove')}</button>}
     </span>
    </li>})}
   </ul>}
  </div>

  <form className={css.section} onSubmit={submitCredentials} autoComplete="off">
   <h3 className={css.title}>{t('imChannels.add')}</h3>
   <label className={css.field}><span>{t('imChannels.kind.label')}</span>
    <select className={css.input} value={kind} disabled={busy} onChange={event=>setKind(event.target.value as ImChannelKind)}>
     {kinds.map(value=><option key={value} value={value}>{t(kindLabel[value])}</option>)}
    </select>
   </label>
   {imCredentialFields[kind].map(field=><label key={`${kind}:${field.key}`} className={css.field}>
    <span>{t(fieldLabel[field.key as keyof typeof fieldLabel])}{field.required?'':` · ${t('imChannels.optional')}`}</span>
    <input className={css.input} name={field.key} type="password" autoComplete="off" spellCheck={false} required={field.required} disabled={busy}/>
   </label>)}
   <ImChannelKindNotes kind={kind}/>
   <span className={css.actions}>
    <button type="submit" className={clsx(css.button,css.primary)} disabled={busy}>{props.savingKind?t('imChannels.saving'):t('imChannels.save')}</button>
   </span>
  </form>

  <div className={css.section}>
   <h3 className={css.title}>{t('imChannels.pairing.title')}</h3>
   {enabled.length===0?<p className={css.muted}>{t('imChannels.pairing.needChannel')}</p>:<span className={css.actions}>
    {enabled.length>1&&<select className={css.input} aria-label={t('imChannels.kind.label')} value={pairTarget} disabled={busy} onChange={event=>setPairChannel(event.target.value)}>
     {enabled.map(channel=><option key={channel.channelId} value={channel.channelId}>{t(kindLabel[channel.kind])}</option>)}
    </select>}
    <button type="button" className={css.button} disabled={busy||!pairTarget} onClick={()=>pairTarget&&props.onPair(pairTarget)}>{t('imChannels.pairing.create')}</button>
   </span>}
   {props.pairing&&(remaining>0
    ?<div className={css.pairing}>
     <span className={css.code}>{props.pairing.code}</span>
     <span className={css.muted}>{t('imChannels.pairing.expiresIn',{time:clock(remaining)})}</span>
     <span className={css.muted}>{t('imChannels.pairing.hint',{channel:label(props.pairing.channelId),code:props.pairing.code})}</span>
     <span className={css.actions}><button type="button" className={css.button} onClick={props.onCopy}>{t('imChannels.pairing.copy')}</button></span>
    </div>
    :<p className={css.muted}>{t('imChannels.pairing.expired')}</p>)}
   {!props.pairing&&props.pairingExpired&&<p className={css.muted}>{t('imChannels.pairing.expired')}</p>}
   {props.copied&&!props.pairing&&<p className={css.muted}>{t('imChannels.pairing.copied')}</p>}
  </div>

  <div className={css.section}>
   <h3 className={css.title}>{t('imChannels.target.label')}</h3>
   {props.bindings.length===0?<p className={css.muted}>{t('imChannels.bindings.empty')}</p>:<ul className={css.list} aria-label={t('imChannels.bindings.title')}>
    {props.bindings.map(binding=><li key={`${binding.channelId}:${binding.imUserId}`} className={css.row}>
     <span className={css.rowText}><strong>{binding.displayName||binding.imUserId}</strong><span className={css.muted}>{label(binding.channelId)}</span></span>
     <span className={css.actions}>
      <select className={css.input} aria-label={t('imChannels.target.label')} value={targetValue(binding.target)} disabled={busy} onChange={event=>{const value=event.target.value;props.onChangeTarget(binding,value==='assistant'?{kind:'assistant'}:{kind:'role',roleId:value.slice(5)})}}>
       <option value="assistant">{t('imChannels.target.assistant')}</option>
       {props.roles.length>0&&<optgroup label={t('imChannels.target.role')}>{props.roles.map(role=><option key={role.id} value={`role:${role.id}`}>{role.name}</option>)}</optgroup>}
      </select>
      <button type="button" className={css.button} disabled={busy} onClick={()=>props.onUnbind(binding)}>{t('imChannels.bindings.unbind')}</button>
     </span>
    </li>)}
   </ul>}
  </div>

  <details className={css.section}>
   <summary className={css.title}>{t('imChannels.groups.title')}</summary>
   {channels.length>0&&<form className={css.inline} onSubmit={submitGroup} autoComplete="off">
    <select className={css.input} name="channelId" aria-label={t('imChannels.kind.label')} disabled={busy}>
     {channels.map(channel=><option key={channel.channelId} value={channel.channelId}>{t(kindLabel[channel.kind])}</option>)}
    </select>
    <input className={css.input} name="chatId" placeholder={t('imChannels.groups.chatId')} aria-label={t('imChannels.groups.chatId')} required disabled={busy}/>
    <select className={css.input} name="groupId" aria-label={t('imChannels.groups.group')} required disabled={busy}>
     {props.groups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}
    </select>
    <button type="submit" className={css.button} disabled={busy||props.groups.length===0}>{t('imChannels.groups.bind')}</button>
   </form>}
   {props.groupBindings.length===0?<p className={css.muted}>{t('imChannels.groups.empty')}</p>:<ul className={css.list}>
    {props.groupBindings.map(row=><li key={`${row.channelId}:${row.chatId}`} className={css.row}>
     <span className={css.rowText}><strong>{props.groups.find(group=>group.id===row.groupId)?.name??row.groupId}</strong><span className={css.muted}>{label(row.channelId)} · {row.chatId}</span></span>
     <span className={css.actions}><button type="button" className={css.button} disabled={busy} onClick={()=>props.onUnbindGroup(row)}>{t('imChannels.groups.unbind')}</button></span>
    </li>)}
   </ul>}
  </details>

  <div className={css.section}>
   <h3 className={css.title}>{t('imChannels.limits.title')}</h3>
   <ul className={css.limits}><li>{t('imChannels.limits.workbenchCard')}</li><li>{t('imChannels.limits.restart')}</li></ul>
  </div>
 </section>
}

function ImChannelsActive({api,roles,groups}:ImChannelsSettingsProps){
 const {t,locale}=useI18n()
 const [channels,setChannels]=useState<ImChannelSummary[]>()
 const [bindings,setBindings]=useState<ImBindingSummary[]>([])
 const [groupBindings,setGroupBindings]=useState<ImGroupBindingSummary[]>([])
 const [roleRows,setRoleRows]=useState<Option[]>([])
 const [groupRows,setGroupRows]=useState<Option[]>([])
 const [pairing,setPairing]=useState<Pairing>()
 const [pairingExpired,setPairingExpired]=useState(false)
 /** 最近一个配对码的到期时刻；「复制并隐藏」后码不再显示，但用户正要去 IM 发码，轮询继续到期为止。 */
 const [pairingUntil,setPairingUntil]=useState<number>()
 const [copied,setCopied]=useState(false)
 const [now,setNow]=useState(()=>Date.now())
 const [busy,setBusy]=useState(false)
 const [savingKind,setSavingKind]=useState<ImChannelKind>()
 const [error,setError]=useState<string>()
 const [recovery,setRecovery]=useState(()=>!!api.pending()||!!api.recoveryMessage())
 const [discarded,setDiscarded]=useState(false)
 const describe=useCallback((cause:unknown)=>cause&&typeof cause==='object'&&'code' in cause?localizeWorkError(locale,cause):t('imChannels.error.generic'),[locale,t])

 const refresh=useCallback(async()=>{
  const [nextChannels,nextBindings,nextGroups]=await Promise.all([api.channels(),api.bindings(),api.groups()])
  setChannels(nextChannels);setBindings(nextBindings);setGroupBindings(nextGroups)
  setRecovery(!!api.pending()||!!api.recoveryMessage())
 },[api])
 useEffect(()=>{
  let cancelled=false
  refresh().catch(cause=>{if(!cancelled)setError(describe(cause))})
  roles().then(rows=>{if(!cancelled)setRoleRows(rows)}).catch(()=>{})
  groups().then(rows=>{if(!cancelled)setGroupRows(rows)}).catch(()=>{})
  return ()=>{cancelled=true}
 },[api])
 useEffect(()=>{
  if(!pairing)return
  // 倒计时到 0：配对码从状态里清掉，不再留在页面（审查 L3）。
  const timer=setInterval(()=>{const current=Date.now();setNow(current);if(current>=Date.parse(pairing.expiresAt)){clearInterval(timer);setPairing(undefined);setPairingExpired(true)}},1000)
  return ()=>clearInterval(timer)
 },[pairing])

 useEffect(()=>pairingUntil===undefined?undefined:pollBindingsUntil(pairingUntil,()=>api.bindings().then(setBindings)),[api,pairingUntil])

 const run=async(action:()=>Promise<unknown>,failure?:(cause:unknown)=>string)=>{
  setBusy(true);setError(undefined)
  try{await action();await refresh();return true}
  catch(cause){setError(failure?.(cause)??describe(cause));setRecovery(!!api.pending()||!!api.recoveryMessage());return false}
  finally{setBusy(false)}
 }

 return <ImChannelsSettingsView channels={channels} bindings={bindings} groupBindings={groupBindings} roles={roleRows} groups={groupRows}
  pairing={pairing} pairingExpired={pairingExpired} copied={copied} now={now} busy={busy} savingKind={savingKind} error={error} recovery={recovery} discarded={discarded}
  onSave={async(kind,credentials)=>{
   setSavingKind(kind)
   try{return await run(()=>api.save({kind,credentials}),cause=>{const key=imSaveFailureKey(kind,cause);return key?t(key):describe(cause)})}
   finally{setSavingKind(undefined)}
  }}
  onToggle={channel=>void run(()=>channel.enabled?api.disable(channel.channelId):api.enable(channel.channelId))}
  onRemove={channelId=>void run(()=>api.remove(channelId))}
  onPair={channelId=>void run(async()=>{const code=await api.createPairing(channelId);setCopied(false);setPairingExpired(false);setNow(Date.now());setPairing({channelId,...code});setPairingUntil(Date.parse(code.expiresAt))})}
  onCopy={()=>{
   if(!pairing)return
   void navigator.clipboard?.writeText(pairing.code).catch(()=>{})
   setPairing(undefined);setCopied(true)
  }}
  onChangeTarget={(binding,target)=>void run(()=>api.changeTarget(binding.channelId,binding.imUserId,target))}
  onUnbind={binding=>void run(()=>api.removeBinding(binding.channelId,binding.imUserId))}
  onBindGroup={(channelId,chatId,groupId)=>run(()=>api.bindGroup(channelId,chatId,groupId))}
  onUnbindGroup={row=>void run(()=>api.unbindGroup(row.channelId,row.chatId))}
  onRetry={()=>void run(()=>api.recover())}
  onDiscard={()=>{api.discard();setRecovery(false);setDiscarded(true);setError(undefined)}}
 />
}
type NoticeState=Exclude<BundledExtensionState,'active'>|'unreadable'
// IM 随平台加载；未就绪只重试，不再引导安装或启停插件。
export function ImChannelsExtensionNotice({onRetry}:{state:NoticeState;onRetry?:()=>void}){
 const {t}=useI18n()
 return <section className={css.section} aria-label={t('imChannels.title')}>
  <h2 className={css.title}>{t('imChannels.title')}</h2>
  <p className={css.notice} role="status">{t('bundledExtensions.im.builtinUnavailable')}</p>
  {onRetry&&<button type="button" className={css.button} onClick={onRetry}>{t('bundledExtensions.retry')}</button>}
 </section>
}
/**
 * im/* 仍回 dependency-unavailable（扩展已卸下或没挂上）时通知重读状态；错误照常抛给原页面呈现。
 * 同步方法（pending、recoveryMessage、discard）保持同步返回，只给返回 Promise 的调用挂拒绝处理。
 */
export function guardImUnavailable<T extends object>(api:T,onUnavailable:()=>void):T{
 const rethrow=(error:unknown):never=>{if(error&&typeof error==='object'&&'code' in error&&error.code==='teloa/dependency-unavailable')onUnavailable();throw error}
 return Object.fromEntries(Object.entries(api).map(([key,value])=>[key,typeof value!=='function'?value:(...args:unknown[])=>{
  let result:unknown
  try{result=value.apply(api,args)}catch(error){return rethrow(error)}
  return result instanceof Promise?result.catch(rethrow):result
 }])) as T
}
/**
 * 宿主刚起时 IM 还在等待注入 teloaWork（上游提示 pending (waiting for service: teloaWork)），这段时间读到的是 failed；
 * 先保持「正在读取」隔一会儿重读，重读完仍是 failed 才如实显示。读取抛错由调用方按读不到处理。
 */
export async function readExtensionStateSettled(read:()=>Promise<BundledExtensionView|undefined>,wait:()=>Promise<void>,rechecks=3):Promise<BundledExtensionState|'unreadable'>{
 for(let left=rechecks;;left--){
  const state=(await read())?.state??'unreadable'
  if(state!=='failed'||left<=0)return state
  await wait()
 }
}
/** 核对内置 IM 就绪状态；就绪即进入渠道配置，失败保留重试。 */
export function ImChannelsSettingsPage(props:ImChannelsSettingsProps){
 const {t}=useI18n()
 const [state,setState]=useState<BundledExtensionState|'loading'|'unreadable'>(props.extension?'loading':'active')
 const [attempt,setAttempt]=useState(0)
 const reread=useCallback(()=>{setState('loading');setAttempt(value=>value+1)},[])
 useEffect(()=>{
  if(!props.extension)return
  let cancelled=false
  readExtensionStateSettled(props.extension.read,()=>new Promise(done=>setTimeout(done,2000))).then(next=>{if(!cancelled)setState(next)}).catch(()=>{if(!cancelled)setState('unreadable')})
  return ()=>{cancelled=true}
 },[props.extension,attempt])
 const api=useMemo(()=>props.extension?guardImUnavailable(props.api,reread):props.api,[props.api,props.extension,reread])
 if(state==='loading')return <p className={css.muted} role="status">{t('bundledExtensions.im.loading')}</p>
 if(state!=='active')return <ImChannelsExtensionNotice state={state} onRetry={reread}/>
 return <ImChannelsActive {...props} api={api}/>
}
