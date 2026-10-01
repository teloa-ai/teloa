import {localizedMarketItemMetadata,sourceLabel,type MarketItem} from './market-preview.ts'
import type {MarketResourceUse} from './market-resource-index.ts'
import {resolveMarketLocalizedMetadata} from './market-locale-metadata.ts'
import type {IndustryResourceKind} from './industry-manifest.ts'
import type {MarketResourceEntry} from './market-resource-index.ts'
import {marketRuntimeForItem,type MarketSkillRuntime} from './market-runtime-state.ts'
import type {TeloaTranslate} from './i18n/index.ts'
import type {MarketCatalogListCounts,MarketEntryKind} from '@teloa/contract'

export type MarketCategory='industry'|'dashboard'|'agent'|'skill'|'plugin'|'connector'|'model'|'knowledge'|'work-template'
// 顺序即导航顺序：先方案，再同事与技能，接着接入方式（连接、模型），最后资料 / 模板 / 扩展。
// 五个目录 kind（industry→solution、agent→role、skill、connector、model）的相对顺序必须等于 marketEntryKinds（规格 §4）。
// 只留顺序不留中文名：名字统一由 market.presentation.category.* 词条给出。
export const MARKET_CATEGORIES:readonly MarketCategory[]=['industry','dashboard','agent','skill','connector','model','knowledge','work-template','plugin']
/** 类别 → 官方目录条目 kind；没有目录 kind 的类别（资料、模板、扩展）不列。 */
export const marketCategoryKind:Partial<Record<MarketCategory,MarketEntryKind>>={industry:'solution',dashboard:'dashboard',agent:'role',skill:'skill',connector:'connector',model:'model'}
/** 导航恢复到 model 但目录已无模型条目（counts.model 为 0）时回退首页；counts 未就绪时不动。 */
export function restoredMarketCategory<K extends string>(kind:K,counts:MarketCatalogListCounts|undefined):K|'home'{
  return kind==='model'&&counts&&counts.model===0?'home':kind
}
/** 无条目的目录类型不渲染（规格 §4）：model 类别完全由官方目录驱动，counts 未就绪或为 0 时隐藏；其余类别有本地资源不受影响。 */
export function visibleMarketCategories(counts:MarketCatalogListCounts|undefined):MarketCategory[]{
  return MARKET_CATEGORIES.filter(category=>category!=='model'||(counts?.model??0)>0)
}

export function marketCategoryLabel(t:TeloaTranslate,category:MarketCategory):string{
  return t(`market.presentation.category.${category}` as Parameters<TeloaTranslate>[0])
}

export function marketVisibilityLabel(t:TeloaTranslate,visibility:MarketItem['visibility']|'unknown'):string{
  return t(`market.catalog.visibility.${visibility}` as Parameters<TeloaTranslate>[0])
}

type LoadIdentity={contentId:string;templateId:string}
type RuntimeOwner='Teloa'|'DSH'|'unknown'

/** 目录卡与详情页共享同一份标题、摘要回退结果。 */
export function localizedMarketItemCopy(item:Pick<MarketItem,'title'|'summary'|'localized'>,locale:string):{title:string;summary:string}{
  const metadata=localizedMarketItemMetadata(item,locale)
  return {title:metadata.title.value,summary:metadata.summary.value}
}

const localFixedSummaryPrefixes=[
  '本机固定内容，仅用于展示结构，不表示外部连接已就绪。',
  'Local fixed content for structural display only; it does not indicate that external connections are ready.',
] as const

/** 目录卡不逐张重复本机内容边界；调用方在目录层统一说明一次。详情仍保留来源原文。 */
export function marketCatalogItemCopy(item:Pick<MarketItem,'title'|'summary'|'localized'>,locale:string):{title:string;summary:string;localFixed:boolean}{
  const copy=localizedMarketItemCopy(item,locale)
  const summary=copy.summary.trimStart()
  const prefix=localFixedSummaryPrefixes.find(value=>summary.startsWith(value))
  return {...copy,summary:prefix?summary.slice(prefix.length).trimStart():copy.summary,localFixed:!!prefix}
}

/** 适用范围选择只列目录中实际存在的值；常用范围优先，其余自定义范围稳定排序。 */
export function marketScopeOptions(items:readonly Pick<MarketItem,'scope'>[]):string[]{
  const values=[...new Set(items.map(item=>item.scope.trim()).filter(Boolean))]
  const priority=new Map([['general',0],['SOC',1],['AppSec',2]])
  return values.sort((left,right)=>(priority.get(left)??3)-(priority.get(right)??3)||left.localeCompare(right))
}

/** 详情字段只采用条目声明的本地化元数据；导入内容未声明时保持稳定原文。 */
export function localizedMarketItemDetailCopy(item:MarketItem,locale:string):MarketItem{
  const value=(metadata:import('@teloa/contract').LocalizedMetadata|undefined,original:string)=>resolveMarketLocalizedMetadata(metadata??{original,defaultLocale:'und',locales:{}},locale).value
  const copy=localizedMarketItemCopy(item,locale)
  return {...item,title:copy.title,summary:copy.summary,
    requirements:item.requirements.map((original,index)=>value(item.localized?.requirements?.[index],original)),
    output:value(item.localized?.output,item.output),author:value(item.localized?.author,item.author),license:value(item.localized?.license,item.license),compatibility:value(item.localized?.compatibility,item.compatibility),
    components:item.components.map((component,index)=>({...component,name:value(item.localized?.components?.[index]?.name,component.name),status:value(item.localized?.components?.[index]?.status,component.status)})),
  }
}

export function localizedMarketResourceUseTitle(use:MarketResourceUse,locale:string):string{
  return resolveMarketLocalizedMetadata(use.localizedTitle??{original:use.templateTitle,defaultLocale:'und',locales:{}},locale).value
}

export function localizedMarketResourceEntryTitle(entry:Pick<MarketResourceEntry,'title'|'localizedTitle'>,locale:string):string{
  return resolveMarketLocalizedMetadata(entry.localizedTitle??{original:entry.title,defaultLocale:'und',locales:{}},locale).value
}

function runtimePresentation(owner:RuntimeOwner,t?:TeloaTranslate){
  if(!t)return owner==='DSH'?{ecosystem:'DSH 生态',runtime:'由 DSH 安装并运行'}:owner==='Teloa'?{ecosystem:'Teloa 生态',runtime:'由 Teloa 管理与绑定'}:{ecosystem:'归属待核对',runtime:'运行归属待核对'}
  return owner==='DSH'?{ecosystem:t('market.presentation.ecosystem.dsh'),runtime:t('market.presentation.runtime.dsh')}:owner==='Teloa'?{ecosystem:t('market.presentation.ecosystem.teloa'),runtime:t('market.presentation.runtime.teloa')}:{ecosystem:t('market.presentation.ownerUnknown'),runtime:t('market.presentation.runtimeUnknown')}
}
const runtimeKey:Record<string,Parameters<TeloaTranslate>[0]>={'状态未核验':'market.presentation.status.unverified','正在核对安装状态':'market.presentation.status.checking','尚未安装':'market.presentation.status.notInstalled','安装待核对':'market.presentation.status.installPending','已停用':'market.presentation.status.disabled','安装记录存在，运行缺失':'market.presentation.status.runtimeMissing','已安装，当前被同名能力遮蔽':'market.presentation.status.shadowed','已安装并可用':'market.presentation.status.available','已安装，可用性未核验':'market.presentation.status.availabilityUnknown','已加载到工作空间':'market.presentation.status.loaded','尚未加载':'market.presentation.status.notLoaded','实例状态待核对':'market.presentation.status.instanceUnknown','安装状态待核对':'market.presentation.status.installUnknown','配置状态待核对':'market.presentation.status.configUnknown','绑定状态待核对':'market.presentation.status.bindingUnknown','无需安装':'market.presentation.status.noInstall','来源或内容冲突':'market.presentation.status.conflict','尚未取得独立资源内容':'market.presentation.status.referenceOnly','查看并安装':'market.presentation.action.install','查看安装管理':'market.presentation.action.manage','继续核对安装':'market.presentation.action.continue','查看安装':'market.presentation.action.viewInstall','核对安装':'market.presentation.action.reviewInstall','查看并加载':'market.presentation.action.load','查看并配置':'market.presentation.action.configure','查看并绑定':'market.presentation.action.bind','查看并使用':'market.presentation.action.use','查看并核对':'market.presentation.action.review','查看引用位置':'market.presentation.action.references'}
const translateRuntime=(value:string,t?:TeloaTranslate)=>t&&runtimeKey[value]?t(runtimeKey[value]!):value

export function marketCategoryOf(item:MarketItem):MarketCategory{
  if(item.kind==='bundle')return item.manifest&&'resources' in item.manifest&&item.manifest.resources.length>0&&item.manifest.resources.every(row=>row.kind==='business-configuration')?'dashboard':'industry'
  if(item.kind==='role')return 'agent'
  if(item.kind==='skill')return 'skill'
  if(item.kind==='template')return 'work-template'
  if(item.resourceKind==='plugin')return 'plugin'
  return item.resourceKind==='knowledge'?'knowledge':'connector'
}

/** 页尾引导块只在首页且不是方案卡落地时出现（home 无搜索词时永远是 solutionLanding，等价于「首页 + 搜索态」）；
 * skill/resource/connector/work-template/intents 等其余页签一律不挂引导块。 */
export function showMarketGuide(input:{hasItem:boolean;itemId:string|null;intentId:string|null;kind:MarketCategory|'home'|'intents';solutionView:boolean}):boolean{
  return !input.hasItem&&!input.itemId&&!input.intentId&&input.kind==='home'&&!input.solutionView
}

const loaded=(item:MarketItem,loads:readonly LoadIdentity[]):boolean=>loads.some(load=>
  load.contentId===item.contentStorage?.contentId||load.templateId===item.manifest?.id,
)

export function marketItemPresentation(item:MarketItem,loads:readonly LoadIdentity[],runtime?:MarketSkillRuntime,t?:TeloaTranslate){
  const category=marketCategoryOf(item)
  const plugin=item.resourceKind==='plugin'
  const observed=runtime?marketRuntimeForItem(item,runtime):undefined
  const status=observed?.status??(plugin?'状态未核验'
    :category==='industry'?loaded(item,loads)?'已加载到工作空间':'尚未加载'
    :category==='agent'?'实例状态待核对'
    :category==='skill'?'安装状态待核对'
    :category==='connector'?'配置状态待核对'
    :category==='knowledge'?'绑定状态待核对'
    :'无需安装')
  const action=observed?.action??(plugin?'查看并安装':category==='industry'?'查看并加载'
    :category==='agent'?'查看并配置'
    :category==='skill'?'查看并安装'
    :category==='connector'?'查看并配置'
    :category==='knowledge'?'查看并绑定'
    :'查看并使用')
  return {category,type:t?marketCategoryLabel(t,category):category,scope:item.scope==='general'?(t?t('market.presentation.general'):'通用'):item.scope,source:sourceLabel(item.source,t),...runtimePresentation(item.owner,t),status:translateRuntime(status,t),action:translateRuntime(action,t),...(observed?.installationId?{installationId:observed.installationId}:{})}
}

const resourceTypeLabels:Record<IndustryResourceKind,string>={
  role:'员工',knowledge:'知识',skill:'技能',mcp:'MCP',plugin:'扩展','data-source':'数据源','execution-tool':'执行工具','work-template':'任务模板',plan:'持续计划',
  'object-type':'对象类型','business-view':'业务视图','business-action':'业务动作','business-configuration':'业务看板',
}

export function marketResourcePresentation(entry:MarketResourceEntry,item?:MarketItem,runtime?:MarketSkillRuntime,t?:TeloaTranslate){
  const industries=[...new Set(entry.uses.map(use=>use.industry))]
  const scope=item?(item.scope==='general'?(t?t('market.presentation.general'):'通用'):item.scope):(industries.length?industries.join('、'):'适用范围待核对')
  const source=item?sourceLabel(item.source,t):entry.uses.length?(t?t('market.presentation.publicReference',{title:entry.uses[0]!.templateTitle}):entry.uses[0]!.templateTitle+'中的公共引用'):(t?t('market.presentation.sourceUnknown'):'来源待核对')
  const category=entry.kind==='role'?'agent':entry.kind==='skill'?'skill':entry.kind==='knowledge'?'knowledge':'connector'
  const observed=item&&runtime?marketRuntimeForItem(item,runtime):undefined
  const status=entry.status==='conflict'?'来源或内容冲突':entry.status==='reference'?'尚未取得独立资源内容':observed?.status??(entry.kind==='plugin'?'状态未核验'
    :category==='agent'?'实例状态待核对':category==='skill'?'安装状态待核对':category==='knowledge'?'绑定状态待核对':'配置状态待核对'
    )
  const action=entry.status==='conflict'?'查看并核对':entry.status==='reference'?'查看引用位置':observed?.action??(entry.kind==='plugin'?'查看并安装'
    :category==='agent'?'查看并配置':category==='skill'?'查看并安装':category==='knowledge'?'查看并绑定':'查看并配置'
    )
  return {type:t?t(`market.industry.resource.${entry.kind}` as Parameters<TeloaTranslate>[0]):resourceTypeLabels[entry.kind],scope:scope==='适用范围待核对'&&t?t('market.presentation.scopeUnknown'):scope,source:source==='来源待核对'&&t?t('market.presentation.sourceUnknown'):source,...runtimePresentation(entry.owner,t),status:translateRuntime(status,t),action:translateRuntime(action,t),...(observed?.installationId?{installationId:observed.installationId}:{})}
}
