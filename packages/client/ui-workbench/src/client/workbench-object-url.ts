import {emptyWorkbenchNavigationState,readWorkbenchNavigationState,writeWorkbenchNavigationState,type WorkbenchNavigationSnapshot,type WorkbenchNavigationState} from './workbench-navigation-state.js'

const prefix='#teloa/v1/'
const historyKey='teloa.object-history/v1'
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// scope 是既有身份，不要求迁移成 UUID；但本机路径和控制字符不能进入地址。
const scopeId=(value:string)=>!!value.trim()&&value.length<=80&&!/[\x00-\x1f\x7f]/.test(value)&&!/^(?:\/|\\|[a-z]:[\\/]|~[\\/])/i.test(value)
const views=['home','attention','messages','team','spaces','market','resources','tasks','plans','projects','settings'] as const
const sections=['overview','projects','data','work','analysis','execution','dashboards','employees','groups'] as const
export type WorkbenchObjectTarget=
 |{kind:'directory';view:typeof views[number];mode?:'directory'|'native'|'groups'}
 |{kind:'task'|'role'|'project'|'conversation'|'role-preview';id:string}
 |{kind:'business';scope:string;section:typeof sections[number]}
 |{kind:'resource';id:string;version:number;sourceVersion:string}
 |{kind:'artifact';id:string;version:number}
export type WorkbenchObjectRoute={base:WorkbenchObjectTarget;detail?:WorkbenchObjectTarget}
const invalid=()=>Object.assign(Error('工作地址无效。'),{code:'teloa/invalid-input'})

function parts(target:WorkbenchObjectTarget):string[]{
 if(target.kind==='directory'){
  if(!views.includes(target.view)||target.mode!==undefined&&(target.view!=='messages'||!['directory','native','groups'].includes(target.mode)))throw invalid()
  return ['directory',target.view,...(target.mode?[target.mode]:[])]
 }
 if(target.kind==='business'){
  if(!scopeId(target.scope)||!sections.includes(target.section))throw invalid()
  return ['business',encodeURIComponent(target.scope),target.section]
 }
 if(!uuid.test(target.id))throw invalid()
 if(target.kind==='resource'){
  if(!Number.isSafeInteger(target.version)||target.version<1||!/^[a-f0-9]{64}$/i.test(target.sourceVersion))throw invalid()
  return ['resource',target.id,String(target.version),target.sourceVersion]
 }
 if(target.kind==='artifact'){
  if(!Number.isSafeInteger(target.version)||target.version<1)throw invalid()
  return ['artifact',target.id,String(target.version)]
 }
 if(!['task','role','project','conversation','role-preview'].includes(target.kind))throw invalid()
 return [target.kind,target.id]
}
function targetOf(value:string[]):WorkbenchObjectTarget{
 const [kind,id,version,hash]=value
 let target:WorkbenchObjectTarget
 if(kind==='directory'&&(value.length===2||value.length===3))target={kind,view:id as typeof views[number],...(version?{mode:version as 'native'}:{})}
 else if(kind==='business'&&value.length===3){let scope:string;try{scope=decodeURIComponent(id!)}catch{throw invalid()};target={kind,scope,section:version as typeof sections[number]}}
 else if(kind==='resource'&&value.length===4)target={kind,id:id!,version:Number(version),sourceVersion:hash!}
 else if(kind==='artifact'&&value.length===3)target={kind,id:id!,version:Number(version)}
 else if(['task','role','project','conversation','role-preview'].includes(kind!)&&value.length===2)target={kind:kind as 'task',id:id!}
 else throw invalid()
 if(parts(target).join('/')!==value.join('/'))throw invalid()
 return target
}
export function workbenchObjectHash(route:WorkbenchObjectRoute):string{
 if(route.base.kind==='role-preview'||route.detail?.kind==='directory'||route.detail?.kind==='conversation'||route.detail?.kind==='resource')throw invalid()
 return prefix+parts(route.base).join('/')+(route.detail?'/detail/'+parts(route.detail).join('/'):'')
}
/** 非本应用锚点原样留给原生入口、无障碍跳转和插件；自己的未知版本明确失败。 */
export function readWorkbenchObjectHash(hash:string):WorkbenchObjectRoute|undefined{
 if(!hash.startsWith('#teloa/'))return undefined
 if(!hash.startsWith(prefix)||hash.length>768||/[?\\\s]/.test(hash))throw invalid()
 const path=hash.slice(prefix.length).split('/'),at=path.indexOf('detail')
 const route={base:targetOf(at<0?path:path.slice(0,at)),...(at<0?{}:{detail:targetOf(path.slice(at+1))})}
 if(workbenchObjectHash(route)!==hash)throw invalid()
 return route
}
/** 分享只重建白名单读取目标，绝不沿用当前认证 query、用户名或密码。 */
export function workbenchObjectLink(href:string,route:WorkbenchObjectRoute):string{
 const url=new URL(href)
 if(!['http:','https:'].includes(url.protocol))throw invalid()
 url.search='';url.username='';url.password='';url.hash=workbenchObjectHash(route)
 return url.href
}

export type WorkbenchObjectReferences={conversationId?:string;resource?:{id:string;version:number;sourceVersion:string}}
export function describeWorkbenchObject(snapshot:WorkbenchNavigationSnapshot&{rolePreview?:{id:string}|null},refs:WorkbenchObjectReferences):WorkbenchObjectRoute{
 let base:WorkbenchObjectTarget={kind:'directory',view:snapshot.view,...(snapshot.view==='messages'?{mode:snapshot.messageMode}:{})}
 if(snapshot.view==='tasks'&&snapshot.taskId&&uuid.test(snapshot.taskId))base={kind:'task',id:snapshot.taskId}
 else if(snapshot.view==='team'&&snapshot.roleId&&uuid.test(snapshot.roleId))base={kind:'role',id:snapshot.roleId}
 else if(snapshot.view==='messages'&&snapshot.messageMode==='native'&&refs.conversationId)base={kind:'conversation',id:refs.conversationId}
 else if(snapshot.view==='spaces'&&snapshot.navigationDirectories.spaces?.businessHome===false){
  const target=snapshot.businessTarget
  if(target.section==='projects'&&target.id&&uuid.test(target.id))base={kind:'project',id:target.id}
  else if(scopeId(target.scope)&&sections.includes(target.section as typeof sections[number]))base={kind:'business',scope:target.scope,section:target.section as typeof sections[number]}
 }else if(snapshot.view==='resources'&&refs.resource)base={kind:'resource',...refs.resource}
 let detail:WorkbenchObjectTarget|undefined
 const target=snapshot.detail.open?snapshot.detail.target:null
 if(snapshot.rolePreview)detail={kind:'role-preview',id:snapshot.rolePreview.id}
 else if(target?.kind==='artifact'&&target.artifactId&&target.version)detail={kind:'artifact',id:target.artifactId,version:target.version}
 else if(target?.kind==='conversation-object'){
  if(target.objectKind!=='business')detail={kind:target.objectKind,id:target.id}
  else if(target.target.section==='projects'&&target.target.id&&uuid.test(target.target.id))detail={kind:'project',id:target.target.id}
  else if(scopeId(target.target.scope))detail={kind:'business',scope:target.target.scope,section:target.target.section}
 }
 else if(target?.kind==='directory-object'&&(target.view==='tasks'||target.view==='team'))detail={kind:target.view==='tasks'?'task':'role',id:target.id}
 const route={base,...(detail?{detail}:{})};workbenchObjectHash(route);return route
}

/** URL 只覆盖当前目标；查询、滚动与返回位置沿用本人的本地条目。 */
export function navigationForWorkbenchObject(route:WorkbenchObjectRoute,local?:WorkbenchNavigationState):WorkbenchNavigationState{
 const saved=local?readWorkbenchNavigationState(writeWorkbenchNavigationState(local)):emptyWorkbenchNavigationState()
 saved.detail={open:false,target:null}
 const target=route.base
 if(target.kind==='directory'){
  saved.view=target.view
  if(target.view==='messages')saved.messageMode=target.mode??'directory'
  if(target.view==='spaces')saved.directories.spaces={...saved.directories.spaces,businessHome:true}
  if(target.view==='tasks')delete saved.selected.taskId
  if(target.view==='team')delete saved.selected.roleId
  if(target.view==='resources')delete saved.selected.resourceId
  if(target.view in saved.directories){const id=target.view as keyof typeof saved.directories;const {selectedId:_,...rest}=saved.directories[id]??{};saved.directories[id]=rest}
 }
 else if(target.kind==='task'){saved.view='tasks';saved.selected.taskId=target.id;saved.directories.tasks={...saved.directories.tasks,selectedId:target.id}}
 else if(target.kind==='role'){saved.view='team';saved.selected.roleId=target.id;saved.directories.team={...saved.directories.team,selectedId:target.id}}
 else if(target.kind==='resource'){saved.view='resources';saved.selected.resourceId=target.id;saved.directories.resources={...saved.directories.resources,selectedId:target.id}}
 else if(target.kind==='conversation'){saved.view='messages';saved.messageMode='native'}
 else if(target.kind==='project'||target.kind==='business')saved.view='spaces'
 return saved
}

/** 启动地址先决定视图，避免 Home 准备器抢走目标；对象选择仍等本人 API 核验后恢复。 */
export function initialWorkbenchObjectNavigation(local:WorkbenchNavigationState|undefined,hash:string):WorkbenchNavigationState|undefined{
 let route:WorkbenchObjectRoute|undefined
 try{route=readWorkbenchObjectHash(hash)}catch{return local}
 if(!route)return local
 const target=navigationForWorkbenchObject(route),view=route.base.kind==='artifact'?'resources':target.view
 return navigationForWorkbenchObject({base:{kind:'directory',view,...(view==='messages'?{mode:target.messageMode}:{})}},local)
}

type HistoryWindow=Pick<Window,'history'|'location'|'addEventListener'|'removeEventListener'>
type HistoryPorts={
 window:HistoryWindow;scope:string
 capture:()=>WorkbenchNavigationState
 describe:()=>Promise<WorkbenchObjectRoute>
 restore:(route:WorkbenchObjectRoute,local:WorkbenchNavigationState|undefined,current:()=>boolean,signal?:AbortSignal)=>Promise<void>
 published?:(route:WorkbenchObjectRoute)=>void
 error:(error:unknown)=>void
}
/** 不增加哨兵条目，不拦截离站 Back；history.state 只接受同一本人/安装范围。 */
export function attachWorkbenchObjectHistory(ports:HistoryPorts){
 const {window:win}=ports
 let live=true,epoch=0,pending=false,unresolved=false,revision:number|undefined,conversation:string|undefined,lastLocation='',last=ports.capture()
 let restoration:AbortController|undefined
 const cancelRestoration=()=>{restoration?.abort();restoration=undefined}
 const positions=new Map<string,string>()
 const entry=()=>win.history.state&&typeof win.history.state==='object'&&!Array.isArray(win.history.state)?win.history.state as Record<string,unknown>:{}
 const locationKey=()=>win.location.href+'\n'+JSON.stringify(entry()[historyKey]??null)
 const remember=(snapshot:WorkbenchNavigationState)=>{
  const value=entry()[historyKey] as {scope?:unknown;id?:unknown}|undefined
  if(value?.scope===ports.scope&&typeof value.id==='string')positions.set(value.id,writeWorkbenchNavigationState(snapshot))
 }
 const save=(snapshot:WorkbenchNavigationState)=>{
  if(!win.location.hash.startsWith(prefix))return
  const previous=entry()[historyKey] as {scope?:unknown;id?:unknown;snapshot?:unknown;hash?:unknown}|undefined
  const value={scope:ports.scope,id:previous?.scope===ports.scope&&typeof previous.id==='string'?previous.id:crypto.randomUUID(),hash:win.location.hash,snapshot:writeWorkbenchNavigationState(snapshot)}
  positions.set(value.id,value.snapshot)
  if(previous?.scope===value.scope&&previous.hash===value.hash&&previous.snapshot===value.snapshot)return
  win.history.replaceState({...entry(),[historyKey]:value},'')
 }
 const restore=()=>{
  const address=win.location.href,key=locationKey()
  if(key===lastLocation)return
  lastLocation=key
  cancelRestoration()
  const controller=new AbortController();restoration=controller
  const request=++epoch;pending=true;unresolved=true
  const current=()=>live&&request===epoch&&win.location.href===address
  void (async()=>{
   const route=readWorkbenchObjectHash(win.location.hash)
   if(!route){unresolved=false;return}
   const value=entry()[historyKey] as {scope?:unknown;id?:unknown;hash?:unknown;snapshot?:unknown}|undefined
   let local:WorkbenchNavigationState|undefined
   if(value?.scope===ports.scope&&value.hash===win.location.hash&&typeof value.snapshot==='string')try{local=readWorkbenchNavigationState(typeof value.id==='string'?positions.get(value.id)??value.snapshot:value.snapshot)}catch{/* 损坏本地位置不影响通过正常 API 读取目标。 */}
   await ports.restore(route,local,current,controller.signal)
   if(current()){unresolved=false;last=ports.capture();save(last);lastLocation=locationKey()}
  })().catch(error=>{if(current())ports.error(error)}).finally(()=>{if(current())pending=false})
 }
 const pagehide=()=>{if(!pending)save(ports.capture())}
 win.addEventListener('popstate',restore);win.addEventListener('hashchange',restore);win.addEventListener('pagehide',pagehide)
 const initialHash=win.location.hash
 if(initialHash.startsWith('#teloa/'))restore()
 else if(!initialHash){
  const request=epoch
  void ports.describe().then(route=>{if(live&&request===epoch&&!win.location.hash){win.history.replaceState(win.history.state,'',workbenchObjectHash(route));ports.published?.(route);save(last);lastLocation=locationKey()}}).catch(error=>{if(live&&request===epoch)ports.error(error)})
 }
 return {
  observe(nextRevision:number,nextConversation:string|undefined){
   const snapshot=ports.capture(),previous=last;last=snapshot
   if(revision===undefined){revision=nextRevision;conversation=nextConversation;return}
   const explicit=revision!==nextRevision,switched=nextConversation!==undefined&&conversation!==undefined&&conversation!==nextConversation
   const settled=nextConversation!==undefined&&conversation===undefined
   revision=nextRevision;conversation=nextConversation??conversation
   if((pending||unresolved)&&!explicit)return
   // 每次输入只更新当前条目的本地位置，避免 WebKit 的 history 写入频率限制。
   if(!explicit&&!switched&&!settled){remember(snapshot);return}
   cancelRestoration();unresolved=false
   const request=++epoch;pending=true
   save(previous)
   void ports.describe().then(route=>{
    if(!live||request!==epoch)return
    const hash=workbenchObjectHash(route)
    if(hash!==win.location.hash){
     if(settled&&!explicit&&!switched){if(!win.location.hash||win.location.hash.startsWith(prefix))win.history.replaceState(win.history.state,'',hash)}
     else win.history.pushState({...entry(),[historyKey]:undefined},'',hash)
    }
    if(win.location.hash!==hash)return
    ports.published?.(route)
    save(ports.capture())
    // 去重只覆盖当前条目的成对浏览器事件；离开后返回旧条目必须启动新的恢复 epoch。
    lastLocation=locationKey()
   }).catch(error=>{if(live&&request===epoch)ports.error(error)}).finally(()=>{if(live&&request===epoch)pending=false})
  },
  retry(){lastLocation='';restore()},
  dispose(){live=false;epoch++;cancelRestoration();win.removeEventListener('popstate',restore);win.removeEventListener('hashchange',restore);win.removeEventListener('pagehide',pagehide)},
 }
}
