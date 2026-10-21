import {isRecord,readTaskCompletionPolicy} from '@teloa/contract'
import type {PlanFields} from './continuous-preview.ts'
import type {PlanTemplate} from './plan-template.ts'
import type {PlanSource} from './plan-api.ts'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.ts'

export type PlanFormDraft={id:string;revision?:number;fields:PlanFields;template?:PlanTemplate;source?:PlanSource;description?:string}
export type ContinuousDraftStorage={namespace:string;storage:WorkbenchNavigationStorage}
type Snapshot={forms:Record<string,PlanFormDraft>;goals:Record<string,string>;warning?:'read'|'write'}
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const exact=(v:unknown,required:string[],optional:string[]=[])=>{if(!isRecord(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))throw Error('Invalid plan draft');return v}
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):isRecord(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
/** 固定来源与修订是恢复身份；可编辑字段不能用来改变原计划、模板或授权。 */
const basis=(d:PlanFormDraft)=>JSON.stringify(canonical({id:d.revision===undefined?null:d.id,revision:d.revision??null,scope:d.revision===undefined?null:d.fields.scope,roleId:d.revision===undefined?null:d.fields.roleId,template:d.template?.key??null,source:d.source??null}))
function fields(value:unknown):PlanFields{
 const row=exact(value,['title','scope','goal','dataScope','delivery','roleId','trigger'],['notificationPolicy','completionPolicy','groupId'])
 if(!text(row.title,120)||!text(row.scope,120)||!row.scope.trim()||!text(row.goal,8000)||!text(row.dataScope,8000)||!text(row.delivery,8000)||!text(row.roleId,120)||row.notificationPolicy!==undefined&&(typeof row.notificationPolicy!=='string'||!['','always','attention','failure','silent'].includes(row.notificationPolicy))||row.groupId!==undefined&&row.groupId!==null&&!text(row.groupId,120))throw Error('Invalid plan draft fields')
 const trigger=isRecord(row.trigger)&&row.trigger.kind==='event'?exact(row.trigger,['kind','source','event']):exact(row.trigger,['kind','cadence','weekday','time','timezone'])
 if(trigger.kind==='event'){if(!text(trigger.source,200)||!text(trigger.event,200))throw Error('Invalid event draft')}
 else if(trigger.kind!=='schedule'||typeof trigger.cadence!=='string'||!['daily','weekly'].includes(trigger.cadence)||!Number.isInteger(trigger.weekday)||Number(trigger.weekday)<1||Number(trigger.weekday)>7||!text(trigger.time,80)||!text(trigger.timezone,80))throw Error('Invalid schedule draft')
 if(row.completionPolicy!==undefined)readTaskCompletionPolicy(row.completionPolicy)
 return structuredClone(row) as PlanFields
}

/** 本人 namespace 内的入口草稿。只恢复输入，不调用计划服务；写失败保留当前内存输入。 */
export function createContinuousFormJournal(input?:ContinuousDraftStorage){
 if(input&&(!text(input.namespace,1024)||!input.namespace.trim()||/[\u0000-\u001f\u007f]/.test(input.namespace)))throw Error('Plan draft namespace is unavailable')
 let snapshot:Snapshot={forms:{},goals:{}}
 const listeners=new Set<()=>void>(),warnings=new Map<string,'read'|'write'>(),blocked=new Set<string>(),loadedGoals=new Set<string>()
 const key=(entry:string,identity:string)=>'teloa.continuous-input/v1/'+encodeURIComponent(input?.namespace??'')+'/'+encodeURIComponent(entry)+'/'+encodeURIComponent(identity)
 const publish=(next:Omit<Snapshot,'warning'>)=>{snapshot={...next,...(warnings.size?{warning:[...warnings.values()].includes('read')?'read':'write'}:{})};for(const listener of listeners)listener()}
 const write=(entry:string,value:string|null)=>{
  if(!input||blocked.has(entry))return
  try{if(value===null)input.storage.removeItem(entry);else input.storage.setItem(entry,value);warnings.delete(entry)}catch{warnings.set(entry,'write')}
 }
 const restore=(entry:string,initial:PlanFormDraft):PlanFormDraft=>{
  if(!input)return initial
  const identity=basis(initial),storageKey=key(entry,identity)
  try{
   const raw=input.storage.getItem(storageKey);if(raw===null)return initial
   if(raw.length>256_000)throw Error()
   const row=exact(JSON.parse(raw),['schema','namespace','entry','basis','id','fields'],['revision','description'])
   if(row.schema!=='teloa.continuous-form/v1'||row.namespace!==input.namespace||row.entry!==entry||row.basis!==identity||!uuid(row.id)||row.revision!==undefined&&(!Number.isSafeInteger(row.revision)||Number(row.revision)<1)||row.revision!==initial.revision||row.description!==undefined&&!text(row.description,8000))throw Error()
   const restored={...initial,id:row.id,fields:fields(row.fields),...(row.description===undefined?{}:{description:row.description as string})}
   if(basis(restored)!==identity)throw Error()
   return restored
  }catch{warnings.set(storageKey,'read');blocked.add(storageKey);return initial}
 }
 return {
  getSnapshot:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
  setForms(change:(forms:Record<string,PlanFormDraft>)=>Record<string,PlanFormDraft>){
   const before=snapshot.forms,next={...change(before)}
   for(const [entry,draft] of Object.entries(next)){
    if(before[entry]===draft)continue
    const value=before[entry]?draft:restore(entry,draft);next[entry]=value
    const identity=basis(value)
    write(key(entry,identity),JSON.stringify({schema:'teloa.continuous-form/v1',namespace:input?.namespace,entry,basis:identity,id:value.id,fields:value.fields,...(value.revision===undefined?{}:{revision:value.revision}),...(value.description===undefined?{}:{description:value.description})}))
   }
   for(const [entry,draft] of Object.entries(before))if(!Object.hasOwn(next,entry))write(key(entry,basis(draft)),null)
   publish({forms:next,goals:snapshot.goals})
  },
  loadGoal(entry:string){
   if(loadedGoals.has(entry))return;loadedGoals.add(entry)
   if(!input)return
   const storageKey=key('goal:'+entry,'manual')
   try{const raw=input.storage.getItem(storageKey);if(raw===null)return;if(raw.length>40_000)throw Error();const row=exact(JSON.parse(raw),['schema','namespace','entry','goal']);if(row.schema!=='teloa.continuous-goal/v1'||row.namespace!==input.namespace||row.entry!==entry||!text(row.goal,8000))throw Error();publish({forms:snapshot.forms,goals:{...snapshot.goals,[entry]:row.goal}})}catch{warnings.set(storageKey,'read');blocked.add(storageKey);publish(snapshot)}
  },
  setGoal(entry:string,goal:string){
   write(key('goal:'+entry,'manual'),goal?JSON.stringify({schema:'teloa.continuous-goal/v1',namespace:input?.namespace,entry,goal}):null)
   publish({forms:snapshot.forms,goals:{...snapshot.goals,[entry]:goal}})
  },
 }
}
