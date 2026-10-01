import type {BusinessScopeLabel,BusinessScopeKind} from './business-directory.js'

type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>

const labelKeys=['scope','title','kind','loads','activeLoads','tasks','groups'] as const
const labelAllowed=[...labelKeys,'sourceNoun'] as const
const kinds:readonly BusinessScopeKind[]=['builtin','domain','legacy']
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=2147483647
const exact=(value:unknown,keys:readonly string[])=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error()
 return value as Record<string,unknown>
}

/** 严格读取：键集必须完全一致，`kind` 只接受三种登记来源，计数必须是非负整数；标题上限与契约、宿主同为 80 字。 */
export function readBusinessScopeLabel(value:unknown):BusinessScopeLabel{
 try{
  const row=exact(value,labelAllowed)
  if(labelKeys.some(key=>!Object.hasOwn(row,key)))throw Error()
  if(!text(row.scope,80)||!text(row.title,80)||!kinds.includes(row.kind as BusinessScopeKind))throw Error()
  if(!count(row.loads)||!count(row.activeLoads)||!count(row.tasks)||!count(row.groups))throw Error()
  const hasSourceNoun=Object.hasOwn(row,'sourceNoun')
  if(hasSourceNoun&&(!text(row.sourceNoun,12)||row.sourceNoun!==row.sourceNoun.trim()||/[\x00-\x1f\x7f]/.test(row.sourceNoun)))throw Error()
  if(Number(row.activeLoads)>Number(row.loads))throw Error()
  return {scope:row.scope,title:row.title,kind:row.kind as BusinessScopeKind,loads:row.loads,activeLoads:row.activeLoads,tasks:row.tasks,groups:row.groups,...(hasSourceNoun?{sourceNoun:row.sourceNoun as string}:{})}
 }catch{throw Error('业务范围标签格式不正确。')}
}

/** 目录只接受 `{items}` 这一个信封；标签重复即视为宿主回包不可信。 */
export function readBusinessScopeList(value:unknown):BusinessScopeLabel[]{
 let envelope:Record<string,unknown>
 try{envelope=exact(value,['items']);if(!Array.isArray(envelope.items)||envelope.items.length>500)throw Error()}catch{throw Error('业务范围目录格式不正确。')}
 const items=envelope.items.map(readBusinessScopeLabel)
 if(new Set(items.map(item=>item.scope)).size!==items.length)throw Error('业务范围目录标签重复。')
 return items
}

export function createBusinessScopeApi(call:Call){
 return {async list(signal?:AbortSignal):Promise<BusinessScopeLabel[]>{return readBusinessScopeList(await call('business-scopes/list',{},signal))}}
}

export type BusinessScopeApi=ReturnType<typeof createBusinessScopeApi>
export type {BusinessScopeLabel}
