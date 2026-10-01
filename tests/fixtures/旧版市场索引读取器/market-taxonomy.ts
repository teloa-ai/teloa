import {WorkError} from '../../../packages/contract/src/work-error.ts'
import {isRecord} from '../../../packages/contract/src/resources.ts'

/**
 * 市场分类受控词表（规格 2026-09-25 §4.2）。
 *
 * 功能 10 键：小写 ASCII 与连字符，单一维度。
 * 行业 6 一级键 + 6 二级键（写成 一级/二级）。
 * 词表只在此处定义；界面文案放在客户端 i18n。
 */

export const marketFunctionKeys=[
 'office-docs',
 'communication',
 'content-design',
 'data-research',
 'dev-tools',
 'cloud-ops',
 'security',
 'business-ops',
 'automation',
 'other',
] as const
export type MarketFunctionKey=typeof marketFunctionKeys[number]

export const marketIndustryKeys=[
 'general',
 'cyber-security',
 'marketing',
 'media',
 'software',
 'other',
 'cyber-security/soc',
 'cyber-security/detection',
 'cyber-security/appsec',
 'cyber-security/grc',
 'marketing/new-media',
 'media/video',
] as const
export type MarketIndustryKey=typeof marketIndustryKeys[number]

const industryParentMap:Partial<Record<MarketIndustryKey,MarketIndustryKey>>={
 'cyber-security/soc':'cyber-security',
 'cyber-security/detection':'cyber-security',
 'cyber-security/appsec':'cyber-security',
 'cyber-security/grc':'cyber-security',
 'marketing/new-media':'marketing',
 'media/video':'media',
}

/** 二级键返回它的一级键；一级键返回 undefined。 */
export function marketIndustryParent(key:MarketIndustryKey):MarketIndustryKey|undefined{
 return industryParentMap[key]
}

/** 只对一级行业键返回 true。 */
export function isMarketIndustryRoot(value:unknown):value is MarketIndustryKey{
 if(typeof value!=='string')return false
 return (marketIndustryKeys as readonly string[]).includes(value)&&!value.includes('/')
}

export type MarketTaxonomy={functions:MarketFunctionKey[];industries:MarketIndustryKey[]}

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)

/**
 * 读取并校验 taxonomy 对象。
 * - 只接受 functions、industries 两个键。
 * - functions：1–2 个，去重，全为已知键。
 * - industries：1–4 个，去重，全为已知键。
 * - 遇到未知键、数量违规、重复键或多余属性，抛 WorkError('teloa/invalid-input', …)。
 */
export function readMarketTaxonomy(value:unknown):MarketTaxonomy{
 if(!isRecord(value))throw bad('taxonomy 格式不正确。')
 const keys=Object.keys(value)
 if(keys.length!==2||!Object.hasOwn(value,'functions')||!Object.hasOwn(value,'industries'))
  throw bad('taxonomy 只能包含 functions 与 industries 两个键。')
 const rawFn=value.functions
 const rawInd=value.industries
 if(!Array.isArray(rawFn)||rawFn.length<1||rawFn.length>2)throw bad('taxonomy.functions 必须是 1–2 个功能键。')
 if(!Array.isArray(rawInd)||rawInd.length<1||rawInd.length>4)throw bad('taxonomy.industries 必须是 1–4 个行业键。')
 const fnKeys=rawFn as unknown[]
 for(const k of fnKeys){
  if(!(marketFunctionKeys as readonly unknown[]).includes(k))throw bad('taxonomy.functions 包含未知键：'+String(k))
 }
 if(new Set(fnKeys).size!==fnKeys.length)throw bad('taxonomy.functions 不能有重复键。')
 const indKeys=rawInd as unknown[]
 for(const k of indKeys){
  if(!(marketIndustryKeys as readonly unknown[]).includes(k))throw bad('taxonomy.industries 包含未知键：'+String(k))
 }
 if(new Set(indKeys).size!==indKeys.length)throw bad('taxonomy.industries 不能有重复键。')
 return {functions:[...fnKeys] as MarketFunctionKey[],industries:[...indKeys] as MarketIndustryKey[]}
}
