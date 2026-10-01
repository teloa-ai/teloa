import {isRecord} from './resources.ts'

/**
 * 业务范围键（机器键；显示名另存于范围标签的 title）：1–64 位字母、数字、下划线或连字符。
 * 行业模板加载、页内新建业务、业务声明的 `domain`、看板与同步的读写、客户端一律按它校验——声明处就拒收不合规的范围，
 * 不会出现「草案能确认、看板读不出」。与任务、资料等范围列的正则取交集（见 backend `isBusinessScopeDomain`）。
 */
export const businessScopeKeyPattern=/^[a-zA-Z0-9_-]{1,64}$/
export const isBusinessScopeKey=(value:unknown):value is string=>typeof value==='string'&&businessScopeKeyPattern.test(value)
/** 业务范围键不合规时的统一文案。 */
export const businessScopeKeyRule='业务范围只能是 1–64 位字母、数字、下划线或连字符'

/**
 * 业务范围标签的来源：`builtin` 是随本人空间一并登记的内置范围；`domain` 由行业模板加载时按 `manifest.domain` 登记；
 * `legacy` 是迁移期为存量取值保留的可读标签（例如不再是内置范围的 `Design`），只保证既有记录继续可读，不允许新建。
 */
export type BusinessScopeKind='builtin'|'domain'|'legacy'
export const businessScopeKinds=['builtin','domain','legacy'] as const
/** 标签及其只读汇总：`loads` 是该范围下的全部加载数，`activeLoads` 只数仍在生效的。 */
/** `sourceNoun` 仅在当前业务范围的有效模板来源说法唯一时出现；缺省即让界面回落通用名词。 */
export type BusinessScopeLabel={scope:string;title:string;kind:BusinessScopeKind;loads:number;activeLoads:number;tasks:number;groups:number;sourceNoun?:string}

/**
 * 内置范围（用户 2026-09-15 决定 `Design` 不再内置）。写入校验对这三个取值恒放行：
 * 大量既有装配并不引导本人空间，标签表里没有它们的行，但这三个取值在这些装配里一直是合法的业务身份。
 */
export const builtinBusinessScopes=[{scope:'general',title:'通用工作'},{scope:'SOC',title:'安全运营'},{scope:'AppSec',title:'应用安全'}] as const
/** 历史范围：库里确有 `scope='Design'` 的存量行时才登记，登记后既有记录可读、也可继续写，但不再作为内置范围推荐。 */
export const legacyBusinessScope={scope:'Design',title:'设计（历史）'} as const
export const isBuiltinBusinessScope=(value:unknown):boolean=>builtinBusinessScopes.some(item=>item.scope===value)
/** 通用工作（general）不绑任何业务数据，任何岗位都支持；其余范围要求岗位声明包含该范围（2026-09-21 用户裁定）。 */
export const roleSupportsScope=(roleScopes:readonly string[],scope:string):boolean=>scope==='general'||roleScopes.includes(scope)

const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=2147483647
const label=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=80&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const sourceNoun=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=12&&!/[\x00-\x1f\x7f]/.test(value)

/** 标签形状核对：标签与标题 1–80，`kind` 取值受限，四个计数都是非负整数；多字段或缺字段一律不成立。 */
export const isBusinessScopeLabel=(value:unknown):value is BusinessScopeLabel=>{
 if(!isRecord(value))return false
 const keys=['scope','title','kind','loads','activeLoads','tasks','groups']
 const hasSourceNoun='sourceNoun' in value
 if(Object.keys(value).length!==keys.length+(hasSourceNoun?1:0)||keys.some(key=>!(key in value)))return false
 return label(value.scope)&&label(value.title)&&businessScopeKinds.some(kind=>kind===value.kind)&&count(value.loads)&&count(value.activeLoads)&&count(value.tasks)&&count(value.groups)&&Number(value.activeLoads)<=Number(value.loads)&&(!hasSourceNoun||sourceNoun(value.sourceNoun))
}
