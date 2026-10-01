import {readModelOptionsDirectory,type ModelOptionsDirectory} from '@teloa/contract'

export type RuntimeConfigItem={
 id:string
 label:string
 default:boolean
 health:'ready'|'unavailable'
 description?:string
 reason?:string
}

export type RuntimeConfigDirectory={
 status:'ready'
 /** DSH 对未指定运行配置的新会话是否展示选择器；岗位只读取该事实，不写宿主设置。 */
 modeSelectionEnabled:boolean
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
 // rc1 目录直接返回声明元数据与选择器策略，不再提供旧目录扫描的 trust/authorable。
 if(Object.keys(roster).some(key=>key!=='presets'&&key!=='modeSelectionEnabled')||!Array.isArray(roster.presets)||typeof roster.modeSelectionEnabled!=='boolean')throw Error('运行配置目录格式不正确。')
 const items=roster.presets.map(row).map(item=>({
  id:item.id,label:item.name??item.id,default:item.isDefault,
  health:item.broken===undefined&&item.id!=='cordis'?'ready' as const:'unavailable' as const,
  ...(item.description===undefined?{}:{description:item.description}),
  ...(item.id==='cordis'?{reason:'创造模式仅供本人会话使用，不能用于员工运行。'}:item.broken===undefined?{}:{reason:item.broken}),
 }))
 if(new Set(items.map(item=>item.id)).size!==items.length||items.filter(item=>item.default).length>1)throw Error('运行配置目录格式不正确。')
 return {status:'ready',modeSelectionEnabled:roster.modeSelectionEnabled,items}
}

/** 将 DSH 原生 agentPresets/list 约束在 UI 边界，避免引入业务侧副本。 */
export function createRoleRuntimeConfigApi(read:()=>Promise<unknown>,models?:()=>Promise<unknown>):RoleRuntimeConfigApi{
 return {list:async()=>readRuntimeConfigDirectory(await read()),...(models?{models:async()=>readModelOptionsDirectory(await models())}:{})}
}

/** 每次读取都是新快照；失败不能沿用旧目录把固定配置误报为可用。 */
export const runtimeConfigLoading=():RuntimeConfigLoadState=>({status:'loading'})
export const runtimeConfigReady=(directory:RuntimeConfigDirectory):RuntimeConfigLoadState=>({status:'ready',directory})
export const runtimeConfigFailed=(error:unknown):RuntimeConfigLoadState=>({status:'error',error:error instanceof Error&&error.message?error.message:'运行配置目录暂不可用。'})

export function runtimeConfigSummary(agentPresetId:string|undefined,directory?:RuntimeConfigDirectory){
 if(!agentPresetId)return {label:'继承当前默认，未固定',detail:'新执行会在创建时核对当前默认运行配置；本人选择创造模式时，员工使用 Teloa 标准模式。当前员工不会自动写回。',health:'inherited' as const}
 if(!directory)return {label:'运行配置待核对',detail:'尚未读取 DSH 原生运行配置目录，不能确认新的无人值守工作。',health:'unavailable' as const}
 const item=directory.items.find(candidate=>candidate.id===agentPresetId)
 if(!item)return {label:'运行配置待核对',detail:'已保存的运行配置不在当前 DSH 目录中，不能用于新的无人值守工作。',health:'unavailable' as const}
 if(item.health==='unavailable')return {label:item.label,detail:item.reason??'运行配置当前不可组合。',health:'unavailable' as const}
 return {label:item.label,detail:item.description??'DSH 已确认可组合；执行时仍会核对资料、技能与工具授权。',health:'ready' as const}
}

export function runtimeConfigOptions(agentPresetId:string|undefined,directory:RuntimeConfigDirectory){
 const missing=agentPresetId&&!directory.items.some(item=>item.id===agentPresetId)?[{id:agentPresetId,label:`已保存：${agentPresetId} · 当前不存在`,disabled:true}]:[]
 return [
  {id:'',label:'继承当前默认（不固定）',disabled:false},
  ...missing,
  ...directory.items.map(item=>({id:item.id,label:item.label+(item.default?' · 当前默认':'')+(item.health==='unavailable'?' · 不可用':''),disabled:item.health!=='ready'})),
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
