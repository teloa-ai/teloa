import {businessObjectReference,type BusinessObjectReference,isBusinessMatchField,isBusinessMatchValue} from '@teloa/contract'
import type {WorkbenchView} from './store.js'
import type {BusinessScope} from './business-directory.js'
import type {WorkbenchDetailState,WorkbenchDetailTarget} from './workbench-detail-target.js'

export const WORKBENCH_NAVIGATION_STORAGE_KEY='teloa.workbench-navigation/v1' as const
export const WORKBENCH_NAVIGATION_MAX_BYTES=16*1024
const utf8Bytes=(value:string)=>new TextEncoder().encode(value).byteLength

export type WorkbenchDirectoryId='tasks'|'team'|'resources'|'capabilities'|'market'|'spaces'|'plans'|'projects'
export type WorkbenchDirectoryNavigation={category?:string;query?:string;selectedId?:string;scrollTop?:number}
export type WorkbenchDirectoryPatch={category?:string|undefined;query?:string|undefined;selectedId?:string|undefined;scrollTop?:number|undefined}
export type WorkbenchNavigationState={
 schema:typeof WORKBENCH_NAVIGATION_STORAGE_KEY
 view:WorkbenchView
 messageMode:'directory'|'native'|'groups'
 capabilityMode:'catalog'|'bindings'
 marketMode:'catalog'|'installations'|'industry-resources'
 selected:{taskId?:string;roleId?:string;resourceId?:string;capabilityBindingId?:string;marketItemId?:string;marketIntentId?:string;installationId?:string;businessId?:string;planId?:string}
 directories:Partial<Record<WorkbenchDirectoryId,WorkbenchDirectoryNavigation>>
 detail:WorkbenchDetailState
}

const views:readonly WorkbenchView[]=['home','attention','messages','team','spaces','market','resources','tasks','capabilities','plans','projects','settings']
// projects 目录：category 存业务筛选、query 存状态筛选、scrollTop 复用。
const directoryIds:readonly WorkbenchDirectoryId[]=['tasks','team','resources','capabilities','market','spaces','plans','projects']
const messageModes=['directory','native','groups'] as const
const capabilityModes=['catalog','bindings'] as const
const marketModes=['catalog','installations','industry-resources'] as const
const selectedKeys=['taskId','roleId','resourceId','capabilityBindingId','marketItemId','marketIntentId','installationId','businessId','planId'] as const
const detailKinds=['directory-object','conversation-object','artifact'] as const

export function emptyWorkbenchNavigationState():WorkbenchNavigationState{return {schema:WORKBENCH_NAVIGATION_STORAGE_KEY,view:'home',messageMode:'native',capabilityMode:'catalog',marketMode:'catalog',selected:{},directories:{},detail:{open:false,target:null}}}

const record=(value:unknown,label:string):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error(label+'格式无效。');return value as Record<string,unknown>}
const exact=(value:Record<string,unknown>,allowed:readonly string[],label:string)=>{for(const key of Object.keys(value))if(!allowed.includes(key))throw Error(label+'包含未知字段：'+key)}
const oneOf=<T extends string>(value:unknown,values:readonly T[],label:string):T=>{if(typeof value!=='string'||!values.includes(value as T))throw Error(label+'无效。');return value as T}
const boundedString=(value:unknown,label:string,max=4096):string=>{if(typeof value!=='string'||!value||value.length>max)throw Error(label+'无效。');return value}
const optionalString=(value:unknown,label:string,max=4096):string|undefined=>value===undefined?undefined:boundedString(value,label,max)
const optionalInteger=(value:unknown,label:string):number|undefined=>{if(value===undefined)return undefined;if(!Number.isSafeInteger(value)||Number(value)<0)throw Error(label+'无效。');return Number(value)}

function parseArtifactSource(value:unknown){
 const source=record(value,'成果来源'),kind=oneOf(source.kind,['task','run','session','analysis','object'] as const,'成果来源类型')
 if(kind==='task'||kind==='run'||kind==='session'){exact(source,['kind','id'],'成果来源');return {kind,id:boundedString(source.id,'成果来源编号')}}
 if(kind==='analysis'){exact(source,['kind','id','scope'],'成果来源');return {kind,id:boundedString(source.id,'成果来源编号'),scope:boundedString(source.scope,'成果范围')}}
 exact(source,['kind','id','scope','objectType'],'成果来源')
 return {kind,id:boundedString(source.id,'成果来源编号'),scope:boundedString(source.scope,'成果范围'),objectType:boundedString(source.objectType,'成果对象类型')}
}

const businessSections=['overview','projects','data','work','analysis','execution','dashboards'] as const
type BusinessSection=typeof businessSections[number]
/** 看板标识与声明标识同一判据；只在看板栏目出现。 */
const dashboardIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const dashboardIdOf=(section:BusinessSection,value:unknown):string|undefined=>{
 if(value===undefined||value==='')return undefined
 if(section!=='dashboards'||typeof value!=='string'||!dashboardIdPattern.test(value))throw Error('看板标识无效。')
 return value
}

/** 下钻筛选：只在对象清单（`data` 且有对象类型）出现；字段与取值判据取自契约（与台账入参同一份）。 */
function businessMatchOf(section:BusinessSection,objectType:string|undefined,value:unknown):{field:string;value:string}|undefined{
 if(value===undefined)return undefined
 if(section!=='data'||!objectType)throw Error('对象筛选只用于对象清单。')
 const match=record(value,'对象筛选');exact(match,['field','value'],'对象筛选')
 if(!isBusinessMatchField(match.field))throw Error('对象筛选字段无效。')
 if(!isBusinessMatchValue(match.value))throw Error('对象筛选取值无效。')
 return {field:match.field,value:match.value}
}

function parseBusinessTarget(value:unknown){
 const target=record(value,'业务详情目标')
 exact(target,['scope','section','id','objectType','dashboardId','match','recordReference'],'业务详情目标')
 const scope=businessScope(target.scope)
 const section=oneOf(target.section,businessSections,'业务栏目')
 const id=optionalString(target.id,'业务对象编号'),objectType=optionalString(target.objectType,'业务对象类型'),dashboardId=dashboardIdOf(section,target.dashboardId),match=businessMatchOf(section,objectType,target.match)
 const recordReference=target.recordReference===undefined?undefined:businessObjectReference(target.recordReference)
 if(recordReference&&(section!=='data'||match||dashboardId||recordReference.scope!==scope||recordReference.type!==objectType||recordReference.id!==id))throw Error('记录来源与业务目标不一致。')
 return {scope,section,...(id?{id}:{}),...(objectType?{objectType}:{}),...(dashboardId?{dashboardId}:{}),...(match?{match}:{}),...(recordReference?{recordReference}:{})}
}

// 业务范围已是空间内的标签，取值由宿主登记；这里只核对 1～80 字的标签文本，是否已登记由目录判定。
const businessScope=(value:unknown):BusinessScope=>{
 const scope=boundedString(value,'业务范围',80)
 if(!scope.trim())throw Error('业务范围无效。')
 return scope
}

function parseDetailTarget(value:unknown):WorkbenchDetailTarget|null{
 if(value===null)return null
 const target=record(value,'详情目标')
 // 读不懂的详情类型只丢这一条详情，不作废整份恢复记录：新版本写入的类型在旧版本里认不得是常态，
 // 为此把视图、目录位置、滚动位置一起重置，代价远大于少恢复一个第三栏。
 const kind=detailKinds.find(candidate=>candidate===target.kind)
 if(!kind)return null
 if(kind==='directory-object'){
  exact(target,['kind','view','id','version','source'],'目录详情目标')
  const source=record(target.source,'目录详情来源');exact(source,['kind'],'目录详情来源')
  return {kind,view:oneOf(target.view,['tasks','team','spaces','resources','capabilities','market','plans'] as const,'目录详情模块'),id:boundedString(target.id,'目录详情编号'),...optionalVersion(target.version),source:{kind:oneOf(source.kind,['directory','attention','search'] as const,'目录详情来源')}}
 }
 if(kind==='conversation-object'){
  const objectKind=oneOf(target.objectKind,['task','role','business'] as const,'会话对象类型')
  if(objectKind==='business'){exact(target,['kind','sessionId','objectKind','target'],'会话业务目标');return {kind,sessionId:boundedString(target.sessionId,'会话编号'),objectKind,target:parseBusinessTarget(target.target)}}
  exact(target,['kind','sessionId','objectKind','id','version'],'会话对象目标')
  return {kind,sessionId:boundedString(target.sessionId,'会话编号'),objectKind,id:boundedString(target.id,'对象编号'),...optionalVersion(target.version)}
 }
 exact(target,['kind','source','sessionId','artifactId','version'],'成果详情目标')
 const sessionId=optionalString(target.sessionId,'会话编号'),artifactId=optionalString(target.artifactId,'成果编号'),version=optionalInteger(target.version,'成果版本')
 if(version!==undefined&&!artifactId)throw Error('成果版本缺少成果编号。')
 return {kind,source:parseArtifactSource(target.source),...(sessionId?{sessionId}:{}),...(artifactId?{artifactId,...(version!==undefined?{version}:{})}:{})}
}

function optionalVersion(value:unknown):{version?:number}{const version=optionalInteger(value,'详情版本');return version===undefined?{}:{version}}

export function readWorkbenchNavigationState(raw:string):WorkbenchNavigationState{
 if(utf8Bytes(raw)>WORKBENCH_NAVIGATION_MAX_BYTES)throw Error('工作台恢复记录过大。')
 let parsed:unknown
 try{parsed=JSON.parse(raw)}catch{throw Error('工作台恢复记录损坏。')}
 const root=record(parsed,'工作台恢复记录')
 exact(root,['schema','view','messageMode','capabilityMode','marketMode','selected','directories','detail'],'工作台恢复记录')
 if(root.schema!==WORKBENCH_NAVIGATION_STORAGE_KEY)throw Error('工作台恢复记录版本无效。')
 const selectedRaw=record(root.selected,'选中对象');exact(selectedRaw,selectedKeys,'选中对象')
 const selected:WorkbenchNavigationState['selected']={}
 for(const key of selectedKeys){const value=optionalString(selectedRaw[key],'选中对象');if(value)selected[key]=value}
 const directoriesRaw=record(root.directories,'目录状态');exact(directoriesRaw,directoryIds,'目录状态')
 const directories:WorkbenchNavigationState['directories']={}
 for(const id of directoryIds){if(directoriesRaw[id]===undefined)continue;const item=record(directoriesRaw[id],'目录状态');exact(item,['category','query','selectedId','scrollTop'],'目录状态');directories[id]={...optionalNamedString('category',item.category),...optionalNamedString('query',item.query,1000),...optionalNamedString('selectedId',item.selectedId),...(item.scrollTop===undefined?{}:{scrollTop:optionalInteger(item.scrollTop,'目录滚动位置')!})}}
 const detailRaw=record(root.detail,'详情状态');exact(detailRaw,['open','target'],'详情状态');if(typeof detailRaw.open!=='boolean')throw Error('详情状态无效。')
 const target=parseDetailTarget(detailRaw.target)
 // 记录里写着“开着”却根本没给目标，是自相矛盾的记录，仍然拒绝；目标只是读不懂时退成关闭。
 if(detailRaw.open&&!target&&detailRaw.target===null)throw Error('打开的详情缺少目标。')
 return {schema:WORKBENCH_NAVIGATION_STORAGE_KEY,view:oneOf(root.view,views,'工作台模块'),messageMode:oneOf(root.messageMode,messageModes,'消息模式'),capabilityMode:oneOf(root.capabilityMode,capabilityModes,'能力模式'),marketMode:oneOf(root.marketMode,marketModes,'市场模式'),selected,directories,detail:{open:detailRaw.open&&!!target,target}}
}

function optionalNamedString<K extends string>(key:K,value:unknown,max=4096):{[P in K]?:string}{const result=optionalString(value,key,max);return result===undefined?{}:{[key]:result} as {[P in K]?:string}}

export function writeDirectoryFilterCategory(fields:Readonly<Record<string,string>>):string{return JSON.stringify(fields)}

export function readDirectoryFilterCategory<T extends Record<string,string>>(
 raw:string|undefined,
 defaults:T,
 allowed:Partial<{[K in keyof T]:readonly string[]}>,
):T{
 if(!raw)return {...defaults}
 try{
  const payload=raw.includes('\n')?raw.slice(raw.indexOf('\n')+1):raw
  const parsed=record(JSON.parse(payload),'目录筛选')
  exact(parsed,Object.keys(defaults),'目录筛选')
  const result={...defaults}
  for(const key of Object.keys(defaults) as Array<keyof T>){
   // 旧记录可能没有这个字段（比如后加的 open）：字段缺失只退回这一个键的默认值，不牵连其它键；
   // 字段存在但不合法（越界/含非法字符）仍要整份回退——半份被篡改的记录不能当真。
   if(!Object.hasOwn(parsed,key as string))continue
   // 空串等同「这个键没有记忆」：折叠记忆超界时写入器本来就会给出空串，它不该把同一份 JSON 里的
   // status/kind 一起作废（终审 H1 的真实回归）。只退回这一个键的默认值，篡改值的整份回退不受影响。
   if(parsed[key as string]==='')continue
   const value=boundedString(parsed[key as string],'目录筛选值',240),options=allowed[key]
   if(options&&!options.includes(value))throw Error('目录筛选值越界。')
   result[key]=value as T[keyof T]
  }
  return result
 }catch{return {...defaults}}
}

export function writeWorkbenchNavigationState(state:WorkbenchNavigationState):string{
 const raw=JSON.stringify(state)
 if(utf8Bytes(raw)>WORKBENCH_NAVIGATION_MAX_BYTES)throw Error('工作台恢复记录过大。')
 // 写入前走同一条严格解析，避免未知字段或非法值进入存储。
 readWorkbenchNavigationState(raw)
 return raw
}

export function restoreAvailableTarget(saved:{id?:string|undefined}|undefined,availableIds:readonly string[]):string|undefined{
 return saved?.id&&availableIds.includes(saved.id)?saved.id:availableIds[0]
}

export function reconcileAvailableDirectoryTarget(
 saved:{id?:string|undefined}|undefined,
 availableIds:readonly string[],
 detail:WorkbenchDetailState,
 view:Extract<WorkbenchView,WorkbenchDirectoryId>,
):{id:string|undefined;detail:WorkbenchDetailState}{
 const id=restoreAvailableTarget(saved,availableIds),target=detail.target
 if(target?.kind!=='directory-object'||target.view!==view||availableIds.includes(target.id))return {id,detail}
 return id
  ?{id,detail:{open:detail.open,target:{kind:'directory-object',view,id,source:target.source}}}
  :{id:undefined,detail:{open:false,target:null}}
}

export type WorkbenchNavigationStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>

export function loadWorkbenchNavigationState(storage:WorkbenchNavigationStorage):WorkbenchNavigationState{
 const raw=storage.getItem(WORKBENCH_NAVIGATION_STORAGE_KEY)
 if(raw===null)return emptyWorkbenchNavigationState()
 try{return readWorkbenchNavigationState(raw)}catch{storage.removeItem(WORKBENCH_NAVIGATION_STORAGE_KEY);return emptyWorkbenchNavigationState()}
}

export function persistWorkbenchNavigationState(storage:WorkbenchNavigationStorage,state:WorkbenchNavigationState):void{
 storage.setItem(WORKBENCH_NAVIGATION_STORAGE_KEY,writeWorkbenchNavigationState(state))
}

export function attachWorkbenchNavigationPersistence(
 store:{getSnapshot:()=>WorkbenchNavigationSnapshot;subscribe:(listener:()=>void)=>()=>void},
 storage:WorkbenchNavigationStorage,
):()=>void{
 const persist=()=>{
  try{persistWorkbenchNavigationState(storage,captureWorkbenchNavigationState(store.getSnapshot()))}
  catch(error){storage.removeItem(WORKBENCH_NAVIGATION_STORAGE_KEY);console.warn('[teloa] 工作台恢复记录写入失败：',error instanceof Error?error.message:'未知错误')}
 }
 persist()
 return store.subscribe(persist)
}

type WorkbenchNavigationSnapshot={
 view:WorkbenchView;messageMode:'directory'|'native'|'groups';capabilityMode:'catalog'|'bindings';marketMode:'catalog'|'installations'|'industry-resources'
 taskId:string|null;roleId:string|null;resourceTarget:{id:string}|null;capabilityBindingId:string|null;marketItemId:string|null;marketIntentId:string|null;installationId:string|null
 businessTarget:{recordReference?:BusinessObjectReference;scope:string;section:string;id?:string;objectType?:string;dashboardId?:string;match?:{field:string;value:string}};continuousTarget:{kind:string;id?:string;scope?:string;roleId?:string}
 navigationDirectories:Partial<Record<WorkbenchDirectoryId,WorkbenchDirectoryNavigation>>;detail:WorkbenchDetailState
}

export function captureWorkbenchNavigationState(snapshot:WorkbenchNavigationSnapshot):WorkbenchNavigationState{
 const selected:WorkbenchNavigationState['selected']={}
 const assign=(key:keyof typeof selected,value:string|null|undefined)=>{if(value)selected[key]=value}
 assign('taskId',snapshot.taskId);assign('roleId',snapshot.roleId);assign('resourceId',snapshot.resourceTarget?.id);assign('capabilityBindingId',snapshot.capabilityBindingId);assign('marketItemId',snapshot.marketItemId);assign('marketIntentId',snapshot.marketIntentId);assign('installationId',snapshot.installationId);assign('businessId',snapshot.businessTarget.id);assign('planId',snapshot.continuousTarget.id)
 const directories:WorkbenchNavigationState['directories']={}
 for(const id of directoryIds){
  const source=snapshot.navigationDirectories[id]
  if(!source)continue
  const next:WorkbenchDirectoryNavigation={}
  if(source.category)next.category=source.category
  if(source.query)next.query=source.query
  if(source.selectedId)next.selectedId=source.selectedId
  if(source.scrollTop!==undefined)next.scrollTop=source.scrollTop
  if(Object.keys(next).length)directories[id]=next
 }
 // 第三段按栏目分派：看板栏目存看板标识，其余栏目存对象类型——两者互斥，复用同一段不加列。
 // 对象清单带下钻筛选时再接两段：字段、URI 编码后的取值（取值里的冒号与换行因此不串段）。
 const {match,recordReference}=snapshot.businessTarget
 const businessRoute=[snapshot.businessTarget.scope,snapshot.businessTarget.section,(snapshot.businessTarget.section==='dashboards'?snapshot.businessTarget.dashboardId:snapshot.businessTarget.objectType)??'',...(recordReference?['@record',encodeURIComponent(JSON.stringify(parseBusinessTarget(snapshot.businessTarget).recordReference))]:[]),...(match&&snapshot.businessTarget.section==='data'&&snapshot.businessTarget.objectType?[match.field,encodeURIComponent(match.value)]:[])].join(':'),businessFilter=directories.spaces?.category?.split('\n').at(-1)
 const continuousRoute=[snapshot.continuousTarget.kind,snapshot.continuousTarget.scope??'',snapshot.continuousTarget.roleId??''].join(':'),continuousFilter=directories.plans?.category?.split('\n').at(-1)
 directories.spaces={...directories.spaces,category:businessRoute+(businessFilter&&businessFilter!==businessRoute?'\n'+businessFilter:'')}
 directories.plans={...directories.plans,category:continuousRoute+(continuousFilter&&continuousFilter!==continuousRoute?'\n'+continuousFilter:'')}
 return {schema:WORKBENCH_NAVIGATION_STORAGE_KEY,view:snapshot.view,messageMode:snapshot.messageMode,capabilityMode:snapshot.capabilityMode,marketMode:snapshot.marketMode,selected,directories,detail:snapshot.detail}
}

export function restoredBusinessTarget(saved:WorkbenchNavigationState):{scope:BusinessScope;section:BusinessSection;id?:string;objectType?:string;dashboardId?:string;match?:{field:string;value:string};recordReference?:BusinessObjectReference}|undefined{
 const [rawScope,rawSection,...rest]=saved.directories.spaces?.category?.split('\n')[0]?.split(':')??[]
 try{
  const scope=businessScope(rawScope),section=oneOf(rawSection,businessSections,'业务栏目'),id=saved.selected.businessId
  // 看板标识不含冒号：整段剩余部分一起核对，带冒号或超长即整条作废、回落默认目标。
  if(section==='dashboards'){const dashboardId=dashboardIdOf(section,rest.join(':'));return {scope,section,...(dashboardId?{dashboardId}:{})}}
  const [objectType,field,encoded,...extra]=rest
  if(extra.length||(field!==undefined&&encoded===undefined))throw Error('业务目标路由无效。')
  if(field==='@record')return parseBusinessTarget({scope,section,id,objectType,recordReference:JSON.parse(decodeURIComponent(encoded!))})
  const match=field===undefined?undefined:businessMatchOf(section,objectType,{field,value:decodeURIComponent(encoded!)})
  return {scope,section,...(id?{id}:{}),...(objectType?{objectType}:{}),...(match?{match}:{})}
 }catch{return undefined}
}

export function restoredContinuousTarget(saved:WorkbenchNavigationState):{kind:'plans'|'runs'|'plan'|'run';id?:string;scope?:BusinessScope;roleId?:string}|undefined{
 const [rawKind,rawScope,roleId]=saved.directories.plans?.category?.split('\n')[0]?.split(':')??[]
 try{
  const kind=oneOf(rawKind,['plans','runs','plan','run'] as const,'持续任务目录'),scope=rawScope?businessScope(rawScope):undefined,id=saved.selected.planId
  return {kind,...(id?{id}:{}),...(scope?{scope}:{}),...(roleId?{roleId}:{})}
 }catch{return undefined}
}
