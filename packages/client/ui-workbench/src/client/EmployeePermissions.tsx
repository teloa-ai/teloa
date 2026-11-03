import {useEffect,useState,useRef,type ReactNode,type SyntheticEvent} from 'react'
import type {PreviewRole} from './role-preview.js'
import type {RoleToolGrantApi} from './role-tool-grant-api.js'
import type {RoleDelegationApi,RoleDelegationRead} from './role-delegation-api.js'
import type {ResourceApi} from './resource-api.js'
import {RoleKnowledge} from './RoleKnowledge.js'
import {roleToolLabel} from './RoleToolGrants.js'
import {useBusinessScopes} from './business-scope-context.js'
import {useI18n} from './i18n/provider.js'
import {employeePermissionsCopy} from './employee-permissions-copy.js'
import css from './EmployeePermissions.module.css'

type ToolRead=Awaited<ReturnType<RoleToolGrantApi['get']>>
type Read<T,A>={api:A;key:string;revision:number;value?:T;failed?:boolean}
export type EmployeePermissionsProps={role:PreviewRole;toolApi?:RoleToolGrantApi|undefined;resources:ResourceApi;delegations?:RoleDelegationApi|undefined;tools:(refresh:()=>void)=>ReactNode;connections:ReactNode;ongoing:ReactNode}
/** 只读摘要与原管理节点共存；折叠不卸载管理节点，也不提交、恢复或确认原请求。 */
export function EmployeePermissions({role,toolApi,resources,delegations,tools,connections,ongoing}:EmployeePermissionsProps){
 const {locale,t}=useI18n(),copy=employeePermissionsCopy(locale),scopes=useBusinessScopes(),key=role.id+':'+role.version
 const [revision,setRevision]=useState(0),[toolRead,setToolRead]=useState<Read<ToolRead,RoleToolGrantApi>>(),[delegationRead,setDelegationRead]=useState<Read<RoleDelegationRead,RoleDelegationApi>>()
 const refresh=()=>setRevision(n=>n+1)
 const knowledgeIdentity=useRef({api:resources,revision:0});if(knowledgeIdentity.current.api!==resources)knowledgeIdentity.current={api:resources,revision:knowledgeIdentity.current.revision+1}
 const currentTools=toolRead&&toolRead.api===toolApi&&toolRead.key===key&&toolRead.revision===revision?toolRead:undefined
 const currentDelegations=delegationRead&&delegationRead.api===delegations&&delegationRead.key===key&&delegationRead.revision===revision?delegationRead:undefined
 useEffect(()=>{let live=true;if(toolApi&&role.storage==='persistent')void toolApi.get(role.id).then(value=>{if(value.roleVersion!==role.version||value.grant&&(value.grant.roleId!==role.id||value.grant.roleVersion>value.roleVersion))throw Error('Grant identity/version mismatch');if(live)setToolRead({api:toolApi,key,revision,value})}).catch(()=>{if(live)setToolRead({api:toolApi,key,revision,failed:true})});return()=>{live=false}},[toolApi,key,revision,role.storage])
 useEffect(()=>{let live=true;if(delegations&&role.storage==='persistent')void delegations.get(role.id).then(value=>{if(value.roleId!==role.id||value.roleVersion!==role.version)throw Error('Delegation identity/version mismatch');if(live)setDelegationRead({api:delegations,key,revision,value})}).catch(()=>{if(live)setDelegationRead({api:delegations,key,revision,failed:true})});return()=>{live=false}},[delegations,key,revision,role.storage])
 const grant=currentTools?.value?.grant,names=grant?.state==='active'?Array.from(new Set(grant.rules.map(rule=>rule.name))):[]
 const toolStatus=currentTools?.failed?copy.failedTools:currentTools?.value?names.length?copy.toolCount(names.length):copy.noneTools:toolApi&&role.storage==='persistent'?copy.loadingTools:copy.unknownTools
 const access=currentDelegations?.value,current=access?.delegations.filter(row=>row.roleId===role.id&&row.roleVersion===role.version).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.version-a.version)[0]
 const ongoingStatus=currentDelegations?.failed?copy.failedOngoing:access?current?copy[current.state]:access.delegations.length?copy.stale:copy.noneOngoing:delegations&&role.storage==='persistent'?copy.loadingOngoing:copy.unknownOngoing
 const pendingTool=toolApi?.pending(),ownToolPending=pendingTool?.roleId===role.id
 const pendingDelegation=delegations?.pending(),pendingConsentId=pendingDelegation&&'consentId'in pendingDelegation.input?pendingDelegation.input.consentId:undefined
 const ownDelegationPending=!!pendingDelegation&&('roleId'in pendingDelegation.input?pendingDelegation.input.roleId===role.id:!!access?.consents.some(row=>row.id===pendingConsentId&&row.roleId===role.id))
 // 只有具名属于本员工的原请求才强制露出原管理节点；另一员工的请求不贴到当前员工。
 const keepPendingVisible=(event:SyntheticEvent<HTMLDetailsElement>,pending:boolean)=>{if(pending&&!event.currentTarget.open)event.currentTarget.open=true}
 return <section className={css.permissions} aria-label={copy.title}>
  <header className={css.heading}><div><h2>{copy.scopeHeading}</h2><p>{copy.intro}</p></div><button type="button" className={css.refresh} onClick={refresh}>{copy.refresh}</button></header>
  <dl className={css.summary}>
   <div><dt>{copy.business}</dt><dd>{role.scopes.length?<div className={css.tags}>{role.scopes.map(scope=><span key={scope}>{scopes[scope]??scope}</span>)}</div>:copy.noScope}</dd></div>
   <div><dt>{copy.materials}</dt><dd>{role.knowledge.length?<RoleKnowledge key={key+':'+knowledgeIdentity.current.revision} api={resources} ids={role.knowledge} scopes={role.scopes} compact/>:<span className={css.muted}>{copy.noMaterials}</span>}</dd></div>
   <div><dt>{copy.granted}</dt><dd><span role={currentTools?.failed?'status':undefined}>{toolStatus}</span>{names.length>0&&<ul className={css.toolNames}>{names.slice(0,3).map(name=><li key={name}>{roleToolLabel(name,t)}</li>)}{names.length>3&&<li>{copy.remainingTools(names.length-3)}</li>}</ul>}</dd></div>
  </dl>
  <p className={css.muted}>{copy.approval}</p>
  {ownToolPending&&<aside className={css.pending} role="status"><strong>{copy.toolPending}</strong><p>{copy.pendingHint}</p></aside>}
  <details className={css.group} open={ownToolPending||undefined} onToggle={event=>keepPendingVisible(event,ownToolPending)}><summary>{copy.tools}</summary><div className={css.content}>{tools(refresh)}</div></details>
  <details className={css.group}><summary>{copy.connections}</summary><div className={css.content}><p className={css.muted}>{copy.connectionsHint}</p>{connections}</div></details>
  {ownDelegationPending&&<aside className={css.pending} role="status"><strong>{copy.ongoingPending}</strong><p>{copy.pendingHint}</p></aside>}
  <details className={css.group} open={ownDelegationPending||undefined} onToggle={event=>keepPendingVisible(event,ownDelegationPending)}><summary><span>{copy.ongoing}</span><small className={css.muted}>{ongoingStatus}</small></summary><div className={css.content}>{ongoing}</div></details>
 </section>
}
