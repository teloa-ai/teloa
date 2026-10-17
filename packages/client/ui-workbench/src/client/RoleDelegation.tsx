import {ToolbarIconButton} from './ToolbarIconButton.js'
import {RefreshCw} from 'lucide-react'
import {useEffect,useRef,useState,type ReactNode} from 'react'
import type {WorkResource} from '@teloa/contract'
import {canConfigureRoleExecution,canReceiveTask,type PreviewRole} from './role-preview.js'
import type {RoleDelegationApi,RoleDelegationFields,RoleDelegationRead} from './role-delegation-api.js'
import type {RoleToolGrantApi} from './role-tool-grant-api.js'
import type {ResourceApi} from './resource-api.js'
import type {GroupApi} from './group-api.js'
import {readRoleGroups} from './role-group-membership.js'
import {useBusinessScopes} from './business-scope-context.js'
import {useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {RoleDelegationMessageKey} from './i18n/locales/role-delegation.js'
import css from './TaskPage.module.css'
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'
import {RoleDelegationOverview} from './RoleDelegationOverview.js'
import {roleToolLabel} from './RoleToolGrants.js'

type DelegationDraft={expectedRoleVersion:number;expectedVersion:number|null;fields:RoleDelegationFields}
const delegationDrafts=createRoleFormDrafts<DelegationDraft>()

export function roleDelegationStatus(role:PreviewRole,read:RoleDelegationRead|undefined):RoleDelegationMessageKey{
 if(!read)return 'roleDelegation.loading'
 if(read.roleId!==role.id||read.roleVersion!==role.version)return 'roleDelegation.status.stale'
 const latest=read.delegations.filter(item=>item.roleId===role.id&&item.roleVersion===role.version).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.version-a.version)[0]
 if(!latest)return read.delegations.length?'roleDelegation.status.stale':role.kind==='twin'?'roleDelegation.status.draft':'roleDelegation.status.none'
 if(latest.state!=='active')return `roleDelegation.status.${latest.state}`
 return role.kind==='employee'||canReceiveTask({...role,workAccess:read},latest.scope)?'roleDelegation.status.active':'roleDelegation.status.awaitingConsent'
}
export function RoleDelegation({role,api,toolGrants,resources,groups,changed,configuration,overview=false}:{role:PreviewRole;api:RoleDelegationApi;toolGrants?:RoleToolGrantApi|undefined;resources:ResourceApi;groups?:GroupApi|undefined;changed?:(read:RoleDelegationRead)=>void;configuration?:(read:RoleDelegationRead)=>ReactNode;overview?:boolean}){
 const {locale,t}=useI18n(),allowed=useApplicationCapability('people'),scopes=useBusinessScopes()
 const [read,setRead]=useState<RoleDelegationRead>(),[error,setError]=useState<string>(),[revision,setRevision]=useState(0)
 const [toolNames,setToolNames]=useState<string[]>([]),[knowledge,setKnowledge]=useState<WorkResource[]>([]),[memberships,setMemberships]=useState<{id:string;name:string}[]>([]),[choicesReady,setChoicesReady]=useState(false)
 const [slot,savedDraft]=useRoleFormDraft(delegationDrafts,api,role.id),draft=savedDraft.value?.fields,busy=!!savedDraft.pending
 const [editing,setEditing]=useState(!!draft),[confirmed,setConfirmed]=useState(false),[discarded,setDiscarded]=useState(false)
 const liveSlot=useRef(slot),mounted=useRef(true);liveSlot.current=slot
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{setEditing(!!slot.read().value);setConfirmed(false)},[slot])
 const changedRef=useRef(changed);changedRef.current=changed
 useEffect(()=>{let live=true;setRead(undefined);setError(undefined);setConfirmed(false)
  void api.get(role.id).then(value=>{if(live){setRead(value);changedRef.current?.(value)}},cause=>{if(live)setError(localizeWorkError(locale,cause))});return()=>{live=false}
 },[api,role.id,role.version,revision,locale])
 useEffect(()=>{let live=true;setChoicesReady(false);setToolNames([]);setKnowledge([]);setMemberships([])
  void Promise.all([toolGrants?.get(role.id),resources.directory(),groups?readRoleGroups(groups,role.id):Promise.resolve([])]).then(([tools,directory,rows])=>{if(live){setToolNames(tools?.roleVersion===role.version&&tools.grant?.roleId===role.id&&tools.grant.roleVersion<=role.version&&tools.grant.state==='active'?[...new Set(tools.grant.rules.map(rule=>rule.name))]:[]);setKnowledge(directory.resources.filter(row=>role.knowledge.includes(row.id)&&row.status==='active'));setMemberships(rows);setChoicesReady(true)}},cause=>{if(live)setError(localizeWorkError(locale,cause))});return()=>{live=false}
 },[toolGrants,resources,groups,role.id,role.version,revision,locale])
 useEffect(()=>setDiscarded(false),[api,role.id,role.version])
 const pending=api.pending(),failure=api.recoveryMessage(),blocked=busy||!!pending||!!failure||!read||read.roleVersion!==role.version,startBlocked=blocked||role.state!=='active'
 const current=read?.delegations.filter(item=>item.roleId===role.id&&item.roleVersion===role.version).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.version-a.version)[0]
 const editBlocked=startBlocked||current?.state==='active'||current?.state==='pausing'||current?.state==='ending'
 const activeConsent=current&&read?.consents.find(consent=>consent.roleVersion===role.version&&consent.state==='active'&&consent.authorization.kind==='delegation'&&consent.authorization.delegationId===current.id&&consent.authorization.delegationVersion===current.version)
 const setDraft=(next:RoleDelegationFields|undefined|((value:RoleDelegationFields|undefined)=>RoleDelegationFields|undefined))=>{const original=slot.read().value,fields=typeof next==='function'?next(original?.fields):next;if(fields){slot.set({...original,expectedRoleVersion:original?.expectedRoleVersion??role.version,expectedVersion:original?original.expectedVersion:current?.version??null,fields});setEditing(true)}else setEditing(false)}
 const toggle=(field:'allowedTools'|'knowledgeIds'|'groupIds',id:string,selected:boolean)=>{setConfirmed(false);setDraft(value=>value?{...value,[field]:selected?[...new Set([...value[field],id])]:value[field].filter(item=>item!==id)}:value)}
 async function act(operation:()=>Promise<unknown>,original?:DelegationDraft){if(busy)return;setError(undefined);setDiscarded(false);try{await slot.run(original,operation);if(mounted.current&&liveSlot.current===slot){if(!slot.read().value)setEditing(false);setConfirmed(false);setRevision(value=>value+1)}}catch{/* 原版本和失败输入仍在本人 API 草稿槽。 */}}
 const recoveryDraft=pending?.endpoint==='role-delegations/change'&&pending.input.action==='save'&&pending.input.roleId===role.id&&pending.input.expectedRoleVersion===savedDraft.value?.expectedRoleVersion&&pending.input.expectedVersion===savedDraft.value?.expectedVersion&&JSON.stringify(pending.input.fields)===JSON.stringify(draft)?savedDraft.value:undefined
 const change=(action:'pause'|'resume'|'end')=>{if(!current||blocked||action==='resume'&&(startBlocked||!applicationPresentation.can('people')))return;void act(()=>api.change({requestId:crypto.randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:current.version,action}))}
 const management=<section className={css.block} aria-label={t('roleDelegation.title')} aria-busy={busy||!read&&!error}>
  <h3>{t('roleDelegation.title')}</h3><p>{t('roleDelegation.description')}</p><p role="status">{t(roleDelegationStatus(role,read))}</p>
  {!!(error||savedDraft.error)&&<p role="alert">{savedDraft.error?localizeWorkError(locale,savedDraft.error):error}</p>}{failure&&<p role="alert">{localizeWorkError(locale,failure)} {t('recovery.nextStep')} <button type="button" disabled={busy} onClick={()=>{setDiscarded(false);try{api.discard();setDiscarded(true)}catch(cause){setError(localizeWorkError(locale,cause))}}}>{t('recovery.discard')}</button></p>}
  {discarded&&<p role="status">{t('recovery.discarded')}</p>}
  {pending&&<p>{t('roleDelegation.pending')} <button type="button" disabled={busy||!!failure} onClick={()=>void act(api.recover,recoveryDraft)}>{t('roleDelegation.recover')}</button></p>}
  {overview&&current&&<dl data-teloa-delegation-scope>
   <dt>{t('roleDelegation.scope')}</dt><dd>{scopes[current.scope]??current.scope}</dd>
   <dt>{t('roleDelegation.tools')}</dt><dd>{current.allowedTools.map(name=>roleToolLabel(name,t)).join(', ')||t('roleDelegation.overview.empty')}</dd>
   <dt>{t('roleDelegation.knowledge')}</dt><dd>{current.knowledgeIds.map(id=>knowledge.find(row=>row.id===id)?.title??t('roleDelegation.overview.unavailable',{count:1})).join(', ')||t('roleDelegation.overview.empty')}</dd>
   <dt>{t('roleDelegation.groups')}</dt><dd>{current.groupIds.map(id=>memberships.find(row=>row.id===id)?.name??t('roleDelegation.overview.unavailable',{count:1})).join(', ')||t('roleDelegation.overview.empty')}</dd>
  </dl>}
  <div className={css.buttons}><ToolbarIconButton label={t('roleDelegation.refresh')} icon={RefreshCw} disabled={busy} onClick={()=>setRevision(value=>value+1)}/>
   {current&&current.state==='active'&&<button type="button" disabled={blocked} onClick={()=>change('pause')}>{t('roleDelegation.pause')}</button>}
   {current&&current.state==='paused'&&<button type="button" disabled={startBlocked||!allowed} onClick={()=>change('resume')}>{t('roleDelegation.resume')}</button>}
   {current&&!['ending','ended'].includes(current.state)&&<button type="button" disabled={blocked} onClick={()=>change('end')}>{t('roleDelegation.end')}</button>}
   {role.kind==='twin'&&current?.state==='active'&&!activeConsent&&<button type="button" disabled={startBlocked||!allowed} onClick={()=>{if(!startBlocked&&applicationPresentation.can('people'))void act(()=>api.confirm({requestId:crypto.randomUUID(),roleId:role.id,expectedRoleVersion:role.version,authorization:{kind:'delegation',delegationId:current.id,delegationVersion:current.version}}))}}>{t('roleDelegation.confirmExecution')}</button>}
   {activeConsent&&<button type="button" disabled={busy||!!pending||!!failure} onClick={()=>void act(()=>api.revoke({requestId:crypto.randomUUID(),consentId:activeConsent.id,expectedVersion:activeConsent.version}))}>{t('roleDelegation.revokeConsent')}</button>}
  </div>
  <p className={css.muted}>{t('roleDelegation.configureHint')}</p>
  {read&&savedDraft.value&&(savedDraft.value.expectedRoleVersion!==role.version||savedDraft.value.expectedVersion!==(current?.version??null))&&<button type="button" disabled={busy} onClick={()=>{slot.set(undefined);setEditing(false);setConfirmed(false)}}>{t('collaboration.resources.discardDraft')}</button>}
  {read&&canConfigureRoleExecution(role,read)&&configuration?.(read)}
  {(!draft||!editing)&&<button type="button" disabled={editBlocked||!allowed||!choicesReady||!toolNames.length} title={current?.state==='active'?t('roleDelegation.pause'):undefined} onClick={()=>{if(editBlocked)return;setConfirmed(false);if(draft)setEditing(true);else setDraft({scope:current?.scope??role.scopes[0]??'general',allowedTools:current?.allowedTools.filter(name=>toolNames.includes(name))??[],knowledgeIds:current?.knowledgeIds.filter(id=>knowledge.some(row=>row.id===id))??[],memoryViewId:null,groupIds:current?.groupIds.filter(id=>memberships.some(row=>row.id===id))??[],safeRecovery:false})}}>{t('roleDelegation.edit')}</button>}
  {choicesReady&&!toolNames.length&&<p>{t('roleDelegation.noTools')}</p>}
  {draft&&editing&&<form className={css.form} onSubmit={event=>{event.preventDefault();const original=savedDraft.value;if(editBlocked||!confirmed||!draft.allowedTools.length||!applicationPresentation.can('people')||!original)return;void act(()=>api.change({requestId:crypto.randomUUID(),roleId:role.id,expectedRoleVersion:original.expectedRoleVersion,expectedVersion:original.expectedVersion,action:'save',fields:original.fields}),original)}}>
   <fieldset disabled={editBlocked||!allowed}><label>{t('roleDelegation.scope')}<select value={draft.scope} onChange={event=>{setConfirmed(false);setDraft({...draft,scope:event.target.value})}}>{role.scopes.map(scope=><option key={scope} value={scope}>{scopes[scope]??scope}</option>)}</select></label>
   <fieldset><legend>{t('roleDelegation.tools')}</legend>{toolNames.map(name=><label key={name}><input type="checkbox" checked={draft.allowedTools.includes(name)} onChange={event=>toggle('allowedTools',name,event.target.checked)}/>{overview?roleToolLabel(name,t):name}</label>)}</fieldset>
   <fieldset><legend>{t('roleDelegation.knowledge')}</legend>{knowledge.map(row=><label key={row.id}><input type="checkbox" checked={draft.knowledgeIds.includes(row.id)} onChange={event=>toggle('knowledgeIds',row.id,event.target.checked)}/>{row.title}</label>)}</fieldset>
   <fieldset><legend>{t('roleDelegation.groups')}</legend>{memberships.map(group=><label key={group.id}><input type="checkbox" checked={draft.groupIds.includes(group.id)} onChange={event=>toggle('groupIds',group.id,event.target.checked)}/>{group.name}</label>)}</fieldset>
   <p>{t('roleDelegation.privateMemory')}</p><label><input type="checkbox" checked={draft.safeRecovery} onChange={event=>{setConfirmed(false);setDraft({...draft,safeRecovery:event.target.checked})}}/>{t('roleDelegation.safeRecovery')}</label>
   <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{t('roleDelegation.confirmScope')}</label></fieldset>
   <div className={css.buttons}><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{t('p5.cancel')}</button><button type="submit" disabled={editBlocked||!allowed||!confirmed||!draft.allowedTools.length}>{t('roleDelegation.save')}</button></div>
  </form>}
  {!!read?.delegations.length&&<details data-teloa-delegation-history><summary>{t('roleDelegation.history')}</summary>{read.delegations.map(item=><p key={item.id}>{scopes[item.scope]??item.scope} · {t(item.roleVersion===role.version?item.state==='active'?'roleDelegation.status.active':`roleDelegation.status.${item.state}`:'roleDelegation.status.stale')} · {item.allowedTools.map(name=>overview?roleToolLabel(name,t):name).join(', ')}</p>)}</details>}
 </section>
 return overview?<RoleDelegationOverview role={role} current={current} status={roleDelegationStatus(role,read)} toolNames={toolNames} knowledge={knowledge} groups={memberships} ready={choicesReady} error={savedDraft.error?localizeWorkError(locale,savedDraft.error):error??(failure?localizeWorkError(locale,failure):undefined)} pending={!!pending} hasHistory={!!read?.delegations.length} closed={()=>setConfirmed(false)}>{management}</RoleDelegationOverview>:management
}
