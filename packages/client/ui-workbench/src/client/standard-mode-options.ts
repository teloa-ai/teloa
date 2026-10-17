export type StandardModeOption={id:string;name?:string;broken?:string}
const ownedNames=new Set(['标准模式','標準模式','Standard mode','DSH 原生标准模式','DSH 原生標準模式','DSH native Standard mode'])

/** 固定模式的品牌名称，不翻译本人命名。 */
export function standardModeName(active:string):string|undefined{
 const locale=active.toLowerCase()
 if(locale==='zh'||locale==='zh-cn'||locale==='zh-hans')return '标准模式'
 if(['zh-hant','zh-tw','zh-hk'].includes(locale))return '標準模式'
 if(locale==='en'||locale.startsWith('en-'))return 'Standard mode'
 return undefined
}

/** 只识别固定预设，保留本人改过的名称与自定义模式。 */
export function isOwnedStandardMode(option:StandardModeOption):boolean{
 return (option.id==='teloa-standard'||option.id==='standard')&&(option.name===undefined||ownedNames.has(option.name))
}

const ownedDescriptions=new Set([
 '在 DSH 标准能力上支持通用业务协作，分析资料、使用工具、组织工作并交付可核对的成果。',
 'DSH 原生工具与提示词组合。',
])
/** 只替换已知的官方技术说明，不改本人编辑过的名称与说明。 */
export function standardModeDescription(option:StandardModeOption&{description?:string},active:string):string|undefined{
 const code=optionalCodeDescriptions.get(option.id)
 if(code&&option.name===undefined&&option.description===code[2])return code[localeIndex(active)]
 if(!isOwnedStandardMode(option)||!option.description||!ownedDescriptions.has(option.description))return option.description
 const locale=active.toLowerCase()
 return ['zh-hant','zh-tw','zh-hk'].includes(locale)?'分析資料、使用工具並交付工作成果。':locale==='zh'||locale==='zh-cn'||locale==='zh-hans'?'分析资料、使用工具并交付工作成果。':'Analyze information, use tools, and deliver work results.'
}

/**
 * DSH 内置预设的产品名：id 集合与语义同官方 `@deepseek-ai/dsh-agent-preset-registry/display`（alpha3 的 presetStandardName、
 * presetPtcName、presetMinimalName、presetCordisName）。简繁英定稿，其余语言回退英文。
 */
const builtInPresetNames=new Map<string,readonly [string,string,string]>([
 ['standard',['标准模式','標準模式','Standard mode']],
 ['ptc',['PTC 模式','PTC 模式','PTC mode']],
 ['ptc-persistent',['代码模式（保留变量）','程式碼模式（保留變數）','Code mode (retained variables)']],
 ['ptc-python',['代码模式（Python）','程式碼模式（Python）','Code mode (Python)']],
 ['minimal',['极简模式','極簡模式','Minimal mode']],
 ['cordis',['创造模式','創造模式','Creator mode']],
])
const localeIndex=(active:string)=>{const locale=active.toLowerCase();return ['zh-hant','zh-tw','zh-hk'].includes(locale)?1:locale==='zh'||locale==='zh-cn'||locale==='zh-hans'?0:2}
const optionalCodeDescriptions=new Map<string,readonly [string,string,string]>([
 ['ptc-persistent',['在当前会话内存中保留变量；重启应用后清空。','在目前會話記憶體中保留變數；重新啟動應用程式後清除。','Keep variables in this session memory; restarting the app clears them.']],
 ['ptc-python',['使用 Python 执行代码，沿用当前文件权限与审批规则。','使用 Python 執行程式碼，沿用目前檔案權限與審批規則。','Run Python code with the current file permissions and approval rules.']],
])
/**
 * 工作模式显示名。Teloa 固定标准预设沿用「标准模式」；其余内置预设只在 roster 没有发布 name 时显示产品名（官方 isBuiltInPreset），
 * 本人命名或改名的模式原样显示、不翻译；未知 id 且无名称时才显示 id。
 */
export function presetDisplayName(option:StandardModeOption,active:string):string{
 if(isOwnedStandardMode(option))return standardModeName(active)??builtInPresetNames.get('standard')![2]
 const names=option.name===undefined?builtInPresetNames.get(option.id):undefined
 return names?names[localeIndex(active)]:option.name??option.id
}

/** Teloa 标准可用时不再重复提供底层 standard；源目录及旧引用不变。 */
export function singleStandardModeOptions<T extends StandardModeOption>(options:readonly T[]):readonly T[]{
 return options.some(option=>option.id==='teloa-standard'&&option.broken===undefined)
  ?options.filter(option=>option.id!=='standard'||!isOwnedStandardMode(option))
  :options
}
