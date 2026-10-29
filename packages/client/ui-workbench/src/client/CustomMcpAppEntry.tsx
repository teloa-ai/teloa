import {useEffect,useRef,useState} from 'react'
import {readCustomMcpDefinition,type PageCreateDraftPreview} from '@teloa/contract'
import {ContextDrawer} from './ContextDrawer.js'
import type {CustomMcpAppApi,CustomMcpPreview} from './mcp-connections-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import shared from './CreateEntry.module.css'
import css from './CustomMcpAppEntry.module.css'
import drawer from './MarketTemplateCreator.module.css'
import {CapabilityTemplateShare,useTemplateShare} from './EmployeeTemplateShare.js'
import {customConnectionShareSource} from './connection-share-source.js'

/** 密钥不进入草稿、导航存储或可恢复写请求；关闭及定义变化即清空输入。 */
function CustomMcpAppForm({api,initial,requestId,active=true,created,removed}:{api:CustomMcpAppApi;initial:CustomMcpPreview;requestId?:string;active?:boolean;created?:(id:string)=>Promise<void>;removed?:()=>void}){
 const {t,locale}=useI18n(),[preview,setPreview]=useState(initial),[url,setUrl]=useState(initial.definition.url)
 const [values,setValues]=useState<Record<string,string>>({}),[readOnly,setReadOnly]=useState(initial.connection?.tools?.filter(tool=>tool.readOnly).map(tool=>tool.name)??[])
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[confirmRemove,setConfirmRemove]=useState(false)
 const inFlight=useRef(false),generation=useRef(0)
 useEffect(()=>{generation.current++;if(!active)setValues({});return ()=>{generation.current++}},[active,initial.definitionHash,api])
 const fields=preview.definition.auth?.headers??[{name:'bearer'}]
 const canReuse=preview.authorizationConfigured&&url===preview.definition.url,entered=Object.values(values).filter(Boolean).length
 const required=preview.definition.auth!==undefined&&!canReuse
 const any=preview.definition.auth?.requirement==='any'
 const complete=!required&&!entered||(any?fields.some(field=>!!values[field.name]?.trim()):fields.every(field=>!!values[field.name]?.trim()))
 const action=async(run:()=>Promise<void>)=>{
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError(undefined);const current=generation.current
  try{await run()}catch(error){if(current===generation.current)setError(localizeWorkError(locale,error))}
  finally{inFlight.current=false;setBusy(false);setValues({})}
 }
 const connect=()=>action(async()=>{
  const definition=readCustomMcpDefinition({...preview.definition,url}),checked=await api.previewCustom(definition)
  const expectedSaved=preview.savedDefinitionHash??(preview.connection?preview.definitionHash:undefined)
  if(checked.connection&&(!expectedSaved||preview.connection&&checked.connection.id!==preview.connection.id||checked.savedDefinitionHash&&checked.savedDefinitionHash!==expectedSaved))throw Object.assign(Error('MCP definition changed'),{code:'teloa/version-conflict'})
  let connection=checked.connection??preview.connection
  if(!connection){if(!requestId)throw Error('missing creation request');connection=await api.saveCustom({requestId,definition,expectedDefinitionHash:checked.definitionHash})}
  else if(checked.definitionHash!==expectedSaved)connection=await api.updateCustom({id:connection.id,requestId:crypto.randomUUID(),definition,expectedDefinitionHash:expectedSaved??preview.definitionHash})
  // 已保存连接身份先保留；后续认证或发现失败可重试同一记录。
  setPreview({...checked,savedDefinitionHash:checked.definitionHash,connection,authorizationConfigured:canReuse})
  const credentials=Object.fromEntries(Object.entries(values).filter(([,value])=>value.length>0))
  const authorized=await api.authorizeCustom({id:connection.id,expectedDefinitionHash:checked.definitionHash,credentials,readOnlyTools:readOnly})
  setPreview({...checked,savedDefinitionHash:checked.definitionHash,connection:authorized,authorizationConfigured:true})
  const connected=await api.connect(connection.id)
  setPreview({...checked,savedDefinitionHash:checked.definitionHash,connection:connected,authorizationConfigured:true});setValues({});await created?.(connected.id)
 })
 return <form className={css.form} onSubmit={event=>{event.preventDefault();if(complete)void connect()}}>
  <label>{t('create.app.url')}<input type="url" required value={url} disabled={busy} onChange={event=>setUrl(event.target.value)}/></label>
  <p className={css.status}>{t('create.app.credentialsHint')}</p>
  {canReuse&&<p className={css.status}>{t('create.app.existingAuth')}</p>}
  {preview.definition.auth&&<p className={css.status}>{t(any?'create.app.authAny':'create.app.authAll')}</p>}
  {fields.map(field=><label key={field.name}>{field.name==='bearer'?t('create.app.optionalBearer'):field.name+(field.scheme?' · '+field.scheme:'')}<input type="password" autoComplete="off" spellCheck={false} value={values[field.name]??''} disabled={busy} onChange={event=>setValues(current=>({...current,[field.name]:event.target.value}))}/></label>)}
  {fields.some(field=>field.scheme)&&<p className={css.status}>{t('create.app.prefixHint')}</p>}
  {preview.connection?.tools?.length?<fieldset className={css.tools} disabled={busy}><legend>{t('create.app.readOnly')}</legend>{preview.connection.tools.map(tool=><div key={tool.name} className={css.tool}>
   <label><input type="checkbox" checked={readOnly.includes(tool.name)} disabled={!readOnly.includes(tool.name)&&readOnly.length>=32} onChange={event=>setReadOnly(current=>event.target.checked?[...current,tool.name]:current.filter(name=>name!==tool.name))}/>{tool.name}</label>
   <p className={css.status}>{tool.fullName}</p>
   {tool.description&&<p className={css.status}>{tool.description}</p>}
   <p className={css.status}>{t(tool.annotations?.readOnlyHint===true?'create.app.serverReadOnly':tool.annotations?.readOnlyHint===false?'create.app.serverWritable':'create.app.serverReadOnlyUnknown')}</p>
   <details><summary>{t('create.app.toolParameters')}</summary>{tool.inputSchema?<pre>{JSON.stringify(tool.inputSchema,null,2)}</pre>:<p className={css.status}>{t('create.app.parametersUnavailable')}</p>}{tool.annotations&&<pre>{JSON.stringify(tool.annotations,null,2)}</pre>}</details>
  </div>)}</fieldset>:null}
  <p className={css.status}>{t('create.app.permissionHint')}</p>
  {preview.connection?.status==='connected'&&<p role="status">{t('create.app.connected',{count:preview.connection.tools?.length??0})}</p>}
  {error&&<div className={shared.alert} role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={()=>void action(async()=>{const checked=await api.previewCustom(preview.definition);setPreview(checked);setUrl(checked.definition.url);setReadOnly(checked.connection?.tools?.filter(tool=>tool.readOnly).map(tool=>tool.name)??[])})}>{t('create.app.retry')}</button></div>}
  <div className={shared.actions}>
   <button type="submit" className={shared.confirm} disabled={busy||!active||!complete}>{t('create.app.connect')}</button>
   {preview.connection&&<><button type="button" disabled={busy} onClick={()=>void action(async()=>{const connection=await api.disconnect(preview.connection!.id);setPreview(current=>({...current,connection}))})}>{t('create.app.disconnect')}</button><button type="button" disabled={busy} onClick={()=>setConfirmRemove(true)}>{t('create.app.remove')}</button></>}
   {confirmRemove&&preview.connection&&<button type="button" disabled={busy} onClick={()=>void action(async()=>{await api.delete(preview.connection!.id);removed?.()})}>{t('create.app.confirmRemove')}</button>}
  </div>
 </form>
}

export function CustomMcpAppConfirmation({api,preview,active,apply}:{api:CustomMcpAppApi;preview:PageCreateDraftPreview;active:boolean;apply:(id:string)=>Promise<void>}){
 const {t}=useI18n(),[checked,setChecked]=useState<CustomMcpPreview>(),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0)
 useEffect(()=>{let live=true;setChecked(undefined);setFailed(false);try{const body=JSON.parse(preview.draft.body);void api.previewCustom(readCustomMcpDefinition(body.definition)).then(value=>{if(live)setChecked(value)},()=>{if(live)setFailed(true)})}catch{setFailed(true)}return ()=>{live=false}},[api,preview.draft.id,preview.draft.bodyHash,retry])
 if(failed)return <div role="alert"><p>{t('create.readFailed')}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>{t('create.app.retry')}</button></div>
 if(!checked)return <p role="status">{t('create.preview.loading')}</p>
 return <CustomMcpAppForm key={checked.definitionHash} api={api} initial={checked} requestId={preview.draft.requestId} active={active} created={apply}/>
}

export function CustomMcpAppManager({api,id,title,close}:{api:CustomMcpAppApi;id:string;title:string;close:()=>void}){
 return <ContextDrawer open title={title} close={close}><div className={drawer.body}><CustomMcpAppSettings api={api} id={id} removed={close}/></div></ContextDrawer>
}

/** 原稿与应用目录使用同一连接设置；关闭所在抽屉即销毁认证输入。 */
export function CustomMcpAppSettings({api,id,removed}:{api:CustomMcpAppApi;id:string;removed:()=>void}){
 const {t}=useI18n(),[preview,setPreview]=useState<CustomMcpPreview>(),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0)
 useEffect(()=>{let live=true;setPreview(undefined);setFailed(false);void api.getCustom(id).then(value=>{if(live)setPreview(value)},()=>{if(live)setFailed(true)});return ()=>{live=false}},[api,id,retry])
 return failed?<div role="alert"><p>{t('create.readFailed')}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>{t('create.app.retry')}</button></div>:preview?<><CustomMcpAppForm key={id+preview.definitionHash} api={api} initial={preview} removed={removed}/><CustomConnectionTemplateShare key={id+preview.definitionHash} id={id} preview={preview}/></>:<p role="status">{t('create.preview.loading')}</p>
}

/** 自定义连接复用已读取的无凭据声明；运行 URL 从不进入分享草稿。 */
function CustomConnectionTemplateShare({id,preview}:{id:string;preview:CustomMcpPreview}){
 const {t}=useI18n(),shared=useTemplateShare(),[open,setOpen]=useState(false),tools=preview.connection?.tools??[]
 if(!shared)return null
 return <><button type="button" disabled={!tools.length} onClick={()=>setOpen(true)}>{t('templateShare.shareConnection')}</button>{!tools.length&&<p className={css.status}>{t('templateShare.connectionToolsRequired')}</p>}{open&&<CapabilityTemplateShare subject="mcp" skills={[]} connections={[customConnectionShareSource(preview.definition,tools)]} open close={()=>setOpen(false)} draftKey={'custom/'+id+'/'+preview.definitionHash}/>}</>
}
