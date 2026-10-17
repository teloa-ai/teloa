import {readModelOptionsDirectory,type ModelOptionsDirectory} from '@teloa/contract'
import {presetDisplayName,singleStandardModeOptions,standardModeName,standardModeDescription} from './standard-mode-options.ts'
const creatorUnavailableReason='创造模式仅供本人会话使用，不能用于员工运行。'

export type RuntimeConfigItem={
 id:string
 /** 原值：roster 发布的名称，缺失时为 id；显示名由 presetDisplayName 决定。 */
 label:string
 /** roster 发布的名称；缺失表示未命名的内置预设，可显示产品名。 */
 name?:string
 default:boolean
 health:'ready'|'unavailable'
 description?:string
 reason?:string
}

export type RuntimeConfigDirectory={
 status:'ready'
 /** 旧版 DSH 的选择器策略；0.2.1-alpha.1 roster 不再公开，缺失时保持未知。 */
 modeSelectionEnabled?:boolean
 items:RuntimeConfigItem[]
}

export type RoleRuntimeConfigApi={list:()=>Promise<RuntimeConfigDirectory>;models?:()=>Promise<ModelOptionsDirectory>}
export type RuntimeConfigLoadState={status:'idle'|'loading'|'ready'|'error';directory?:RuntimeConfigDirectory|undefined;error?:string|undefined}

export type RoleResponsibilityView={
 triggers:string[]
 autonomousActions:string[]
 confirmationPoints:string[]
 escalationRules:string[]
 deliveryChecks:string[]
}

type AgentPresetRow={
 id:string
 isDefault:boolean
 order?:number
 name?:string
 description?:string
 broken?:string
}

const text=(value:unknown,max=4000):string|undefined=>typeof value==='string'&&value.trim().length>0&&value.length<=max?value.trim():undefined

function row(value:unknown):AgentPresetRow{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('运行配置目录格式不正确。')
 const item=value as Record<string,unknown>
 if(Object.keys(item).some(key=>!['id','isDefault','name','description','broken','order'].includes(key)))throw Error('运行配置目录格式不正确。')
 const id=text(item.id,120),name=item.name===undefined?undefined:text(item.name,160),description=item.description===undefined?undefined:text(item.description),broken=item.broken===undefined?undefined:text(item.broken)
 if(!id||!/^[a-z0-9][a-z0-9-]*$/.test(id)||typeof item.isDefault!=='boolean'||(item.order!==undefined&&(typeof item.order!=='number'||!Number.isFinite(item.order)))||(item.name!==undefined&&!name)||(item.description!==undefined&&!description)||(item.broken!==undefined&&!broken))throw Error('运行配置目录格式不正确。')
 return {id,isDefault:item.isDefault,...(name===undefined?{}:{name}),...(description===undefined?{}:{description}),...(broken===undefined?{}:{broken})}
}

/** 只投影 DSH 已公开的 roster；不保存或复制 preset 正文。 */
export function readRuntimeConfigDirectory(value:unknown):RuntimeConfigDirectory{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('运行配置目录格式不正确。')
 const roster=value as Record<string,unknown>
 // 固定版 0.2.1-alpha.1 AgentPresetRoster 只有 presets；兼容旧目录的策略字段，不补造它。
 if(Object.keys(roster).some(key=>key!=='presets'&&key!=='modeSelectionEnabled')||!Array.isArray(roster.presets)||(roster.modeSelectionEnabled!==undefined&&typeof roster.modeSelectionEnabled!=='boolean'))throw Error('运行配置目录格式不正确。')
 const items=roster.presets.map(row).map(item=>({
  id:item.id,label:item.name??item.id,...(item.name===undefined?{}:{name:item.name}),default:item.isDefault,
  health:item.broken===undefined&&item.id!=='cordis'?'ready' as const:'unavailable' as const,
  ...(item.description===undefined?{}:{description:item.description}),
  ...(item.id==='cordis'?{reason:creatorUnavailableReason}:item.broken===undefined?{}:{reason:item.broken}),
 }))
 if(new Set(items.map(item=>item.id)).size!==items.length||items.filter(item=>item.default).length>1)throw Error('运行配置目录格式不正确。')
 return {status:'ready',...(roster.modeSelectionEnabled===undefined?{}:{modeSelectionEnabled:roster.modeSelectionEnabled as boolean}),items}
}

/** 将 DSH 原生 agentPresets/list 约束在 UI 边界，避免引入业务侧副本。 */
export function createRoleRuntimeConfigApi(read:()=>Promise<unknown>,models?:()=>Promise<unknown>):RoleRuntimeConfigApi{
 return {list:async()=>readRuntimeConfigDirectory(await read()),...(models?{models:async()=>readModelOptionsDirectory(await models())}:{})}
}

/** 每次读取都是新快照；失败不能沿用旧目录把固定配置误报为可用。 */
export const runtimeConfigLoading=():RuntimeConfigLoadState=>({status:'loading'})
export const runtimeConfigReady=(directory:RuntimeConfigDirectory):RuntimeConfigLoadState=>({status:'ready',directory})
export const runtimeConfigFailed=(_error:unknown,locale='zh-Hans'):RuntimeConfigLoadState=>({status:'error',error:modeText(locale,'unreadable')})

const modeCopy={
 inherited:['使用默认工作模式','使用預設工作模式','Use the default work mode'],
 inheritedDetail:['新工作使用当前默认模式；创造模式不可用于员工，将使用标准模式。','新工作使用目前預設模式；創造模式不能用於員工，將使用標準模式。','New work uses the current default. Creator mode is unavailable for employees, so Standard mode is used instead.'],
 creatorUnavailable:[creatorUnavailableReason,'創造模式僅供本人會話使用，不能用於員工執行。','Creator mode is available only in your own conversations and cannot run employees.'],
 unavailable:['工作模式待核对','工作模式待核對','Work mode needs review'],
 unreadable:['暂时无法读取工作模式，请重试后再开始新工作。','暫時無法讀取工作模式，請重試後再開始新工作。','Work modes could not be loaded. Retry before starting new work.'],
 missing:['原工作模式已不可用，请选择其他模式后再开始新工作。','原工作模式已無法使用，請選擇其他模式後再開始新工作。','The saved work mode is no longer available. Choose another mode before starting new work.'],
 broken:['所选工作模式暂不可用，请选择其他模式。','所選工作模式暫時無法使用，請選擇其他模式。','The selected work mode is unavailable. Choose another mode.'],
 ready:['工作模式可用；资料、技能和工具仍按已有授权使用。','工作模式可用；資料、技能和工具仍依既有授權使用。','The work mode is available. Existing permissions still apply to materials, skills, and tools.'],
 default:['使用当前默认','使用目前預設','Use the current default'],
 current:['当前默认','目前預設','Current default'],
 disabled:['不可用','無法使用','Unavailable'],
 missingOption:['已保存的工作模式 · 当前不可用','已儲存的工作模式 · 目前無法使用','Saved work mode · unavailable'],
} as const
const modeText=(locale:string,key:keyof typeof modeCopy)=>modeCopy[key][['zh-hant','zh-tw','zh-hk'].includes(locale.toLowerCase())?1:/^zh(?:$|-cn$|-hans$)/i.test(locale)?0:2]

export function runtimeConfigSummary(agentPresetId:string|undefined,directory?:RuntimeConfigDirectory,locale='zh-Hans'){
 if(!agentPresetId)return {label:modeText(locale,'inherited'),detail:modeText(locale,'inheritedDetail'),health:'inherited' as const}
 if(!directory)return {label:modeText(locale,'unavailable'),detail:modeText(locale,'unreadable'),health:'unavailable' as const}
 const item=directory.items.find(candidate=>candidate.id===agentPresetId)
 if(!item)return {label:modeText(locale,'unavailable'),detail:modeText(locale,'missing'),health:'unavailable' as const}
 const label=presetDisplayName(item,locale)
 if(item.health==='unavailable')return {label,detail:item.id==='cordis'&&item.reason===creatorUnavailableReason?modeText(locale,'creatorUnavailable'):item.reason??modeText(locale,'broken'),health:'unavailable' as const}
 return {label,detail:standardModeDescription(item,locale)??modeText(locale,'ready'),health:'ready' as const}
}

export function runtimeConfigOptions(agentPresetId:string|undefined,directory:RuntimeConfigDirectory,locale='zh-Hans'){
 const available=singleStandardModeOptions(directory.items.map(item=>({...item,...(item.health==='unavailable'?{broken:item.reason??'unavailable'}:{})})))
 const legacy=agentPresetId==='standard'&&!available.some(item=>item.id==='standard')&&directory.items.some(item=>item.id==='standard')
 const missing=agentPresetId&&!directory.items.some(item=>item.id===agentPresetId)?[{id:agentPresetId,label:modeText(locale,'missingOption'),disabled:true}]:[]
 const name=standardModeName(locale)??'Standard mode',stored=locale.toLowerCase().startsWith('zh')?`${['zh-hant','zh-tw','zh-hk'].includes(locale.toLowerCase())?'已儲存':'已保存'}：${name}`:`Saved: ${name}`
 return [
  {id:'',label:modeText(locale,'default'),disabled:false},
  ...missing,
  ...(legacy?[{id:'standard',label:stored,disabled:true}]:[]),
  ...available.map(item=>({id:item.id,label:presetDisplayName(item,locale)+(item.default?' · '+modeText(locale,'current'):'')+(item.health==='unavailable'?' · '+modeText(locale,'disabled'):''),disabled:item.health!=='ready'})),
 ]
}

/**
 * 继承默认是明确的空配置。编辑已固定的岗位时，只有用户主动切换后才能清除原 preset，
 * 避免目录读取失败或选项消失时把旧值静默当成继承。
 */
export function runtimeConfigCanSave(input:{initialAgentPresetId:string|undefined;agentPresetId:string|undefined;changed:boolean;directory:RuntimeConfigDirectory|undefined}){
 if(!input.agentPresetId)return input.initialAgentPresetId===undefined||input.changed
 return !!input.directory?.items.some(item=>item.id===input.agentPresetId&&item.health==='ready')
}

export function roleFormProgress(input:{step:number;identityReady:boolean;scopeReady:boolean;runtimeReady:boolean}){
 const canOpenStep=(index:number)=>index===0||index===1&&input.identityReady||(index===2||index===3)&&input.identityReady&&input.scopeReady||index===4&&input.identityReady&&input.scopeReady&&input.runtimeReady
 const canContinue=input.step===0?input.identityReady:input.step===1?input.scopeReady:input.step===3?input.runtimeReady:input.step===4?input.identityReady&&input.scopeReady&&input.runtimeReady:true
 return {canContinue,canOpenStep}
}

// 标签走词典键而非中文字面量：这五组文案此前是硬编码中文，其余九种语言的用户看到的也是中文——
// 改成 labelKey 由调用方过 t()，才是真正的十语呈现（不是新增字段，只是补齐已漏掉的本地化）。
export function responsibilityGroups(value:RoleResponsibilityView){
 return [
  {key:'triggers',labelKey:'team.form.responsibility.triggers',items:value.triggers},
  {key:'autonomousActions',labelKey:'team.form.responsibility.autonomousActions',items:value.autonomousActions},
  {key:'confirmationPoints',labelKey:'team.form.responsibility.confirmationPoints',items:value.confirmationPoints},
  {key:'escalationRules',labelKey:'team.form.responsibility.escalationRules',items:value.escalationRules},
  {key:'deliveryChecks',labelKey:'team.form.responsibility.deliveryChecks',items:value.deliveryChecks},
 ] as const
}
