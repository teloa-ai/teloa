/**
 * 个人版只有一个工作空间：`scope` 不再是空间身份，而是本空间内的业务范围标签。
 * 标签取值由宿主登记（内置 general/SOC/AppSec、已加载模板的 domain、迁移期遗留标签），客户端只做投影。
 */
export type BusinessScope=string
export type BusinessScopeKind='builtin'|'domain'|'legacy'
/** 与 `business-scopes/list` 的回包一一对应；计数为只读汇总，不参与任何写入。 */
/** `sourceNoun` 由宿主从当前有效行业模板汇总；缺省时界面使用通用来源名词。 */
export type BusinessScopeLabel={scope:string;title:string;kind:BusinessScopeKind;loads:number;activeLoads:number;tasks:number;groups:number;sourceNoun?:string}
/** 与 `business-spaces/current` 的回包一一对应；个人版 `kind` 恒为 `'personal'`。 */
export type BusinessSpaceRecord={id:string;name:string;description:string;version:number;kind:'personal';createdAt:string;updatedAt:string}
export type BusinessDirectory={space:BusinessSpaceRecord;labels:BusinessScopeLabel[]}

export const builtinBusinessNames={general:'通用工作',SOC:'安全运营',AppSec:'应用安全'} as const
export type BuiltinBusinessScope=keyof typeof builtinBusinessNames
export const builtinBusinessScope=(scope:unknown):scope is BuiltinBusinessScope=>typeof scope==='string'&&Object.hasOwn(builtinBusinessNames,scope)

/** 业务范围目录读到之前的兜底：只有三个内置标签，计数一律为 0。 */
export const initialBusinessSpaces=():BusinessScopeLabel[]=>(Object.keys(builtinBusinessNames) as BuiltinBusinessScope[]).map(scope=>({scope,title:builtinBusinessNames[scope],kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}))

/** 只为目录已经返回的标识生成名称；内置词典只负责本地化同名标识，不生成目录记录。 */
export type BusinessScopeNames=Readonly<Record<string,string>>
export const businessScopeNames=(labels:readonly BusinessScopeLabel[],builtinTitles:Partial<Record<BuiltinBusinessScope,string>>={}):BusinessScopeNames=>
 Object.fromEntries(labels.map(label=>[label.scope,builtinBusinessScope(label.scope)?builtinTitles[label.scope]??label.title:label.title]))

/**
 * 把已保存的行业模板加载投影成业务范围标签：标题取模板标题，缺失时退回标签本身。
 * 不能用空间名——个人版下它恒为“我的工作空间”，对每个标签都一样。
 */
export const industryLoadScopeLabels=(loads:readonly {space:{scope:string};templateTitle?:string}[]):BusinessScopeLabel[]=>
 [...new Map(loads.map(load=>[load.space.scope,load])).values()].map(load=>({scope:load.space.scope,title:load.templateTitle?.trim()||load.space.scope,kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0}))

/** 三个内置范围永远成立，目录尚未读到也不会把既有工作判成未注册范围。 */
export const registeredBusinessScope=(scope:unknown,labels:readonly BusinessScopeLabel[])=>typeof scope==='string'&&(builtinBusinessScope(scope)||labels.some(label=>label.scope===scope))

/**
 * 本地校验失败也必须带稳定 code：界面上的改名错误统一走 `localizeWorkError`，
 * 无 code 的 Error 会被当成未知错误、落到“操作未完成，请稍后重试”，读不出真实原因。
 */
const rejected=(code:'teloa/invalid-input'|'teloa/version-conflict',message:string)=>Object.assign(Error(message),{rejected:true,code})

/** 个人版只保留改名：新建空间属于专业版 / 企业版。 */
export type BusinessSpaceChange={type:'rename';expectedVersion:number;name:string;description:string}
export function changeBusinessDirectory(directory:BusinessDirectory,change:BusinessSpaceChange):BusinessDirectory{
 const name=change.name.trim(),description=change.description.trim()
 if(!name||name.length>80||description.length>2000)throw rejected('teloa/invalid-input','业务名称需为1～80字，说明不能超过2000字。')
 if(directory.space.version!==change.expectedVersion)throw rejected('teloa/version-conflict','业务空间已变化，请重新核对。')
 return {...directory,space:{...directory.space,name,description,version:directory.space.version+1}}
}
