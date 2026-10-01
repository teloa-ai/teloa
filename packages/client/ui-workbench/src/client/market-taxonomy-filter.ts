/**
 * 市场分类词表两排筛选纯函数：不依赖 React / CSS，可在 node --test 中直接 import。
 * 界面文案统一经 translateMessage 取当前语言（11 列），不在这里分语言。
 */
import {
  marketIndustryKeys,
  marketFunctionKeys,
  marketIndustryParent,
  isMarketIndustryRoot,
  type MarketFunctionKey,
  type MarketIndustryKey,
} from '@teloa/contract'
import type {MarketCatalogItem} from './market-catalog-api.ts'
import type {MarketItem} from './market-preview.ts'
import type {MarketResourceEntry} from './market-resource-index.ts'
import {isIndustryManifest} from './industry-manifest.ts'
import {builtinItemFunctions,builtinPackageFunctions} from './builtin-market-taxonomy.ts'
import {MARKET_TAXONOMY_MESSAGE_ROWS} from './i18n/locales/market-taxonomy.ts'
import {translateMessage,type MessageKey} from './i18n/messages.ts'

/** 功能筛选多一个「未分类」：只选出没有功能分类的本机条目（用户自建或导入、未选分类的）。 */
export const UNCLASSIFIED='unclassified' as const
export type FunctionFilter=MarketFunctionKey|typeof UNCLASSIFIED
export type TaxonomyFilter={industry:MarketIndustryKey|null;fn:FunctionFilter|null}

export type TaxonomyAxis='function'|'industry'

/**
 * 词表键对应的界面词条键；必须带维度：`security`、`other` 同时是功能键和行业键，文案不同（安全 / 网络安全）。
 * 二级行业键里的 / 写成 .（如 security/soc → market.taxonomy.industry.security.soc）。
 */
export function taxonomyMessageKey(axis:TaxonomyAxis,key:string):MessageKey|undefined{
 if(axis==='function')return (marketFunctionKeys as readonly string[]).includes(key)?`market.taxonomy.function.${key}` as MessageKey:undefined
 return (marketIndustryKeys as readonly string[]).includes(key)?`market.taxonomy.industry.${key.replace('/','.')}` as MessageKey:undefined
}

const searchTerms=new Map(MARKET_TAXONOMY_MESSAGE_ROWS.map(([messageKey,...labels])=>[messageKey as string,[...new Set(labels)]]))

/** 词表键在全部界面语言下的文案，用于搜索：任何语言输入分类名都能命中。 */
export function taxonomySearchTerms(axis:TaxonomyAxis,key:string):string[]{
 const messageKey=taxonomyMessageKey(axis,key)
 const own=messageKey?searchTerms.get(messageKey)??[]:[]
 // 二级行业同时收录上一级名称：挂在 cyber-security/soc 的条目，搜「网络安全」也能命中
 const parent=axis==='industry'&&messageKey?marketIndustryParent(key as MarketIndustryKey):undefined
 return parent?[...own,...taxonomySearchTerms('industry',parent)]:own
}

/** 词表键在指定界面语言下的显示文案；不在词表则返回 undefined。 */
export function getTaxonomyLabel(axis:TaxonomyAxis,key:string,locale:string):string|undefined{
 const messageKey=taxonomyMessageKey(axis,key)
 return messageKey?translateMessage(locale,messageKey):undefined
}

// ── 行业匹配逻辑 ───────────────────────────────────────────────────────────────

/** 未知行业值（不在 marketIndustryKeys 中）视同 'other'。 */
function isUnknownIndustry(value:string):boolean{
 return!(marketIndustryKeys as readonly string[]).includes(value)
}

function matchesIndustry(industries:readonly string[],key:MarketIndustryKey):boolean{
 if(key==='other'){
  // 'other' 键本身，或任何不在词表中的域（私有模板未知 domain）
  return industries.some(ind=>ind==='other'||isUnknownIndustry(ind))
 }
 if(isMarketIndustryRoot(key)){
  // 根键：匹配本键 + 该根键的所有二级键
  return industries.some(ind=>ind===key||marketIndustryParent(ind as MarketIndustryKey)===key)
 }
 // 二级键：精确匹配
 return industries.includes(key)
}

// ── 主筛选函数 ────────────────────────────────────────────────────────────────

/**
 * 按行业 + 功能筛选市场目录条目。
 * - industry/fn 为 null 表示不限该维度。
 * - industry 为根键时包含其所有二级键的条目。
 * - industry 为二级键时仅精确匹配。
 * - industry='other' 时匹配含 'other' 或未知行业键的条目。
 */
export function filterByTaxonomy(
 entries:readonly MarketCatalogItem[],
 filter:TaxonomyFilter,
):MarketCatalogItem[]{
 return filterTaxonomyRows(entries,item=>item.entry.taxonomy,filter)
}

/** 任何带行业 / 功能标签的行都能套同一套筛选：官方条目、本机条目、本机资源行共用一个判据。 */
export type TaxonomyTags={industries:readonly string[];functions:readonly string[]}
export function matchesTaxonomy(tags:TaxonomyTags,filter:TaxonomyFilter):boolean{
 if(filter.industry!==null&&!matchesIndustry(tags.industries,filter.industry))return false
 if(filter.fn===UNCLASSIFIED)return tags.functions.length===0
 if(filter.fn!==null&&!tags.functions.includes(filter.fn))return false
 return true
}
export function filterTaxonomyRows<T>(rows:readonly T[],tags:(row:T)=>TaxonomyTags,filter:TaxonomyFilter):T[]{
 return rows.filter(row=>matchesTaxonomy(tags(row),filter))
}

// ── 本机条目的行业 / 功能 ─────────────────────────────────────────────────────

/** 旧版方案清单与本机条目的业务范围写法（security、SOC、AppSec…）映射到行业词表键；其余不在词表的值原样保留，筛选时按「其他」处理。 */
const legacyIndustry:Record<string,MarketIndustryKey>={
 security:'cyber-security',soc:'cyber-security/soc',appsec:'cyber-security/appsec',grc:'cyber-security/grc',detection:'cyber-security/detection',cloudsec:'cyber-security',datasec:'cyber-security',
}
export function industryKeyOf(value:string):string{
 if((marketIndustryKeys as readonly string[]).includes(value))return value
 return legacyIndustry[value.toLowerCase()]??value
}
const unique=<T>(values:readonly T[]):T[]=>[...new Set(values)]
/**
 * 条目自身的功能分类，只取真实数据：本人创建时选的分类；Teloa 内置示例与内置行业模板查 `builtin-market-taxonomy.ts`。
 * 都没有就是空数组（界面上归「未分类」），不按行业或引用方推断。
 */
export function marketItemFunctions(item:Pick<MarketItem,'id'|'source'|'manifest'|'functions'>):MarketFunctionKey[]{
 if(item.functions?.length)return [...item.functions]
 if(item.source.kind==='builtin'&&builtinItemFunctions[item.id])return [...builtinItemFunctions[item.id]!]
 const packageId=isIndustryManifest(item.manifest)?item.manifest.id:undefined
 return packageId&&builtinPackageFunctions[packageId]?[...builtinPackageFunctions[packageId]!.functions]:[]
}
/** 本机条目：行业取方案清单的 domain，没有清单时取业务范围（空则「通用」）；功能见 marketItemFunctions。 */
export function marketItemTaxonomy(item:Pick<MarketItem,'id'|'source'|'scope'|'manifest'|'functions'>):TaxonomyTags{
 const domain=isIndustryManifest(item.manifest)?item.manifest.domain:item.scope
 return {industries:[domain?industryKeyOf(domain):'general'],functions:marketItemFunctions(item)}
}
/**
 * 本机资源行。行业：被方案引用时只用引用方的行业，不再并上条目默认的「通用」；没有引用方时用条目自身的，再没有才落到「通用」。
 * 功能：条目自身的分类，加上它在 Teloa 内置包里登记的分类（按包编号 + 包内资源编号查）；不按引用方的功能推断。
 */
export function resourceEntryTaxonomy(entry:Pick<MarketResourceEntry,'uses'>,item?:Pick<MarketItem,'id'|'source'|'scope'|'manifest'|'functions'>,lookup?:(itemId:string)=>Pick<MarketItem,'manifest'>|undefined):TaxonomyTags{
 const referenced=unique(entry.uses.map(use=>industryKeyOf(use.industry)))
 const industries=referenced.length?referenced:item?marketItemTaxonomy(item).industries:['general']
 const registered=entry.uses.flatMap(use=>{const manifest=lookup?.(use.templateId)?.manifest;return isIndustryManifest(manifest)?builtinPackageFunctions[manifest.id]?.resources[use.resourceId]??[]:[]})
 return {industries,functions:unique([...(item?marketItemFunctions(item):[]),...registered])}
}

// ── 根键的二级子列表 ──────────────────────────────────────────────────────────

/** 返回指定根行业键下的所有二级键（词表顺序）。 */
export function getIndustrySubKeys(root:MarketIndustryKey):MarketIndustryKey[]{
 return(marketIndustryKeys as readonly MarketIndustryKey[]).filter(
  key=>marketIndustryParent(key)===root,
 )
}

// 导出词表键列表供 UI 使用
export {marketIndustryKeys,marketFunctionKeys,isMarketIndustryRoot,marketIndustryParent}
export type {MarketFunctionKey,MarketIndustryKey}
