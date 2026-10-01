import {useCallback,useEffect,useState,type CSSProperties} from 'react'
import {readBusinessDefinitionBody,type BusinessCustomizationDirectory,type BusinessCustomizationEntry,type BusinessDefinitionPreview,type BusinessSourceMappingDefinition,type BusinessWidgetDefinition} from '@teloa/contract'
import type {BusinessCustomizationApi} from './business-customization-api.js'
import {ObjectTypeBlock} from './BusinessLedger.js'
import {BusinessWidget} from './BusinessWidgets.js'
import {customizationApplyGuard,customizationDraftRows,customizationFailureKey,customizationRevertOptions} from './business-customization-presentation.js'
import {useI18n} from './i18n/provider.js'
import base from './TaskPage.module.css'
import css from './BusinessCustomization.module.css'
import dashboardCss from './BusinessDashboardPage.module.css'

type Props={scope:string;api:BusinessCustomizationApi;changed:()=>void;colorScheme:'light'|'dark'}
type FailedStage='directory'|'preview'|undefined

const authoritativeEntry=(directory:BusinessCustomizationDirectory,preview:BusinessDefinitionPreview):BusinessCustomizationEntry|undefined=>directory.entries.find(entry=>entry.kind===preview.draft.kind&&entry.localId===preview.draft.localId)

/** 预览的基准说明来自服务端，不从目录版本或正文形状反推。 */
function PreviewBase({preview}:{preview:BusinessDefinitionPreview}){
 const {t}=useI18n()
 const key:'business.custom.preview.base.template'|'business.custom.preview.base.local'|'business.custom.preview.base.none'=preview.base.origin==='template'?'business.custom.preview.base.template':preview.base.origin==='local'?'business.custom.preview.base.local':'business.custom.preview.base.none'
 return <p className={css.base}>{t(key)}</p>
}

function ImpactList({label,values}:{label:string;values:readonly string[]}){
 return <div className={css.impactRow}><dt>{label}</dt><dd>{values.length?values.join(', '):'—'}</dd></div>
}

const mappingTrialRows=5

/**
 * 试算按草案种类分派，内容全部取自服务端预览回包：组件画成看板里同一张组件卡（失败只写固定词条），
 * 看板画 12 列只读网格缩略，映射列出映射后前 5 条对象的字段；取值一律作 React 文本子节点。
 * 试拉失败（规格 §5.2）：`source-disconnected` 按来源分两句（受管连接未建立 / 数据源没接上），`config-unreadable` 请用户检查配置文件，
 * `pull-failed` 固定句并保留「试拉」可重试；调用失败的原文不上屏。
 */
function DraftTrial({preview,colorScheme,busy,pull}:{preview:BusinessDefinitionPreview;colorScheme:'light'|'dark';busy:boolean;pull:()=>void}){
 const {t}=useI18n()
 if(preview.trialUnavailable==='source-disconnected'){
  const source=preview.draft.kind==='source-mapping'?(readBusinessDefinitionBody('source-mapping',JSON.parse(preview.draft.body)) as BusinessSourceMappingDefinition).source:undefined
  return <p className={css.empty} data-trial="disconnected">{source?.kind==='mcp-tool'?t('business.custom.preview.connectionMissing',{server:source.serverName}):t('business.custom.preview.sourceMissing')}</p>
 }
 if(preview.trialUnavailable==='config-unreadable')return <p className={css.empty} data-trial="config-unreadable">{t('business.custom.preview.configUnreadable')}</p>
 if(preview.trialUnavailable==='pull-failed')return <div className={css.trial} data-trial="pull-failed">
  <p className={css.empty}>{t('business.custom.preview.pullFailed')}</p>
  <button type="button" disabled={busy} onClick={pull}>{t('business.custom.preview.pull')}</button>
 </div>
 if(preview.trialUnavailable==='pull-required'){
  // 受管 MCP 工具来源：先把要调的 server / tool / 参数（取自服务端给出的草案正文）摆出来，用户点「试拉」才调一次。
  const source=(readBusinessDefinitionBody('source-mapping',JSON.parse(preview.draft.body)) as BusinessSourceMappingDefinition).source
  if(source.kind!=='mcp-tool')return null
  return <div className={css.trial} data-trial="pull">
   <p className={css.base}>{t('business.custom.preview.pullNote')}</p>
   <p className={css.call}><code>{source.serverName} / {source.tool}</code></p>
   {Object.keys(source.arguments).length>0&&<ul className={css.call}>{Object.entries(source.arguments).map(([key,value])=><li key={key}><code>{key} = {String(value)}</code></li>)}</ul>}
   <button type="button" disabled={busy} onClick={pull}>{t('business.custom.preview.pull')}</button>
  </div>
 }
 if(preview.widgetTrial){
  const widget=readBusinessDefinitionBody('widget',JSON.parse(preview.draft.body)) as BusinessWidgetDefinition
  return <div className={css.trial} data-trial="widget"><p className={css.base}>{t('business.custom.preview.widgetTrial')}</p><article className={dashboardCss.widget}><BusinessWidget widget={widget} result={preview.widgetTrial} colorScheme={colorScheme}/></article></div>
 }
 if(preview.dashboardTrial)return <div className={css.trial} data-trial="dashboard">
  <p className={css.base}>{t('business.custom.preview.dashboardTrial')}</p>
  <div className={css.layout}>{preview.dashboardTrial.layout.map(item=><span key={item.widget} style={{'--widget-column':`${item.x+1} / span ${item.w}`,'--widget-row':`${item.y+1} / span ${item.h}`} as CSSProperties}>{item.widget}</span>)}</div>
 </div>
 if(preview.mappingTrial){
  const objects=preview.mappingTrial.objects.slice(0,mappingTrialRows)
  const fields=[...new Set(objects.flatMap(object=>object.fields.map(field=>field.field)))]
  return <div className={css.trial} data-trial="mapping">
   <p className={css.base}>{t('business.custom.preview.mappingTrial',{fetched:preview.mappingTrial.fetched,shown:objects.length})}</p>
   {objects.length>0&&<div className={css.mapping}><table><thead><tr>{fields.map(field=><th scope="col" key={field}>{field}</th>)}</tr></thead><tbody>{objects.map(object=><tr key={object.objectId}>{fields.map(field=><td key={field}>{object.fields.find(item=>item.field===field)?.value??'—'}</td>)}</tr>)}</tbody></table></div>}
  </div>
 }
 if(preview.trial)return <div className={css.trial}><ObjectTypeBlock block={preview.trial} actions={[]} open={()=>{}} connect={()=>{}} /></div>
 return <p className={css.empty}>{t('business.custom.trialUnavailable')}</p>
}

/** 一份草案的预览：基准、变化、影响、试算与确认。组件试算失败时不能确认（规格 §4.4：真实试算通过后才确认）。 */
export function CustomizationPreview({scope,preview,busy,colorScheme,confirm,cancel,pull=()=>{}}:{scope:string;preview:BusinessDefinitionPreview;busy:boolean;colorScheme:'light'|'dark';confirm:()=>void;cancel:()=>void;pull?:()=>void}){
 const {t}=useI18n()
 const trialFailed=preview.widgetTrial?.status==='failed'
 return <section className={css.preview} aria-label={preview.draft.localId}>
  <header><div><span>{t(customizationDraftRows({schema:'teloa.business-customization/v1',scope,readAt:preview.computedAt,drafts:[preview.draft],entries:[]})[0]!.kindKey)}</span><h3>{preview.draft.localId}</h3></div><button type="button" disabled={busy} onClick={cancel}>{t('business.custom.cancel')}</button></header>
  <PreviewBase preview={preview}/>
  <h4>{t('business.custom.preview.diff')}</h4>
  <dl className={css.diff}><div className={css.diffHeader}><dt>{t('business.custom.preview.diff.path')}</dt><dd><span>{t('business.custom.preview.diff.before')}</span><span>{t('business.custom.preview.diff.after')}</span></dd></div>{preview.diff.map(row=><div key={row.path}><dt>{row.path}</dt><dd><del>{row.before??'—'}</del><ins>{row.after??'—'}</ins></dd></div>)}</dl>
  {preview.diffTruncated&&<p className={css.disclosure}>{t('business.custom.preview.diffTruncated')}</p>}
  <h4>{t('business.custom.preview.impact')}</h4>
  <dl className={css.impact}><ImpactList label={t('business.custom.preview.impact.scope')} values={[preview.impact.scope]}/><ImpactList label={t('business.custom.preview.impact.objectType')} values={preview.impact.objectType?[preview.impact.objectType]:[]}/><ImpactList label={t('business.custom.preview.impact.views')} values={preview.impact.views}/><ImpactList label={t('business.custom.preview.impact.actions')} values={preview.impact.actions}/><ImpactList label={t('business.custom.preview.impact.fields')} values={preview.impact.fields}/><ImpactList label={t('business.custom.preview.impact.widgets')} values={preview.impact.widgets}/><ImpactList label={t('business.custom.preview.impact.dashboards')} values={preview.impact.dashboards}/></dl>
  <h4>{t('business.custom.preview.trial')}</h4>
  <DraftTrial preview={preview} colorScheme={colorScheme} busy={busy} pull={pull}/>
  {trialFailed&&<p className={css.disclosure} role="status">{t('business.custom.preview.trialFailed')}</p>}
  <footer><button type="button" disabled={busy||trialFailed} onClick={confirm}>{busy?t('business.custom.confirm.busy'):t('business.custom.confirm')}</button><button type="button" disabled={busy} onClick={cancel}>{t('business.custom.cancel')}</button></footer>
 </section>
}

/**
 * 会话可以提出草案，但只能由这里的预览回包启用确认。确认与回退都带乐观版本，
 * 任何冲突都会强制重新读取预览，不能在旧预览上再次提交。
 */
export function BusinessCustomization({scope,api,changed,colorScheme}:Props){
 const {t}=useI18n()
 const [directory,setDirectory]=useState<BusinessCustomizationDirectory>()
 const [preview,setPreview]=useState<BusinessDefinitionPreview>()
 const [loading,setLoading]=useState(true)
 const [busy,setBusy]=useState(false)
 const [message,setMessage]=useState('')
 const [failedStage,setFailedStage]=useState<FailedStage>()
 const [previewDraftId,setPreviewDraftId]=useState<string>()

 const loadDirectory=useCallback(async(signal?:AbortSignal)=>{
  setLoading(true)
  try{
   const value=await api.directory({scope},signal)
   if(signal?.aborted)return
   setDirectory(value)
   setFailedStage(undefined)
  }catch(error){
   if(!signal?.aborted){const failure=customizationFailureKey(error);setMessage(t(failure.key,failure.params));setFailedStage('directory')}
  }finally{if(!signal?.aborted)setLoading(false)}
 },[api,scope,t])

 const loadPreview=useCallback(async(draftId:string,pull?:true)=>{
  setBusy(true)
  setMessage('')
  try{
   const value=await api.preview({draftId,...(pull?{pull}:{})})
   setPreview(value)
   setPreviewDraftId(draftId)
   setFailedStage(undefined)
   return value
  }catch(error){
   // invalid-input 把服务端原因（截 200 个码点）作文本子节点带上屏（跨声明核对失败与其他输入问题各一句），其余码只显示固定句。
   const failure=customizationFailureKey(error)
   setMessage(t(failure.key,failure.params))
   setFailedStage('preview')
   return undefined
  }finally{setBusy(false)}
 },[api,t])

 useEffect(()=>{
  const controller=new AbortController()
  setPreview(undefined)
  setPreviewDraftId(undefined)
  setMessage('')
  void loadDirectory(controller.signal)
  return ()=>controller.abort()
 },[loadDirectory])

 const retry=()=>{
  if(failedStage==='preview'&&previewDraftId)void loadPreview(previewDraftId)
  else void loadDirectory()
 }
 const cancelPreview=()=>{setPreview(undefined);setPreviewDraftId(undefined);setMessage('');setFailedStage(undefined)}

 const confirm=async()=>{
  if(!preview||!directory||preview.widgetTrial?.status==='failed')return
  const guard=customizationApplyGuard(preview,authoritativeEntry(directory,preview))
  if(!guard.ok){
   setMessage(t(guard.reason==='stale-preview'?'business.custom.conflict':'business.custom.readFailed'))
   if(guard.reason==='stale-preview')void loadPreview(preview.draft.id)
   return
  }
  setBusy(true)
  setMessage('')
  try{
   await api.apply({requestId:crypto.randomUUID(),draftId:preview.draft.id,previewReceipt:preview.receipt,...guard})
   cancelPreview()
   await loadDirectory()
   changed()
   setMessage(t('business.custom.confirmed'))
  }catch(error){
   const failure=customizationFailureKey(error)
   setMessage(t(failure.key,failure.params))
   if(failure.key==='business.custom.conflict')void loadPreview(preview.draft.id)
  }finally{setBusy(false)}
 }

 const revert=async(entry:BusinessCustomizationEntry,target:{kind:'local-version';version:number}|{kind:'template'})=>{
  setBusy(true)
  setMessage('')
  try{
   await api.revert({requestId:crypto.randomUUID(),scope,kind:entry.kind,localId:entry.localId,target,expectedCurrentVersion:entry.current?.version??0})
   await loadDirectory()
   changed()
   setMessage(t('business.custom.revert.done'))
  }catch(error){const failure=customizationFailureKey(error);setMessage(t(failure.key,failure.params))}finally{setBusy(false)}
 }

 if(loading)return <section className={css.panel} aria-label={t('business.custom.title')}><p className={css.empty}>{t('business.custom.loading')}</p></section>
 const rows=directory?customizationDraftRows(directory).filter(row=>row.pending):[]
 return <section className={css.panel} aria-label={t('business.custom.title')}>
  <header><div><h2>{t('business.custom.title')}</h2><p>{t('business.custom.note')}</p></div></header>
  {message&&<p className={base.error} role="alert">{message}</p>}
  {failedStage&&<button type="button" className={css.retry} disabled={busy} onClick={retry}>{t('business.custom.retry')}</button>}
  {!preview&&<>
   {!rows.length?<p className={css.empty}>{t('business.custom.drafts.empty')}</p>:<div className={css.rows}>{rows.map(row=><article key={row.draftId}><div><strong>{row.localId}</strong><small>{t(row.kindKey)} · v{row.semver} · {t('business.custom.draft.pending')}</small></div><button type="button" disabled={busy} onClick={()=>void loadPreview(row.draftId)}>{t('business.custom.preview.open')}</button></article>)}</div>}
   {!!directory?.entries.length&&<details className={css.versions}><summary>{t('business.custom.local.version')}</summary>{directory.entries.map(entry=>{
    const options=customizationRevertOptions(entry)
    if(!options.length)return null
    return <div key={entry.kind+'/'+entry.localId}><strong>{entry.localId}</strong>{options.map(option=><button key={option.target.kind==='template'?'template':option.target.version} type="button" disabled={busy} onClick={()=>void revert(entry,option.target)}>{option.labelKey==='business.custom.revert.version'?t(option.labelKey,{version:option.version!}):t(option.labelKey)}</button>)}</div>
   })}</details>}
  </>}
  {preview&&<CustomizationPreview scope={scope} preview={preview} busy={busy} colorScheme={colorScheme} confirm={()=>void confirm()} cancel={cancelPreview} pull={()=>void loadPreview(preview.draft.id,true)}/>}
 </section>
}
