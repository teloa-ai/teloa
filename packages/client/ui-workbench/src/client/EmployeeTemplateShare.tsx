import {createContext,useContext,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react'
import {Copy,FileDown,FileText,Link2,Send,ShieldCheck,Upload} from 'lucide-react'
import {assertBusinessShareInspection,inspectBusinessShareContent,readTemplateSharePackage,type TemplateSharePackage,type TemplateShareReceipt,type TemplateShareBridge,type TemplateSharePolicy} from '@teloa/contract'
import type {PreviewRole} from './role-preview.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {buildSharePlan,canonicalSharePackage,editSharePackage,editShareConnectionSetup,readSharePackage,readShareSubmission,sharePackageDigest,sharePackageSummary,shareInspectionInput,type SharePackage,type ShareConnectionSource,type ShareRoleSource,type ShareSkillSource,type ShareSubject,type ShareSubmission} from './share-package-plan.js'
import {readIndustryArchive} from './industry-archive.js'
import {isIndustryManifest} from './industry-manifest.js'
import {TemplateShareDrawer} from './TemplateShareDrawer.js'
import {ContextDrawer} from './ContextDrawer.js'
import {TemplateShareCard} from './TemplateShareCard.js'
import {useI18n} from './i18n/provider.js'
import type {TemplateShareMessageKey} from './i18n/locales/template-share.js'
import css from './TemplateShareDrawer.module.css'
import {templateShareErrorKey,templateSharePolicyKey} from './template-share-errors.js'
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'
import {ConnectionTemplateSetup,ConnectionTemplateSetupEditor} from './ConnectionTemplateSetup.js'

/**
 * 分享桥：在契约 v1 桥的基础上接受 v2 包并可选提供投稿；契约 v2 合入后以 `TemplateShareBridge` 替换本类型。
 * `withdraw` 为可选交界：根代理服务已实现 withdraw，Pro 透传另接；桥未提供时界面只显示准确的不可用状态。
 */
export type ShareBridge=Omit<TemplateShareBridge,'publish'|'read'>&{
 publish(input:{requestId:string;package:SharePackage}):Promise<TemplateShareReceipt>
 read(input:{shareId:string}):Promise<{shareId:string;package:unknown;sha256:string}>
 submit?(input:{shareId:string;licenseAttestation:true;notes?:string}):Promise<unknown>
 withdraw?(input:{shareId:string}):Promise<unknown>
 /** 社区 Web 的公开链接只触发预览意图，不安装或执行。 */
 receiveLink?(input:string):void
}
/** 分享来源：按员工绑定的原生技能名解析实际安装身份、版本与（许可允许时的）静态正文；连接按受管记录解析。 */
export type TemplateShareSources={skills:(names:readonly string[],selection?:{installationId:string})=>Promise<ShareSkillSource[]>;connections?:(serverNames?:readonly string[])=>Promise<ShareConnectionSource[]>}
export type TemplateShareContextValue={storage:WorkbenchNavigationStorage;bridge?:ShareBridge|undefined;publisher:string;sources?:TemplateShareSources|undefined;receive:()=>void;openDraft:(pkg:SharePackage)=>void}
const TemplateShareContext=createContext<TemplateShareContextValue|undefined>(undefined)
export const TemplateShareProvider=TemplateShareContext.Provider
export const useTemplateShare=()=>useContext(TemplateShareContext)

/** 投稿回执单独保存为客户端规范化形状，不与契约回执字段相互侵入。 */
type Draft={package:SharePackage;requestId:string;attempted:boolean;receipt?:TemplateShareReceipt;submission?:ShareSubmission;inspection?:{digest:string;findings:number}|undefined}
export function downloadEmployeeTemplate(pkg:SharePackage){
 const url=URL.createObjectURL(new Blob([canonicalSharePackage(pkg)],{type:'application/json'})),a=document.createElement('a')
 a.href=url;a.download=(readSharePackage(pkg).format==='teloa.template-share/v2'?(pkg as {subject:ShareSubject}).subject:'employee')+'-template.teloa-share.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export function TemplateFiles({pkg}:{pkg:SharePackage}){
 const {t}=useI18n(),summary=sharePackageSummary(pkg),[path,setPath]=useState(pkg.files[0]?.path)
 const selected=pkg.files.find(file=>file.path===path)??pkg.files[0],reader=useRef<HTMLPreElement>(null),scrolls=useRef(new Map<string,number>())
 const selectFile=(next:string)=>{if(selected&&reader.current)scrolls.current.set(selected.path,reader.current.scrollTop);setPath(next)}
 useLayoutEffect(()=>{if(reader.current)reader.current.scrollTop=scrolls.current.get(selected?.path??'')??0},[selected?.path])
 return <details className={css.disclosure}><summary><FileText size={17} aria-hidden="true"/>{t('templateShare.details')}<span className={css.summaryMeta}>{pkg.files.length}</span></summary><div className={css.detailContent}>
  {(summary.license||summary.publisher)&&<dl className={css.facts}>{summary.publisher&&<><dt>{t('templateShare.publisher')}</dt><dd>{summary.publisher}</dd></>}{summary.license&&<><dt>{t('templateShare.license')}</dt><dd>{summary.license}</dd></>}{summary.provenance.length>0&&<><dt>{t('templateShare.provenance')}</dt><dd>{summary.provenance.map(s=><span key={s.title}>{s.title} · {s.license}{s.url?' · '+s.url:''}</span>)}</dd></>}</dl>}
  {summary.connections.filter(connection=>connection.setup).map(connection=><div key={connection.resourceId}><strong>{connection.title}</strong><ConnectionTemplateSetup setup={connection.setup!}/></div>)}
  <div className={css.fileReader}><nav aria-label={t('templateShare.files')}>{pkg.files.map(file=><button type="button" key={file.path} aria-pressed={selected?.path===file.path} onClick={()=>selectFile(file.path)}>{file.path}</button>)}</nav>{selected&&<section aria-label={selected.path}><h4>{selected.path}</h4><pre ref={reader}>{selected.text}</pre></section>}</div>{pkg.requirements.length>0&&<><strong>{t('templateShare.requirements')}</strong><ul>{pkg.requirements.map((r,i)=><li key={i}>{r}</li>)}</ul></>}
 </div></details>
}
const inspect=async(pkg:SharePackage)=>{const result=await inspectBusinessShareContent(shareInspectionInput(pkg));return {digest:result.digest,findings:result.findings.length}}

/** 员工、团队、单独能力和自然语言草案共用的分享抽屉：草稿按入口键保留；导出或发布前以预览时的检查摘要核验正文未变。 */
export function SharePackageDrawer({open,close,storage,bridge,draftKey,hint,title,initial,editable=true,allowBundle=false,onPublished,expectedDigest,children}:{open:boolean;close:()=>void;storage:WorkbenchNavigationStorage;bridge?:ShareBridge|undefined;draftKey:string;hint?:TemplateShareMessageKey;title:string;initial:()=>Promise<SharePackage>|SharePackage;editable?:boolean;allowBundle?:boolean;onPublished?:(receipt:TemplateShareReceipt)=>Promise<void>|void;expectedDigest?:string;children?:ReactNode}){
 const {t}=useI18n(),key='teloa.template-draft/v2/'+draftKey
 const [draft,setDraft]=useState<Draft>(),[error,setError]=useState<string>(),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false),[policy,setPolicy]=useState<TemplateSharePolicy>(),[links,setLinks]=useState<TemplateShareReceipt[]>([]),[attested,setAttested]=useState(false),[notes,setNotes]=useState('')
 const [publicationHandled,setPublicationHandled]=useState(false)
 const persist=(value:Draft)=>{storage.setItem(key,JSON.stringify(value));setDraft(value);setCopied(false)}
 const run=async(action:()=>Promise<void>)=>{setError(undefined);setBusy(true);try{await action()}catch(error){setError(t(templateShareErrorKey(error)))}finally{setBusy(false)}}
 useEffect(()=>{
  if(!open)return
  let alive=true
  setPolicy(undefined);setError(undefined);setPublicationHandled(false);setDraft(undefined)
  void (async()=>{
   try{
    const raw=storage.getItem(key)
    const value:Draft=raw?JSON.parse(raw):{package:await initial(),requestId:crypto.randomUUID(),attempted:false}
    value.package=readSharePackage(value.package);if(!/^[a-f0-9-]{36}$/i.test(value.requestId))throw Error()
    if(expectedDigest!==undefined&&await sharePackageDigest(value.package)!==expectedDigest)throw Object.assign(Error('share changed'),{code:'share-changed'})
    if(!alive)return
    if(!raw)storage.setItem(key,JSON.stringify(value))
    setDraft(value)
    if(!value.inspection){const inspection=await inspect(value.package);if(alive)persist({...value,inspection})}
   }catch(error){if(alive)setError(t(templateShareErrorKey(error,'templateShare.invalid')))}
  })()
  if(bridge)void bridge.policy().then(p=>{if(alive)setPolicy(p)}).catch(()=>{if(alive)setPolicy({receiveMode:'preview-only',canPublish:false})})
  return()=>{alive=false}
 },[open,key,storage,bridge,expectedDigest])
 const replace=async(pkg:SharePackage)=>{const next:Draft={package:pkg,requestId:crypto.randomUUID(),attempted:false};persist(next);persist({...next,inspection:await inspect(pkg)})}
 const change=(title:string,description:string)=>{if(!draft||draft.attempted)return;try{const pkg=editSharePackage(draft.package,title,description);persist({...draft,package:pkg,inspection:undefined});void inspect(pkg).then(inspection=>setDraft(current=>current&&current.package===pkg?(storage.setItem(key,JSON.stringify({...current,inspection})),{...current,inspection}):current))}catch{setError(t('templateShare.invalid'))}}
 /** 任何导出或发布都先按预览时的检查摘要核验正文未变、无疑似凭据。 */
 const verified=async(value:Draft)=>{if(!value.inspection)throw Object.assign(Error('inspection pending'),{code:'invalid'});await assertBusinessShareInspection(shareInspectionInput(value.package),value.inspection.digest)}
 const exportFile=()=>run(async()=>{if(!draft)return;await verified(draft);downloadEmployeeTemplate(draft.package)})
 const confirmPublication=async(value:Draft)=>{
  const receipt=value.receipt
  if(!receipt||receipt.revoked||typeof receipt.shareId!=='string'||!receipt.shareId.trim()||receipt.sha256!==await sharePackageDigest(value.package)||receipt.version!==value.package.version)throw Error()
  await verified(value)
  await onPublished?.(receipt)
  setPublicationHandled(true)
 }
 const publish=()=>run(async()=>{
  if(!draft||!bridge||!policy?.canPublish)return
  await verified(draft);readSharePackage(draft.package)
  const pending={...draft,attempted:true};persist(pending)
  const receipt=await bridge.publish({requestId:pending.requestId,package:pending.package})
  if(receipt.sha256!==await sharePackageDigest(pending.package)||receipt.version!==pending.package.version||typeof receipt.revoked!=='boolean')throw Error()
  const rawSubmission=(receipt as {submission?:unknown}).submission,submission=rawSubmission===undefined?undefined:readShareSubmission(rawSubmission)
  const published={...pending,receipt,...(submission?{submission}:{})}
  persist(published)
  if(onPublished)await confirmPublication(published)
 })
 const submit=()=>run(async()=>{
  if(!draft?.receipt||draft.receipt.revoked||!bridge?.submit||!attested)return
  const submission=readShareSubmission(await bridge.submit({shareId:draft.receipt.shareId,licenseAttestation:true,...(notes.trim()?{notes:notes.trim()}:{})}))
  if(submission.shareId!==draft.receipt.shareId||submission.sha256!==draft.receipt.sha256)throw Error()
  persist({...draft,submission})
 })
 const withdraw=()=>run(async()=>{
  if(!draft?.receipt||!draft.submission||!bridge?.withdraw)return
  const submission=readShareSubmission(await bridge.withdraw({shareId:draft.receipt.shareId}))
  persist({...draft,submission})
 })
 const chooseBundle=async(file:File)=>run(async()=>{
  if(!draft||draft.attempted)return
  if(file.size>20*1024*1024)throw Error()
  const entries=await readIndustryArchive(new Uint8Array(await file.arrayBuffer()),file.name)
  if(entries.length!==1||!entries[0]?.item)throw Error()
  const item=entries[0].item
  if(!item.packageContent||!isIndustryManifest(item.manifest))throw Error()
  const manifest={...item.manifest,id:crypto.randomUUID()},content=item.packageContent
  const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
  await replace(readTemplateSharePackage({
   format:'teloa.template-share/v1',id:manifest.id,version:manifest.version,title:manifest.title,description:manifest.description,requirements:[],
   compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:manifest.resources.some(r=>r.kind==='plan')?['people','automation']:['people']},
   files:content.files.map(f=>({path:f.path.slice(root.length),text:f.path===content.manifestPath?JSON.stringify(manifest,null,2):new TextDecoder('utf-8',{fatal:true}).decode(f.bytes)})),
  }))
 })
 const newDraft=()=>run(async()=>{await replace(await initial())})
 const blocked=!draft?.inspection||draft.inspection.findings>0
 const mainAction=()=>{
  if(!draft)return null
  if(draft.receipt&&!draft.receipt.revoked)return <>
   <p className={css.shareLink}><Link2 size={15} aria-hidden="true"/><span aria-label={t('templateShare.shareUrl')}>{draft.receipt.shareUrl}</span></p>
   <button type="button" className={css.primary} disabled={busy} onClick={()=>void run(async()=>{await navigator.clipboard.writeText(draft.receipt!.shareUrl);setCopied(true)})}><Copy size={17} aria-hidden="true"/><span aria-live="polite">{t(copied?'templateShare.copied':'templateShare.copy')}</span></button>
   {onPublished&&!publicationHandled&&<button type="button" disabled={busy} onClick={()=>void run(()=>confirmPublication(draft))}>{t('templateShare.continueConfirmation')}</button>}
  </>
  if(draft.receipt?.revoked)return editable?<button type="button" className={css.primary} disabled={busy} onClick={()=>void newDraft()}>{t('templateShare.newDraft')}</button>:null
  if(policy?.reason==='authentication-required')return <button type="button" className={css.primary} disabled={busy} onClick={()=>void run(async()=>{await window.teloaApplication?.openAccount();setPolicy(await bridge!.policy())})}>{t('templateShare.account')}</button>
  if(bridge&&(!policy||policy.canPublish))return <button type="button" className={css.primary} disabled={busy||!policy||blocked} onClick={()=>void publish()}><Link2 size={17} aria-hidden="true"/>{t(busy||!policy?'templateShare.busy':draft.attempted?'templateShare.retry':'templateShare.publish')}</button>
  return <button type="button" className={css.primary} disabled={busy||blocked} onClick={()=>void exportFile()}><FileDown size={17} aria-hidden="true"/>{t('templateShare.export')}</button>
 }
 const submission=draft?.receipt?draft.submission:undefined
 return <TemplateShareDrawer open={open} title={title} close={close}>
  {hint&&<p className={css.intro}>{t(hint)}</p>}
  {error&&<p className={css.alert} role="alert">{error}</p>}
  {draft&&!draft.inspection&&!error&&<p className={css.note} role="status">{t('templateShare.inspecting')}</p>}
  {draft?.inspection&&draft.inspection.findings>0&&<p className={css.alert} role="alert">{t('templateShare.inspectionIssue')}</p>}
  {children}
  {draft&&<>
   <TemplateShareCard key={draft.package.id} pkg={draft.package} status={draft.receipt?(draft.receipt.revoked?'revoked':'published'):draft.attempted?'unconfirmedStatus':'draft'}>
    {mainAction()}
    {(!bridge||policy&&!policy.canPublish)&&<p className={css.note}>{t(templateSharePolicyKey(policy))}</p>}
   </TemplateShareCard>
   <p className={css.privacy}><ShieldCheck size={17} aria-hidden="true"/><span>{t('templateShare.excluded')}</span></p>
   {editable&&!draft.attempted&&sharePackageSummary(draft.package).connections.some(connection=>connection.serverName)&&<details className={css.disclosure}><summary>{t('templateShare.connectionTemplate')}</summary><div className={css.detailContent}><p className={css.note}>{t('templateShare.connectionTemplateHint')}</p>{sharePackageSummary(draft.package).connections.filter(connection=>connection.serverName).map(connection=><ConnectionTemplateSetupEditor key={draft.package.id+'/'+connection.resourceId} title={connection.title} setup={connection.setup} disabled={busy} apply={value=>{const next=editShareConnectionSetup(draft.package,connection.resourceId,value);persist({...draft,package:next,inspection:undefined});void inspect(next).then(inspection=>setDraft(current=>current?.package===next?(storage.setItem(key,JSON.stringify({...current,inspection})),{...current,inspection}):current))}}/>)}</div></details>}
   <TemplateFiles pkg={draft.package}/>
   {editable&&!draft.attempted&&<details className={css.disclosure}><summary>{t('templateShare.editIntro')}</summary><div className={css.detailContent}>
    <label>{t('templateShare.title')}<input maxLength={120} value={draft.package.title} disabled={busy} onChange={e=>change(e.target.value,draft.package.description)}/></label>
    <label>{t('templateShare.description')}<textarea maxLength={2000} value={draft.package.description} disabled={busy} onChange={e=>change(draft.package.title,e.target.value)}/></label>
    {allowBundle&&<label className={css.file}><Upload size={16} aria-hidden="true"/>{t('templateShare.chooseBundle')}<input className={css.fileInput} type="file" accept=".zip" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void chooseBundle(file);e.target.value=''}}/></label>}
   </div></details>}
   {(bridge||draft.receipt)&&<div className={css.actions}>
    <button type="button" disabled={busy||blocked} onClick={()=>void exportFile()}><FileDown size={16} aria-hidden="true"/>{t('templateShare.export')}</button>
    {draft.receipt&&!draft.receipt.revoked&&<>
     <button type="button" className={css.textButton} disabled={busy} onClick={()=>void run(async()=>{await bridge!.revoke({shareId:draft.receipt!.shareId});persist({...draft,receipt:{...draft.receipt!,revoked:true}})})}>{t('templateShare.revoke')}</button>
     {editable&&<button type="button" className={css.textButton} disabled={busy} onClick={()=>void newDraft()}>{t('templateShare.newDraft')}</button>}
    </>}
   </div>}
   {draft.receipt&&!draft.receipt.revoked&&policy?.canPublish&&(bridge?.submit?<details className={css.disclosure}><summary><Send size={16} aria-hidden="true"/>{t('templateShare.submit')}{submission&&<span className={css.summaryMeta}>{t(`templateShare.submission.${submission.status}`)}</span>}</summary><div className={css.detailContent}>
    <p className={css.note}>{t('templateShare.submitHint')}</p>
    {submission?<>
     <p role="status">{t(`templateShare.submission.${submission.status}`)}{submission.reviewerNote?` · ${submission.reviewerNote}`:''}</p>
     {submission.status==='pending'&&bridge.withdraw&&<button type="button" className={css.textButton} disabled={busy} onClick={()=>void withdraw()}>{t('templateShare.withdraw')}</button>}
    </>:<>
     <label className={css.option}><input type="checkbox" checked={attested} disabled={busy} onChange={e=>setAttested(e.target.checked)}/>{t('templateShare.attestation')}</label>
     <label>{t('templateShare.notes')}<textarea maxLength={2000} value={notes} disabled={busy} onChange={e=>setNotes(e.target.value)}/></label>
     <button type="button" disabled={busy||!attested} onClick={()=>void submit()}><Send size={16} aria-hidden="true"/>{t('templateShare.submit')}</button>
    </>}
   </div></details>:<p className={css.note}>{t('templateShare.submitUnavailable')}</p>)}
  </>}
  {bridge&&<details className={css.disclosure} onToggle={event=>{if(event.currentTarget.open)void bridge.list().then(setLinks).catch(()=>setError(t('templateShare.readError')))}}>
   <summary>{t('templateShare.savedLinks')}</summary>
   <div className={css.detailContent}>{links.map(link=><div className={css.savedLink} key={link.shareId}>
    <p>{link.shareUrl}</p><small>{t(link.revoked?'templateShare.revoked':'templateShare.published')} · v{link.version}</small>
    {!link.revoked&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await bridge.revoke({shareId:link.shareId});setLinks(await bridge.list());if(draft?.receipt?.shareId===link.shareId)persist({...draft,receipt:{...draft.receipt,revoked:true}})})}>{t('templateShare.revoke')}</button>}
   </div>)}</div>
  </details>}
 </TemplateShareDrawer>
}

const roleSource=(role:PreviewRole):ShareRoleSource=>({id:role.id,name:role.name,kind:role.kind,...(role.avatarKey===undefined?{}:{avatarKey:role.avatarKey}),duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge,responsibility:role.responsibility})
/** 员工分享：技能按员工绑定的原生技能名解析实际安装身份；没有来源端口时只写成接收方需配置项。 */
export function EmployeeTemplateShare({role,open,close,storage,bridge}:{role:PreviewRole;open:boolean;close:()=>void;storage:WorkbenchNavigationStorage;bridge?:ShareBridge|undefined}){
 const {t}=useI18n(),shared=useTemplateShare()
 const initial=async()=>buildSharePlan({subject:'employee',publisher:shared?.publisher??'',roles:[roleSource(role)],skills:await shared?.sources?.skills(role.skills)??[],connections:await shared?.sources?.connections?.()??[]})
 return <SharePackageDrawer open={open} close={close} storage={storage} bridge={bridge} draftKey={'employee/'+role.id} hint="templateShare.shareHint" title={t('templateShare.create')} initial={initial} allowBundle/>
}
type TeamShareProps={roles:readonly PreviewRole[];open:boolean;close:()=>void;scope:string;title:string;coordinatorRoleId?:string|undefined;origin?:'directory'|'business'}
type TeamShareRole={source:ShareRoleSource;version:number;state:PreviewRole['state']}
type TeamShareComposition={roles:TeamShareRole[];members:string[];lead:string;signature:string;revision?:string}
const teamShareDrafts=createRoleFormDrafts<TeamShareComposition>(),teamShareOwners=new WeakMap<ShareBridge,WeakMap<WorkbenchNavigationStorage,object>>()
function teamShareOwner(shared:TemplateShareContextValue){
 if(!shared.bridge)return shared.storage
 let storages=teamShareOwners.get(shared.bridge);if(!storages){storages=new WeakMap();teamShareOwners.set(shared.bridge,storages)}
 let owner=storages.get(shared.storage);if(!owner){owner={};storages.set(shared.storage,owner)}return owner
}
/** 选择按本人分享端口和原团队入口保留；重新读取目录不能替本人换成员或协调者。 */
export function TeamTemplateShare(props:TeamShareProps){
 const shared=useTemplateShare(),identity=useRef<{owner:object;context:string;epoch:number}>()
 if(!shared)return null
 const owner=teamShareOwner(shared),context=JSON.stringify([props.origin??'business',props.scope])
 if(identity.current?.owner!==owner||identity.current.context!==context)identity.current={owner,context,epoch:(identity.current?.epoch??0)+1}
 return <TeamTemplateShareEditor key={identity.current.epoch} {...props} shared={shared} owner={owner} context={context}/>
}
function TeamTemplateShareEditor({roles,open,close,scope,title,coordinatorRoleId,shared,owner,context}:TeamShareProps&{shared:TemplateShareContextValue;owner:object;context:string}){
 const {t}=useI18n(),[slot,snapshot]=useRoleFormDraft(teamShareDrafts,owner,context)
 const currentRoles=roles.filter(role=>role.kind==='employee'&&role.state!=='retired').map(role=>({source:roleSource(role),version:role.version,state:role.state}))
 const signature=JSON.stringify({roles:[...currentRoles].sort((a,b)=>a.source.id.localeCompare(b.source.id)),coordinator:coordinatorRoleId??''})
 const current:TeamShareComposition={roles:currentRoles,members:currentRoles.map(role=>role.source.id),lead:currentRoles.some(role=>role.source.id===coordinatorRoleId)?coordinatorRoleId!:'',signature}
 // 默认全员组合也已开始生成静态原稿，必须在首次挂载固定，不能等本人改选后才保护来源。
 useLayoutEffect(()=>{if(!slot.read().value)slot.set(current)},[slot])
 const draft=snapshot.value??current,{members,lead}=draft,stale=draft.signature!==signature
 const change=(patch:Partial<Pick<TeamShareComposition,'members'|'lead'>>)=>slot.set({...draft,...patch})
 // 原静态包与已发布回执仍留在原键；本人放弃选择后另起原稿，不能悄悄重用旧版本包。
 const discard=()=>slot.set({...current,revision:crypto.randomUUID()})
 const chosen=draft.roles.filter(role=>members.includes(role.source.id))
 const initial=async()=>buildSharePlan({subject:'team',title,publisher:shared.publisher,roles:chosen.map(role=>role.source),skills:await shared.sources?.skills([...new Set(chosen.flatMap(role=>role.source.skills))])??[],connections:await shared.sources?.connections?.()??[],...(lead&&members.includes(lead)?{coordinatorRoleId:lead}:{})})
 // 同一成员与协调者组合回到同一份草稿；改选即换草稿键，不覆盖已发布版本。
 const draftKey='team/'+scope+'/'+[...members].sort().join(',')+'/'+(lead||'-')+(draft.revision?'/'+draft.revision:'')
 const composition=<div className={css.composition}>
   <strong>{t('templateShare.members')}</strong>
   <ul>{draft.roles.map(({source:role})=><li key={role.id}><label className={css.option}><input type="checkbox" disabled={stale} checked={members.includes(role.id)} onChange={event=>{const next=event.target.checked?[...members,role.id]:members.filter(id=>id!==role.id);change({members:next,lead:next.includes(lead)?lead:''})}}/>{role.name}</label></li>)}</ul>
   <label>{t('templateShare.coordinator')}<select disabled={stale} value={lead} onChange={event=>change({lead:event.target.value})}><option value="">{t('templateShare.noCoordinator')}</option>{chosen.map(({source:role})=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
   {snapshot.value&&<button type="button" onClick={discard}>{t('collaboration.resources.discardDraft')}</button>}
  </div>
 if(stale)return <TemplateShareDrawer open={open} close={close} title={t('templateShare.shareTeam')}>{composition}<p className={css.alert} role="alert">{t('artifact.panel.text.119')}</p></TemplateShareDrawer>
 return <SharePackageDrawer key={draftKey} open={open} close={close} storage={shared.storage} bridge={shared.bridge} draftKey={draftKey} hint="templateShare.teamHint" title={t('templateShare.shareTeam')} initial={initial}>{composition}</SharePackageDrawer>
}
/** 单独能力分享：技能、应用（技能加连接）或连接；来源不可读时显示准确的不可用状态。 */
export function CapabilityTemplateShare({subject,skills,connections,open,close,draftKey}:{subject:Exclude<ShareSubject,'employee'|'team'>;skills:readonly ShareSkillSource[];connections?:readonly ShareConnectionSource[];open:boolean;close:()=>void;draftKey:string}){
 const {t}=useI18n(),shared=useTemplateShare()
 if(!shared)return null
 const initial=()=>buildSharePlan({subject,publisher:shared.publisher,roles:[],skills,connections:connections??[]})
 return <SharePackageDrawer open={open} close={close} storage={shared.storage} bridge={shared.bridge} draftKey={'capability/'+subject+'/'+draftKey} hint="templateShare.capabilityHint" title={t(subject==='skill'?'templateShare.shareSkill':subject==='mcp'?'templateShare.shareConnection':'templateShare.shareApp')} initial={initial}/>
}
/** 自然语言草案：只预览静态模板并导出或发布；发布成功后可由调用方落定原草案。 */
export function ShareDraftDrawer({pkg,open,close,onPublished,editable=true}:{pkg:SharePackage;open:boolean;close:()=>void;onPublished?:(receipt:TemplateShareReceipt)=>Promise<void>|void;editable?:boolean}){
 const {t}=useI18n(),shared=useTemplateShare()
 const [identity,setIdentity]=useState<{pkg:SharePackage;digest:string}|undefined>(),[error,setError]=useState(false)
 useEffect(()=>{
  let current=true;setIdentity(undefined);setError(false)
  if(open)void sharePackageDigest(pkg).then(digest=>{if(current)setIdentity({pkg,digest})},()=>{if(current)setError(true)})
  return()=>{current=false}
 },[pkg,open])
 if(!shared)return null
 if(!open)return null
 if(!identity||identity.pkg!==pkg)return <ContextDrawer padded title={t('templateShare.create')} close={close}><p role={error?'alert':'status'}>{t(error?'templateShare.invalid':'templateShare.busy')}</p></ContextDrawer>
 // 同一自然语言草案修改了正文后，旧已冻结的发布尝试不能覆盖新原稿；仅相同摘要恢复同一尝试。
 return <SharePackageDrawer key={identity.digest} open={open} close={close} storage={shared.storage} bridge={shared.bridge} draftKey={'draft/'+pkg.id+'/'+identity.digest} title={t('templateShare.create')} initial={()=>pkg} editable={editable} {...(!editable?{expectedDigest:identity.digest}:{})} {...(onPublished?{onPublished}:{})}/>
}
