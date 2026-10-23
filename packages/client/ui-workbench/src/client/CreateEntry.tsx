import {useContext,useEffect,useRef,useState,type ReactNode} from 'react'
import {WorkError,type BusinessDefinitionPreview,type PageCreateDraftDirectory,type PageCreateDraftPreview,type PageCreateEntity} from '@teloa/contract'
import type {MessageKey} from './i18n/messages.js'
import type {PageCreateApi} from './page-create-api.js'
import {createPlanPreview,isPlanPreviewConsequence,createReadableFields,createConfirmGuard,createConsequenceKey,createDraftRows,createFailureKey,createNextKey,createOptions,createPlaceholderKey,createSentencePrompt,readCreateSentenceDraft,writeCreateSentenceDraft,type CreateSentenceDraft} from './page-create-presentation.js'
import {useI18n} from './i18n/provider.js'
import {useDismissible} from './use-dismissible.js'
import css from './CreateEntry.module.css'
import {Pencil,RefreshCw} from 'lucide-react'
import {PageCreateRevisionContext} from './page-create-revision-context.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

/**
 * 页内新建的统一入口：Markdown 说明、已有创建方式、只读预览与确认。
 *
 * **组件不知道任何一支的落点**：`onConfirm(preview)` 由调用方给（T6 逐支接到既有写路径），
 * 这里只管两件事——预览过了才让点确认，以及确认入参逐字取预览回包。预览面板本身一个写动作都没有。
 */
export type CreateEntryProps={
 entity:PageCreateEntity
 /** 同一页面承载多类创建时，用动作名区分入口，避免两个「新建」区块并列。 */
 titleKey?:MessageKey
 /** 明确的自然语言创建入口直接展示输入，不再让用户重复点一次。 */
 directSentence?:boolean
 /** 抽屉已提供对象标题，不再重复显示「新建」。 */
 embedded?:boolean
 /** 常驻抽屉重新打开时重新读取草稿，输入仍留在原入口。 */
 active?:boolean
 /** 原对象入口只展开正式目录内身份与摘要均相符的这一份草案，不另存草案或猜选最新项。 */
 focusDraft?:{draftId:string;bodyHash:string}
 /** 嵌入原对象抽屉时，沿用现有提交状态阻止提交中误关，不另建操作状态。 */
 onBusyChange?:(busy:boolean)=>void
 submitLabelKey?:MessageKey
 /** 确认动作沿真实预览区分保存或启用，缺省沿用原确认。 */
 confirmLabelKey?:(preview:PageCreateDraftPreview)=>MessageKey
 /** 同一创建协议可有不同对象，示例使用当前入口的对象名称。 */
 descriptionPlaceholderKey?:MessageKey
 /** 调用方提供已按本人隔离的导航存储，不使用全局共享草稿。 */
 sentenceDraft?:{key:string;storage:WorkbenchNavigationStorage}
 /** 仅管理其他类型的历史草案时，不显示新建输入。 */
 hideSentence?:boolean
 /** 业务与连接器必填（目标业务范围）；同事、技能、扩展缺省。 */
 scope?:string
 api:PageCreateApi
 /** 这一页本来是空的：照规格 §七 在三选上面多加一句提示，不另起一块空态。 */
 empty?:boolean
 /** 「自己填」那一项：调用方传进来的既有表单打开函数；不传即这一项不出现（不摆必然被拒的按钮）。 */
 openForm?:()=>void
 /** 「去市场挑」那一项：调用方传进来的既有跳转函数；不传即这一项不出现。 */
 openMarket?:()=>void
 /** 创建说明预备进当前会话（D3）：调用方接既有 `PromptPreparation.prepare`，本组件不碰模型。 */
 prepare:(prompt:{sourceId:string;title:string;text:string})=>void|Promise<void>
 /** 当前入口仍有效、会话准备成功后才关闭；迟到结果不触碰新入口。 */
 onPrepared?:()=>void
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
 return <CreateEntryContent key={JSON.stringify([props.entity,props.scope,props.focusDraft?.draftId,props.focusDraft?.bodyHash])} {...props}/>
}

function CreateEntryContent({entity,scope,api,empty,openForm,openMarket,prepare,onPrepared,onConfirm,afterConfirm,renderConfirmation,renderBusinessPreview,titleKey,directSentence=false,hideSentence=false,embedded=false,active=true,focusDraft,onBusyChange,submitLabelKey,confirmLabelKey,descriptionPlaceholderKey,sentenceDraft}:CreateEntryProps){
 const {t}=useI18n()
 const prepareRevision=useContext(PageCreateRevisionContext),[revisionFailure,setRevisionFailure]=useState(false)
 const [directory,setDirectory]=useState<PageCreateDraftDirectory>()
 const [failure,setFailure]=useState<'create.readFailed'|'create.conflict'|'create.forbidden'>()
 const [reload,setReload]=useState(0)
 // 句稿记录按入口持久化：预备成功也保留原说明（prepared=true），重开入口能恢复并标明「已备好未发送」。
 const readSentenceDraft=():CreateSentenceDraft=>{try{return readCreateSentenceDraft(sentenceDraft?.storage.getItem(sentenceDraft.key))}catch{return {text:'',prepared:false}}}
 const initialDraft=readSentenceDraft()
 // 恢复出的句稿默认展开，用户一进入口就能看到原说明或被标明「已备好未发送」的草稿。
 const [sentenceOpen,setSentenceOpen]=useState(initialDraft.text!=='')
 const [sentence,setSentence]=useState(initialDraft.text)
 const latestSentence=useRef(sentence);latestSentence.current=sentence
 const writeSentenceDraft=(draft:CreateSentenceDraft)=>{setSentence(draft.text);setPrepared(draft.prepared);try{if(sentenceDraft){const raw=writeCreateSentenceDraft(draft);if(raw)sentenceDraft.storage.setItem(sentenceDraft.key,raw);else sentenceDraft.storage.removeItem(sentenceDraft.key)}}catch{/* 存储不可用时仍保留本入口内存原稿。 */}}
 const writeSentence=(value:string)=>writeSentenceDraft({text:value,prepared:false})
 useEffect(()=>{const saved=readSentenceDraft();setSentence(saved.text);setPrepared(saved.prepared)},[sentenceDraft?.key,sentenceDraft?.storage])
 const [prepared,setPrepared]=useState(initialDraft.prepared)
 const [preparing,setPreparing]=useState(false)
 const [openDraft,setOpenDraft]=useState<string>()
 const [preview,setPreview]=useState<PageCreateDraftPreview>()
 const [previewFailure,setPreviewFailure]=useState<'create.readFailed'|'create.conflict'|'create.forbidden'>()
 const [previewReload,setPreviewReload]=useState(0)
 const [busy,setBusy]=useState(false)
 useEffect(()=>{onBusyChange?.(busy)},[busy,onBusyChange])
 const operation=useRef(false)
 const lifetime=useRef<AbortController>()
 const preparation=useRef<{api:PageCreateApi;active:boolean;busy:boolean}>({api,active,busy:false})
 if(preparation.current.api!==api||preparation.current.active!==active)preparation.current={api,active,busy:false}
 useEffect(()=>{setPreparing(false)},[api,active])
 // 点外面关闭：输入框有未提交的字就不因为点外面而丢，Esc 仍放行。
 const sentenceGroup=useRef<HTMLDivElement>(null)
 useDismissible(sentenceGroup,!directSentence&&sentenceOpen,()=>setSentenceOpen(false),source=>source==='escape'||!sentence.trim())

 useEffect(()=>{
  const controller=new AbortController()
  lifetime.current=controller
  operation.current=false
  setBusy(false)
  return ()=>controller.abort()
 },[api])

 useEffect(()=>{
  if(!active)return
  const controller=new AbortController()
  setDirectory(undefined)
  setFailure(undefined)
  setOpenDraft(undefined)
  setPreview(undefined)
  api.directory({entity,...(scope===undefined?{}:{scope})},controller.signal)
   .then(value=>{
    if(controller.signal.aborted)return
    if(focusDraft){
     const selected=value.drafts.find(row=>row.id===focusDraft.draftId)
     if(value.entity!==entity||value.scope!==scope||!selected||selected.entity!==entity||selected.scope!==scope||selected.bodyHash!==focusDraft.bodyHash)throw new WorkError('teloa/conflict','原草案已变化。')
     setDirectory({...value,drafts:[selected]});setOpenDraft(selected.id)
    }else setDirectory(value)
   })
   .catch((error:unknown)=>{if(!controller.signal.aborted)setFailure(createFailureKey(error))})
  return ()=>controller.abort()
 },[api,entity,scope,reload,active,focusDraft?.draftId,focusDraft?.bodyHash])

 useEffect(()=>{
  setPreview(undefined)
  setPreviewFailure(undefined)
  setRevisionFailure(false)
  if(openDraft===undefined)return
  const controller=new AbortController()
  api.preview({draftId:openDraft},controller.signal)
   .then(value=>{
    if(value.draft.id!==openDraft||value.draft.entity!==entity||value.draft.scope!==scope)throw Error('草案预览与当前页面不一致。')
    if(focusDraft&&(value.draft.id!==focusDraft.draftId||value.draft.bodyHash!==focusDraft.bodyHash))throw new WorkError('teloa/conflict','原草案已变化。')
    if(!controller.signal.aborted)setPreview(value)
   })
   .catch((error:unknown)=>{if(!controller.signal.aborted)setPreviewFailure(createFailureKey(error))})
  return ()=>controller.abort()
 },[api,entity,scope,openDraft,previewReload,focusDraft?.draftId,focusDraft?.bodyHash])

 const options=createOptions({entity,hasForm:openForm!==undefined,hasMarket:openMarket!==undefined})
 const rows=directory===undefined?[]:createDraftRows(directory)
 const pendingRows=rows.filter(row=>row.pending),historyRows=rows.filter(row=>!row.pending)
 // 展开另一行与 effect 清空预览之间还有一帧；只有逐字匹配当前行的预览才允许确认。
 const currentPreview=preview?.draft.id===openDraft?preview:undefined
 const plan=currentPreview?.draft.entity==='plan'
 let planPreview:ReturnType<typeof createPlanPreview>|undefined
 if(plan&&currentPreview)try{planPreview=createPlanPreview(currentPreview,t)}catch{/* 无效正文不能退回原字段路径或继续确认。 */}
 const guard:ReturnType<typeof createConfirmGuard>=plan&&!planPreview?{ok:false,reason:'not-previewed'}:createConfirmGuard(currentPreview)
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
    if(controller?.signal.aborted||controller!==lifetime.current)return
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
 const renderDraft=(row:typeof rows[number])=><li key={row.draftId}>
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
          <h4>{t(plan?'create.plan.preview.title':'create.preview.fields')}</h4>
          <dl className={css.fields}>{(plan?planPreview?.fields??[]:createReadableFields(currentPreview)).map(field=><div key={field.path} className={field.value.includes('\n')?css.documentField:undefined}><dt>{field.path}</dt><dd>{field.value}</dd></div>)}</dl>
          {!plan&&currentPreview.fieldsTruncated&&<p className={css.disclosure}>{t('create.preview.truncated')}</p>}
          {plan&&!planPreview&&<p role="alert">{t('create.readFailed')}</p>}
          {planPreview&&<ul className={css.consequences}>{planPreview.consequences.map(text=><li key={text}>{text}</li>)}</ul>}
          {planPreview&&<details><summary>{t('create.plan.preview.references')}</summary><dl className={css.fields}>{planPreview.references.map(reference=><div key={reference.path}><dt>{reference.path}</dt><dd>{reference.value}</dd></div>)}</dl></details>}

          {currentPreview.consequences.some(item=>!plan||!isPlanPreviewConsequence(item.id))&&<><h4>{t('create.preview.consequences')}</h4>
          <ul className={css.consequences}>{currentPreview.consequences.filter(item=>!plan||!isPlanPreviewConsequence(item.id)).map(item=><li key={item.kind+item.id}>{t(createConsequenceKey(item.kind))}{!plan&&<span className={css.status}>{item.id}</span>}{item.required&&<span className={css.status}>{t('create.consequence.required')}</span>}</li>)}</ul></>}
          {currentPreview.businessPreview!==undefined&&renderBusinessPreview?.(currentPreview.businessPreview)}
          {!focusDraft&&!plan&&<><h4>{t('create.preview.next')}</h4>
          <p>{t('create.next.step',{step:t(createNextKey(entity))})}</p></>}
          {currentPreview.next.consentKeys.length>0&&<>
           <p>{t('create.next.consent')}</p>
           <ul className={css.consents}>{currentPreview.next.consentKeys.map(key=><li key={key}>{t(key as MessageKey)}</li>)}</ul>
          </>}
          {guard.ok&&renderConfirmation?.({preview:currentPreview,busy,apply:appliedRef=>apply(currentPreview,appliedRef)})}
          <div className={css.actions}>
           {guard.ok&&prepareRevision&&api.origin&&<ToolbarIconButton label={t('create.revise')} icon={Pencil} disabled={busy} onClick={async()=>{
            if(operation.current)return
            operation.current=true;setBusy(true);setRevisionFailure(false)
            const signal=lifetime.current?.signal??new AbortController().signal
            try{await prepareRevision(currentPreview.draft,signal)}catch{if(!signal.aborted)setRevisionFailure(true)}finally{if(!signal.aborted){operation.current=false;setBusy(false)}}
           }}/>}
           {guard.ok&&onConfirm!==undefined&&(currentPreview.businessPreview===undefined||renderBusinessPreview!==undefined)&&<button type="button" className={css.confirm} disabled={busy} onClick={()=>settle('applied')}>{t(busy?'create.confirm.busy':confirmLabelKey?.(currentPreview)??'create.confirm')}</button>}
           {guard.ok&&<button type="button" disabled={busy} onClick={()=>settle('discarded')}>{t('create.discard')}</button>}
          </div>
          {revisionFailure&&<p role="alert" className={css.alert}>{t('create.revise.failed')}</p>}
         </div>)}
      </details>
     </li>
 return <section className={css.entry} aria-label={title}>
  {!embedded&&<h2 className={css.title}>{title}</h2>}
  {empty===true&&<div className={css.lead}><h3>{t('create.empty.title')}</h3><p>{t('create.empty.description')}</p></div>}
  <div ref={sentenceGroup} className={css.sentenceGroup}>
   {!hideSentence&&!directSentence&&<div className={css.options}>
    {options.map(option=>option==='sentence'
     ?<button key={option} type="button" className={css.option} aria-expanded={sentenceOpen} onClick={()=>setSentenceOpen(!sentenceOpen)}>{t('create.option.sentence')}</button>
     :<button key={option} type="button" className={css.option} onClick={option==='form'?openForm:openMarket}>{t(option==='form'?'create.option.form':'create.option.market')}</button>)}
   </div>}
   {!hideSentence&&(directSentence||sentenceOpen)&&<form className={css.sentence} onSubmit={async event=>{
    event.preventDefault()
    const current=preparation.current
    const controller=lifetime.current
    const currentEntry=()=>current===preparation.current&&current.active&&controller===lifetime.current&&!controller?.signal.aborted
    const submittedSentence=sentence
    if(!sentence.trim()||current.busy||!active)return
    current.busy=true
    setPreparing(true);setFailure(undefined)
    try{
     await prepare(createSentencePrompt(entity,scope,sentence,t))
     if(!currentEntry())return
     if(latestSentence.current===submittedSentence){writeSentenceDraft({text:submittedSentence,prepared:true});setSentenceOpen(false);onPrepared?.()}
    }catch(error){if(error!==null&&typeof error==='object'&&'code' in error&&error.code==='teloa/cancelled')return;if(currentEntry())setFailure(createFailureKey(error))}
    finally{current.busy=false;if(currentEntry())setPreparing(false)}
   }}>
    <label>{t('create.sentence.label')}
     <textarea rows={5} maxLength={2000} value={sentence} placeholder={t(descriptionPlaceholderKey??createPlaceholderKey(entity))} onChange={event=>writeSentence(event.target.value)}/>
    </label>
    <button type="submit" disabled={!sentence.trim()||preparing}>{t(submitLabelKey??'create.sentence.submit')}</button>
   </form>}
  </div>
  {prepared&&<p role="status" className={css.notice}>{t('create.sentence.prepared')}<button type="button" className={css.clearDraft} onClick={()=>writeSentenceDraft({text:'',prepared:false})}>{t('recovery.discard')}</button></p>}
  {!focusDraft&&<div className={css.draftsHeader}><h3 className={css.draftsTitle}>{t('create.drafts.title')}</h3>
   <ToolbarIconButton label={t('create.retry')} icon={RefreshCw} disabled={busy} onClick={()=>setReload(value=>value+1)}/>
  </div>}
  {failure!==undefined
   ?<p role="alert" className={css.alert}>{t(failure)}<button type="button" onClick={()=>setReload(value=>value+1)}>{t('create.retry')}</button></p>
   :directory===undefined
    ?<p role="status" className={css.notice}>{t('create.drafts.loading')}</p>
    :<>
     {pendingRows.length===0?<p className={css.notice}>{t('create.drafts.empty')}</p>:<ul className={css.drafts}>{pendingRows.map(renderDraft)}</ul>}
     {historyRows.length>0&&<details className={css.history}><summary>{t('create.drafts.history',{count:historyRows.length})}</summary><ul className={css.drafts}>{historyRows.map(renderDraft)}</ul></details>}
    </>}

 </section>
}
