import {useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import {useEffect,useState} from 'react'
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

const toolLabelKeys:Readonly<Record<string,MessageKey>>={read:'roleGrant.files.read',write:'roleGrant.files.write',edit:'roleGrant.files.edit',workflow:'roleGrant.tool.workflow',ralph:'roleGrant.tool.ralph',run_code:'roleGrant.tool.ptc',get_goal:'roleDelegation.tool.goalRead',create_goal:'roleDelegation.tool.goalCreate',update_goal:'roleDelegation.tool.goalUpdate'}
function roleToolLabel(name:string,t:Translate):string{const key=Object.hasOwn(toolLabelKeys,name)?toolLabelKeys[name]:undefined;return key?t(key):name}

export function RoleToolGrants({role,api,resources,changed,delegations}:{role:PreviewRole;api:RoleToolGrantApi;resources:ResourceApi;changed:()=>void;delegations?:RoleDelegationApi|undefined}){
 const {locale,t}=useI18n()
 const allowed=useApplicationCapability('people')
 const [executionAccess,setExecutionAccess]=useState<RoleDelegationRead>()
 const [current,setCurrent]=useState<Awaited<ReturnType<RoleToolGrantApi['get']>>>(),[candidates,setCandidates]=useState<Awaited<ReturnType<RoleToolGrantApi['candidates']>>>(),[names,setNames]=useState<Record<string,string>>({}),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[revision,setRevision]=useState(0),[discarded,setDiscarded]=useState(false)
 useEffect(()=>{let live=true;setCurrent(undefined);setCandidates(undefined);setExecutionAccess(undefined);setError(undefined);setSelected([])
 void Promise.all([api.get(role.id),resources.directory().catch(()=>({resources:[]})),delegations?delegations.get(role.id):Promise.resolve(undefined)]).then(([row,directory,access])=>{if(!live)return;setCurrent(row);setExecutionAccess(access);setNames(Object.fromEntries(directory.resources.map(r=>[r.sourceId,r.title])));return api.candidates(role.id).then(value=>{if(live){if(value.roleVersion!==row.roleVersion)throw Error('role version changed');setCandidates(value)}})}).catch(e=>{if(live)setError(localizeWorkError(locale,e))});return()=>{live=false}
 },[role.id,role.version,role.kind,api,resources,delegations,revision,locale])
 const configurable=delegations?canConfigureRoleExecution(role,executionAccess):role.kind==='employee'?role.state==='paused':canConfigureRoleExecution(role,role.workAccess)
 const pending=api.pending(),failure=api.recoveryMessage(),rules=candidates?.rules??[]
 const toggle=(key:string,checked:boolean)=>setSelected(values=>checked?[...values,key]:values.filter(value=>value!==key))
 const run=async(action:'save'|'revoke'|'recover')=>{if(busy||action==='save'&&(!configurable||!applicationPresentation.can('people')))return;setBusy(true);setError(undefined);try{if(action==='recover')await api.recover();else{if(!current)throw Error('grant unavailable');await api.change({roleId:role.id,expectedRoleVersion:current.roleVersion,action,rules:action==='revoke'?[]:selectedRoleToolGrantRules(rules,new Set(selected))})}changed();setRevision(n=>n+1)}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}
 return <section className={css.block} aria-label={t('roleGrant.aria')}><h3>{t('roleGrant.title')}</h3><p>{t('roleGrant.description')}</p>{error&&<p role="alert">{error}</p>}{failure&&<p role="alert">{localizeWorkError(locale,failure)} {t('recovery.nextStep')}</p>}{failure&&<button type="button" onClick={()=>{api.discard();setDiscarded(true)}}>{t('recovery.discard')}</button>}{discarded&&<p role="status">{t('recovery.discarded')}</p>}{!current&&!error&&<p role="status">{t('roleGrant.loading')}</p>}{current&&<><p>{t(current.grant?.state==='active'?'roleGrant.active':current.grant?.state==='revoked'?'roleGrant.revoked':'roleGrant.none')}</p>{current.grant?.state==='active'&&<ul>{current.grant.rules.flatMap(rule=>isSubagentDelegationRule(rule)?<li key={rule.name}>{t('subagent.grant.active')}</li>:isWebToolRule(rule)?<li key={rule.name}>{t(rule.name==='web_search'?'roleGrant.web.search':'roleGrant.web.fetch')}</li>:rule.anyArguments===true||isWorkspaceFileRule(rule)?<li key={rule.name}>{roleToolLabel(rule.name,t)}</li>:rule.name===skillHttpToolName?rule.allowed.map(args=><li key={roleToolGrantSelectionKey(rule,args)}>{t('roleGrant.skillHttp.granted',{skill:String(args.skill)})}</li>):rule.allowed.map(args=><li key={roleToolGrantSelectionKey(rule,args)}>{t('roleGrant.resourceVersion',{name:names[String(args.id)]??String(args.id),version:String(args.version).slice(0,8)})}</li>))}</ul>}</>}
 {pending&&<p>{t('roleGrant.pending',{action:t(pending.action==='save'?'roleGrant.savingGrant':'roleGrant.revokingGrant')})}<button type="button" disabled={busy||!!failure} onClick={()=>void run('recover')}>{t('roleGrant.recover')}</button></p>}
 {configurable&&<RoleToolGrantOptions candidates={candidates} names={names} selected={selected} toggle={toggle} disabled={!allowed||busy||!!pending||!!failure||!candidates} locale={locale} t={t} pauseHint={role.kind==='twin'?t('roleDelegation.configureHint'):undefined}/>}
 {!configurable&&<p>{t(role.kind==='twin'?'roleDelegation.configureHint':'roleGrant.pauseHint')}</p>}
 <div className={css.buttons}><button type="button" disabled={busy} onClick={()=>setRevision(n=>n+1)}>{t('roleGrant.refresh')}</button>{configurable&&<button type="button" disabled={!allowed||busy||!!pending||!!failure||!selected.length||!candidates} onClick={()=>void run('save')}>{t('roleGrant.save')}</button>}{current?.grant?.state==='active'&&<button type="button" disabled={busy||!!pending||!!failure} onClick={()=>void run('revoke')}>{t('roleGrant.revoke')}</button>}</div>
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
  if(isWorkspaceFileRule(rule)){const key=roleToolGrantSelectionKey(rule);return <label key={key} className={css.grantOption} data-teloa-file-grant={rule.name}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span>{roleToolLabel(rule.name,t)}</span><small>{t('roleGrant.files.scope')}</small></label>}
  if(rule.anyArguments===true&&!isWebToolRule(rule)){const key=roleToolGrantSelectionKey(rule);return <label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span>{roleToolLabel(rule.name,t)}</span>{['workflow','ralph','run_code'].includes(rule.name)&&<small>{t('roleGrant.orchestrationHint')}</small>}</label>}
  return rule.allowed.map(args=>{const key=roleToolGrantSelectionKey(rule,args);return <label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/>{t('roleGrant.resourceVersion',{name:names[String(args.id)]??String(args.id),version:String(args.version).slice(0,8)})}</label>})
 })}{candidates&&!ownOptions&&(otherGroups.length?<p>{t('roleGrant.otherCandidates',{groups:otherGroups.join(locale.startsWith('zh')||locale==='ja'?'、':', ')})}</p>:<p>{t('roleGrant.noKnowledge')}</p>)}</fieldset>
  <fieldset disabled={disabled}><legend>{t('roleGrant.web.title')}</legend><p>{t('roleGrant.web.description')}</p>{candidates&&webRules.length>0?<>{webToolNames.flatMap(name=>{const rule=webRules.find(item=>item.name===name);if(!rule)return [];const key=roleToolGrantSelectionKey(rule);return [<label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span>{t(name==='web_search'?'roleGrant.web.search':'roleGrant.web.fetch')}</span><small>{t(name==='web_search'?'roleGrant.web.searchHint':'roleGrant.web.fetchHint')}</small></label>]})}<p>{pauseHint??t('roleGrant.pauseHint')}</p></>:candidates&&<p>{t('roleGrant.web.disabledByGlobal')}</p>}</fieldset>
  {skillHttpRule&&candidates?.skillHttp&&<fieldset disabled={disabled}><legend>{t('roleGrant.skillHttp.title')}</legend><p>{t('roleGrant.skillHttp.description')}</p>{candidates.skillHttp.map(item=>{const key=roleToolGrantSelectionKey(skillHttpRule,{skill:item.skill});return <label key={key} className={css.grantOption}><input type="checkbox" checked={selected.includes(key)} onChange={event=>toggle(key,event.target.checked)}/><span>{t('roleGrant.skillHttp.skill',{skill:item.skill,origins:item.origins.join(', ')})}</span><small>{t(item.source==='role'?'roleGrant.skillHttp.sourceRole':'roleGrant.skillHttp.sourceIndustry')}</small>{item.configured!==undefined&&<small>{t(item.configured?'roleGrant.skillHttp.configured':'roleGrant.skillHttp.missing')}</small>}</label>})}</fieldset>}
 </>
}
