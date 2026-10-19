import {isIndustryManifest} from './industry-manifest.ts'
import { readIndustryArchive } from './industry-archive.js'
import { IndustryDiscoveryList } from './IndustryDiscoveryList.js'
import { discoverIndustryTemplates, readIndustryDirectory, sharePackageItem, SharePackageImportError, type IndustryDiscovery } from './industry-directory.js'
import { prepareIndustryReferenceCandidates } from './industry-reference.js'
import { IndustryReferences } from './IndustryReferences.js'
import { openDialog } from './dialog-focus.js'
import { useDialogDismiss } from './use-dialog-dismiss.js'
import { useEffect, useId, useRef, useState } from 'react'
import { ClipboardPaste, FileArchive, FileUp, FolderOpen, GitBranch, Info, X } from 'lucide-react'
import { ToolbarIconButton } from './ToolbarIconButton.js'
import { createTeamTemplate, githubSource, itemFromManifest, MAX_MANIFEST_BYTES, parseMarketManifest, readGrokRecipeItemSource, reprepareGrokRecipeItem, sourceItem, type MarketItem } from './market-preview.js'
import {grokRecipeConnectorCandidates,grokRecipeConnectorMapping,type GrokRecipe,type GrokRecipeConnectorCandidate,type GrokRecipePluginMapping,type MarketCatalogConnectorEntry} from '@teloa/contract'
import {catalogText,loadCatalogListing,type MarketCatalogApi,type MarketCatalogListing} from './market-catalog-api.js'
import type { MarketContentApi } from './market-content-api.js'
import type {GithubSourceApi,GithubSourceReceipt} from './github-source-api.js'
import {githubSourcePreview,type GithubSourcePreview} from './github-source-preview.js'
import css from './TaskPage.module.css'
import drawerCss from './ContextDrawer.module.css'
import marketCss from './MarketPage.module.css'
import importCss from './MarketForms.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {localizedMarketItemCopy} from './market-home-presentation.js'
import type {BusinessScopeLabel} from './business-directory.js'
import {getTaxonomyLabel,marketFunctionKeys,type MarketFunctionKey} from './market-taxonomy-filter.js'
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'

/** 「自己做一个」时可选的功能分类（市场分类定案 9 类 + 其他）；默认不选，市场里归「未分类」。 */
function FunctionCategoryField({value,onChange,disabled}:{value:MarketFunctionKey|'';onChange:(value:MarketFunctionKey|'')=>void;disabled:boolean}){
  const {locale,t}=useI18n()
  return <label>{t('market.forms.functionCategory')}<select disabled={disabled} value={value} onChange={event=>onChange(event.target.value as MarketFunctionKey|'')}><option value="">{t('market.catalog.official.taxonomyUnclassified')}</option>{(marketFunctionKeys as readonly MarketFunctionKey[]).map(key=><option key={key} value={key}>{getTaxonomyLabel('function',key,locale)??key}</option>)}</select></label>
}
/** 选了分类才写 `functions`，没选就不带这个键（旧数据与未分类同形）。 */
const withFunction=(item:MarketItem,value:MarketFunctionKey|''):MarketItem=>value?{...item,functions:[value]}:item

export type TemplateSeed={title:string;scope:string;description:string;skills?:readonly {id:string;title:string;version:string}[]}
export type MarketImportMode='upload'|'paste'|'github'|'conversation'
/** 仅保存输入；预览、固定来源回执、应用选择和授权状态均须重新核验。 */
export type MarketImportDraft={mode:MarketImportMode;file:File|undefined;raw:string;url:string;revision:string;title:string;request:string;requestFunction:MarketFunctionKey|'';directory:File[];manifestFile:string;githubAs:'template'|'skill';skillDir:string}
type RecipeAppSelection={catalogEntryId:string;catalogVersion:string;tools:string[]}
type GithubSkillInput=Parameters<MarketContentApi['importGithubSkill']>[0]
const githubSkillDrafts=createRoleFormDrafts<GithubSkillInput>(),githubSkillReceipts=new WeakMap<object,MarketItem>()
const githubSkillOwners=new WeakMap<object,WeakMap<object,object>>()
// 已核回来源与迟到回执只留在原来源/内容 API 组合内，不换请求、不自动重发。
function githubSkillOwner(source:object,content:object){let contents=githubSkillOwners.get(source);if(!contents){contents=new WeakMap();githubSkillOwners.set(source,contents)}let owner=contents.get(content);if(!owner){owner={};contents.set(content,owner)}return owner}
const jsonValue=(raw:string):unknown=>{try{return JSON.parse(raw)}catch{return undefined}}
export function MarketImportForm({githubSourceApi,contentApi,marketCatalogApi,openConnection,items,mode:initial,draft,onDraft,close,save,saveMany}:{githubSourceApi:GithubSourceApi;contentApi?:MarketContentApi;marketCatalogApi?:MarketCatalogApi|undefined;openConnection?:((catalogId:string,entry:MarketCatalogConnectorEntry)=>void)|undefined;items:readonly MarketItem[];mode:MarketImportMode;draft?:MarketImportDraft|undefined;onDraft?:((draft:MarketImportDraft)=>void)|undefined;close:()=>void;save:(item:MarketItem,chat:boolean)=>void;saveMany:(items:MarketItem[])=>void}){
  const {locale,t}=useI18n()
  const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0),aboutId=useId()
  const conversation=initial==='conversation'
  const [mode,setMode]=useState<MarketImportMode>(conversation?'conversation':draft?.mode&&draft.mode!=='conversation'?draft.mode:initial),[about,setAbout]=useState(false),[file,setFile]=useState<File|undefined>(draft?.file),[raw,setRaw]=useState(draft?.raw??''),[url,setUrl]=useState(draft?.url??''),[revision,setRevision]=useState(draft?.revision??'main'),[title,setTitle]=useState(draft?.title??''),[request,setRequest]=useState(draft?.request??''),[requestFunction,setRequestFunction]=useState<MarketFunctionKey|''>(draft?.requestFunction??''),[reading,setBusy]=useState(false),[error,setError]=useState(''),[discarded,setDiscarded]=useState(false)
  const [directory,setDirectory]=useState<File[]>(draft?.directory??[]),[manifestFile,setManifestFile]=useState(draft?.manifestFile??'')
  const [discovery,setDiscovery]=useState<IndustryDiscovery[]|null>(null),[selectedPaths,setSelectedPaths]=useState<string[]>([])
  const [referencePreview,setReferencePreview]=useState<{item:MarketItem;items:MarketItem[]}|null>(null)
  // Grok recipe 只在确认前预览；预览不写入、不授权，返回时保留粘贴文本与已选文件。
  const [recipePreview,setRecipePreview]=useState<MarketItem|null>(null)
  const [recipeSource,setRecipeSource]=useState<GrokRecipe|null>(null),[recipeCatalog,setRecipeCatalog]=useState<MarketCatalogListing|null>(null),[recipeCandidates,setRecipeCandidates]=useState<GrokRecipeConnectorCandidate[]>([]),[recipeApps,setRecipeApps]=useState<Record<string,RecipeAppSelection>>({})
  const [fixedPreview,setFixedPreview]=useState<GithubSourcePreview|null>(null),[fixedRequest,setFixedRequest]=useState('')
  const [githubAs,setGithubAs]=useState<'template'|'skill'>(draft?.githubAs??'template'),[skillDir,setSkillDir]=useState(draft?.skillDir??'')
  const [skillSlot,skillSnapshot]=useRoleFormDraft(githubSkillDrafts,githubSkillOwner(githubSourceApi,contentApi??githubSourceApi),'import'),mounted=useRef(true)
  const currentSkill=useRef({slot:skillSlot,save});currentSkill.current={slot:skillSlot,save}
  const busy=reading||!!skillSnapshot.pending,fixedSkill=skillSnapshot.value
  const deliverSkill=()=>{const item=githubSkillReceipts.get(skillSlot);if(item&&mounted.current&&currentSkill.current.slot===skillSlot){githubSkillReceipts.delete(skillSlot);currentSkill.current.save(item,false)}}
  const draftCallback=useRef(onDraft);draftCallback.current=onDraft
  useEffect(()=>{draftCallback.current?.({mode,file,raw,url,revision,title,request,requestFunction,directory,manifestFile,githubAs,skillDir})},[mode,file,raw,url,revision,title,request,requestFunction,directory,manifestFile,githubAs,skillDir])
  const dismissEvents=useDialogDismiss(close,!busy)
  const stageRecipe=async(item:MarketItem,token:number)=>{const source=await readGrokRecipeItemSource(item);if(token!==generation.current)return;setRecipeSource(source.recipe);setRecipeCatalog(null);setRecipeCandidates([]);setRecipeApps({});setRecipePreview(item)}
  const inspectRecipeApps=async()=>{
    if(!marketCatalogApi||!recipeSource||recipeCatalog||busy)return
    const token=++generation.current;setBusy(true);setError('')
    try{const listing=await loadCatalogListing(marketCatalogApi,'teloa'),candidates=grokRecipeConnectorCandidates(recipeSource,listing.items.map(row=>row.entry));if(token===generation.current){setRecipeCatalog(listing);setRecipeCandidates(candidates)}}catch(error){if(token===generation.current)setError(localizeWorkError(locale,error))}finally{if(token===generation.current)setBusy(false)}
  }
  const scan=async()=>{const token=++generation.current;setBusy(true);setDiscovery(null);setSelectedPaths([]);setError('');try{const rows=await discoverIndustryTemplates(directory.map(file=>({path:file.webkitRelativePath,size:file.size,read:async()=>new Uint8Array(await file.arrayBuffer())})),directory[0]?.webkitRelativePath.split('/')[0]||t("market.forms.industry.template.directory"));if(token===generation.current){setDiscovery(rows);setSelectedPaths(rows.filter(row=>row.item).map(row=>row.path))}}catch(error){if(token===generation.current)setError(localizeWorkError(locale,error))}finally{if(token===generation.current)setBusy(false)}}
  useEffect(()=>{mounted.current=true;const dispose=openDialog(dialog.current);return()=>{mounted.current=false;generation.current++;dispose()}},[])
  useEffect(()=>{setBusy(false);setError('');setDiscarded(false);return()=>{generation.current++}},[skillSlot])
  useEffect(()=>{deliverSkill();if(skillSnapshot.pending)void skillSnapshot.pending.then(deliverSkill,()=>{})},[skillSlot,skillSnapshot.pending])
  const inspectGithub=async(receipt:GithubSourceReceipt,token:number)=>{
    const rows=await discoverIndustryTemplates(receipt.files.map(file=>({path:file.path,size:file.bytes.byteLength,read:async()=>Uint8Array.from(file.bytes)})),receipt.provenance.owner+'/'+receipt.provenance.repo)
    if(token===generation.current){setFixedPreview(githubSourcePreview(receipt,rows));setFixedRequest(receipt.requestId)}
  }
  const importFixedSkill=async(input=skillSlot.read().value)=>{
    if(!input)return
    if(!contentApi)throw Error(t("market.forms.market.based.fixed.content.services.are.not.accessible"))
    await skillSlot.run(input,async()=>{githubSkillReceipts.set(skillSlot,await contentApi.importGithubSkill(input))});deliverSkill()
  }
  const discardFixedSkill=()=>{if(skillSlot.read().pending)return;skillSlot.set(undefined);githubSkillReceipts.delete(skillSlot);setError('');setDiscarded(true)}
  const stageGithub=async(receipt:GithubSourceReceipt,token:number)=>{
    if(receipt.provenance.path!==undefined){
      const input={githubRequestId:receipt.requestId,skillPath:receipt.provenance.path+'/SKILL.md'},pending=skillSlot.read().value
      if(pending&&(pending.githubRequestId!==input.githubRequestId||pending.skillPath!==input.skillPath))throw Error(t('market.content.pendingImport'))
      skillSlot.set(input)
      if(token===generation.current&&mounted.current&&currentSkill.current.slot===skillSlot)await importFixedSkill(input)
    }else await inspectGithub(receipt,token)
  }
  const recoverGithub=async()=>{
    if(busy)return
    const token=++generation.current;setBusy(true);setError('')
    try{if(githubSourceApi.pending()?.path&&!contentApi)throw Error(t("market.forms.market.based.fixed.content.services.are.not.accessible"));await stageGithub(await githubSourceApi.recover(),token)}catch(error){if(token===generation.current)setError(localizeWorkError(locale,error))}finally{if(token===generation.current)setBusy(false)}
  }
  const importFixedIndustry=async()=>{
    const token=++generation.current;setBusy(true);setError('')
    try{
      if(!contentApi)throw Error(t("market.forms.market.based.fixed.content.services.are.not.accessible"))
      // 固定来源里只接受唯一一份 v2 行业清单；有多份时交回用户选择，不在客户端猜测。
      const found=(fixedPreview?.discovery??[]).filter(row=>isIndustryManifest(row.item?.manifest))
      if(!found.length)throw Error(t("market.forms.no.recognizable.industry.list.in.the.fixed.source"))
      if(found.length>1)throw Error(t("market.forms.multiple.industry.lists.in.the.fixed.source"))
      const item=await contentApi.importGithub({githubRequestId:fixedRequest,manifestPath:found[0]!.path})
      if(token===generation.current)save(item,false)
    }catch(error){if(token===generation.current)setError(localizeWorkError(locale,error))}finally{if(token===generation.current)setBusy(false)}
  }
  const confirmRecipe=async()=>{
    if(!recipePreview||busy)return
    const token=++generation.current;setBusy(true);setError('')
    try{
      if(!contentApi)throw Error(t("market.forms.market.based.fixed.content.services.are.not.accessible"))
      let prepared=recipePreview
      const selected=Object.entries(recipeApps).filter(([,selection])=>selection.catalogEntryId)
      if(selected.length){
        if(!marketCatalogApi||!recipeSource||!recipeCatalog)throw Error(t('market.forms.recipe.catalogUnavailable'))
        const fresh=await loadCatalogListing(marketCatalogApi,'teloa'),entries=fresh.items.map(row=>row.entry),candidates=grokRecipeConnectorCandidates(recipeSource,entries)
        if(token!==generation.current)return
        if(fresh.catalogVersion!==recipeCatalog.catalogVersion||selected.some(([pluginId,selection])=>!candidates.some(candidate=>candidate.pluginId===pluginId&&candidate.catalogEntryId===selection.catalogEntryId&&candidate.catalogVersion===selection.catalogVersion)))throw Error(t('market.forms.recipe.catalogChanged'))
        const mappings:Record<string,GrokRecipePluginMapping>={}
        for(const [pluginId,selection] of selected)if(selection.tools.length)mappings[pluginId]=grokRecipeConnectorMapping(recipeSource,{pluginId,catalogEntryId:selection.catalogEntryId,tools:selection.tools},entries)
        if(Object.keys(mappings).length)prepared=await reprepareGrokRecipeItem(recipePreview,mappings)
      }
      if(token!==generation.current)return
      // 只声明本人所选的已审工具；连接、认证与启用仍各自走原入口。
      const imported=await contentApi.importIndustry(prepared)
      if(token===generation.current)save(imported,false)
    }catch(error){if(token===generation.current)setError(localizeWorkError(locale,error))}finally{if(token===generation.current)setBusy(false)}
  }
  const submit=async()=>{
    if(referencePreview||fixedPreview||recipePreview||fixedSkill||busy)return
    const token=++generation.current;setBusy(true);setError('')
    try{
      if(mode==='upload'&&discovery){const chosen=discovery.filter(row=>row.item&&selectedPaths.includes(row.path)).map(row=>row.item!);if(!chosen.length)throw Error(t("market.forms.please.select.at.least.one.industry.template.that"));if(!contentApi)throw Error(t("market.forms.market.based.fixed.content.services.are.not.accessible"));const review=chosen.filter(item=>isIndustryManifest(item.manifest)&&item.manifest.resources.some(resource=>resource.source.kind==='public'));if(review.length&&chosen.length>1)throw Error(t("market.forms.industry.templates.with.public.references.need.to.be"));if(review[0]){const candidates=await prepareIndustryReferenceCandidates(review[0],items,item=>contentApi.hydrate(item));if(token===generation.current)setReferencePreview({item:review[0],items:candidates});return}const stored:MarketItem[]=[];for(const item of chosen)stored.push(await contentApi.importIndustry(item));if(token===generation.current)saveMany(stored);return}
      if(mode==='github'){
        const source=githubSource(url,revision)
        if(source.kind!=='github')throw Error(t("market.forms.the.github.source.type.is.incorrect"))
        const parts=new URL(source.url).pathname.split('/').filter(Boolean)
        if(parts.length!==2)throw Error(t("market.forms.github.addresses.must.be.precisely.pointed.to.the"))
        if(githubAs==='skill'){
          // 子目录模式：宿主按固定提交只读这个目录并逐文件核对摘要，随后直接固定为本人 Skill；来源未经 Teloa 审核。
          const dir=skillDir.trim()
          if(!dir||dir.length>300||dir.startsWith('/')||dir.endsWith('/')||dir.split('/').some(part=>!part||part==='.'||part==='..'))throw Error(t('market.forms.github.skillPathInvalid'))
          if(!contentApi)throw Error(t("market.forms.market.based.fixed.content.services.are.not.accessible"))
          const receipt=await githubSourceApi.resolve({owner:parts[0]!,repo:parts[1]!,ref:source.revision,path:dir})
          await stageGithub(receipt,token)
          return
        }
        const receipt=await githubSourceApi.resolve({owner:parts[0]!,repo:parts[1]!,ref:source.revision})
        await inspectGithub(receipt,token)
        return
      }
      let item:MarketItem
      if(mode==='paste'){
        // AI 创建或他人分享的 v2 分享包先转成行业包；其余清单走原解析。
        const shared=await sharePackageItem(jsonValue(raw))
        if(shared)item=shared
        else{
          const parsed=await parseMarketManifest(raw)
          // 粘贴的 Grok 原件按上传来源固定（原文件名 recipe.json），确认后才经 importIndustry 保存。
          item=itemFromManifest(parsed,parsed.recipeImport?{kind:'upload',name:'recipe.json',size:new TextEncoder().encode(raw).byteLength}:{kind:'paste'})
        }
      }
      else if(mode==='upload'){
        if(directory.length){
          item=await readIndustryDirectory(directory.map(file=>({path:file.webkitRelativePath,size:file.size,read:async()=>new Uint8Array(await file.arrayBuffer())})),manifestFile,directory[0]!.webkitRelativePath.split('/')[0]||t("market.forms.industry.template.directory"))
        }else{
        if(!file)throw Error(t("market.forms.please.select.a.file.or.directory"))
        if(/\.zip$/i.test(file.name)){
          if(file.size>20*1024*1024)throw Error(t("market.forms.zip.file.cannot.exceed.20.mib"))
          const rows=await readIndustryArchive(new Uint8Array(await file.arrayBuffer()),file.name)
          if(token===generation.current){setDiscovery(rows);setSelectedPaths(rows.filter(row=>row.item).map(row=>row.path))}
          return
        }else if(/\.json$/i.test(file.name)){
          if(file.size>MAX_MANIFEST_BYTES)throw Error(t("market.forms.the.json.list.cannot.exceed.1.mib"))
          const fileText=await file.text()
          const shared=await sharePackageItem(jsonValue(fileText))
          if(shared)item=shared
          else{
            const parsed=await parseMarketManifest(fileText)
            if(!isIndustryManifest(parsed.manifest))throw Error(t("market.forms.the.first.v2.industry.templates.are.supported.by"))
            item=await readIndustryDirectory([{path:file.name,size:file.size,read:async()=>new Uint8Array(await file.arrayBuffer())}],file.name,file.name)
          }
        }else throw Error(t("market.forms.select.the.zip.industry.template.or.json.list"))
        }
      }else{if(!request.trim())throw Error(t("market.forms.please.fill.in.the.working.methods.and.resource"));item=withFunction(sourceItem(crypto.randomUUID(),title||t("market.forms.industryTemplateDraft.defaultName"),{kind:'conversation',request:request.trim()},'general'),requestFunction)}
      if(item.recipeImport){await stageRecipe(item,token);return}
      if(mode==='upload'){if(!contentApi)throw Error(t("market.forms.market.based.fixed.content.services.are.not.accessible"));if(isIndustryManifest(item.manifest)&&item.manifest.resources.some(resource=>resource.source.kind==='public')){const candidates=await prepareIndustryReferenceCandidates(item,items,row=>contentApi.hydrate(row));if(token===generation.current)setReferencePreview({item,items:candidates});return}item=await contentApi.importIndustry(item)}
      if(generation.current===token)save(item,mode==='conversation')
    }catch(error){if(generation.current===token)setError(error instanceof SharePackageImportError?t(`market.forms.shareIssue.${error.issue}`):localizeWorkError(locale,error))}finally{if(generation.current===token)setBusy(false)}
  }
  const pendingGithub=githubSourceApi.pending(),githubRecovery=githubSourceApi.recoveryMessage()
  const previewing=!!referencePreview||!!fixedPreview||!!recipePreview||!!fixedSkill,heading=t(conversation?'market.forms.session.creation':'market.forms.importTitle'),visibleError=error||(skillSnapshot.error?localizeWorkError(locale,skillSnapshot.error):'')
  // 默认只需选文件或文件夹；粘贴与 GitHub 是按需页签，自然语言创建由市场单独入口以 conversation 打开
  const modes=[{value:'upload',icon:FileUp,label:t('market.forms.upload')},{value:'paste',icon:ClipboardPaste,label:t('market.forms.paste')},{value:'github',icon:GitBranch,label:t('market.forms.githubTab')}] as const
  // 技术说明与边界按需展开，不删除
  const notes=[...(mode==='conversation'?[t('market.forms.saves.the.source.demand.on.the.page.before')]:[t('market.forms.the.industry.templates.are.industry.positioning.by.normative'),...(mode==='upload'?[t('market.forms.uploadManifestNotice'),t('market.forms.the.directory.has.a.maximum.of.500.documents')]:mode==='github'?[t('market.forms.visit.the.github.api.and.archive.host.required')]:[])]),t('market.forms.savedToPersonalDraftNotice')]
  return <dialog ref={dialog} className={css.dialog+' '+drawerCss.drawer+' '+importCss.drawer} aria-label={heading} {...dismissEvents}><header className={drawerCss.header}><h2 className={importCss.title}>{heading}</h2><ToolbarIconButton label={t('market.forms.about')} icon={Info} aria-expanded={about} aria-controls={aboutId} onClick={()=>setAbout(value=>!value)}/><button type="button" aria-label={t("market.forms.close.market.import")} disabled={busy} onClick={close}><X size={18}/></button></header><form className={css.form+' '+drawerCss.content+' '+importCss.body} onSubmit={event=>{event.preventDefault();void submit()}}><div id={aboutId} hidden={!about} className={importCss.notes}>{notes.map(note=><p key={note}>{note}</p>)}</div>{!conversation&&<div className={importCss.modes} role="group" aria-label={heading}>{modes.map(({value,icon:Icon,label})=><button key={value} type="button" disabled={busy||previewing} aria-pressed={mode===value} onClick={()=>{setMode(value);setError('');setReferencePreview(null);setFixedPreview(null);setFixedRequest('');setRecipePreview(null)}}><Icon size={15} aria-hidden/>{label}</button>)}</div>}{visibleError&&<p role="alert">{visibleError}</p>}{mode==='github'&&githubRecovery&&<><p role="alert">{localizeWorkError(locale,githubRecovery)} {t('recovery.nextStep')}</p><button type="button" onClick={()=>{githubSourceApi.discard();setDiscarded(true)}}>{t('recovery.discard')}</button></>}{mode==='github'&&discarded&&<p role="status">{t('recovery.discarded')}</p>}{mode==='github'&&pendingGithub&&!fixedSkill&&<section className={marketCss.notice} aria-label={t("market.forms.pending.verification.of.github.source")}><h3>{t("market.forms.one.source.has.not.yet.been.checked")}</h3><p>{pendingGithub.owner}/{pendingGithub.repo} · {pendingGithub.ref}{t("market.forms.i.don.t.know.continues.to.use.the")}</p><button type="button" disabled={busy} onClick={()=>void recoverGithub()}>{busy?t("market.forms.checking"):t("market.forms.check.for.incomplete.acquisitions")}</button></section>}{fixedSkill&&<section className={marketCss.notice} aria-label={t('market.content.pendingImport')}><h3>{t('market.content.pendingImport')}</h3><button type="button" disabled={busy} onClick={()=>{setError('');void importFixedSkill().catch(()=>{})}}>{busy?t('market.forms.checking'):t('market.import.reviewIncomplete')}</button><button type="button" disabled={busy} onClick={discardFixedSkill}>{t('recovery.discard')}</button></section>}{fixedSkill?null:recipePreview?<RecipeImportPreview item={recipePreview} candidates={recipeCandidates} catalog={recipeCatalog} selections={recipeApps} change={setRecipeApps} inspect={()=>void inspectRecipeApps()} busy={busy} catalogAvailable={!!marketCatalogApi} openConnection={openConnection}/>:fixedPreview?<section className={marketCss.sheet} aria-label={t("market.forms.github.fixed.source.preview")}><h3>{fixedPreview.repository}</h3><p>{t("market.forms.the.host.has.already")} {fixedPreview.requestedRef} {t("market.forms.parsing.to.a.fixed.number.and.verifying.the")}</p><dl><div><dt>{t("market.forms.fixed")}</dt><dd><code>{fixedPreview.commit}</code></dd></div><div><dt>{t("market.forms.archives.sha.256")}</dt><dd><code>{fixedPreview.archiveHash}</code></dd></div><div><dt>{t("market.forms.fixed.file")}</dt><dd>{fixedPreview.files.length} {t("market.forms.item")} {fixedPreview.totalBytes} {t("market.forms.bytes")}</dd></div></dl><details><summary>{t("market.forms.view.fixed.file.directory")}</summary><ul>{fixedPreview.files.map(file=><li key={file.path}><code>{file.path}</code> · {file.bytes} {t("market.forms.bytes.c64673")} {file.hash.slice(0,12)}…</li>)}</ul></details><h3>{t("market.forms.industry.template.found")}</h3>{fixedPreview.discovery.length?<ul>{fixedPreview.discovery.map(row=><li key={row.path}><strong>{row.path}</strong> · {row.item?localizedMarketItemCopy(row.item,locale).title+' '+row.item.version+t("market.forms.discovery.parsedUnsavedSuffix"):t("market.forms.discovery.parseFailedPrefix")+row.error}</li>)}</ul>:<p>{t("market.forms.no.list.of.teloa.industry.templates.was.found")}</p>}</section>:referencePreview?<IndustryReferences embedded requireAll item={referencePreview.item} items={referencePreview.items} save={async item=>{if(busy)return;const token=++generation.current;setBusy(true);try{if(!contentApi)throw Error(t("market.forms.market.based.fixed.content.services.are.not.accessible"));const imported=await contentApi.importIndustry(item);if(token===generation.current)save(imported,false)}finally{if(token===generation.current)setBusy(false)}}}/>:mode==='upload'?<><div className={importCss.pickers}><label className={importCss.picker}><input type="file" className={importCss.hiddenInput} aria-label={t("market.forms.template.file")} disabled={busy} onChange={event=>{setFile(event.target.files?.[0]);setDirectory([]);setManifestFile('');setDiscovery(null);setSelectedPaths([]);setReferencePreview(null);setError('')}}/><FileArchive size={18} aria-hidden/><span>{t("market.forms.select.template.compressor.package.or.list")}</span></label><label className={importCss.picker+' '+importCss.secondary}><input type="file" className={importCss.hiddenInput} aria-label={t("market.forms.industry.template.directory")} multiple ref={node=>{node?.setAttribute('webkitdirectory','')}} disabled={busy} onChange={event=>{const files=Array.from(event.target.files||[]);setDirectory(files);setDiscovery(null);setSelectedPaths([]);setFile(undefined);setReferencePreview(null);setManifestFile(files.find(file=>file.name==='teloa.json')?.webkitRelativePath||files.find(file=>/\.json$/i.test(file.name))?.webkitRelativePath||'');setError('')}}/><FolderOpen size={18} aria-hidden/><span>{t("market.forms.or.select.a.full.template.directory")}</span></label></div>{file&&<p className={importCss.chosen}>{t("market.forms.selectedFile",{name:file.name})}</p>}{directory.length>0&&<><label>{t("market.forms.list.of.industries")}<select aria-label={t("market.forms.list.of.selected.industries")} required disabled={busy} value={manifestFile} onChange={event=>{setManifestFile(event.target.value);setDiscovery(null);setSelectedPaths([]);setReferencePreview(null)}}><option value="">{t("market.forms.select.a.list.of.v2.industries")}</option>{directory.filter(file=>/\.json$/i.test(file.name)).map(file=><option key={file.webkitRelativePath} value={file.webkitRelativePath}>{file.webkitRelativePath}</option>)}</select></label><p>{t("market.forms.selected")} {directory.length} {t("market.forms.a.file.the.inventory.path.is.the.baseline")}</p><button type="button" disabled={busy} onClick={()=>void scan()}>{t("market.forms.all.industry.templates.found")}</button></>}{discovery&&<IndustryDiscoveryList rows={discovery} selected={selectedPaths} change={setSelectedPaths} busy={busy}/>}</>:mode==='paste'?<label>{t("market.forms.json.list")}<textarea autoFocus rows={12} required disabled={busy} value={raw} onChange={event=>setRaw(event.target.value)} placeholder={t("market.forms.telea.work.template.v1.or.telea.business.package")}/></label>:mode==='github'?<><label>{t("market.forms.github.repository.address")}<input autoFocus required type="url" disabled={busy||!!pendingGithub} value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://github.com/owner/repo"/></label><label>{t("market.forms.branches.labels.or.submissions")}<input required maxLength={200} disabled={busy||!!pendingGithub} value={revision} onChange={event=>setRevision(event.target.value)}/></label><fieldset className={importCss.importAs} disabled={busy||!!pendingGithub}><legend>{t('market.forms.github.importAs')}</legend><label className={githubAs==='template'?importCss.choice+' '+importCss.selected:importCss.choice}><input type="radio" name="teloa-github-import-as" value="template" checked={githubAs==='template'} onChange={()=>setGithubAs('template')}/><span>{t('market.forms.github.asTemplate')}</span></label><label className={githubAs==='skill'?importCss.choice+' '+importCss.selected:importCss.choice}><input type="radio" name="teloa-github-import-as" value="skill" checked={githubAs==='skill'} onChange={()=>setGithubAs('skill')}/><span>{t('market.forms.github.asSkill')}</span></label></fieldset>{githubAs==='skill'&&<><label>{t('market.forms.github.skillPath')}<input required maxLength={300} disabled={busy||!!pendingGithub} value={skillDir} onChange={event=>setSkillDir(event.target.value)} placeholder="skills/.curated/pdf" aria-describedby="teloa-github-skill-path-hint"/></label><p id="teloa-github-skill-path-hint">{t('market.forms.github.skillPathHint')}</p><p role="note">{t('market.forms.github.unreviewed')}</p></>}</>:<><label>{t("market.forms.draft.name")}<input autoFocus maxLength={120} disabled={busy} value={title} onChange={event=>setTitle(event.target.value)}/></label><label>{t("market.forms.what.kind.of.work.do.you.want.to")}<textarea rows={5} maxLength={4000} required disabled={busy} value={request} onChange={event=>setRequest(event.target.value)} placeholder={t("market.forms.for.example.create.templates.for.team.research.weekly")}/></label><FunctionCategoryField value={requestFunction} onChange={setRequestFunction} disabled={busy}/></>}{!previewing&&<><footer className={css.buttons}><button type="button" disabled={busy} onClick={close}>{t("market.forms.cancel")}</button><button type="submit" disabled={busy||(mode==='github'&&!!pendingGithub)}>{busy?(mode==='github'?t("market.forms.fetching.and.checking"):t("market.forms.save.and.check")):mode==='upload'&&discovery?t('market.forms.saveSelected',{count:selectedPaths.length}):mode==='upload'&&!!file&&/\.zip$/i.test(file.name)?t("market.forms.read.zip.and.preview"):mode==='upload'&&(directory.length>0||!!file&&/\.json$/i.test(file.name))?t("market.forms.fixed.save.to.personal.directory"):mode==='paste'?t("market.forms.parsing.page.preview"):mode==='conversation'?t("market.forms.save.and.prepare.sessions"):t("market.forms.access.and.fixation.of.sources")}</button></footer></>}{referencePreview&&<footer className={css.buttons}><button type="button" disabled={busy} onClick={close}>{t("market.forms.cancel")}</button><button type="button" disabled={busy} onClick={()=>setReferencePreview(null)}>{t("market.forms.return.file.selection")}</button></footer>}{recipePreview&&<footer className={css.buttons}><button type="button" disabled={busy} onClick={close}>{t("market.forms.cancel")}</button><button type="button" disabled={busy} onClick={()=>{setRecipePreview(null);setError('')}}>{t('market.forms.recipe.back')}</button><button type="button" disabled={busy||!contentApi} onClick={()=>void confirmRecipe()}>{busy?t('market.forms.recipe.importing'):t('market.forms.recipe.confirm')}</button></footer>}{fixedPreview&&<footer className={css.buttons}><button type="button" disabled={busy} onClick={close}>{t("market.forms.close.preview")}</button><button type="button" disabled={busy} onClick={()=>{setFixedPreview(null);setFixedRequest('')}}>{t("market.forms.returns.github.input")}</button><button type="button" disabled={busy} onClick={()=>void importFixedIndustry()}>{t("market.forms.import.as.industry.template")}</button></footer>}</form></dialog>
}
/** 预览只声明依赖；候选来自固定目录，未选择的应用仍待配置。 */
function RecipeImportPreview({item,candidates,catalog,selections,change,inspect,busy,catalogAvailable,openConnection}:{item:MarketItem;candidates:readonly GrokRecipeConnectorCandidate[];catalog:MarketCatalogListing|null;selections:Readonly<Record<string,RecipeAppSelection>>;change:(value:Record<string,RecipeAppSelection>)=>void;inspect:()=>void;busy:boolean;catalogAvailable:boolean;openConnection:((catalogId:string,entry:MarketCatalogConnectorEntry)=>void)|undefined}){
  const {locale,t}=useI18n(),report=item.recipeImport
  if(!report)return null
  const copy=localizedMarketItemCopy(item,locale),description=isIndustryManifest(item.manifest)?item.manifest.description:''
  // 身份只按真实清单里的员工资源数归类：0 → 任务模板，1 → AI 员工，多位 → AI 团队
  const roles=isIndustryManifest(item.manifest)?item.manifest.resources.filter(resource=>resource.kind==='role'):[],identity=roles.length>1?'team':roles.length===1?'employee':'template'
  const pluginState=(state:'needs-configuration'|'declared-not-connected')=>t(state==='needs-configuration'?'market.forms.recipe.needsConfiguration':'market.forms.recipe.declaredNotConnected')
  const started=report.gettingStarted?report.gettingStarted.skillResourceId?report.skills.find(skill=>skill.resourceId===report.gettingStarted!.skillResourceId)?.title??report.gettingStarted.skill:t('market.forms.recipe.gettingStartedUnmatched',{skill:report.gettingStarted.skill}):undefined
  const group=(key:string,label:string,rows:readonly {key:string;title:string;note?:string}[])=><div className={importCss.recipeGroup} key={key}><dt>{label}<span>{rows.length}</span></dt><dd>{rows.length?<ul>{rows.map(row=><li key={row.key}><span>{row.title}</span>{row.note&&<small>{row.note}</small>}</li>)}</ul>:<span className={importCss.empty}>{t('market.forms.recipe.none')}</span>}</dd></div>
  return <section className={importCss.recipe} aria-label={t('market.forms.recipe.title')}>
    <h3 className={importCss.identity} data-import-identity={identity}><span>{t(identity==='team'?'templateShare.subject.team':identity==='employee'?'market.catalog.official.roleBadge':'templateShare.workTemplate')}</span>{identity==='team'&&<small>{t('market.primary.teamMembers',{count:roles.length})}</small>}</h3>
    <p>{t('market.forms.recipe.intro')}</p>
    <div className={importCss.recipeDuty}><strong>{copy.title}</strong>{description&&<span>{t('market.forms.recipe.duty')} · {description}</span>}</div>
    {identity==='team'&&<ul className={importCss.members}>{roles.map(role=><li key={role.id} data-import-member={role.title}>{role.title}</li>)}</ul>}
    <dl className={importCss.recipeGroups}>
      {group('skills',t('market.forms.recipe.skills'),report.skills.map(skill=>({key:skill.resourceId,title:skill.title})))}
      {group('routines',t('market.forms.recipe.routines'),report.routines.map(routine=>({key:routine.resourceId,title:routine.title,note:t('market.forms.recipe.needsSchedule')})))}
      <div className={importCss.recipeGroup}><dt>{t('market.forms.recipe.plugins')}<span>{report.plugins.length}</span></dt><dd>{report.plugins.length?<ul>{report.plugins.map(plugin=>{
        const options=candidates.filter(candidate=>candidate.pluginId===plugin.pluginId),selection=selections[plugin.pluginId],candidate=options.find(option=>option.catalogEntryId===selection?.catalogEntryId),entry=catalog?.items.find(row=>row.entry.id===candidate?.catalogEntryId)?.entry
        return <li key={plugin.resourceId} data-recipe-plugin={plugin.pluginId} className={importCss.recipeApp}>
          <div><span>{plugin.name}</span><small>{selection?.tools.length?t('market.forms.recipe.selectedDeclaration'):pluginState(plugin.state)}</small></div>
          <details onToggle={event=>{if(event.currentTarget.open)inspect()}}><summary>{t('market.forms.recipe.chooseApp')}</summary>
            {!catalogAvailable?<p>{t('market.forms.recipe.catalogUnavailable')}</p>:!catalog?<p>{t(busy?'market.forms.checking':'market.forms.recipe.catalogRetry')}</p>:!options.length?<p>{t('market.forms.recipe.noApp')}</p>:<>
              <label>{t('market.forms.recipe.app')}<select disabled={busy} value={selection?.catalogEntryId??''} onChange={event=>{const option=options.find(row=>row.catalogEntryId===event.target.value);const next={...selections};if(option)next[plugin.pluginId]={catalogEntryId:option.catalogEntryId,catalogVersion:option.catalogVersion,tools:[]};else delete next[plugin.pluginId];change(next)}}><option value="">{t('market.forms.recipe.unselected')}</option>{options.map(option=>{const row=catalog.items.find(row=>row.entry.id===option.catalogEntryId)?.entry;return <option key={option.catalogEntryId} value={option.catalogEntryId}>{row?.kind==='connector'?catalogText(row.connector.title,locale):option.serverName}</option>})}</select></label>
              {candidate&&selection&&<>{candidate.tools.length?<fieldset disabled={busy} className={importCss.recipeTools}><legend>{t('market.forms.recipe.tools')}</legend>{candidate.tools.slice(0,5).map(tool=><label key={tool.name}><input type="checkbox" checked={selection.tools.includes(tool.name)} onChange={event=>change({...selections,[plugin.pluginId]:{...selection,tools:event.target.checked?[...selection.tools,tool.name]:selection.tools.filter(name=>name!==tool.name)}})}/><span>{catalogText(tool.description,locale)}<small>{tool.name} · {t(tool.readOnly?'market.forms.recipe.readOnly':'market.forms.recipe.canWrite')}</small></span></label>)}{candidate.tools.length>5&&<details><summary>{t('market.forms.recipe.moreTools',{count:candidate.tools.length-5})}</summary>{candidate.tools.slice(5).map(tool=><label key={tool.name}><input type="checkbox" checked={selection.tools.includes(tool.name)} onChange={event=>change({...selections,[plugin.pluginId]:{...selection,tools:event.target.checked?[...selection.tools,tool.name]:selection.tools.filter(name=>name!==tool.name)}})}/><span>{catalogText(tool.description,locale)}<small>{tool.name} · {t(tool.readOnly?'market.forms.recipe.readOnly':'market.forms.recipe.canWrite')}</small></span></label>)}</details>}</fieldset>:<p>{t('market.forms.recipe.verifyTools')}</p>}
                {openConnection&&entry?.kind==='connector'&&<button type="button" disabled={busy} onClick={()=>openConnection(entry.id,entry)}>{t('market.forms.recipe.openConnection')}</button>}
                <p>{t('market.forms.recipe.mappingNotice')}</p>
              </>}
            </>}
          </details>
        </li>
      })}</ul>:<span className={importCss.empty}>{t('market.forms.recipe.none')}</span>}</dd></div>
    </dl>
    <details className={importCss.recipeSource}><summary>{t('market.forms.recipe.source')}</summary><p>{report.memory.resourceIds.length?t('market.forms.recipe.memoryNote',{count:report.memory.resourceIds.length}):t('market.forms.recipe.memoryNone')}</p>{started!==undefined&&<p>{t('market.forms.recipe.gettingStarted')} · {started}</p>}<p className={importCss.recipeHash}>{t('market.forms.recipe.sourceHash')} · <code>{report.sourceHash}</code></p></details>
    {/* 只有模板真的声明了应用或例行任务，才提示连接授权或另行设置计划 */}
    <p role="note">{[t('market.forms.recipe.afterImport'),...(report.plugins.length?[t('market.forms.recipe.afterImportApps')]:[]),...(report.routines.length?[t('market.forms.recipe.afterImportRoutines')]:[])].join(' ')}</p>
  </section>
}
export type TemplateInputDraft={title:string;scope:string;description:string;requirements:string;output:string;templateFunction:MarketFunctionKey|'';visibility:string;skills:readonly {id:string;title:string;version:string}[]}
export function TemplateForm({seed,source,spaces=[],draft,onDraft,close,save}:{seed?:TemplateSeed|undefined;source?:{title:string;sessionId:string};spaces?:readonly BusinessScopeLabel[];draft?:TemplateInputDraft|undefined;onDraft?:((draft:TemplateInputDraft)=>void)|undefined;close:()=>void;save:(item:MarketItem)=>void}){
  const {locale,t}=useI18n()
  const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0),titleInput=useRef<HTMLInputElement>(null)
  const [title,setTitle]=useState(draft?.title??seed?.title??''),[scope,setScope]=useState(draft?.scope??seed?.scope??''),[description,setDescription]=useState(draft?.description??seed?.description??''),[requirements,setRequirements]=useState(draft?.requirements??t("market.forms.objectives.of.the.work.and.scope.of.information")),[output,setOutput]=useState(draft?.output??t("market.forms.available.results.and.source.description")),[templateFunction,setTemplateFunction]=useState<MarketFunctionKey|''>(draft?.templateFunction??''),[visibility,setVisibility]=useState(draft?.visibility??'personal'),[skills,setSkills]=useState<readonly {id:string;title:string;version:string}[]>(draft?.skills??seed?.skills??[]),[checked,setChecked]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const draftCallback=useRef(onDraft);draftCallback.current=onDraft
  useEffect(()=>{draftCallback.current?.({title,scope,description,requirements,output,templateFunction,visibility,skills})},[title,scope,description,requirements,output,templateFunction,visibility,skills])
  const dismissEvents=useDialogDismiss(close,!busy)
  useEffect(()=>{const dispose=openDialog(dialog.current,titleInput.current);return()=>{generation.current++;dispose()}},[])
  const scopeOptions=scope&&!spaces.some(space=>space.scope===scope)?[...spaces,{scope,title:scope}]:spaces
  return <dialog ref={dialog} className={css.dialog} aria-label={t("market.forms.saveAsTaskTemplate")} {...dismissEvents}><form className={css.form} aria-label={t("market.forms.saveTaskTemplateForm")} onSubmit={event=>{event.preventDefault();if(!checked||busy)return;const token=++generation.current;setBusy(true);setError('');void createTeamTemplate({id:'work-'+crypto.randomUUID(),title,domain:scope,description,requirements:requirements.split('\n').filter(Boolean),output,visibility}).then(item=>{if(token===generation.current)save(withFunction(item,templateFunction))},error=>{if(token===generation.current)setError(localizeWorkError(locale,error))}).finally(()=>{if(token===generation.current)setBusy(false)})}}><header><h2>{t("market.forms.saveAsTaskTemplate")}</h2><button type="button" aria-label={t("market.forms.close.template.form")} disabled={busy} onClick={close}><X size={18}/></button></header><p className={css.muted}>{t("market.forms.save.only.the.template.fields.you.have.reviewed")}</p>{source&&<details><summary>{t("market.forms.from.session")}{source.title}</summary><p>{t("market.forms.session.id")}{source.sessionId}</p><p>{t("market.forms.the.source.is.used.only.for.this.compilation")}</p></details>}{error&&<p role="alert">{error}</p>}<label>{t("market.forms.template.name")}<input ref={titleInput} required maxLength={120} disabled={busy} value={title} onChange={event=>{setTitle(event.target.value);setChecked(false)}}/></label><label>{t("market.forms.templateScope")}<select required disabled={busy} value={scope} onChange={event=>{setScope(event.target.value);setChecked(false)}}><option value="" disabled>{t("market.forms.selectScopePlaceholder")}</option>{scopeOptions.map(option=><option key={option.scope} value={option.scope}>{option.title}</option>)}</select></label><FunctionCategoryField value={templateFunction} onChange={value=>{setTemplateFunction(value);setChecked(false)}} disabled={busy}/><label>{t("market.forms.workGoal")}<textarea required rows={5} maxLength={2000} disabled={busy} value={description} onChange={event=>{setDescription(event.target.value);setChecked(false)}}/></label><label>{t("market.forms.input.requirements.one.item.per.line")}<textarea required rows={3} disabled={busy} value={requirements} onChange={event=>{setRequirements(event.target.value);setChecked(false)}}/></label><label>{t("market.forms.delivery.requirements")}<textarea required rows={2} maxLength={2000} disabled={busy} value={output} onChange={event=>{setOutput(event.target.value);setChecked(false)}}/></label><label>{t("market.forms.saveScope")}<select disabled={busy} value={visibility} onChange={event=>{setVisibility(event.target.value);setChecked(false)}}><option value="personal">{t("market.forms.in.person")}</option><option value="team">{t("market.forms.team.interface.presentation")}</option></select></label><div><strong>{t("market.forms.methodReferences")}</strong>{skills.length?skills.map(skill=><p key={skill.id}>{skill.title} · {skill.version}<button type="button" disabled={busy} onClick={()=>{setSkills(current=>current.filter(item=>item.id!==skill.id));setChecked(false)}}>{t("market.forms.removeSkill",{name:skill.title})}</button></p>):<p>{t("market.forms.noMethodReferences")}</p>}</div><p className={css.muted}>{t("market.forms.templateExclusionsNotice")}</p><label className={marketCss.check}><input type="checkbox" disabled={busy} checked={checked} onChange={event=>setChecked(event.target.checked)}/>{t("market.forms.checked.without.customer.specific.information.account.numbers.certificates")}</label><footer className={css.buttons}><button type="button" disabled={busy} onClick={close}>{t("market.forms.cancel")}</button><button type="submit" disabled={!checked||busy}>{busy?t("market.forms.saving"):t("market.forms.save.as.a.draft.template")}</button></footer></form></dialog>
}
