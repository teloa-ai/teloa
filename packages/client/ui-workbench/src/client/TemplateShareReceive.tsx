import {useEffect,useMemo,useRef,useState} from 'react'
import {ArrowUpRight,Check,FileUp,ShieldCheck} from 'lucide-react'
import {type TemplateShareIntent,type TemplateSharePolicy} from '@teloa/contract'
import {hasShareSelection,readSharePackage,sharePackageDigest,sharePackageSummary,type SharePackage,type ShareSummary} from './share-package-plan.js'
import type {ShareAcceptChoice,ShareAcceptItem,ShareAcceptItemState,ShareAcceptanceResult} from './template-share-accept.js'
import {TemplateFiles,type ShareBridge} from './EmployeeTemplateShare.js'
import {TemplateShareDrawer} from './TemplateShareDrawer.js'
import {TemplateShareCard} from './TemplateShareCard.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {applicationPresentation} from './application-presentation.js'
import {CapabilityNotice,useApplicationCapability} from './CapabilityNotice.js'
import {useI18n} from './i18n/provider.js'
import css from './TemplateShareDrawer.module.css'
import {templateShareErrorKey,templateSharePolicyKey} from './template-share-errors.js'
import {ConnectionTemplateSetup} from './ConnectionTemplateSetup.js'
import {readWebTemplateShareLink} from './web-template-share.js'

type Props={createTeam?:((loadId:string,isCurrent?:()=>boolean)=>Promise<void>)|undefined;openGroup?:((groupId:string)=>void)|undefined;open:boolean;close:()=>void;intent:TemplateShareIntent|null;bridge?:ShareBridge|undefined;accept:(pkg:SharePackage,choice:ShareAcceptChoice,intent?:TemplateShareIntent)=>Promise<ShareAcceptanceResult>;/** 已开始接收的原选择：存在时锁定范围与技能，只能继续原申请。 */savedChoice?:((pkg:SharePackage)=>Promise<ShareAcceptChoice|undefined>)|undefined;openRole:(id:string)=>void;configure:(loadId:string)=>void;openSkill?:((installationId:string)=>void)|undefined;openConnections?:(()=>void)|undefined;/** 可添加到的业务范围；缺省只提供通用。 */targets?:readonly {scope:string;title:string}[]|undefined}
const stateClass=(state:ShareAcceptItemState)=>state==='done'?css.stateGood:state==='failed'?css.stateBad:undefined
/** 组成确认与结果共用一张清单：添加前显示选择，添加后逐项显示真实状态，不把全部项写成已就绪。 */
function Composition({summary,locked,selected,toggle,result,busy,openRole,openSkill,openConnections,t}:{summary:ShareSummary;locked:boolean;selected:Set<string>;toggle:(id:string,on:boolean)=>void;result?:ShareAcceptanceResult|undefined;busy:boolean;openRole:(id:string)=>void;openSkill?:((id:string)=>void)|undefined;openConnections?:(()=>void)|undefined;t:(key:`templateShare.${string}`)=>string}){
 const state=(items:ShareAcceptItem[]|undefined,id:string)=>items?.find(i=>i.resourceId===id)
 const label=(item:ShareAcceptItem|undefined)=>item?<em className={stateClass(item.state)}>{t(`templateShare.result.${item.state}`)}</em>:null
 return <div className={css.composition}>
  {summary.roles.length>0&&<><strong>{t(summary.subject==='team'?'templateShare.members':'templateShare.employee')}</strong><ul>{summary.roles.map(role=>{const added=result?.roles.find(r=>r.resourceId===role.resourceId);return <li key={role.resourceId}><EmployeeAvatar avatarKey={role.avatarKey} size="sm"/><span className={css.compositionText}><strong>{role.name}</strong>{summary.coordinatorResourceId===role.resourceId&&<small>{t('templateShare.coordinator')}</small>}</span>{added?.roleId?<button type="button" className={css.textButton} onClick={()=>openRole(added.roleId!)}>{t('templateShare.openRole')}</button>:added?<em className={stateClass(added.state)}>{t(`templateShare.result.${added.state}`)}</em>:null}</li>})}</ul></>}
  {summary.skills.length>0&&<><strong>{t('templateShare.skill')}</strong><ul>{summary.skills.map(skill=>{const item=state(result?.skills,skill.resourceId);return <li key={skill.resourceId}><span className={css.compositionText}>{result?<strong>{skill.title}</strong>:<label className={css.option}><input type="checkbox" disabled={busy||locked} checked={selected.has(skill.resourceId)} onChange={e=>toggle(skill.resourceId,e.target.checked)}/>{skill.title}</label>}<small>v{skill.version} · {t(skill.source==='public'?'templateShare.skillPublic':'templateShare.skillLocal')}{!result&&' · '+t('templateShare.installSkill')}</small></span>{item?.installationId&&openSkill?<button type="button" className={css.textButton} onClick={()=>openSkill(item.installationId!)}>{t('templateShare.openSkill')}</button>:label(item)}</li>})}</ul></>}
  {summary.connections.length>0&&<><strong>{t('templateShare.connection')}</strong><ul>{summary.connections.map(c=>{const item=state(result?.mcp,c.resourceId);return <li key={c.resourceId}><span className={css.compositionText}><strong>{c.title}</strong><small>{c.serverName?c.serverName+(c.tools?' · '+c.tools.length:''):''}</small>{c.setup&&<ConnectionTemplateSetup setup={c.setup}/>}</span>{item?.state==='done'&&openConnections?<button type="button" className={css.textButton} onClick={openConnections}>{t('templateShare.openConnections')}</button>:label(item)}</li>})}</ul><p className={css.note}>{t('templateShare.connectionsNote')}</p></>}
  {summary.plugins.length>0&&<><strong>{t('templateShare.plugin')}</strong><ul>{summary.plugins.map(p=>{const item=state(result?.plugins,p.resourceId);return <li key={p.resourceId}><span className={css.compositionText}><strong>{p.title}</strong><small>{p.packageName??''} v{p.version}{item?.reason?' · '+t(`templateShare.pluginReason.${item.reason}`):''}</small></span>{label(item)}</li>})}</ul><p className={css.note}>{t('templateShare.pluginNote')}</p></>}
  {summary.plans.length>0&&<><strong>{t('templateShare.plan')}</strong><ul>{summary.plans.map(p=><li key={p.resourceId}><span className={css.compositionText}><strong>{p.title}</strong></span>{label(state(result?.plans,p.resourceId))}</li>)}</ul><p className={css.note}>{t('templateShare.plansNote')}</p></>}
 </div>
}
export function TemplateShareReceive({open,close:onClose,intent,bridge,accept,savedChoice,openRole,configure,openSkill,openConnections,targets,createTeam,openGroup}:Props){
 const {t}=useI18n(),allowed=useApplicationCapability('people'),automation=useApplicationCapability('automation')
 const [pkg,setPackage]=useState<SharePackage>(),[policy,setPolicy]=useState<TemplateSharePolicy>(),[error,setError]=useState<string>(),[busy,setBusy]=useState(false),[result,setResult]=useState<ShareAcceptanceResult>(),[online,setOnline]=useState<string>(),[selected,setSelected]=useState<Set<string>>(new Set()),[scope,setScope]=useState('general'),[locked,setLocked]=useState(false)
 const [choiceReady,setChoiceReady]=useState(false)
 const [shareLink,setShareLink]=useState('')
 const epoch=useRef(0)
 const close=()=>{
  epoch.current++
  // 完成回执保留在原接收记录；重新打开导入入口应能接收另一份模板。未完成申请仍保留原选择。
  if(result?.complete){setPackage(undefined);setResult(undefined);setOnline(undefined);setShareLink('');setLocked(false);setChoiceReady(false);setError(undefined)}
  onClose()
 }
 const summary=useMemo(()=>pkg?sharePackageSummary(pkg):undefined,[pkg])
 const restoreChoice=async(value:SharePackage,serial:number)=>{
  setChoiceReady(false)
  // 已开始的接收沿用原选择：未知回执或中断后不能悄悄换范围或技能。
  const saved=await savedChoice?.(value)
  if(serial!==epoch.current)return
  if(saved){setScope(saved.scope);setSelected(new Set(saved.skills))}
  setLocked(!!saved);setChoiceReady(true)
 }
 const show=async(value:SharePackage,serial:number)=>{
  setPackage(value);setResult(undefined);setLocked(false);setScope('general');setSelected(new Set(sharePackageSummary(value).skills.filter(s=>s.required).map(s=>s.resourceId)))
  await restoreChoice(value,serial)
 }
 const read=async()=>{const serial=++epoch.current;if(intent){setPackage(undefined);setOnline(undefined);setResult(undefined)}setChoiceReady(false);setError(undefined);setBusy(true);try{const p=bridge?await bridge.policy():{receiveMode:applicationPresentation.getSnapshot().product==='Free'?'personal-role':'preview-only',canPublish:false} as TemplateSharePolicy;if(serial!==epoch.current)return;setPolicy(p);if(intent&&bridge){const received=await bridge.read(intent),parsed=readSharePackage(received.package);if(received.shareId!==intent.shareId||received.sha256!==await sharePackageDigest(parsed))throw Error();if(serial!==epoch.current)return;await show(parsed,serial);if(serial===epoch.current)setOnline(intent.shareId)}else if(pkg)await restoreChoice(pkg,serial)}catch(error){if(serial===epoch.current)setError(t(templateShareErrorKey(error,'templateShare.readError')))}finally{if(serial===epoch.current)setBusy(false)}}
 useEffect(()=>{if(open)void read();else setChoiceReady(false);return()=>{epoch.current++}},[open,intent?.shareId,bridge])
 const choose=async(file:File)=>{const serial=++epoch.current;setError(undefined);setPackage(undefined);setOnline(undefined);setResult(undefined);setChoiceReady(false);setBusy(true);try{if(file.size>8*1024*1024)throw Error();const parsed=readSharePackage(JSON.parse(await file.text()));if(serial!==epoch.current)return;await show(parsed,serial)}catch{if(serial===epoch.current)setError(t('templateShare.invalid'))}finally{if(serial===epoch.current)setBusy(false)}}
 const needsPeople=!!summary&&summary.roles.length>0
 const emptySelection=!!summary&&!hasShareSelection(summary,[...selected])
 const confirm=async()=>{if(!pkg||busy||!choiceReady||emptySelection||policy?.receiveMode==='preview-only'||needsPeople&&!allowed)return;const serial=epoch.current;setBusy(true);setError(undefined);try{
  const currentPolicy=bridge?await bridge.policy():policy;if(currentPolicy?.receiveMode!=='personal-role'&&currentPolicy?.receiveMode!=='organization-install')throw Error();setPolicy(currentPolicy)
  if(currentPolicy.receiveMode==='organization-install'&&(!bridge?.beginAcceptance||!bridge.endAcceptance))throw Object.assign(Error('Template installation context is unavailable.'),{code:'permission-denied'})
  if(needsPeople&&!applicationPresentation.can('people')||pkg.compatibility.capabilities.includes('automation')&&!applicationPresentation.can('automation'))throw Error()
  if(online){const current=await bridge!.read({shareId:online});if(current.shareId!==online||current.sha256!==await sharePackageDigest(pkg)||await sharePackageDigest(current.package)!==current.sha256)throw Object.assign(Error('Template share changed.'),{code:'share-changed'})}
  if(serial!==epoch.current)return
  const added=await accept(pkg,{skills:[...selected],scope},online?{shareId:online}:undefined);if(serial!==epoch.current)return;setResult(added);if(online&&added.complete)await bridge!.dismiss({shareId:online})
 }catch(error){if(serial===epoch.current){setError(t(error&&typeof error==='object'&&'code'in error&&error.code==='acceptance-choice-conflict'?'templateShare.resumeChoice':templateShareErrorKey(error)));try{await restoreChoice(pkg,serial)}catch{if(serial===epoch.current)setError(t('templateShare.readError'))}}}finally{if(serial===epoch.current)setBusy(false)}}
 const automationBlocked=!!pkg&&pkg.compatibility.capabilities.includes('automation')&&!automation
 const added=result?.complete?(summary?.subject==='team'?'templateShare.teamAdded':summary?.roles.length?'templateShare.added':'templateShare.capabilityAdded'):'templateShare.partial'
 return <TemplateShareDrawer open={open} title={t('templateShare.receive')} close={close}>
  {error&&<p className={css.alert} role="alert">{error}</p>}
  {bridge?.receiveLink&&<form className={css.detailContent} onSubmit={event=>{event.preventDefault();if(busy||locked)return;try{const selected=readWebTemplateShareLink(shareLink);setError(undefined);if(intent?.shareId===selected.shareId)void read();else bridge.receiveLink!(shareLink)}catch{setError(t('templateShare.invalid'))}}}>
   <label>{t('templateShare.shareUrl')}<input type="url" value={shareLink} maxLength={2048} placeholder="https://market.teloa.ai/share/?id=…" disabled={busy||locked} onChange={event=>setShareLink(event.target.value)}/></label>
   <button type="submit" disabled={busy||locked||!shareLink.trim()}>{t('templateShare.read')}</button>
  </form>}
  {pkg&&summary?<>
   <TemplateShareCard key={pkg.id} pkg={pkg} status={result?.complete?'addedLabel':'preview'}>
    {result?.complete?<>
     <p className={css.success} role="status"><Check size={17} aria-hidden="true"/>{t(added)}</p>
     {result.groupId&&openGroup?<button type="button" className={css.primary} onClick={()=>{close();openGroup(result.groupId!)}}>{t('templateShare.openTeam')}<ArrowUpRight size={17} aria-hidden="true"/></button>:result.roleIds[0]&&<button type="button" className={css.primary} onClick={()=>{close();openRole(result.coordinatorRoleId??result.roleIds[0]!)}}>{t('templateShare.openRole')}<ArrowUpRight size={17} aria-hidden="true"/></button>}
     {result.loadId&&<button type="button" onClick={()=>{close();configure(result.loadId!)}}>{t('templateShare.configure')}</button>}
    </>:policy?.reason==='authentication-required'?<button type="button" className={css.primary} disabled={busy} onClick={()=>void window.teloaApplication?.openAccount().then(()=>read()).catch(()=>setError(t('templateShare.login')))}>{t('templateShare.account')}</button>:<>
     {result&&<p className={css.note} role="status">{t('templateShare.partial')}</p>}
     {summary.subject==='team'&&result?.loadId&&!result.groupId&&result.roles.every(role=>role.state==='done')&&createTeam&&<button type="button" className={css.primary} disabled={busy} onClick={()=>{const serial=epoch.current;setBusy(true);setError(undefined);void createTeam(result.loadId!,()=>serial===epoch.current).catch(error=>{if(serial===epoch.current)setError(t(templateShareErrorKey(error)))}).finally(()=>{if(serial===epoch.current)setBusy(false)})}}>{t('templateShare.createTeam')}</button>}
     <button type="button" className={summary.subject==='team'&&result?.loadId?undefined:css.primary} disabled={busy||!choiceReady||emptySelection||!policy||policy.receiveMode==='preview-only'||needsPeople&&!allowed||automationBlocked} onClick={()=>void confirm()}>{t(busy?'templateShare.busy':result?'templateShare.continueAdd':error?'templateShare.retry':'templateShare.addAll')}</button>
     {emptySelection&&<p className={css.note} role="status">{t('templateShare.chooseOne')}</p>}
    </>}
    {!result&&policy?.receiveMode==='preview-only'&&<p className={css.note}>{t(policy.reason?templateSharePolicyKey(policy):'templateShare.permission')}</p>}
   </TemplateShareCard>
   {!result?.complete&&policy?.reason!=='authentication-required'&&(needsPeople&&!allowed?<CapabilityNotice capability="people"/>:automationBlocked?<CapabilityNotice capability="automation"/>:null)}
   {locked&&!result&&<p className={css.note} role="status">{t('templateShare.resumeChoice')}</p>}
   {!result&&needsPeople&&targets&&targets.length>0&&<label className={css.option}>{t('templateShare.target')}<select value={scope} disabled={busy||locked||!choiceReady} onChange={e=>setScope(e.target.value)}><option value="general">{t('templateShare.general')}</option>{targets.filter(x=>x.scope!=='general').map(x=><option key={x.scope} value={x.scope}>{x.title}</option>)}</select></label>}
   <strong>{t('templateShare.composition')}</strong>
   <Composition summary={summary} locked={locked||!choiceReady} selected={selected} toggle={(id,on)=>setSelected(current=>{const next=new Set(current);if(on)next.add(id);else next.delete(id);return next})} result={result} busy={busy} openRole={id=>{close();openRole(id)}} openSkill={openSkill?id=>{close();openSkill(id)}:undefined} openConnections={openConnections?()=>{close();openConnections()}:undefined} t={t as (key:`templateShare.${string}`)=>string}/>
   {result?.loadId&&(result.roleIds.length>0||result.pendingKinds.length>0)&&<div className={css.notice}>{result.roleIds.length>0&&<p>{t('templateShare.paused')}</p>}{result.pendingKinds.length>0&&<p>{t('templateShare.pending')}</p>}</div>}
   <p className={css.privacy}><ShieldCheck size={17} aria-hidden="true"/><span>{t('templateShare.addedHint')}</span></p>
   <TemplateFiles pkg={pkg}/>
  </>:<div className={css.empty}>
   <span className={css.emptyIcon}><FileUp size={28} aria-hidden="true"/></span>
   <h3>{t('templateShare.emptyTitle')}</h3><p className={css.note}>{t('templateShare.emptyHint')}</p>
   {intent&&bridge&&<button type="button" className={css.primary} disabled={busy} onClick={()=>void read()}>{t(busy?'templateShare.busy':'templateShare.read')}</button>}
  </div>}
  {!pkg&&policy?.reason==='authentication-required'&&<div className={css.notice}><p>{t('templateShare.login')}</p><button type="button" onClick={()=>void window.teloaApplication?.openAccount().then(()=>read()).catch(()=>setError(t('templateShare.login')))}>{t('templateShare.account')}</button></div>}
  <label className={css.file}><FileUp size={16} aria-hidden="true"/>{t('templateShare.selectFile')}<input className={css.fileInput} type="file" accept=".json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void choose(file);e.target.value=''}}/></label>
 </TemplateShareDrawer>
}
