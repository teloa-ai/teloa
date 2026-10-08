import {useState} from 'react'
import {IndustryResourceBrowser} from './IndustryResourceBrowser.js'
import type {IndustryResourceKind} from './industry-manifest.js'
import {readUnloadBlockers,type IndustryLoadRecord,type IndustryLoadUnloadBlocker,type IndustryLoadUnloadInput} from './industry-load-api.js'
import type {IndustryKnowledgeInstance,IndustryKnowledgeRequest} from './industry-knowledge-api.js'
import type {IndustryDataSourceInstance,IndustryDataSourceInstantiateInput,IndustryDataSourceAuthorizeInput} from './industry-data-source-api.js'
import type {IndustryExecutionToolInstance,IndustryExecutionToolInstantiateInput,IndustryExecutionToolAuthorizeInput} from './industry-execution-tool-api.js'
import type {IndustryMcpConnectionInstance,IndustryMcpConnectionInstantiateInput,IndustryMcpConnectionConnectInput} from './industry-mcp-connection-api.js'
import type {IndustryPluginInstance,IndustryPluginInstantiateInput,IndustryPluginInstallInput} from './industry-plugin-api.js'
import type {ConnectorKind,ConnectorProbeResult} from './connector-probe-api.js'
import type {MarketPluginInstallPreview,WorkError} from '@teloa/contract'
import {IndustryPluginInstallControl} from './IndustryPluginInstallControl.js'
import {industryKnowledgeAction} from './industry-knowledge-state.js'
import type {IndustryRoleInstance,IndustryRoleRequest} from './industry-role-api.js'
import {industryRoleAction} from './industry-role-state.js'
import type {IndustryTaskApi} from './industry-task-api.js'
import {SavedIndustryTaskForm} from './SavedIndustryTaskForm.js'
import type {IndustryPlanApi,IndustryPlanRequest} from './industry-plan-api.js'
import {SavedIndustryPlanForm} from './SavedIndustryPlanForm.js'
import type {RoleDelegationRead} from './role-delegation-api.js'
import type {SkillInstallApi} from './skill-install-api.js'
import {SkillInstallControl} from './SkillInstallControl.js'
import {IndustryReadinessPanel,type ReadinessPort} from './IndustryReadinessPanel.js'
import {useBusinessScopes} from './business-scope-context.js'
import css from './MarketPage.module.css'
import ui from './SavedIndustryDirectory.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

type KnowledgeProps={items:readonly IndustryKnowledgeInstance[];error:string|undefined;refresh:()=>Promise<void>;pending:IndustryKnowledgeRequest|undefined;recoveryError:WorkError|undefined;instantiate:(input:IndustryKnowledgeRequest)=>Promise<IndustryKnowledgeInstance>;recover:()=>Promise<IndustryKnowledgeInstance>}
type DataSourceProps={items:readonly IndustryDataSourceInstance[];error:string|undefined;partial:boolean;refresh:()=>Promise<void>;pending:IndustryDataSourceAuthorizeInput|undefined;recoveryError:WorkError|undefined;instantiate:(input:IndustryDataSourceInstantiateInput)=>Promise<IndustryDataSourceInstance>;authorize:(input:IndustryDataSourceAuthorizeInput)=>Promise<IndustryDataSourceInstance>;recover:()=>Promise<IndustryDataSourceInstance>}
type ExecutionToolProps={items:readonly IndustryExecutionToolInstance[];error:string|undefined;partial:boolean;refresh:()=>Promise<void>;pending:IndustryExecutionToolAuthorizeInput|undefined;recoveryError:WorkError|undefined;instantiate:(input:IndustryExecutionToolInstantiateInput)=>Promise<IndustryExecutionToolInstance>;authorize:(input:IndustryExecutionToolAuthorizeInput)=>Promise<IndustryExecutionToolInstance>;recover:()=>Promise<IndustryExecutionToolInstance>}
type McpConnectionProps={items:readonly IndustryMcpConnectionInstance[];error:string|undefined;partial:boolean;refresh:()=>Promise<void>;pending:IndustryMcpConnectionConnectInput|undefined;recoveryError:WorkError|undefined;instantiate:(input:IndustryMcpConnectionInstantiateInput)=>Promise<IndustryMcpConnectionInstance>;connect:(input:IndustryMcpConnectionConnectInput)=>Promise<IndustryMcpConnectionInstance>;recover:()=>Promise<IndustryMcpConnectionInstance>}
type PluginProps={items:readonly IndustryPluginInstance[];error:string|undefined;partial:boolean;refresh:()=>Promise<void>;pending:IndustryPluginInstallInput|undefined;recoveryError:WorkError|undefined;instantiate:(input:IndustryPluginInstantiateInput)=>Promise<IndustryPluginInstance>;preview:(instanceId:string)=>Promise<MarketPluginInstallPreview>;install:(input:IndustryPluginInstallInput)=>Promise<IndustryPluginInstance>;enable:(instanceId:string,preview:MarketPluginInstallPreview)=>Promise<IndustryPluginInstance>;reconcile:(instanceId:string)=>Promise<IndustryPluginInstance>;recover:()=>Promise<IndustryPluginInstance>}
type RoleProps={items:readonly IndustryRoleInstance[];error:string|undefined;refresh:()=>Promise<void>;pending:IndustryRoleRequest|undefined;recoveryError:WorkError|undefined;instantiate:(input:IndustryRoleRequest)=>Promise<IndustryRoleInstance>;recover:()=>Promise<IndustryRoleInstance>;open:(roleId:string)=>Promise<void>}
type PlanProps={api:IndustryPlanApi;pending:boolean;recoveryError:WorkError|undefined;create:(x:IndustryPlanRequest)=>Promise<void>;recover:()=>Promise<void>;openRole:(id:string)=>Promise<void>}
type TaskProps={api:IndustryTaskApi;pending:boolean;recoveryError:WorkError|undefined;create:Parameters<typeof SavedIndustryTaskForm>[0]['create'];recover:()=>Promise<void>}
type UnloadProps={pending:boolean;recoveryError:WorkError|undefined;run:(input:IndustryLoadUnloadInput)=>Promise<void>;recover:()=>Promise<void>}
/** 「测试连接」只读探一次：宿主未接线时省去这个可选属性，目录照常渲染，只是没有测试连接入口。 */
type ConnectorsProps={probe:(input:{kind:ConnectorKind;instanceId:string})=>Promise<ConnectorProbeResult>}
/**
 * 沿用项的实例挂在被替代的加载上：本加载上没有时改按沿用来源找，状态文案与操作入口因此都指向来源实例。
 * 沿用一个尚未接入完的资源之后必须还能把它推进完（授权、连接、安装）——宿主对"仍被活跃加载沿用"的实例
 * 放行推进，只拒绝新开实例，所以这里给出的入口不会撞墙。
 */
const heldInstance=<T extends {loadId:string;itemInstanceId:string}>(rows:readonly T[],load:IndustryLoadRecord,item:{instanceId:string;carriedFrom?:string}):T|undefined=>
 rows.find(row=>row.loadId===load.id&&row.itemInstanceId===item.instanceId)??(item.carriedFrom?rows.find(row=>row.itemInstanceId===item.carriedFrom):undefined)
/** 岗位依赖的必需行业知识中尚未启用的项；与宿主 industry-roles 实例化前的校验一致，缺项时宿主会拒绝创建岗位。 */
export function missingRoleKnowledge(load:IndustryLoadRecord,roleItemId:string,knowledgeRows:readonly IndustryKnowledgeInstance[]){
 return load.relations.filter(link=>link.kind==='role-knowledge'&&link.from===roleItemId)
  .map(link=>load.items.find(row=>row.instanceId===link.to))
  .filter((row):row is IndustryLoadRecord['items'][number]=>!!row&&row.required&&heldInstance(knowledgeRows,load,row)?.state!=='active')
}
export function SavedIndustryDirectory({loads,loadId,scope,roleId,templateId,target,error,refresh,openMarket,nativeSettings,knowledge,dataSources,executionTools,mcpConnections,plugins,roles,tasks,plans,unload,skillInstallApi,connectors,readiness,executionAccess}:{loads:readonly IndustryLoadRecord[];loadId?:string;scope?:string;roleId?:string;templateId?:string;target?:{loadId:string;itemInstanceId:string};error:string|undefined;refresh:()=>Promise<void>;openMarket:(id?:string)=>void;nativeSettings:()=>void;knowledge:KnowledgeProps;dataSources:DataSourceProps;executionTools:ExecutionToolProps;mcpConnections:McpConnectionProps;plugins:PluginProps;roles:RoleProps;tasks:TaskProps;plans:PlanProps;unload:UnloadProps;skillInstallApi:SkillInstallApi;connectors?:ConnectorsProps;readiness?:ReadinessPort;executionAccess?:Readonly<Record<string,RoleDelegationRead>>}){
 const {locale,t}=useI18n()
 const scopeNames=useBusinessScopes()
 type ItemStatus=IndustryLoadRecord['items'][number]['status']
 const knowledgeLabel=(row:IndustryKnowledgeInstance|undefined,status:ItemStatus)=>status==='skipped'?t('market.industry.saved.status.skipped'):row?.state==='active'?t('market.industry.saved.status.knowledgeActive'):row?.state==='withdrawn'?t('market.industry.saved.status.knowledgeWithdrawn'):row?.state==='failed'?t('market.industry.saved.status.instantiateFailed'):row?.state==='pending'?t('market.skill.state.pending'):t('market.industry.saved.status.adapterPending')
 const roleLabel=(row:IndustryRoleInstance|undefined,status:ItemStatus)=>status==='skipped'?t('market.industry.saved.status.skipped'):row?.state==='paused'?t('market.industry.saved.status.rolePaused'):row?.state==='active'?t('market.industry.saved.status.roleActive'):row?.state==='retired'?t('market.industry.saved.status.roleRetired'):row?.state==='failed'?t('market.industry.saved.status.instantiateFailed'):row?.state==='pending'?t('market.skill.state.pending'):t('market.industry.saved.status.adapterPending')
 const dataSourceLabel=(row:IndustryDataSourceInstance|undefined,status:ItemStatus)=>status==='skipped'?t('market.industry.saved.status.skipped'):row?.state==='detached'?t('market.industry.saved.status.detached'):row?.drift?t('market.industry.saved.status.drift'):row?.state==='active'?t('market.industry.saved.status.dataSourceConnected'):row?.state==='needs_authorization'?t('market.industry.saved.status.dataSourceRegistered'):t('market.industry.saved.status.integrationPending')
 const executionToolLabel=(row:IndustryExecutionToolInstance|undefined,status:ItemStatus)=>status==='skipped'?t('market.industry.saved.status.skipped'):row?.state==='detached'?t('market.industry.saved.status.detached'):row?.drift?t('market.industry.saved.status.drift'):row?.state==='active'?t('market.industry.saved.status.executionToolActive'):row?.state==='needs_authorization'?t('market.industry.saved.status.executionToolRegistered'):t('market.industry.saved.status.authorizationPending')
 const mcpLabel=(row:IndustryMcpConnectionInstance|undefined,status:ItemStatus)=>status==='skipped'?t('market.industry.saved.status.skipped'):row?.state==='detached'?t('market.industry.saved.status.detached'):row?.drift?t('market.industry.saved.status.drift'):row?.state==='active'?t('market.industry.saved.status.mcpConnected'):row?.state==='needs_connection'?t('market.industry.saved.status.mcpRegistered'):t('market.industry.saved.status.connectionPending')
 const pluginLabel=(row:IndustryPluginInstance|undefined,status:ItemStatus)=>status==='skipped'?t('market.industry.saved.status.skipped'):row?.state==='detached'?t('market.industry.saved.status.detached'):row?.drift?t('market.industry.saved.status.drift'):row?.state==='active'?t('market.industry.saved.status.pluginInstalled'):row?.state==='restart-required'?t('market.industry.saved.status.pluginRestartRequired'):row?.state==='pending-enable'?t('market.industry.saved.status.pluginPendingEnable'):row?.state==='installing'?t('market.skill.state.pending'):row?.state==='failed'?t('market.industry.saved.status.instantiateFailed'):row?.state==='needs_install'?t('market.industry.saved.status.pluginRegistered'):t('market.industry.saved.status.installPending')
 const omittedReason={"not-instantiated":t('market.industry.saved.status.notInstantiated'),pending:t('market.skill.state.pending'),failed:t('market.industry.saved.status.instantiateFailed'),withdrawn:t('market.industry.saved.status.materialWithdrawn'),skipped:t('market.industry.saved.status.loadSkipped')} as const
 /** 沿用上一版实例的项不再另行实例化：状态标签前置说明它沿用自被替代的版本。 */
 const carried=(load:IndustryLoadRecord,item:{carriedFrom?:string},label:string)=>item.carriedFrom&&load.upgrade?t('market.industry.saved.status.carriedFrom',{version:load.upgrade.templateVersion})+' · '+label:label
 const adapterLabel=(kind:IndustryLoadRecord['items'][number]['kind'],status:ItemStatus)=>status==='skipped'?t('market.industry.saved.status.skipped'):status==='detached'?t('market.industry.saved.status.detached'):status==='active'?(kind==='mcp'?t('market.industry.saved.status.mcpConnected'):kind==='plugin'?t('market.industry.saved.status.pluginInstalled'):kind==='data-source'?t('market.industry.saved.status.dataSourceConnected'):kind==='execution-tool'?t('market.industry.saved.status.executionToolActive'):t('market.industry.saved.status.adapterPending')):status==='instantiated'?t('market.skill.state.pending'):kind==='mcp'?t('market.industry.saved.status.connectionPending'):kind==='plugin'?t('market.industry.saved.status.installPending'):kind==='data-source'?t('market.industry.saved.status.integrationPending'):kind==='execution-tool'?t('market.industry.saved.status.authorizationPending'):t('market.industry.saved.status.adapterPending')
 // 分组与类型名按市场标签称呼（同事、技能、连接、扩展），数据源、MCP 连接、执行工具在用户侧统称「连接」；
 // 业务对象与看板单独一组，各组加起来正好是「全部」。组 id 与准备就绪面板的跳转目标一致。
 const environmentGroups=[
  {id:'roles',title:t('market.presentation.category.agent'),kinds:['role']},
  {id:'knowledge',title:t('market.industry.saved.group.knowledge'),kinds:['knowledge']},
  {id:'capabilities',title:t('market.teamCapabilities'),kinds:['skill']},
  {id:'extensions',title:t('market.presentation.category.plugin'),kinds:['plugin']},
  {id:'tasks',title:t('market.industry.saved.group.tasks'),kinds:['work-template']},
  {id:'plans',title:t('market.industry.saved.group.plans'),kinds:['plan']},
  {id:'connectors',title:t('market.presentation.category.connector'),kinds:['data-source','mcp','execution-tool']},
  {id:'business',title:t('composition.row.board'),kinds:['object-type','business-view','business-action']},
 ] as const satisfies readonly {id:string;title:string;kinds:readonly IndustryResourceKind[]}[]
 const kindLabel=(kind:IndustryResourceKind)=>{const group=environmentGroups.find(row=>(row.kinds as readonly string[]).includes(kind));return group&&group.id!=='business'?group.title:t(`market.industry.resource.${kind}` as Parameters<typeof t>[0])}
 const [connectorProbes,setConnectorProbes]=useState<Record<string,{status:'testing'}|{status:'ok';at:string}|{status:'failed';reason:string}>>({})
 /** 探针失败不进 actionError：它只更新自己那一行的结果，不该抢占整页的错误提示位。 */
 const runConnectorProbe=(kind:ConnectorKind,instanceId:string)=>{
  if(!connectors)return
  setConnectorProbes(current=>({...current,[instanceId]:{status:'testing'}}))
  connectors.probe({kind,instanceId}).then(result=>{
   setConnectorProbes(current=>({...current,[instanceId]:result.ok?{status:'ok',at:result.probedAt}:{status:'failed',reason:result.reason}}))
  }).catch(reason=>{
   setConnectorProbes(current=>({...current,[instanceId]:{status:'failed',reason:localizeWorkError(locale,reason)}}))
  })
 }
 const connectorProbeControl=(kind:ConnectorKind,instanceId:string)=>{
  const state=connectorProbes[instanceId]
  return <p role="status">
   <button type="button" className={ui.secondaryButton} data-connector-probe={kind} disabled={state?.status==='testing'} onClick={()=>runConnectorProbe(kind,instanceId)}>{t('connector.test')}</button>
   {' '}
   {state?.status==='testing'?t('connector.testing'):state?.status==='ok'?t('connector.ok',{at:state.at}):state?.status==='failed'?t('connector.failed',{reason:state.reason}):t('connector.neverTested')}
  </p>
 }
 // 卸载阻塞项只有类型与编号：主区按类型报数量，编号收进技术详情。
 const blockerKey={'plan-occurrence':'market.industry.saved.blocker.planOccurrence','task-run':'market.industry.saved.blocker.taskRun'} as const
 const [busy,setBusy]=useState(false),[actionError,setActionError]=useState<string>()
 // 技能安装不在上面这些实例列表里；装完后经 SkillInstallControl.changed 递增，让准备就绪面板重读
 const [skillRevision,setSkillRevision]=useState(0)
 const [unloadTarget,setUnloadTarget]=useState<string>(),[blockers,setBlockers]=useState<readonly IndustryLoadUnloadBlocker[]>([])
 const [planForm,setPlanForm]=useState<{load:IndustryLoadRecord;itemInstanceId:string}>()
 const [taskForm,setTaskForm]=useState<{load:IndustryLoadRecord;itemInstanceId:string}>()
 const [categoryByLoad,setCategoryByLoad]=useState<Record<string,string>>({})
 // 面板随相关操作刷新：本方案条目状态、各类实例的状态与修订、当前分组任一变化都重读清单
 const readinessKey=(load:IndustryLoadRecord)=>[...load.items.map(item=>item.instanceId+':'+item.status),...[knowledge.items,roles.items,dataSources.items,executionTools.items,mcpConnections.items,plugins.items].flatMap(list=>(list as readonly {loadId:string;itemInstanceId:string;state:string;revision:number}[]).filter(row=>row.loadId===load.id).map(row=>row.itemInstanceId+':'+row.state+':'+row.revision)),categoryByLoad[load.id]??'',skillRevision].join('|')
 const rows=loads.filter(load=>(!loadId||load.id===loadId)&&(!scope||load.space.scope===scope)&&(!templateId||load.templateId===templateId)&&(!roleId||roles.items.some(instance=>instance.loadId===load.id&&instance.role?.id===roleId))&&(!target||load.id===target.loadId&&load.items.some(item=>item.instanceId===target.itemInstanceId)))
 if(!rows.length){
  if(!templateId&&!scope&&!error)return null
  return <section className={css.sheet+' '+css.savedDirectory+' '+ui.page+' '+ui.emptyState} aria-label={t(templateId?'market.industry.saved.industry.template.loading.state':'market.industry.saved.working.environment')}>
   <p className={ui.emptyDescription} role={error?'alert':undefined}>{error?<>{t('market.industry.saved.work.environment.reading.failed')} {localizeWorkError(locale,error)}</>:t(templateId?'market.industry.saved.the.current.template.only.contains.resource.statements.in':'market.industry.saved.scopeEmpty')}</p>
   <button type="button" className={ui.secondaryButton} onClick={()=>error?void refresh().catch(()=>{}):openMarket(templateId)}>{t(error?'market.industry.saved.retry.reading':templateId?'market.industry.saved.view.templates.and.start.loading':'market.industry.saved.load.industry.templates.from.market')}</button>
  </section>
 }
 // 只打开一套模板时模板名就是页面主标题；按范围列出多套时范围名做分组标题，模板名降一级。
 const multiple=rows.length>1,TitleTag=multiple?'h3':'h2'
 // 按业务范围标签分组：个人版只有一个空间，加载之间的区别是范围。首次出现的顺序即目录顺序。
 const scopeGroups=rows.reduce<{scope:string;title:string;loads:IndustryLoadRecord[]}[]>((groups,load)=>{
  const found=groups.find(group=>group.scope===load.space.scope)
  if(found)found.loads.push(load)
  else groups.push({scope:load.space.scope,title:scopeNames[load.space.scope]??load.space.scope,loads:[load]})
  return groups
 },[])
 const act=async(run:()=>Promise<unknown>)=>{setBusy(true);setActionError(undefined);try{await run()}catch(reason){setActionError(localizeWorkError(locale,reason))}finally{setBusy(false)}}
 // 卸载被在途执行阻断时列出阻塞项而不是只报一句错，其余拒绝仍走统一的错误提示。
 const runUnload=async(load:IndustryLoadRecord)=>{
  setBusy(true);setActionError(undefined);setBlockers([])
  try{await unload.run({requestId:crypto.randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash});setUnloadTarget(undefined)}
  catch(reason){const found=readUnloadBlockers(reason);if(found.length)setBlockers(found);else setActionError(localizeWorkError(locale,reason))}
  finally{setBusy(false)}
 }
 return <section className={css.sheet+' '+css.savedDirectory+' '+ui.page} aria-label={t("market.industry.saved.working.environment")}>
  {error&&<p role="alert">{localizeWorkError(locale,error)} <button type="button" onClick={()=>void refresh().catch(()=>{})}>{t("market.industry.saved.refresh.industry.load.directory")}</button></p>}
  {(knowledge.error||knowledge.recoveryError||actionError)&&<p role="alert">{actionError??localizeWorkError(locale,knowledge.recoveryError??knowledge.error)} {knowledge.error&&<button type="button" onClick={()=>void knowledge.refresh().catch(()=>{})}>{t("market.industry.saved.update.industry.knowledge.catalogue")}</button>}</p>}
  {dataSources.error&&<p role="alert">{localizeWorkError(locale,dataSources.error)} <button type="button" onClick={()=>void dataSources.refresh().catch(()=>{})}>{t('market.industry.saved.refreshDataSources')}</button></p>}
  {dataSources.partial&&<p role="alert">{t('market.industry.saved.listPartial')} <button type="button" onClick={()=>void dataSources.refresh().catch(()=>{})}>{t('market.industry.saved.refreshDataSources')}</button></p>}
  {dataSources.recoveryError&&<p role="alert">{localizeWorkError(locale,dataSources.recoveryError)}</p>}
  {dataSources.pending&&<p role="status"><button type="button" disabled={busy||!!dataSources.recoveryError} onClick={()=>void act(dataSources.recover)}>{t('market.industry.saved.recover.dataSource')}</button></p>}
  {executionTools.error&&<p role="alert">{localizeWorkError(locale,executionTools.error)} <button type="button" onClick={()=>void executionTools.refresh().catch(()=>{})}>{t('market.industry.saved.refreshExecutionTools')}</button></p>}
  {executionTools.partial&&<p role="alert">{t('market.industry.saved.listPartial')} <button type="button" onClick={()=>void executionTools.refresh().catch(()=>{})}>{t('market.industry.saved.refreshExecutionTools')}</button></p>}
  {executionTools.recoveryError&&<p role="alert">{localizeWorkError(locale,executionTools.recoveryError)}</p>}
  {executionTools.pending&&<p role="status"><button type="button" disabled={busy||!!executionTools.recoveryError} onClick={()=>void act(executionTools.recover)}>{t('market.industry.saved.recover.executionTool')}</button></p>}
  {mcpConnections.error&&<p role="alert">{localizeWorkError(locale,mcpConnections.error)} <button type="button" onClick={()=>void mcpConnections.refresh().catch(()=>{})}>{t('market.industry.saved.refreshMcpConnections')}</button></p>}
  {mcpConnections.partial&&<p role="alert">{t('market.industry.saved.listPartial')} <button type="button" onClick={()=>void mcpConnections.refresh().catch(()=>{})}>{t('market.industry.saved.refreshMcpConnections')}</button></p>}
  {mcpConnections.recoveryError&&<p role="alert">{localizeWorkError(locale,mcpConnections.recoveryError)}</p>}
  {mcpConnections.pending&&<p role="status"><button type="button" disabled={busy||!!mcpConnections.recoveryError} onClick={()=>void act(mcpConnections.recover)}>{t('market.industry.saved.recover.mcpConnection')}</button></p>}
  {plugins.error&&<p role="alert">{localizeWorkError(locale,plugins.error)} <button type="button" onClick={()=>void plugins.refresh().catch(()=>{})}>{t('market.industry.saved.refreshPlugins')}</button></p>}
  {plugins.partial&&<p role="alert">{t('market.industry.saved.listPartial')} <button type="button" onClick={()=>void plugins.refresh().catch(()=>{})}>{t('market.industry.saved.refreshPlugins')}</button></p>}
  {plugins.recoveryError&&<p role="alert">{localizeWorkError(locale,plugins.recoveryError)}</p>}
  {plugins.pending&&<p role="status"><button type="button" disabled={busy||!!plugins.recoveryError} onClick={()=>void act(plugins.recover)}>{t('market.industry.saved.recover.plugin')}</button></p>}
  {knowledge.pending&&<p role="status">{t("market.industry.saved.there.are.requests.for.practicalization.of.industry.knowledge")} <button type="button" disabled={busy||!!knowledge.recoveryError} onClick={()=>void act(knowledge.recover)}>{t("market.industry.saved.reconcile.uncompleted.examples.of.knowledge")}</button></p>}
  {(roles.error||roles.recoveryError)&&<p role="alert">{roles.recoveryError?localizeWorkError(locale,roles.recoveryError):roles.error} {roles.error&&<button type="button" onClick={()=>void roles.refresh().catch(()=>{})}>{t("market.industry.saved.refresh.list.of.trade.jobs")}</button>}</p>}
  {roles.pending&&<p role="status">{t("market.industry.saved.there.are.requests.for.the.demonstration.of.jobs")} <button type="button" disabled={busy||!!roles.recoveryError} onClick={()=>void act(roles.recover)}>{t("market.industry.saved.check.for.examples.of.unfinished.jobs")}</button></p>}
  {plans.recoveryError&&<p role="alert">{localizeWorkError(locale,plans.recoveryError)}</p>}
  {plans.pending&&<p role="status">{t("market.industry.saved.there.is.an.unreconciled.business.continuity.plan.creation")} <button type="button" disabled={busy||!!plans.recoveryError} onClick={()=>void act(plans.recover)}>{t("market.industry.saved.check.uncompleted.plan.creation")}</button></p>}
  {tasks.recoveryError&&<p role="alert">{localizeWorkError(locale,tasks.recoveryError)}</p>}
  {unload.recoveryError&&<p role="alert">{localizeWorkError(locale,unload.recoveryError)}</p>}
  {unload.pending&&<p role="status"><button type="button" disabled={busy||!!unload.recoveryError} onClick={()=>void act(unload.recover)}>{t('market.industry.saved.recover.unload')}</button></p>}
  {tasks.pending&&<p role="status">{t("market.industry.saved.there.are.industry.job.creation.requests.whose.results")} <button type="button" disabled={busy||!!tasks.recoveryError} onClick={()=>void act(tasks.recover)}>{t("market.industry.saved.check.unfinished.create")}</button></p>}
  {scopeGroups.map(group=><section className={css.environmentScope+' '+ui.scopeGroup} key={group.scope} aria-label={group.title}>
  {multiple&&<h2 className={css.environmentScopeTitle+' '+ui.scopeTitle}>{group.title}</h2>}
  {group.loads.map(load=>{const selectedGroup=environmentGroups.find(group=>group.id===categoryByLoad[load.id]),visibleItems=selectedGroup?load.items.filter(item=>(selectedGroup.kinds as readonly string[]).includes(item.kind)):load.items,focusId=target?.loadId===load.id?target.itemInstanceId:undefined,active=load.status!=='unloaded';return <section className={css.environmentLoad+' '+ui.load} key={load.id} aria-label={t('market.industry.saved.loadTemplateAria',{name:load.templateTitle})}>
   <header className={ui.hero}>
    <p className={ui.state}>{active?<span className={ui.stateOn}>{t("market.industry.saved.the.pool.of.resources.has.been.loaded.to")}</span>:<span role="status">{t('market.industry.saved.status.unloaded')}</span>}{group.title!==load.templateTitle&&<span className={ui.scope}>{group.title}</span>}</p>
    <TitleTag className={ui.title}>{load.templateTitle}</TitleTag>
    <p className={ui.meta}>{t('market.industry.saved.versionLine',{version:load.templateVersion})}</p>
    {active&&<p className={ui.lede}>{t("market.industry.saved.loading.will.fix.templates.resource.trees.and.linkages")}</p>}
    <div className={ui.actions}>
     <button type="button" className={ui.textButton} onClick={()=>openMarket('directory-'+load.contentHash)}>{t("market.industry.saved.view.regular.template.sources")}</button>
     {active&&<button type="button" className={ui.dangerButton} disabled={busy||unload.pending||!!unload.recoveryError} onClick={()=>{setUnloadTarget(load.id);setBlockers([])}}>{t('market.industry.saved.unload')}</button>}
    </div>
    {unloadTarget===load.id&&<div className={ui.confirm} role="group" aria-label={t('market.industry.saved.unload')}><p>{t('market.industry.saved.unloadConfirm')}</p><div className={ui.actions}><button type="button" className={ui.dangerSolid} disabled={busy} onClick={()=>void runUnload(load)}>{t('market.industry.saved.unload')}</button><button type="button" className={ui.secondaryButton} onClick={()=>{setUnloadTarget(undefined);setBlockers([])}}>{t('market.industry.saved.unloadCancel')}</button></div></div>}
    {unloadTarget===load.id&&blockers.length>0&&<div role="alert" className={ui.confirm}><p>{t('market.industry.saved.unloadBlocked')}</p><ul>{(['plan-occurrence','task-run'] as const).map(kind=>({kind,count:blockers.filter(blocker=>blocker.kind===kind).length})).filter(row=>row.count>0).map(row=><li key={row.kind}>{t(blockerKey[row.kind])} · {t('market.industry.saved.blocker.count',{count:row.count})}</li>)}</ul><details className={ui.techDetails}><summary>{t('market.industry.saved.techDetails')}</summary><ul>{blockers.map(blocker=><li key={blocker.kind+':'+blocker.id}>{t(blockerKey[blocker.kind])} · {t('market.industry.saved.load.numbering')} {blocker.id}</li>)}</ul></details></div>}
    <details className={ui.diagnostics}><summary>{t('market.industry.saved.techDetails')}</summary><dl><dt>{t('market.industry.saved.template.source.and.version')}</dt><dd>{load.templateTitle} · {load.templateVersion}</dd><dt>{t('market.industry.saved.load.numbering')}</dt><dd><code>{load.id}</code></dd></dl></details>
   </header>
   {readiness&&load.status==='active'&&<IndustryReadinessPanel loadId={load.id} port={readiness} refreshKey={readinessKey(load)} onOpen={group=>group==='models'?nativeSettings():setCategoryByLoad(current=>({...current,[load.id]:group}))}/>}
   <nav className={ui.segmented} aria-label={t("market.industry.saved.classification.of.the.working.environment")}><button type="button" aria-pressed={!selectedGroup} onClick={()=>setCategoryByLoad(current=>({...current,[load.id]:'all'}))}>{t("market.industry.saved.all")} <span>{load.items.length}</span></button>{environmentGroups.map(group=>({group,count:load.items.filter(item=>(group.kinds as readonly string[]).includes(item.kind)).length})).filter(row=>row.count>0).map(({group,count})=><button type="button" key={group.id} aria-pressed={selectedGroup?.id===group.id} onClick={()=>setCategoryByLoad(current=>({...current,[load.id]:group.id}))}>{group.title} <span>{count}</span></button>)}</nav>
   <IndustryResourceBrowser key={load.id+':'+(selectedGroup?.id??'all')+':'+(focusId??'')} showCategories={false} title={selectedGroup?.title} kindLabel={kindLabel} initialSelectedId={focusId} resources={visibleItems.map(item=>({id:item.instanceId,...item}))} status={item=>carried(load,item,item.kind==='knowledge'?knowledgeLabel(heldInstance(knowledge.items,load,item),item.status):item.kind==='role'?roleLabel(heldInstance(roles.items,load,item),item.status):item.kind==='data-source'?dataSourceLabel(heldInstance(dataSources.items,load,item),item.status):item.kind==='execution-tool'?executionToolLabel(heldInstance(executionTools.items,load,item),item.status):item.kind==='plan'&&item.status==='pending-adapter'?t("market.industry.saved.create.program"):item.kind==='work-template'&&item.status==='pending-adapter'?t("market.industry.saved.other.organiser"):item.kind==='skill'&&item.status==='pending-adapter'?t("market.industry.saved.check.installation.status"):item.kind==='mcp'?mcpLabel(heldInstance(mcpConnections.items,load,item),item.status):item.kind==='plugin'?pluginLabel(heldInstance(plugins.items,load,item),item.status):adapterLabel(item.kind,item.status))} render={item=>{const instance=heldInstance(knowledge.items,load,item),roleInstance=heldInstance(roles.items,load,item),dataSourceInstance=heldInstance(dataSources.items,load,item),executionToolInstance=heldInstance(executionTools.items,load,item),mcpInstance=heldInstance(mcpConnections.items,load,item),pluginInstance=heldInstance(plugins.items,load,item),label=carried(load,item,item.kind==='knowledge'?knowledgeLabel(instance,item.status):item.kind==='role'?roleLabel(roleInstance,item.status):item.kind==='data-source'?dataSourceLabel(dataSourceInstance,item.status):item.kind==='execution-tool'?executionToolLabel(executionToolInstance,item.status):item.kind==='plan'&&item.status==='pending-adapter'?t("market.industry.saved.create.program"):item.kind==='work-template'&&item.status==='pending-adapter'?t("market.industry.saved.other.organiser"):item.kind==='skill'&&item.status==='pending-adapter'?t("market.industry.saved.check.installation.status"):item.kind==='mcp'?mcpLabel(mcpInstance,item.status):item.kind==='plugin'?pluginLabel(pluginInstance,item.status):adapterLabel(item.kind,item.status)),action=item.kind==='knowledge'&&item.status!=='skipped'?industryKnowledgeAction(instance,knowledge.pending):'none',roleAction=item.kind==='role'&&item.status!=='skipped'?industryRoleAction(roleInstance,roles.pending):'none';const missingKnowledge=roleAction==='create'||roleAction==='continue'?missingRoleKnowledge(load,item.instanceId,knowledge.items):[];return <>
    <span>{item.required?t("market.industry.saved.required.resources"):t("market.industry.saved.optional.resources")} · {label}</span>
    {instance?.failure&&<p role="alert">{localizeWorkError(locale,instance.failure)}</p>}
    {action==='create'&&<button type="button" className={ui.primaryButton} disabled={busy} aria-label={t("market.industry.saved.knowledge.addAriaPrefix")+item.title} onClick={()=>void act(()=>knowledge.instantiate({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}))}>{t("market.industry.saved.join.knowledge.base")}</button>}
    {action==='continue'&&<button type="button" disabled={busy} aria-label={t("market.industry.saved.review.continueAriaPrefix")+item.title} onClick={()=>void act(()=>knowledge.instantiate({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}))}>{t("market.industry.saved.keep.checking")}</button>}
    {missingKnowledge.length>0&&<p role="status">{t('market.industry.saved.role.needsKnowledge',{names:new Intl.ListFormat(locale,{type:'conjunction'}).format(missingKnowledge.map(row=>row.title))})}</p>}
    {roleAction==='create'&&<button type="button" className={ui.primaryButton} disabled={busy||missingKnowledge.length>0} aria-label={t("market.industry.saved.role.createAriaPrefix")+item.title} onClick={()=>void act(()=>roles.instantiate({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}))}>{t("market.industry.saved.create.digital.employees")}</button>}
    {roleAction==='continue'&&<button type="button" disabled={busy||missingKnowledge.length>0} aria-label={t("market.industry.saved.role.continueAriaPrefix")+item.title} onClick={()=>void act(()=>roles.instantiate({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}))}>{t("market.industry.saved.keep.checking.positions")}</button>}
    {roleInstance?.role&&<><button type="button" aria-label={t("market.industry.saved.role.openAriaPrefix")+item.title} onClick={()=>void act(()=>roles.open(roleInstance.role!.id))}>{t("market.industry.saved.can.not.open.message")}</button></>}
    {roleInstance?.failure&&<p role="alert">{localizeWorkError(locale,roleInstance.failure)}</p>}
    {roleInstance&&<><h4>{t("market.industry.saved.fixed.knowledge.reference")}</h4>{roleInstance.knowledge.length?<ul>{roleInstance.knowledge.map(value=><li key={value.itemInstanceId}>{load.items.find(candidate=>candidate.instanceId===value.itemInstanceId)?.title??value.itemInstanceId}</li>)}</ul>:<p>{t("market.industry.saved.the.job.is.created.with.no.fixed.knowledge")}</p>}{roleInstance.omittedKnowledge.length>0&&<><h4>{t("market.industry.saved.optional.knowledge.not.connected")}</h4><ul>{roleInstance.omittedKnowledge.map(value=><li key={value.itemInstanceId}>{load.items.find(candidate=>candidate.instanceId===value.itemInstanceId)?.title??value.itemInstanceId} · {omittedReason[value.reason]}</li>)}</ul></>}<h4>{t("market.industry.saved.declaration.dependence")}</h4>{roleInstance.declarations.length?<ul>{roleInstance.declarations.map(value=><li key={value.kind+':'+value.itemInstanceId}>{value.kind==='model'?t("market.industry.saved.template.model.ignored"):<>{load.items.find(candidate=>candidate.instanceId===value.itemInstanceId)?.title??value.itemInstanceId} · {value.status==='skipped'?t("market.industry.saved.skipped"):t("market.industry.saved.status.adapterPending")}</>}</li>)}</ul>:<p>{t("market.industry.saved.no.skill.connection.or.tool.declaration.to.access")}</p>}</>}
    {item.kind==='skill'&&item.status==='pending-adapter'&&<SkillInstallControl key={'industry-skill-'+load.id+':'+item.instanceId} api={skillInstallApi} source={{kind:'industry',loadId:load.id,itemInstanceId:item.instanceId}} title={item.title} changed={()=>setSkillRevision(value=>value+1)}/>} 
    {item.kind==='mcp'&&item.status==='pending-adapter'&&!mcpInstance&&<button type="button" className={ui.primaryButton} disabled={busy} onClick={()=>void act(()=>mcpConnections.instantiate({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}))}>{t('market.industry.saved.registerMcpConnection')}</button>}
    {item.kind==='mcp'&&mcpInstance?.state==='needs_connection'&&<><button type="button" className={ui.primaryButton} disabled={busy} onClick={()=>void act(()=>mcpConnections.connect({requestId:crypto.randomUUID(),instanceId:mcpInstance.id,expectedRevision:mcpInstance.revision}))}>{t('market.industry.saved.connectMcpConnection')}</button><button type="button" onClick={nativeSettings}>{t("market.industry.saved.open.connection.and.running.environment")}</button></>}
    {mcpInstance&&connectors&&connectorProbeControl('mcp',mcpInstance.id)}
    {item.kind==='plugin'&&item.status==='pending-adapter'&&!pluginInstance&&<button type="button" className={ui.primaryButton} disabled={busy} onClick={()=>void act(()=>plugins.instantiate({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}))}>{t('market.industry.saved.registerPlugin')}</button>}
    {item.kind==='plugin'&&(pluginInstance?.state==='needs_install'||pluginInstance?.state==='pending-enable')&&<><IndustryPluginInstallControl
      key={'industry-plugin-consent-'+pluginInstance.id}
      instance={pluginInstance}
      busy={busy}
      preview={plugins.preview}
      install={(instanceId,expectedRevision,preview)=>act(()=>plugins.install({requestId:crypto.randomUUID(),instanceId,expectedRevision,preview}))}
      enable={(instanceId,preview)=>act(()=>plugins.enable(instanceId,preview))}
    /><button type="button" onClick={nativeSettings}>{t("market.industry.saved.open.connection.and.running.environment")}</button></>}
    {item.kind==='plugin'&&(pluginInstance?.state==='installing'||pluginInstance?.state==='pending-enable'||pluginInstance?.state==='restart-required'||pluginInstance?.state==='failed')&&<><button type="button" disabled={busy} onClick={()=>void act(()=>plugins.reconcile(pluginInstance.id))}>{t('market.industry.saved.reconcilePlugin')}</button>{pluginInstance.state==='failed'&&<button type="button" onClick={nativeSettings}>{t("market.industry.saved.open.connection.and.running.environment")}</button>}</>}
    {item.kind==='data-source'&&item.status==='pending-adapter'&&!dataSourceInstance&&<button type="button" className={ui.primaryButton} disabled={busy} onClick={()=>void act(()=>dataSources.instantiate({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}))}>{t('market.industry.saved.registerDataSource')}</button>}
    {item.kind==='data-source'&&dataSourceInstance?.state==='needs_authorization'&&<button type="button" className={ui.primaryButton} disabled={busy} onClick={()=>void act(()=>dataSources.authorize({requestId:crypto.randomUUID(),instanceId:dataSourceInstance.id,expectedRevision:dataSourceInstance.revision}))}>{t('market.industry.saved.connectDataSource')}</button>}
    {dataSourceInstance&&connectors&&connectorProbeControl('data-source',dataSourceInstance.id)}
    {item.kind==='execution-tool'&&item.status==='pending-adapter'&&!executionToolInstance&&<button type="button" className={ui.primaryButton} disabled={busy} onClick={()=>void act(()=>executionTools.instantiate({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}))}>{t('market.industry.saved.registerExecutionTool')}</button>}
    {item.kind==='execution-tool'&&executionToolInstance?.state==='needs_authorization'&&<><button type="button" className={ui.primaryButton} disabled={busy} onClick={()=>void act(()=>executionTools.authorize({requestId:crypto.randomUUID(),instanceId:executionToolInstance.id,expectedRevision:executionToolInstance.revision}))}>{t('market.industry.saved.connectExecutionTool')}</button><button type="button" onClick={nativeSettings}>{t("market.industry.saved.open.connection.and.running.environment")}</button></>}
    {executionToolInstance&&connectors&&connectorProbeControl('execution-tool',executionToolInstance.id)}
    {item.kind==='plan'&&item.status==='pending-adapter'&&<button type="button" className={ui.primaryButton} disabled={busy||plans.pending||!!plans.recoveryError} aria-label={t("market.industry.saved.plan.createAriaPrefix")+item.title} onClick={()=>setPlanForm({load,itemInstanceId:item.instanceId})}>{t("market.industry.saved.create.ongoing.scheme")}</button>}
    {item.kind==='work-template'&&item.status==='pending-adapter'&&<button type="button" className={ui.primaryButton} disabled={busy||tasks.pending||!!tasks.recoveryError} aria-label={t("market.industry.saved.task.createAriaPrefix")+item.title} onClick={()=>setTaskForm({load,itemInstanceId:item.instanceId})}>{t("market.industry.saved.create.real.task")}</button>}
    {load.entrypoints.includes(item.instanceId)&&<p>{t("market.industry.saved.business.entry")} {label}</p>}
    {/* 编号、修订号、包名@版本只在排查问题时有用：收进默认收起的「技术详情」。 */}
    {(instance?.resource||roleInstance?.role||roleInstance?.knowledge.length||mcpInstance||pluginInstance||dataSourceInstance||executionToolInstance)&&<details className={ui.techDetails}><summary>{t('market.industry.saved.techDetails')}</summary><ul>
     {instance?.resource&&<li>{t("market.industry.saved.knowledge.reference.number")}{instance.resource.id} · v{instance.resource.version}</li>}
     {roleInstance?.role&&<li>{t("market.industry.saved.real.job.number")}{roleInstance.role.id} · v{roleInstance.role.version}</li>}
     {roleInstance?.knowledge.map(value=><li key={'knowledge:'+value.itemInstanceId}>{load.items.find(candidate=>candidate.instanceId===value.itemInstanceId)?.title??value.itemInstanceId} {t("market.industry.saved.knowledge")} {value.resourceId} · v{value.resourceVersion}</li>)}
     {mcpInstance&&<li>{t('market.industry.saved.mcpInstance')} {mcpInstance.id} · v{mcpInstance.revision}{mcpInstance.state==='active'&&' · '+mcpInstance.binding.serverName}</li>}
     {pluginInstance&&<li>{t('market.industry.saved.pluginInstance')} {pluginInstance.id} · v{pluginInstance.revision} · {pluginInstance.definition.packageName}@{pluginInstance.definition.version}</li>}
     {dataSourceInstance&&<li>{t('market.industry.saved.dataSourceInstance')} {dataSourceInstance.id} · v{dataSourceInstance.revision}{dataSourceInstance.state==='active'&&' · '+dataSourceInstance.binding.sourceId}</li>}
     {executionToolInstance&&<li>{t('market.industry.saved.executionToolInstance')} {executionToolInstance.id} · v{executionToolInstance.revision}</li>}
    </ul></details>}
    {(links=>links.length>0&&<><h4>{t("market.industry.saved.associated.resources")}</h4><ul>{links.map(link=>{const otherId=link.from===item.instanceId?link.to:link.from,other=load.items.find(row=>row.instanceId===otherId),otherInstance=other?.kind==='knowledge'?knowledge.items.find(row=>row.loadId===load.id&&row.itemInstanceId===other.instanceId):undefined,otherLabel=other?.kind==='knowledge'?knowledgeLabel(otherInstance,other.status):other?.kind==='role'?roleLabel(roles.items.find(row=>row.loadId===load.id&&row.itemInstanceId===other.instanceId),other.status):other?.kind==='work-template'&&other.status==='pending-adapter'?t("market.industry.saved.other.organiser"):other?.kind==='skill'&&other.status==='pending-adapter'?t("market.industry.saved.check.installation.status"):other?adapterLabel(other.kind,other.status):t("market.industry.saved.pending.verification");return <li key={link.kind+':'+link.from+':'+link.to}>{other?.title??otherId} · {otherLabel}</li>})}</ul></>)(load.relations.filter(link=>link.from===item.instanceId||link.to===item.instanceId))}
   </>}}/>
  </section>})}
 </section>)}
  {planForm&&<SavedIndustryPlanForm load={planForm.load} itemInstanceId={planForm.itemInstanceId} roles={roles.items} {...(executionAccess?{executionAccess}:{})} api={plans.api} close={()=>setPlanForm(undefined)} create={plans.create} openRole={plans.openRole}/>}
  {taskForm&&<SavedIndustryTaskForm load={taskForm.load} itemInstanceId={taskForm.itemInstanceId} roles={roles.items} {...(executionAccess?{executionAccess}:{})} api={tasks.api} close={()=>setTaskForm(undefined)} create={tasks.create}/>}
 </section>
}
