import type {SidebarRightTabDefinition} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {isBusinessMatchField,isBusinessMatchValue} from '@teloa/contract'
import type {WorkbenchDetailTarget} from './workbench-detail-target.js'

export const TELOA_TAB_KINDS=['teloa.task','teloa.role','teloa.business','teloa.artifact'] as const
export type TeloaTabKind=typeof TELOA_TAB_KINDS[number]

export const TELOA_TAB_IDS:Readonly<Record<TeloaTabKind,string>>={
 'teloa.task':'@teloa/client-ui-workbench/task',
 'teloa.role':'@teloa/client-ui-workbench/role',
 'teloa.business':'@teloa/client-ui-workbench/business',
 'teloa.artifact':'@teloa/client-ui-workbench/artifact',
}

/**
 * 本轮已迁入原生右栏的页类型。会话页只对这些 kind 开页签，其余仍走页内第三栏；
 * 注册方与承载方共用这一份名单，免得两边各记一份、各错一半。
 *
 * 把 `teloa.artifact` 加进来之前，`createRailTabs` 的记账必须从 kind 改成 (kind,params)：
 * 它是唯一 `multiple:true` 的页类型，同一 kind 会同时存在多个页签，按 kind 索引会互相覆盖。
 */
export const TELOA_RAIL_KINDS=['teloa.task','teloa.role','teloa.business'] as const
export type TeloaRailKind=typeof TELOA_RAIL_KINDS[number]

export type TeloaTabParams={
 'teloa.task':{taskId:string}
 'teloa.role':{roleId:string}
 // objectType 跟着 section='data' 一起决定看哪一类业务对象，丢了它刷新回来就是另一个列表，
 // 所以它跟 id 一样是导航参数的一部分，而不是可省的装饰。
 'teloa.business':{scope:string;section:string;id?:string;objectType?:string;dashboardId?:string;match?:{field:string;value:string}}
 'teloa.artifact':{source:'session'|'task';id:string;artifactId?:string;version?:number}
}

// 参数表按 kind 声明合并进 DSH：openTab 的 params 由这里定型，调用方写错字段是编译期错误。
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client'{
 interface SidebarRightTabParamsMap{
  'teloa.task':TeloaTabParams['teloa.task']
  'teloa.role':TeloaTabParams['teloa.role']
  'teloa.business':TeloaTabParams['teloa.business']
  'teloa.artifact':TeloaTabParams['teloa.artifact']
 }
}

/**
 * 页类型不写 patterns（它们不是资源地址），也不注册 guide 条目：引导页条目数 >4 时
 * 上游会整体丢弃 description（README:107），而终端、文件、文档预览已各占一条，
 * Teloa 再塞四条只会把引导页变成一片无说明的胶囊。Teloa 的入口本来就在自己的列表与箭头上。
 */
export function teloaTabDefinition(kind:TeloaTabKind,title:()=>string):SidebarRightTabDefinition{
 return {
  id:TELOA_TAB_IDS[kind],
  kind,
  title:()=>title(),
  // multiple:true 只给成果。启用它（把 teloa.artifact 加进 TELOA_RAIL_KINDS）之前，
  // createRailTabs 的记账必须从 kind 改成 (kind,params)，否则多个成果页签会互相覆盖登记。
  ...(kind==='teloa.artifact'?{multiple:true}:{}),
 }
}

const BUSINESS_SECTIONS=['overview','projects','data','work','analysis','execution','dashboards'] as const
const dashboardIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
type BusinessSection=typeof BUSINESS_SECTIONS[number]

const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0
const keys=(value:unknown,allowed:readonly string[]):value is Record<string,unknown>=>
 typeof value==='object'&&value!==null&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))

export function detailTargetToTab(target:WorkbenchDetailTarget|null):{kind:TeloaTabKind;params:TeloaTabParams[TeloaTabKind]}|null{
 if(!target)return null
 if(target.kind==='conversation-object'){
  // 先分出 business：它是联合里唯一带 target 的那支，先判掉才能让 task / role 正确收窄到带 id 的那支。
  if(target.objectKind==='business')return {kind:'teloa.business',params:{scope:target.target.scope,section:target.target.section,...(target.target.id?{id:target.target.id}:{}),...(target.target.objectType?{objectType:target.target.objectType}:{}),...(target.target.dashboardId?{dashboardId:target.target.dashboardId}:{}),...(target.target.match?{match:{field:target.target.match.field,value:target.target.match.value}}:{})}}
  if(target.objectKind==='task')return {kind:'teloa.task',params:{taskId:target.id}}
  return {kind:'teloa.role',params:{roleId:target.id}}
 }
 // 分析、业务对象来源的成果不在页签参数的表达范围内（参数只认 session / task），
 // 与其编一个错的 source，不如交回 null 让调用方退回页内详情。
 if(target.kind==='artifact'&&(target.source.kind==='session'||target.source.kind==='task'))
  return {kind:'teloa.artifact',params:{source:target.source.kind,id:target.source.id,...(target.artifactId?{artifactId:target.artifactId}:{}),...(target.version!==undefined?{version:target.version}:{})}}
 return null
}

export function tabToDetailTarget(kind:TeloaTabKind,params:unknown,sessionId:string):WorkbenchDetailTarget|null{
 if(kind==='teloa.task'){
  if(!keys(params,['taskId'])||!text(params.taskId))return null
  return {kind:'conversation-object',sessionId,objectKind:'task',id:params.taskId}
 }
 if(kind==='teloa.role'){
  if(!keys(params,['roleId'])||!text(params.roleId))return null
  return {kind:'conversation-object',sessionId,objectKind:'role',id:params.roleId}
 }
 if(kind==='teloa.business'){
  if(!keys(params,['scope','section','id','objectType','dashboardId','match'])||!text(params.scope))return null
  if(!BUSINESS_SECTIONS.includes(params.section as BusinessSection))return null
  if(params.id!==undefined&&!text(params.id))return null
  if(params.objectType!==undefined&&!text(params.objectType))return null
  // 看板标识只随看板栏目走，形如声明标识；否则整条页签参数作废。
  if(params.dashboardId!==undefined&&(params.section!=='dashboards'||typeof params.dashboardId!=='string'||!dashboardIdPattern.test(params.dashboardId)))return null
  // 下钻筛选只随对象清单走（data 且有对象类型）；否则整条页签参数作废。
  const match=params.match===undefined?undefined:keys(params.match,['field','value'])&&isBusinessMatchField(params.match.field)&&isBusinessMatchValue(params.match.value)?{field:params.match.field,value:params.match.value}:null
  if(match===null||(match&&(params.section!=='data'||!text(params.objectType))))return null
  return {kind:'conversation-object',sessionId,objectKind:'business',target:{scope:params.scope,section:params.section as BusinessSection,...(params.id?{id:params.id}:{}),...(params.objectType?{objectType:params.objectType}:{}),...(params.dashboardId?{dashboardId:params.dashboardId}:{}),...(match?{match}:{})}}
 }
 if(!keys(params,['source','id','artifactId','version'])||!text(params.id))return null
 // unknown 不会被 !== 收窄成字面量联合，这里显式取一次，避免落回 string。
 const source=params.source==='session'?'session' as const:params.source==='task'?'task' as const:null
 if(source===null)return null
 if(params.artifactId!==undefined&&!text(params.artifactId))return null
 if(params.version!==undefined&&!Number.isSafeInteger(params.version))return null
 // 版本只跟着成果编号走：没有编号就没有版本，这条约束写在详情目标的类型里，不能靠展开糊过去。
 const artifact={kind:'artifact' as const,source:{kind:source,id:params.id}}
 const artifactId=params.artifactId
 if(!text(artifactId))return artifact
 const version=params.version
 return typeof version==='number'?{...artifact,artifactId,version}:{...artifact,artifactId}
}

/**
 * 页签内部的二级视图：对象本身（报告）与要逐字核对的依据。
 * 外层 DSH 页签只表示打开了哪些对象，同一对象的不同取景框留在 tab 内部。
 * 审批不单列一个视图——报告视图里的任务详情已经带着审批卡，再开一页就是同一份内容渲染两遍。
 */
export const TELOA_TAB_SECONDARY_VIEWS=['report','evidence'] as const
export type TeloaTabSecondaryView=typeof TELOA_TAB_SECONDARY_VIEWS[number]

/** 没有依据可核对时连切换条都不出：只有一个可选项的切换条是凭空多出来的交互。 */
export function visibleSecondaryViews(hasEvidence:boolean):readonly TeloaTabSecondaryView[]{
 return hasEvidence?TELOA_TAB_SECONDARY_VIEWS:TELOA_TAB_SECONDARY_VIEWS.filter(view=>view!=='evidence')
}
