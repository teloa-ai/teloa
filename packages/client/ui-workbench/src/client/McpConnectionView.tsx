// 受管 MCP 连接详情与设置视图：纯展示组件 + 有状态包装。
// 凭据字段 write-only：type="password"，不预填，提交后清空。
// OAuth：授权链接只以新窗口外链展示，由负责人点击，不自动跳转；错误只显示计划附录固定文案。
import {useEffect,useRef,useState,type ReactNode} from 'react'
import type {ConnectorAuthSecretVar,MarketCatalogConnectorEntry} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {ManagedMcpConnectionApi,ManagedMcpConnectionRecord,ManagedMcpOAuthStatus} from './mcp-connections-api.js'
import {oauthAuthorizationUrlAllowed} from './mcp-connections-api.js'
import {catalogText,oauthAllowlistBlocked,oauthFullAccessToken} from './MarketCatalogSection.js'
import {catalogAlternatives,catalogEntrySource,loadCatalogListing,type MarketCatalogApi,type MarketCatalogItem} from './market-catalog-api.js'
import css from './McpConnectionView.module.css'

/** 凭据字段 key 命名规则，必须与 managed-mcp-connections 宿主侧一致；basic 返回密码槽，用户名槽见 basicUserCredentialKey。 */
export function credentialKey(v:ConnectorAuthSecretVar,serverName:string):string{
 if(v.target==='env')return v.envVarName
 if(v.target==='bearer')return `bearer_${serverName}`
 if(v.target==='header')return `header_${serverName}__${v.name.toLowerCase()}`
 if(v.target==='basic')return `basic_pass_${serverName}`
 return `url_path_${serverName}`
}
export const basicUserCredentialKey=(serverName:string)=>`basic_user_${serverName}`

type Translate=(key:string,params?:Record<string,string|number>)=>string

/** 宿主固定文案（计划附录）→ 词条；按片段匹配，宿主原文从不直接展示 */
const oauthErrorKeys:readonly (readonly [string,string])[]=[
 ['OAuth 授权被取消或拒绝','market.catalog.connector.oauthErrorDenied'],
 ['OAuth 凭据无效或授权码已过期','market.catalog.connector.oauthErrorExchange'],
 ['OAuth 回调验证失败','market.catalog.connector.oauthErrorState'],
 ['授权已过期或被吊销','market.catalog.connector.oauthErrorExpired'],
 ['oauth.publicCallbackUrl','market.catalog.connector.oauthErrorPublicCallback'],
 ['厂商只允许白名单审批的客户端','market.catalog.connector.oauthErrorAllowlist'],
]
function oauthErrorKey(message:unknown):string|undefined{
 return typeof message==='string'?oauthErrorKeys.find(([fragment])=>message.includes(fragment))?.[1]:undefined
}
/** 宿主 connectFailureReason 的固定文案（授权后建连失败），整句命中才按原文显示 */
const connectFailureTexts:readonly string[]=['无法连接到服务：请检查网络或服务是否可用。','服务返回错误，连接未建立；请稍后重试。']
/** 密钥或授权被拒绝：新旧两版宿主原文（旧版已落盘在连接记录里）都按界面语言显示同一条词条 */
const connectRejectedTexts:readonly string[]=['凭据被拒绝：请检查凭据是否正确、是否已过期或权限不足。','密钥或授权被拒绝：请检查密钥是否正确、授权是否已过期或权限不足。']
/** 连接记录上的 OAuth 错误：附录文案或建连固定文案之一，否则固定兜底 */
export function oauthRecordErrorText(t:Translate,message:unknown):string{
 const key=oauthErrorKey(message)
 if(key)return t(key)
 if(typeof message==='string'&&connectRejectedTexts.includes(message))return t('market.catalog.connector.connectRejected')
 return typeof message==='string'&&connectFailureTexts.includes(message)?message:t('error.unknown')
}
/** OAuth 请求抛出的错误：附录文案之一，否则按错误码给固定文案 */
export function oauthFailureText(t:Translate,locale:string,error:unknown):string{
 const key=oauthErrorKey(error instanceof Error?error.message:undefined)
 return key?t(key):localizeWorkError(locale,error)
}

/** 用户自带 client_id 的前端预校验：可见 ASCII、1–512 字符，并匹配配方的 clientIdPattern（宿主会再校验一次） */
export function validClientId(value:string,pattern:string|undefined):boolean{
 if(!/^[\x21-\x7e]{1,512}$/.test(value))return false
 try{return !pattern||new RegExp(pattern,'u').test(value)}catch{return false}
}

export type OAuthPollResult=ManagedMcpOAuthStatus|{status:'timeout'}|{status:'aborted'}
/** 授权进度轮询：每 3 秒查询一次，连接成功或出错即结束，5 分钟后超时；查询失败视为暂时性，继续轮询 */
export async function pollOAuthStatus(api:Pick<ManagedMcpConnectionApi,'oauthStatus'>,id:string,options:{signal?:AbortSignal;intervalMs?:number;timeoutMs?:number;sleep?:(ms:number)=>Promise<void>}={}):Promise<OAuthPollResult>{
 const intervalMs=options.intervalMs??3000,rounds=Math.ceil((options.timeoutMs??300_000)/intervalMs)
 const signal=options.signal
 // 默认 sleep 响应中止：立即结束等待并清掉计时器
 const sleep=options.sleep??(ms=>new Promise<void>(resolve=>{
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve()}
  const timer=setTimeout(done,ms)
  signal?.addEventListener('abort',done,{once:true})
 }))
 for(let round=0;round<rounds;round++){
  if(options.signal?.aborted)return {status:'aborted'}
  await sleep(intervalMs)
  if(options.signal?.aborted)return {status:'aborted'}
  try{
   const result=await api.oauthStatus(id)
   if(result.status!=='pending-oauth')return result
  }catch{}
 }
 return {status:'timeout'}
}

/** OAuth 登记：已有同目录记录则沿用（existing=true，调用方需提示用户输入未保存），否则 add 且只提交 oauth_client_id */
export async function registerOAuthConnection(api:Pick<ManagedMcpConnectionApi,'list'|'add'>,catalogId:string,clientId:string|undefined):Promise<{record:ManagedMcpConnectionRecord;existing:boolean}>{
 const found=(await api.list()).find(r=>r.catalogId===catalogId)
 if(found)return {record:found,existing:true}
 return {record:await api.add(catalogId,clientId?{oauth_client_id:clientId}:undefined),existing:false}
}

/**
 * 建连并在等待期间轮询记录：宿主首次安装依赖（上限 180 秒）时记录为 installing，看到即回调一次，界面据此显示「正在安装」；
 * 连接结束（成功或失败）即停止轮询，结果与错误原样交回；轮询查询失败视为暂时性，不影响连接本身。
 */
export async function connectWithInstallProgress(api:Pick<ManagedMcpConnectionApi,'connect'|'get'>,id:string,onInstalling:(record:ManagedMcpConnectionRecord)=>void,options:{intervalMs?:number;sleep?:(ms:number)=>Promise<void>}={}):Promise<ManagedMcpConnectionRecord>{
 const intervalMs=options.intervalMs??1000
 const sleep=options.sleep??(ms=>new Promise<void>(done=>setTimeout(done,ms)))
 let settled=false,reported=false
 const connecting=api.connect(id).finally(()=>{settled=true})
 const poll=async()=>{
  while(!settled){
   await sleep(intervalMs)
   if(settled)return
   try{
    const record=await api.get(id)
    if(!settled&&!reported&&record.status==='installing'){reported=true;onInstalling(record)}
   }catch{}
  }
 }
 void poll()
 return connecting
}

export type McpConnectionViewPhase=
 |{phase:'loading'}
 |{phase:'no-auth';error:string}
 |{phase:'secret-empty';vars:ConnectorAuthSecretVar[];serverName:string;error:string}
 |{phase:'connected';record:ManagedMcpConnectionRecord;deleteConfirm:boolean;oauth?:boolean}
 /** 宿主首次安装依赖中：不是建连失败，只显示进度与提示 */
 |{phase:'installing';record:ManagedMcpConnectionRecord}
 |{phase:'error';record:ManagedMcpConnectionRecord;deleteConfirm:boolean;oauth?:boolean}
 |{phase:'unsupported';reason:string}
 /** OAuth 连接器尚未登记：clientId=true 时需先填写用户自建 OAuth 应用的 client_id */
 |{phase:'oauth-new';clientId:boolean;error:string}
 /** 已登记、待授权：authorizationUrl 非空时展示外链并在后台轮询进度 */
 |{phase:'pending-oauth';record:ManagedMcpConnectionRecord;authorizationUrl:string;error:string;deleteConfirm:boolean}

export type McpConnectionViewPresentationProps={
 title:string
 migration?:ReactNode
 phase:McpConnectionViewPhase
 busy:boolean
 locale:string
 t:(key:string,params?:Record<string,string|number>)=>string
 onBack:()=>void
 onConnect:(creds?:Record<string,string>)=>void
 onDisconnect:()=>void
 onDelete:()=>void
 onDeleteConfirm:(open:boolean)=>void
 /** OAuth：登记（如需）并发起授权；clientId 只在 requiresUserClientId 时传入 */
 onAuthorize?:(clientId?:string)=>void
 /** 授权不限定 scope（令牌为全权限）：添加确认、待授权、已连接与出错界面显著提示 */
 fullAccessWarning?:boolean
}

/** 纯展示组件，无 hooks、无副作用，便于 SSR 渲染测试逐态核对。 */
export function McpConnectionViewPresentation({title,migration,phase,busy,locale,t,onBack,onConnect,onDisconnect,onDelete,onDeleteConfirm,onAuthorize=()=>{},fullAccessWarning=false}:McpConnectionViewPresentationProps){
 const fullAccess=fullAccessWarning&&<p className={css.error} role="note">{t('market.catalog.connector.oauthFullAccess')}</p>
 const formRef=useRef<HTMLFormElement>(null)
 const handleSubmit=(e:React.FormEvent)=>{
  e.preventDefault()
  if(!formRef.current)return
  const data=new FormData(formRef.current)
  const creds:Record<string,string>={}
  for(const [k,v] of data.entries())if(typeof v==='string'&&v)creds[k]=v
  formRef.current.reset()
  onConnect(creds)
 }
 if(phase.phase==='loading')return <div className={css.view}><button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button><p className={css.loading}>{t('market.catalog.connector.loading')}</p></div>
 if(phase.phase==='unsupported')return <div className={css.view}><button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button><h2 className={css.title}>{title}</h2>{migration}<p className={css.reason}>{phase.reason}</p></div>
 if(phase.phase==='no-auth')return(
  <div className={css.view}>
   <button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button>
   <h2 className={css.title}>{title}</h2>{migration}
   {phase.error&&<p className={css.error} role="alert">{phase.error}</p>}
   <div className={css.actions}><button type="button" className={`${css.btn} ${css.btnPrimary}`} disabled={busy} onClick={()=>onConnect()}>{busy?t('market.catalog.connector.connecting'):t('market.catalog.connector.testConnection')}</button></div>
  </div>
 )
 if(phase.phase==='secret-empty'){
  const{vars,serverName,error}=phase
  // 目录说明按界面语言取字段（主控裁定），未给语言时回落中文
  const text=(value:{'zh-CN':string;en:string})=>catalogText(value,locale||'zh-CN')
  return(
   <div className={css.view}>
    <button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button>
    <h2 className={css.title}>{title}</h2>{migration}
    <form ref={formRef} onSubmit={handleSubmit}>
     <fieldset className={css.fieldset} disabled={busy}>
      <legend className={css.legend}>{t('market.catalog.connector.credentialsLabel')}</legend>
      {vars.map((v,i)=>{
       const key=credentialKey(v,serverName)
       const secret=<label key={i} className={css.label}><span>{text(v.label)}</span><input className={css.input} type="password" name={key} autoComplete="new-password" required={v.required}/>{v.target==='header'&&<span className={css.reason}>{t('connector.credential.headerNote',{name:v.name})}</span>}</label>
       // basic：用户名为普通文本框（不回显已存值），密码仍为 password；两者都随表单提交后清空
       if(v.target==='basic')return <div key={i}>
        <label className={css.label}><span>{text(v.userLabel)}</span><input className={css.input} type="text" name={basicUserCredentialKey(serverName)} autoComplete="off" spellCheck={false} maxLength={256} placeholder={t('connector.credential.username')} required={v.required}/></label>
        {secret}
        <p className={css.reason}>{t('connector.credential.basicNote')}</p>
       </div>
       return secret
      })}
     </fieldset>
     {error&&<p className={css.error} role="alert">{error}</p>}
     <div className={css.actions}><button type="submit" className={`${css.btn} ${css.btnPrimary}`} disabled={busy}>{busy?t('market.catalog.connector.connecting'):t('market.catalog.connector.testConnection')}</button></div>
    </form>
   </div>
  )
 }
 const authorizeLabel=busy?t('market.catalog.connector.connecting'):t('market.catalog.connector.oauthAuthorize')
 const deleteBlock=(deleteConfirm:boolean,primary:React.ReactNode)=>deleteConfirm
  ?<div className={css.confirmBox}><p className={css.confirmText}>{t('market.catalog.connector.deleteConfirm')}</p><div className={css.actions}><button type="button" className={`${css.btn} ${css.btnDestructive}`} disabled={busy} onClick={onDelete}>{busy?t('market.catalog.connector.deleting'):t('market.catalog.connector.deleteYes')}</button><button type="button" className={css.btn} disabled={busy} onClick={()=>onDeleteConfirm(false)}>{t('market.catalog.connector.deleteNo')}</button></div></div>
  :<div className={css.actions}>{primary}<button type="button" className={`${css.btn} ${css.btnDestructive}`} disabled={busy} onClick={()=>onDeleteConfirm(true)}>{t('market.catalog.connector.delete')}</button></div>
 if(phase.phase==='oauth-new'){
  const submit=(e:React.FormEvent<HTMLFormElement>)=>{
   e.preventDefault()
   onAuthorize(phase.clientId?String(new FormData(e.currentTarget).get('oauth_client_id')??'').trim():undefined)
  }
  return(
   <div className={css.view}>
    <button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button>
    <h2 className={css.title}>{title}</h2>{migration}
    {fullAccess}
    <form onSubmit={submit}>
     {phase.clientId&&<fieldset className={css.fieldset} disabled={busy}><label className={css.label}><span>{t('market.catalog.connector.oauthClientIdLabel')}</span><input className={css.input} type="text" name="oauth_client_id" autoComplete="off" spellCheck={false} maxLength={512} required/></label></fieldset>}
     {phase.error&&<p className={css.error} role="alert">{phase.error}</p>}
     <div className={css.actions}><button type="submit" className={`${css.btn} ${css.btnPrimary}`} disabled={busy}>{authorizeLabel}</button></div>
    </form>
   </div>
  )
 }
 if(phase.phase==='pending-oauth'){
  const url=oauthAuthorizationUrlAllowed(phase.authorizationUrl)?phase.authorizationUrl:''
  return(
   <div className={css.view}>
    <button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button>
    <h2 className={css.title}>{title}</h2>{migration}
    <span className={css.status}>{t('market.catalog.connector.oauthStatusPending')}</span>
    {fullAccess}
    {phase.error&&<p className={css.error} role="alert">{phase.error}</p>}
    {url&&<div className={css.authorize}><p className={css.reason}>{t('market.catalog.connector.oauthWaiting')}</p><a className={`${css.btn} ${css.btnPrimary}`} href={url} target="_blank" rel="noopener noreferrer">{t('market.catalog.connector.oauthAuthorizeLink')}</a></div>}
    {deleteBlock(phase.deleteConfirm,!url&&<button type="button" className={`${css.btn} ${css.btnPrimary}`} disabled={busy} onClick={()=>onAuthorize()}>{authorizeLabel}</button>)}
   </div>
  )
 }
 if(phase.phase==='installing')return(
  <div className={css.view}>
   <button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button>
   <h2 className={css.title}>{title}</h2>{migration}
   <span className={css.status} role="status">{t('market.catalog.connector.installing')}</span>
   <p className={css.reason}>{t('market.catalog.connector.installingHint')}</p>
  </div>
 )
 if(phase.phase==='connected'){
  const{record,deleteConfirm}=phase
  const tools=record.tools??[]
  return(
   <div className={css.view}>
    <button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button>
    <h2 className={css.title}>{title}</h2>{migration}
    <span className={`${css.status} ${css.statusConnected}`}>{t('market.catalog.connector.statusConnected')}</span>
    {fullAccess}
    {tools.length>0&&<div className={css.tools}><p className={css.toolsTitle}>{t('market.catalog.connector.tools')}</p><ul className={css.toolList}>{tools.map(tool=><li key={tool.name} className={css.tool}><span className={css.toolName}>{tool.name}</span><span className={css.toolBadge}>{tool.readOnly?t('market.catalog.connector.toolReadOnly'):t('market.catalog.connector.toolReadWrite')}</span></li>)}</ul></div>}
    {phase.oauth&&<p className={css.reason}>{t('market.catalog.connector.oauthDisconnectHint')}</p>}
    {deleteConfirm
     ?<div className={css.confirmBox}><p className={css.confirmText}>{t('market.catalog.connector.deleteConfirm')}</p><div className={css.actions}><button type="button" className={`${css.btn} ${css.btnDestructive}`} disabled={busy} onClick={onDelete}>{busy?t('market.catalog.connector.deleting'):t('market.catalog.connector.deleteYes')}</button><button type="button" className={css.btn} disabled={busy} onClick={()=>onDeleteConfirm(false)}>{t('market.catalog.connector.deleteNo')}</button></div></div>
     :<div className={css.actions}><button type="button" className={css.btn} disabled={busy} onClick={onDisconnect}>{busy?t('market.catalog.connector.disconnecting'):t('market.catalog.connector.disconnect')}</button><button type="button" className={`${css.btn} ${css.btnDestructive}`} disabled={busy} onClick={()=>onDeleteConfirm(true)}>{t('market.catalog.connector.delete')}</button></div>}
   </div>
  )
 }
 // phase === 'error'
 const{record,deleteConfirm}=phase
 return(
  <div className={css.view}>
   <button type="button" className={css.back} onClick={onBack}>{t('market.catalog.connector.back')}</button>
   <h2 className={css.title}>{title}</h2>{migration}
   <span className={`${css.status} ${css.statusError}`}>{t('market.catalog.connector.statusError')}</span>
   {fullAccess}
   {phase.oauth
    ?<p className={css.error} role="alert">{oauthRecordErrorText(t,record.errorMessage)}</p>
    :record.errorCode
     ?<p className={css.error} role="alert">{t(record.errorCode==='install-timeout'?'market.catalog.connector.installTimeout':'market.catalog.connector.installFailed')}</p>
     :record.errorMessage&&<p className={css.error} role="alert">{connectRejectedTexts.includes(record.errorMessage)?t('market.catalog.connector.connectRejected'):record.errorMessage}</p>}
   {phase.oauth
    ?deleteBlock(deleteConfirm,<button type="button" className={`${css.btn} ${css.btnPrimary}`} disabled={busy} onClick={()=>onAuthorize()}>{busy?t('market.catalog.connector.connecting'):t('market.catalog.connector.oauthReauthorize')}</button>)
    :deleteBlock(deleteConfirm,<button type="button" className={`${css.btn} ${css.btnPrimary}`} disabled={busy} onClick={()=>onConnect()}>{busy?t('market.catalog.connector.connecting'):t(record.errorCode?'market.catalog.connector.retryConnect':'market.catalog.connector.testConnection')}</button>)}
  </div>
 )
}

export type McpConnectionViewProps={
 catalogApi?:Pick<MarketCatalogApi,'list'>
 onOpenCatalog?:(entryId:string)=>void
 catalogId:string
 entry:MarketCatalogConnectorEntry
 api:ManagedMcpConnectionApi
 onBack:()=>void
}

export function McpConnectionView({catalogId,entry,api,onBack,catalogApi,onOpenCatalog}:McpConnectionViewProps){
 const {t,locale}=useI18n()
 const [phase,setPhase]=useState<McpConnectionViewPhase>({phase:'loading'})
 const [busy,setBusy]=useState(false)
 const [connections,setConnections]=useState<ManagedMcpConnectionRecord[]>()
 const title=catalogText(entry.connector.title,locale)
 const auth=entry.connector.auth
 const serverName=entry.connector.serverName
 const oauth=auth.kind==='oauth'&&auth.supported?auth:undefined

 // 初始加载：查找已有的受管连接记录
 useEffect(()=>{
  let active=true
  setPhase({phase:'loading'});setConnections(undefined)
  void api.list().then(records=>{
   if(!active)return
   setConnections(records)
   const found=records.find(r=>r.catalogId===catalogId)
   if(found){
    if(found.status==='connected')setPhase({phase:'connected',record:found,deleteConfirm:false,oauth:!!oauth})
    else if(found.status==='installing')setPhase({phase:'installing',record:found})
    else if(found.status==='error')setPhase({phase:'error',record:found,deleteConfirm:false,oauth:!!oauth})
    else if(oauth)setPhase({phase:'pending-oauth',record:found,authorizationUrl:'',error:'',deleteConfirm:false})
    else{
     // saved but not connected
     if(auth.kind==='none')setPhase({phase:'no-auth',error:''})
     else if(auth.kind==='secret')setPhase({phase:'secret-empty',vars:auth.vars,serverName,error:''})
     else setPhase({phase:'unsupported',reason:(auth as {reason:string}).reason??''})
    }
   }else{
    if(auth.kind==='none')setPhase({phase:'no-auth',error:''})
    // 厂商白名单制且不收用户自带 client_id：暂不可用，无连接按钮
    else if(oauthAllowlistBlocked(auth))setPhase({phase:'unsupported',reason:t('market.catalog.connector.oauthErrorAllowlist')})
    else if(oauth&&entry.compatibility.status!=='unsupported')setPhase({phase:'oauth-new',clientId:!!oauth.requiresUserClientId,error:''})
    else if(auth.kind==='oauth'||entry.compatibility.status==='unsupported')setPhase({phase:'unsupported',reason:auth.kind==='oauth'?(auth as {reason:string}).reason??'':t('market.catalog.official.compatUnsupported')})
    else if(auth.kind==='secret')setPhase({phase:'secret-empty',vars:auth.vars,serverName,error:''})
    else setPhase({phase:'unsupported',reason:''})
   }
  },error=>{
   if(!active)return
   setPhase({phase:'no-auth',error:localizeWorkError(locale,error)})
  })
  return()=>{active=false}
 },[api,catalogId])

 // 进页时宿主已在安装（本页没有发起连接）：每 2 秒查一次，装完或失败即切到对应状态
 const installingId=phase.phase==='installing'&&!busy?phase.record.id:''
 useEffect(()=>{
  if(!installingId)return
  let active=true
  const timer=setInterval(()=>{
   void api.get(installingId).then(record=>{
    if(!active||record.status==='installing')return
    if(record.status==='connected')setPhase({phase:'connected',record,deleteConfirm:false})
    else if(record.status==='error')setPhase({phase:'error',record,deleteConfirm:false})
    else if(auth.kind==='secret')setPhase({phase:'secret-empty',vars:auth.vars,serverName,error:''})
    else setPhase({phase:'no-auth',error:''})
   },()=>{})
  },2000)
  return()=>{active=false;clearInterval(timer)}
 },[installingId])

 // 授权链接已展示：后台轮询进度，离开页面或状态变化即停止
 const pollingId=phase.phase==='pending-oauth'&&phase.authorizationUrl?phase.record.id:''
 useEffect(()=>{
  if(!pollingId)return
  const controller=new AbortController()
  void pollOAuthStatus(api,pollingId,{signal:controller.signal}).then(async result=>{
   if(controller.signal.aborted||result.status==='aborted')return
   if(result.status==='connected'){
    try{
     const record=await api.get(pollingId)
     if(!controller.signal.aborted)setPhase({phase:'connected',record,deleteConfirm:false,oauth:true})
    }catch(error){
     if(!controller.signal.aborted)setPhase(prev=>prev.phase==='pending-oauth'?{...prev,authorizationUrl:'',error:oauthFailureText(t,locale,error)}:prev)
    }
    return
   }
   setPhase(prev=>{
    if(prev.phase!=='pending-oauth'||prev.record.id!==pollingId)return prev
    if(result.status==='error'){
     const record:ManagedMcpConnectionRecord={...prev.record,status:'error'}
     if(result.errorMessage)record.errorMessage=result.errorMessage
     return {phase:'error',record,deleteConfirm:false,oauth:true}
    }
    // 5 分钟未完成：本次授权链接作废，提示重新发起
    return {...prev,authorizationUrl:'',error:t('market.catalog.connector.oauthErrorState')}
   })
  })
  return()=>controller.abort()
 },[pollingId])

 const connect=async(creds?:Record<string,string>)=>{
  setBusy(true)
  let recordId=''
  try{
   // 查找已有记录 ID 或新建
   const records=await api.list()
   let record=records.find(r=>r.catalogId===catalogId)
   if(!record)record=await api.add(catalogId,creds)
   recordId=record.id
   const connected=await connectWithInstallProgress(api,record.id,installing=>setPhase({phase:'installing',record:installing}))
   setPhase({phase:'connected',record:connected,deleteConfirm:false})
  }catch(error){
   // 安装失败（超时或未完成）落在记录上：显示可重试的安装错误，而不是笼统的建连失败
   const latest=recordId?await api.get(recordId).catch(()=>undefined):undefined
   if(latest?.status==='error'&&latest.errorCode){setPhase({phase:'error',record:latest,deleteConfirm:false});return}
   const msg=localizeWorkError(locale,error)
   // 安装态是本次连接临时切入的：失败后回到凭据表单（secret）或无凭据连接页
   setPhase(prev=>prev.phase==='secret-empty'?{...prev,error:msg}:auth.kind==='secret'&&prev.phase==='installing'?{phase:'secret-empty',vars:auth.vars,serverName,error:msg}:{phase:'no-auth',error:msg})
  }finally{setBusy(false)}
 }
 // OAuth：必要时登记（只提交 catalogId 与用户自带的 oauth_client_id），再发起授权，只取回授权链接
 const authorize=async(clientId?:string)=>{
  if(!oauth)return
  if(phase.phase==='oauth-new'&&oauth.requiresUserClientId&&!validClientId(clientId??'',oauth.clientIdPattern)){
   setPhase({...phase,error:t('market.catalog.connector.oauthClientIdInvalid')})
   return
  }
  setBusy(true)
  let record=phase.phase==='pending-oauth'||phase.phase==='error'?phase.record:undefined
  try{
   if(!record){
    const registered=await registerOAuthConnection(api,catalogId,oauth.requiresUserClientId?clientId:undefined)
    record=registered.record
    // 已有连接而用户填了 client_id：不静默丢弃输入，提示后进入该连接的待授权态，由用户再点「去授权」
    if(registered.existing&&oauth.requiresUserClientId){setPhase({phase:'pending-oauth',record,authorizationUrl:'',error:t('market.catalog.connector.oauthExisting'),deleteConfirm:false});return}
   }
   const started=await api.oauthStart(record.id)
   if('authorizationUrl' in started)setPhase({phase:'pending-oauth',record,authorizationUrl:started.authorizationUrl,error:'',deleteConfirm:false})
   else setPhase({phase:'connected',record:await api.get(record.id),deleteConfirm:false,oauth:true})
  }catch(error){
   const msg=oauthFailureText(t,locale,error)
   if(record)setPhase({phase:'pending-oauth',record,authorizationUrl:'',error:msg,deleteConfirm:false})
   else setPhase(prev=>prev.phase==='oauth-new'?{...prev,error:msg}:prev)
  }finally{setBusy(false)}
 }
 const disconnect=async()=>{
  if(phase.phase!=='connected')return
  setBusy(true)
  try{
   const record=await api.disconnect(phase.record.id)
   if(auth.kind==='none')setPhase({phase:'no-auth',error:''})
   else if(auth.kind==='secret')setPhase({phase:'secret-empty',vars:auth.vars,serverName,error:''})
   else if(oauth)setPhase({phase:'pending-oauth',record,authorizationUrl:'',error:'',deleteConfirm:false})
   else setPhase({phase:'error',record,deleteConfirm:false})
  }catch(error){setPhase({phase:'error',record:{...phase.record,status:'error',errorMessage:localizeWorkError(locale,error)},deleteConfirm:false,oauth:!!oauth})}
  finally{setBusy(false)}
 }
 const del=async()=>{
  const id=(phase as {record:ManagedMcpConnectionRecord}).record?.id
  if(!id)return
  setBusy(true)
  try{await api.delete(id);onBack()}
  catch(error){
    const msg=localizeWorkError(locale,error)
    setPhase(prev=>{
     if(prev.phase==='connected')return{phase:'error',record:{...prev.record,status:'error',errorMessage:msg},deleteConfirm:false,oauth:!!oauth}
     if(prev.phase==='error')return{...prev,deleteConfirm:false,record:{...prev.record,errorMessage:msg}}
     if(prev.phase==='pending-oauth')return{...prev,deleteConfirm:false,error:msg}
     return prev
    })
   }
  finally{setBusy(false)}
 }
 const toggleDeleteConfirm=(open:boolean)=>setPhase(prev=>{
  if(prev.phase==='connected')return{...prev,deleteConfirm:open}
  if(prev.phase==='error')return{...prev,deleteConfirm:open}
  if(prev.phase==='pending-oauth')return{...prev,deleteConfirm:open}
  return prev
 })
 return <McpConnectionViewPresentation migration={catalogApi&&onOpenCatalog&&connections?.some(record=>record.catalogId===catalogId)?<McpConnectionMigration catalogId={catalogId} api={catalogApi} connections={connections} open={onOpenCatalog} disabled={busy}/>:null} title={title} phase={phase} busy={busy} locale={locale} t={t} onBack={onBack} onConnect={connect} onDisconnect={disconnect} onDelete={del} onDeleteConfirm={toggleDeleteConfirm} onAuthorize={authorize} fullAccessWarning={oauthFullAccessToken(entry.connector.auth)}/>
}

/** 只推荐当前目录中明确标记的官方连接器，状态来自受管连接记录。 */
export function recommendedMcpMigration(catalogId:string,items:readonly MarketCatalogItem[],connections:readonly ManagedMcpConnectionRecord[]){
 if(!connections.some(record=>record.catalogId===catalogId))return undefined
 const source=items.find(item=>item.entry.id===catalogId)
 if(source?.entry.kind!=='connector')return undefined
 const target=catalogAlternatives(source.entry,items).find(({recommended,item})=>recommended&&item.entry.kind==='connector'&&catalogEntrySource(item.entry)==='teloa'&&item.entry.compatibility.status!=='unsupported'&&!oauthAllowlistBlocked(item.entry.connector.auth))?.item
 if(target?.entry.kind!=='connector')return undefined
 return {entry:target.entry,connected:connections.some(record=>record.catalogId===target.entry.id&&record.status==='connected')}
}

// 按宿主接口缓存 Teloa 目录读取：每次进入连接页不重读整份目录；失败不缓存，重试强制重读。
const connectionCatalogCache=new WeakMap<object,Promise<MarketCatalogItem[]>>()
export function loadConnectionCatalogItems(api:Pick<MarketCatalogApi,'list'>,{refresh=false}:{refresh?:boolean}={}):Promise<MarketCatalogItem[]>{
 const cached=refresh?undefined:connectionCatalogCache.get(api)
 if(cached)return cached
 const pending=loadCatalogListing(api,'teloa').then(value=>value.items)
 connectionCatalogCache.set(api,pending)
 pending.catch(()=>{if(connectionCatalogCache.get(api)===pending)connectionCatalogCache.delete(api)})
 return pending
}

function McpConnectionMigration({catalogId,api,connections,open,disabled}:{catalogId:string;api:Pick<MarketCatalogApi,'list'>;connections:readonly ManagedMcpConnectionRecord[];open:(entryId:string)=>void;disabled:boolean}){
 const {t,locale}=useI18n()
 const [items,setItems]=useState<MarketCatalogItem[]>([]),[failed,setFailed]=useState(false),[revision,setRevision]=useState(0)
 useEffect(()=>{
  let active=true
  setItems([]);setFailed(false)
  void loadConnectionCatalogItems(api,{refresh:revision>0}).then(value=>{if(active)setItems(value)},()=>{if(active)setFailed(true)})
  return()=>{active=false}
 },[api,catalogId,revision])
 if(failed)return <p className={css.error} role="status">{t('market.catalog.official.recommendationsUnavailable')} <button type="button" className={css.btn} disabled={disabled} onClick={()=>setRevision(value=>value+1)}>{t('market.catalog.official.retry')}</button></p>
 const migration=recommendedMcpMigration(catalogId,items,connections)
 if(!migration)return null
 const title=catalogText(migration.entry.connector.title,locale)
 // 连接器只来自 Teloa 官方目录，当前连接本身就是官方连接器：只说推荐改用，不说「已有官方连接器」
 return <aside className={css.migration} aria-label={t('market.catalog.official.alternativeRecommended',{title})}>
  <strong>{t('market.catalog.official.alternativeRecommended',{title})}</strong>
  {migration.connected&&<span className={css.statusConnected}>{t('market.catalog.official.connectionReady')}</span>}
  <p>{t('market.catalog.official.connectionMigrate')}</p>
  <button type="button" className={css.btn} disabled={disabled} onClick={()=>open(migration.entry.id)}>{t('market.catalog.official.alternativeOpen',{title})}</button>
 </aside>
}
