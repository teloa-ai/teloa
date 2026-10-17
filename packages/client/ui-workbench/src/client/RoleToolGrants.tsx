import {ToolbarIconButton} from './ToolbarIconButton.js'
import {RefreshCw} from 'lucide-react'
import {useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import {useEffect,useRef,useState} from 'react'
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'
import {canConfigureRoleExecution,type PreviewRole} from './role-preview.js'
import type {RoleDelegationApi,RoleDelegationRead} from './role-delegation-api.js'
import type {RoleToolGrantApi} from './role-tool-grant-api.js'
import type {ResourceApi} from './resource-api.js'
import {isSkillHttpRule,isSubagentDelegationRule,isWebToolRule,roleToolGrantSelectionKey,selectedRoleToolGrantRules,skillHttpToolName,webToolNames} from './role-tool-grant-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import {isWorkspaceFileRule} from '@teloa/contract'
import type {MessageKey} from './i18n/messages.js'

const toolLabelKeys:Readonly<Record<string,MessageKey>>={teloa_business_object_result_record:'roleDelegation.tool.objectResult',teloa_business_result_record:'roleDelegation.tool.batchResult',teloa_business_dashboard_read:'roleDelegation.tool.dashboardRead',teloa_business_sql_trial:'roleDelegation.tool.sqlTrial',teloa_business_change_prepare:'roleDelegation.tool.changePrepare',teloa_business_change_read:'roleDelegation.tool.changeRead',teloa_business_change_apply:'roleDelegation.tool.changeApply',read:'roleGrant.files.read',write:'roleGrant.files.write',edit:'roleGrant.files.edit',workflow:'roleGrant.tool.workflow',ralph:'roleGrant.tool.ralph',run_code:'roleGrant.tool.ptc',get_goal:'roleDelegation.tool.goalRead',create_goal:'roleDelegation.tool.goalCreate',update_goal:'roleDelegation.tool.goalUpdate',
 job_output:'roleDelegation.tool.jobOutput',job_list:'roleDelegation.tool.jobList',job_kill:'roleDelegation.tool.jobStop',
 spawn_teammate:'roleDelegation.tool.teammateCreate',send_message:'roleDelegation.tool.teammateMessage',list_agents:'roleDelegation.tool.teammateList',wait_agent:'roleDelegation.tool.teammateWait',interrupt_agent:'roleDelegation.tool.teammateInterrupt',
 team_task_create:'roleDelegation.tool.teamTaskCreate',team_task_list:'roleDelegation.tool.teamTaskList',team_task_get:'roleDelegation.tool.teamTaskRead',team_task_update:'roleDelegation.tool.teamTaskUpdate',teloa_knowledge_search:'roleDelegation.tool.knowledgeSearch'}
export function roleToolLabel(name:string,t:Translate):string{const key=Object.hasOwn(toolLabelKeys,name)?toolLabelKeys[name]:undefined;return key?t(key):name}
type ToolDraft={expectedRoleVersion:number;candidates:Awaited<ReturnType<RoleToolGrantApi['candidates']>>;selected:string[]}
const toolDrafts=createRoleFormDrafts<ToolDraft>()

export function RoleToolGrants({role,api,resources,changed,delegations}:{role:PreviewRole;api:RoleToolGrantApi;resources:ResourceApi;changed:()=>void;delegations?:RoleDelegationApi|undefined}){
 const {locale,t}=useI18n()
 const allowed=useApplicationCapability('people')
 const [executionAccess,setExecutionAccess]=useState<RoleDelegationRead>()
 const [current,setCurrent]=useState<Awaited<ReturnType<RoleToolGrantApi['get']>>>(),[candidates,setCandidates]=useState<Awaited<ReturnType<RoleToolGrantApi['candidates']>>>(),[names,setNames]=useState<Record<string,string>>({}),[error,setError]=useState<string>(),[revision,setRevision]=useState(0),[discarded,setDiscarded]=useState(false)
 const [slot,savedDraft]=useRoleFormDraft(toolDrafts,api,role.id),selected=savedDraft.value?.selected??[],busy=!!savedDraft.pending
 const liveSlot=useRef(slot),mounted=useRef(true),changedRef=useRef(changed);liveSlot.current=slot;changedRef.current=changed
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const canConfigure=(access:RoleDelegationRead|undefined)=>delegations?canConfigureRoleExecution(role,access):role.kind==='employee'?role.state==='paused':canConfigureRoleExecution(role,role.workAccess)
 useEffect(()=>{let live=true;setCurrent(undefined);setCandidates(undefined);setExecutionAccess(undefined);setError(undefined)
 void Promise.all([api.get(role.id),resources.directory().catch(()=>({resources:[]})),delegations?delegations.get(role.id):Promise.resolve(undefined)]).then(([row,directory,access])=>{if(!live)return;setCurrent(row);setExecutionAccess(access);setNames(Object.fromEntries(directory.resources.map(r=>[r.sourceId,r.title])));if(!canConfigure(access))return;return api.candidates(role.id).then(value=>{if(live){if(value.roleVersion!==row.roleVersion)throw Error('role version changed');setCandidates(value)}})}).catch(e=>{if(live)setError(localizeWorkError(locale,e))});return()=>{live=false}
 },[role.id,role.version,role.kind,role.state,api,resources,delegations,revision,locale])
 const configurable=canConfigure(executionAccess)
 const pending=api.pending(),failure=api.recoveryMessage(),shownCandidates=savedDraft.value?.candidates??candidates,rules=shownCandidates?.rules??[]
 const requestedRules=selectedRoleToolGrantRules(rules,new Set(selected)),selectionAvailable=JSON.stringify(requestedRules)===JSON.stringify(selectedRoleToolGrantRules(candidates?.rules??[],new Set(selected)))
 const toggle=(key:string,checked:boolean)=>{if(!current||!candidates)return;const original=slot.read().value,values=original?.selected??[],next=checked?[...new Set([...values,key])]:values.filter(value=>value!==key);slot.set(next.length?{expectedRoleVersion:original?.expectedRoleVersion??current.roleVersion,candidates:original?.candidates??candidates,selected:next}:undefined)}
 const run=async(action:'save'|'revoke'|'recover')=>{if(busy||action==='save'&&(!configurable||!selectionAvailable||!applicationPresentation.can('people')))return;setError(undefined);const original=savedDraft.value,recovery=action==='recover'&&pending?.action==='save'&&pending.roleId===role.id&&pending.expectedRoleVersion===original?.expectedRoleVersion&&JSON.stringify(pending.rules)===JSON.stringify(requestedRules)?original:undefined;try{await slot.run(action==='save'?original:recovery,async()=>{if(action==='recover')await api.recover();else{if(!current)throw Error('grant unavailable');await api.change({roleId:role.id,expectedRoleVersion:action==='save'&&original?original.expectedRoleVersion:current.roleVersion,action,rules:action==='revoke'?[]:requestedRules})}});if(mounted.current&&liveSlot.current===slot){changedRef.current();setRevision(n=>n+1)}}catch{/* 未提交选择与原请求版本保留。 */}}
 return <section className={css.block} aria-label={t('roleGrant.aria')}><h3>{t('roleGrant.title')}</h3><p>{t('roleGrant.description')}</p>{!!(error||savedDraft.error)&&<p role="alert">{savedDraft.error?localizeWorkError(locale,savedDraft.error):error}</p>}{failure&&<p role="alert">{localizeWorkError(locale,failure)} {t('recovery.nextStep')}</p>}{failure&&<button type="button" onClick={()=>{api.discard();setDiscarded(true)}}>{t('recovery.discard')}</button>}{discarded&&<p role="status">{t('recovery.discarded')}</p>}{!current&&!error&&<p role="status">{t('roleGrant.loading')}</p>}{current&&<><p>{t(current.grant?.state==='active'?'roleGrant.active':current.grant?.state==='revoked'?'roleGrant.revoked':'roleGrant.none')}</p>{current.grant?.state==='active'&&<ul>{current.grant.rules.flatMap(rule=>isSubagentDelegationRule(rule)?<li key={rule.name}>{t('subagent.grant.active')}</li>:isWebToolRule(rule)?<li key={rule.name}>{t(rule.name==='web_search'?'roleGrant.web.search':'roleGrant.web.fetch')}</li>:rule.anyArguments===true||isWorkspaceFileRule(rule)?<li key={rule.name}><span title={rule.name}>{roleToolLabel(rule.name,t)}</span></li>:rule.name===skillHttpToolName?rule.allowed.map(args=><li key={roleToolGrantSelectionKey(rule,args)}>{t('roleGrant.skillHttp.granted',{skill:String(args.skill)})}</li>):rule.allowed.map(args=><li key={roleToolGrantSelectionKey(rule,args)}>{t('roleGrant.resourceVersion',{name:names[String(args.id)]??String(args.id),version:String(args.version).slice(0,8)})}</li>))}</ul>}</>}
 {pending&&<p>{t('roleGrant.pending',{action:t(pending.action==='save'?'roleGrant.savingGrant':'roleGrant.revokingGrant')})}<button type="button" disabled={busy||!!failure} onClick={()=>void run('recover')}>{t('roleGrant.recover')}</button></p>}
 {configurable&&<RoleToolGrantOptions candidates={shownCandidates} names={names} selected={selected} toggle={toggle} disabled={!allowed||busy||!!pending||!!failure||!candidates||!selectionAvailable} locale={locale} t={t} pauseHint={role.kind==='twin'?t('roleDelegation.configureHint'):undefined}/>}
 {candidates&&!selectionAvailable&&<p role="alert">{t('roleDelegation.status.stale')}</p>}
 {savedDraft.value&&current&&(savedDraft.value.expectedRoleVersion!==current.roleVersion||candidates&&!selectionAvailable)&&<button type="button" disabled={busy} onClick={()=>slot.set(undefined)}>{t('collaboration.resources.discardDraft')}</button>}
 {!configurable&&<p>{t(role.kind==='twin'?'roleDelegation.configureHint':'roleGrant.pauseHint')}</p>}
 <div className={css.buttons}><ToolbarIconButton label={t('roleGrant.refresh')} icon={RefreshCw} disabled={busy} onClick={()=>setRevision(n=>n+1)}/>{configurable&&<button type="button" disabled={!allowed||busy||!!pending||!!failure||!selected.length||!candidates||!selectionAvailable} onClick={()=>void run('save')}>{t('roleGrant.save')}</button>}{current?.grant?.state==='active'&&<button type="button" disabled={busy||!!pending||!!failure} onClick={()=>void run('revoke')}>{t('roleGrant.revoke')}</button>}</div>
 </section>
}


type Translate=(key:string,params?:Record<string,string|number>)=>string
/** 可授予候选三栏（资料与工具、上网、技能接口代发）：纯展示，无 hooks，便于逐态渲染核对。 */
export function RoleToolGrantOptions({candidates,names,selected,toggle,disabled,locale,t,pauseHint}:{candidates:Awaited<ReturnType<RoleToolGrantApi['candidates']>>|undefined;names:Record<string,string>;selected:readonly string[];toggle:(key:string,checked:boolean)=>void;disabled:boolean;locale:string;t:Translate;pauseHint?:string|undefined}){
 const rules=candidates?.rules??[],webRules=rules.filter(isWebToolRule),skillHttpRule=rules.find(isSkillHttpRule)
 // 本栏只列资料、行业工具与子任务委派；上网与技能接口代发在下方各自一栏。本栏没有自己的候选时写明候选在哪，不留空框。
 const ownOptions=rules.some(rule=>isSubagentDelegationRule(rule)?!!candidates?.delegation:!isSkillHttpRule(rule)&&!isWebToolRule(rule)&&(rule.anyArguments===true||isWorkspaceFileRule(rule)||rule.allowed.length>0))
 const otherGroups=[...(webRules.length?[t('roleGrant.web.title')]:[]),...(skillHttpRule&&candidates?.skillHttp?.length?[t('roleGrant.skillHttp.title')]:[])]
 return <>
  <fieldset disabled={disabled}><legend>{t('subagent.grant.options')}</legend>{rules.flatMap(rule=>{
  if(isSubagentDelegationRule(rule)){const limits=candidates?.delegation;if(!limits)return [];const key=roleToolGrantSelectionKey(rule);return <label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span>{t('subagent.grant.title')}</span><small>{t('subagent.grant.description',{maxDepth:String(limits.maxDepth),maxPerRun:String(limits.maxPerRun)})}</small></label>}
  if(isSkillHttpRule(rule))return []
  if(isWorkspaceFileRule(rule)){const key=roleToolGrantSelectionKey(rule);return <label key={key} className={css.grantOption} data-teloa-file-grant={rule.name}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span title={rule.name}>{roleToolLabel(rule.name,t)}</span><small>{t('roleGrant.files.scope')}</small></label>}
  if(rule.anyArguments===true&&!isWebToolRule(rule)){const key=roleToolGrantSelectionKey(rule);return <label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span title={rule.name}>{roleToolLabel(rule.name,t)}</span>{['workflow','ralph','run_code'].includes(rule.name)&&<small>{t('roleGrant.orchestrationHint')}</small>}</label>}
  return rule.allowed.map(args=>{const key=roleToolGrantSelectionKey(rule,args);return <label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/>{t('roleGrant.resourceVersion',{name:names[String(args.id)]??String(args.id),version:String(args.version).slice(0,8)})}</label>})
 })}{candidates&&!ownOptions&&(otherGroups.length?<p>{t('roleGrant.otherCandidates',{groups:otherGroups.join(locale.startsWith('zh')||locale==='ja'?'、':', ')})}</p>:<p>{t('roleGrant.noKnowledge')}</p>)}</fieldset>
  <fieldset disabled={disabled}><legend>{t('roleGrant.web.title')}</legend><p>{t('roleGrant.web.description')}</p>{candidates&&webRules.length>0?<>{webToolNames.flatMap(name=>{const rule=webRules.find(item=>item.name===name);if(!rule)return [];const key=roleToolGrantSelectionKey(rule);return [<label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span>{t(name==='web_search'?'roleGrant.web.search':'roleGrant.web.fetch')}</span><small>{t(name==='web_search'?'roleGrant.web.searchHint':'roleGrant.web.fetchHint')}</small></label>]})}<p>{pauseHint??t('roleGrant.pauseHint')}</p></>:candidates&&<p>{t('roleGrant.web.disabledByGlobal')}</p>}</fieldset>
  {skillHttpRule&&candidates?.skillHttp&&<fieldset disabled={disabled}><legend>{t('roleGrant.skillHttp.title')}</legend><p>{t('roleGrant.skillHttp.description')}</p>{candidates.skillHttp.map(item=>{const key=roleToolGrantSelectionKey(skillHttpRule,{skill:item.skill});return <label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span>{t('roleGrant.skillHttp.skill',{skill:item.skill,origins:item.origins.join(', ')})}</span><small>{t(item.source==='role'?'roleGrant.skillHttp.sourceRole':'roleGrant.skillHttp.sourceIndustry')}</small>{item.configured!==undefined&&<small>{t(item.configured?'roleGrant.skillHttp.configured':'roleGrant.skillHttp.missing')}</small>}</label>})}</fieldset>}
 </>
}
