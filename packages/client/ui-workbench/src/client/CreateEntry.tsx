import {useEffect,useRef,useState,type ReactNode} from 'react'
import type {BusinessDefinitionPreview,PageCreateDraftDirectory,PageCreateDraftPreview,PageCreateEntity} from '@teloa/contract'
import type {MessageKey} from './i18n/messages.js'
import type {PageCreateApi} from './page-create-api.js'
import {createReadableFields,createConfirmGuard,createConsequenceKey,createDraftRows,createFailureKey,createNextKey,createOptions,createPlaceholderKey,createSentencePrompt} from './page-create-presentation.js'
import {useI18n} from './i18n/provider.js'
import {useDismissible} from './use-dismissible.js'
import css from './CreateEntry.module.css'

/**
 * 页内新建的统一入口：三选（用一句话描述 / 自己填 / 去市场挑）+ 一句话输入 + 只读预览三块 + 确认。
 *
 * **组件不知道任何一支的落点**：`onConfirm(preview)` 由调用方给（T6 逐支接到既有写路径），
 * 这里只管两件事——预览过了才让点确认，以及确认入参逐字取预览回包。预览面板本身一个写动作都没有。
 */
export type CreateEntryProps={
 entity:PageCreateEntity
 /** 同一页面承载多类创建时，用动作名区分入口，避免两个「新建」区块并列。 */
 titleKey?:MessageKey
 /** 业务与连接器必填（目标业务范围）；同事、技能、扩展缺省。 */
 scope?:string
 api:PageCreateApi
 /** 这一页本来是空的：照规格 §七 在三选上面多加一句提示，不另起一块空态。 */
 empty?:boolean
 /** 「自己填」那一项：调用方传进来的既有表单打开函数；不传即这一项不出现（不摆必然被拒的按钮）。 */
 openForm?:()=>void
 /** 「去市场挑」那一项：调用方传进来的既有跳转函数；不传即这一项不出现。 */
 openMarket?:()=>void
 /** 一句话预备进当前会话（D3）：调用方接既有 `PromptPreparation.prepare`，本组件不碰模型。 */
 prepare:(prompt:{sourceId:string;title:string;text:string})=>void
 /** 确认：落点逐支不同，由调用方实现；抛出来的错误由这里按错误码选一条固定文案。 */
 /** 返回既有写路径真实创建的实体标识；它会写进草案的 appliedRef，不能借草案 id 冒充。 */
 /**
  * 只有页面已经接上真实落地动作时才提供。没有这条回调的页面仍可查看和撤回草案，
  * 但不会展示一个实际上无法完成的「确认创建」按钮。
  */
 onConfirm?:(preview:PageCreateDraftPreview)=>string|Promise<string>
 /** 已完成真实写入并把草案落定后才跳转，避免先卸载页面导致落定请求中断。 */
 afterConfirm?:(appliedRef:string)=>void
 /**
  * 某些既有写路径本身还带独立的知情同意（例如插件安装）。它完成真实写入后回调 `apply`，
  * 由此处统一落定草案；不能把「展示安装预览」提前写成已创建。
  */
 renderConfirmation?:(value:{preview:PageCreateDraftPreview;busy:boolean;apply:(appliedRef:string)=>Promise<void>})=>ReactNode
 /** 业务声明那一支的三块是第二期的预览组件（规格 §八），由调用方渲染进来，本组件不重算也不重画。 */
 renderBusinessPreview?:(preview:BusinessDefinitionPreview)=>ReactNode
}

export function CreateEntry(props:CreateEntryProps){
 // 同一页面换范围时，输入、请求、预览与操作状态一起销毁，旧草案不能借用新页面的确认落点。
 return <CreateEntryContent key={JSON.stringify([props.entity,props.scope])} {...props}/>
}

function CreateEntryContent({entity,scope,api,empty,openForm,openMarket,prepare,onConfirm,afterConfirm,renderConfirmation,renderBusinessPreview,titleKey}:CreateEntryProps){
 const {t}=useI18n()
 const [directory,setDirectory]=useState<PageCreateDraftDirectory>()
 const [failure,setFailure]=useState<'create.readFailed'|'create.conflict'|'create.forbidden'>()
 const [reload,setReload]=useState(0)
 const [sentenceOpen,setSentenceOpen]=useState(false)
 const [sentence,setSentence]=useState('')
 const [prepared,setPrepared]=useState(false)
 const [openDraft,setOpenDraft]=useState<string>()
 const [preview,setPreview]=useState<PageCreateDraftPreview>()
 const [previewFailure,setPreviewFailure]=useState<'create.readFailed'|'create.conflict'|'create.forbidden'>()
 const [previewReload,setPreviewReload]=useState(0)
 const [busy,setBusy]=useState(false)
 const operation=useRef(false)
 const lifetime=useRef<AbortController>()
 // 点外面关闭：输入框有未提交的字就不因为点外面而丢，Esc 仍放行。
 const sentenceGroup=useRef<HTMLDivElement>(null)
 useDismissible(sentenceGroup,sentenceOpen,()=>setSentenceOpen(false),source=>source==='escape'||!sentence.trim())

 useEffect(()=>{
  const controller=new AbortController()
  lifetime.current=controller
  operation.current=false
  setBusy(false)
  return ()=>controller.abort()
 },[api])

 useEffect(()=>{
  const controller=new AbortController()
  setDirectory(undefined)
  setFailure(undefined)
  setOpenDraft(undefined)
  setPreview(undefined)
  api.directory({entity,...(scope===undefined?{}:{scope})},controller.signal)
   .then(value=>{if(!controller.signal.aborted)setDirectory(value)})
   .catch((error:unknown)=>{if(!controller.signal.aborted)setFailure(createFailureKey(error))})
  return ()=>controller.abort()
 },[api,entity,scope,reload])

 useEffect(()=>{
  setPreview(undefined)
  setPreviewFailure(undefined)
  if(openDraft===undefined)return
  const controller=new AbortController()
  api.preview({draftId:openDraft},controller.signal)
   .then(value=>{
    if(value.draft.id!==openDraft||value.draft.entity!==entity||value.draft.scope!==scope)throw Error('草案预览与当前页面不一致。')
    if(!controller.signal.aborted)setPreview(value)
   })
   .catch((error:unknown)=>{if(!controller.signal.aborted)setPreviewFailure(createFailureKey(error))})
  return ()=>controller.abort()
 },[api,entity,scope,openDraft,previewReload])

 const options=createOptions({entity,hasForm:openForm!==undefined,hasMarket:openMarket!==undefined})
 const rows=directory===undefined?[]:createDraftRows(directory)
 // 展开另一行与 effect 清空预览之间还有一帧；只有逐字匹配当前行的预览才允许确认。
 const currentPreview=preview?.draft.id===openDraft?preview:undefined
 const guard=createConfirmGuard(currentPreview)
 // 确认与丢弃都要 `expectedBodyHash`：预览之后草案被改过，这两条都该被挡回来而不是照旧落定（D8）。
 const apply=async(preview:PageCreateDraftPreview,appliedRef:string)=>{
  const nextGuard=createConfirmGuard(preview)
  if(!nextGuard.ok||operation.current)throw Error('草案当前不能落定。')
  if(!appliedRef.trim())throw Error('既有创建流程没有返回落地记录。')
  const controller=lifetime.current
  operation.current=true
  setBusy(true)
  try{
   await api.settle({requestId:crypto.randomUUID(),draftId:preview.draft.id,expectedBodyHash:nextGuard.expectedBodyHash,outcome:'applied',appliedRef},controller?.signal)
   if(!controller?.signal.aborted){
    setOpenDraft(undefined)
    setReload(value=>value+1)
    afterConfirm?.(appliedRef)
   }
  }catch(error:unknown){
   if(!controller?.signal.aborted){
    setPreview(undefined)
    setPreviewFailure(createFailureKey(error))
   }
   throw error
  }finally{
   if(!controller?.signal.aborted){operation.current=false;setBusy(false)}
  }
 }

 const settle=async(outcome:'applied'|'discarded')=>{
  if(!guard.ok||currentPreview===undefined||operation.current)return
  const controller=lifetime.current
  operation.current=true
  setBusy(true)
  try{
   if(outcome==='discarded'){
    await api.settle({requestId:crypto.randomUUID(),draftId:currentPreview.draft.id,expectedBodyHash:guard.expectedBodyHash,outcome:'discarded'},controller?.signal)
   }else{
    if(onConfirm===undefined)return
    // 同步打开既有表单也可能抛错；与异步写路径共用同一道错误呈现。
    const appliedRef=await onConfirm(currentPreview)
    operation.current=false
    setBusy(false)
    await apply(currentPreview,appliedRef)
    return
   }
   if(!controller?.signal.aborted){
    setOpenDraft(undefined)
    setReload(value=>value+1)
   }
  }catch(error:unknown){
   // 调用方把确认带进既有表单后，用户可主动取消。取消不是保存失败，草案仍保持待确认状态。
   if(error!==null&&typeof error==='object'&&'code' in error&&(error as {code?:unknown}).code==='teloa/cancelled')return
   if(!controller?.signal.aborted){
    setPreview(undefined)
    setPreviewFailure(createFailureKey(error))
   }
  }finally{
   if(!controller?.signal.aborted){operation.current=false;setBusy(false)}
  }
 }

 const title=t(titleKey??'create.title')
 return <section className={css.entry} aria-label={title}>
  <h2 className={css.title}>{title}</h2>
  {empty===true&&<div className={css.lead}><h3>{t('create.empty.title')}</h3><p>{t('create.empty.description')}</p></div>}
  <div ref={sentenceGroup} className={css.sentenceGroup}>
   <div className={css.options}>
    {options.map(option=>option==='sentence'
     ?<button key={option} type="button" className={css.option} aria-expanded={sentenceOpen} onClick={()=>setSentenceOpen(!sentenceOpen)}>{t('create.option.sentence')}</button>
     :<button key={option} type="button" className={css.option} onClick={option==='form'?openForm:openMarket}>{t(option==='form'?'create.option.form':'create.option.market')}</button>)}
   </div>
   {sentenceOpen&&<form className={css.sentence} onSubmit={event=>{
    event.preventDefault()
    if(!sentence.trim())return
    prepare(createSentencePrompt(entity,scope,sentence,t))
    setSentence('')
    setPrepared(true)
    setSentenceOpen(false)
   }}>
    <label>{t('create.sentence.label')}
     <textarea rows={2} maxLength={2000} value={sentence} placeholder={t(createPlaceholderKey(entity))} onChange={event=>setSentence(event.target.value)}/>
    </label>
    <button type="submit" disabled={!sentence.trim()}>{t('create.sentence.submit')}</button>
   </form>}
  </div>
  {prepared&&<p role="status" className={css.notice}>{t('create.sentence.prepared')}</p>}
  <div className={css.draftsHeader}><h3 className={css.draftsTitle}>{t('create.drafts.title')}</h3>
   <button type="button" disabled={busy} onClick={()=>setReload(value=>value+1)}>{t('create.retry')}</button>
  </div>
  {failure!==undefined
   ?<p role="alert" className={css.alert}>{t(failure)}<button type="button" onClick={()=>setReload(value=>value+1)}>{t('create.retry')}</button></p>
   :directory===undefined
    ?<p role="status" className={css.notice}>{t('create.drafts.loading')}</p>
    :rows.length===0
     ?<p className={css.notice}>{t('create.drafts.empty')}</p>
     :<ul className={css.drafts}>{rows.map(row=><li key={row.draftId}>
      <details open={openDraft===row.draftId} onToggle={event=>{
       if(operation.current)return
       const open=event.currentTarget.open
       setOpenDraft(current=>open?row.draftId:current===row.draftId?undefined:current)
      }}>
       <summary onClick={event=>{if(busy)event.preventDefault()}}>{row.title}<span className={css.status}>{t(row.titleKey)}</span></summary>
       {openDraft===row.draftId&&(previewFailure!==undefined
        ?<p role="alert" className={css.alert}>{t(previewFailure)}<button type="button" onClick={()=>setPreviewReload(value=>value+1)}>{t('create.retry')}</button></p>
        :currentPreview===undefined
         ?<p role="status" className={css.notice}>{t('create.preview.loading')}</p>
         :<div className={css.preview}>
          <h4>{t('create.preview.fields')}</h4>
          <dl className={css.fields}>{createReadableFields(currentPreview).map(field=><div key={field.path}><dt>{field.path}</dt><dd>{field.value}</dd></div>)}</dl>
          {currentPreview.fieldsTruncated&&<p className={css.disclosure}>{t('create.preview.truncated')}</p>}
          <h4>{t('create.preview.consequences')}</h4>
          <ul className={css.consequences}>{currentPreview.consequences.map(item=><li key={item.kind+item.id}>{t(createConsequenceKey(item.kind))}<span className={css.status}>{item.id}</span>{item.required&&<span className={css.status}>{t('create.consequence.required')}</span>}</li>)}</ul>
          {currentPreview.businessPreview!==undefined&&renderBusinessPreview?.(currentPreview.businessPreview)}
          <h4>{t('create.preview.next')}</h4>
          <p>{t('create.next.step',{step:t(createNextKey(entity))})}</p>
          {currentPreview.next.consentKeys.length>0&&<>
           <p>{t('create.next.consent')}</p>
           <ul className={css.consents}>{currentPreview.next.consentKeys.map(key=><li key={key}>{t(key as MessageKey)}</li>)}</ul>
          </>}
          {guard.ok&&renderConfirmation?.({preview:currentPreview,busy,apply:appliedRef=>apply(currentPreview,appliedRef)})}
          <div className={css.actions}>
           {guard.ok&&onConfirm!==undefined&&(currentPreview.businessPreview===undefined||renderBusinessPreview!==undefined)&&<button type="button" className={css.confirm} disabled={busy} onClick={()=>settle('applied')}>{t(busy?'create.confirm.busy':'create.confirm')}</button>}
           {guard.ok&&<button type="button" disabled={busy} onClick={()=>settle('discarded')}>{t('create.discard')}</button>}
          </div>
         </div>)}
      </details>
     </li>)}</ul>}
 </section>
}
