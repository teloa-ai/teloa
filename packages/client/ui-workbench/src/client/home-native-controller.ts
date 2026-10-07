type Storage={getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
type HomePort={storage:Storage;identity:()=>string;isBlank:(id:string)=>boolean|undefined|Promise<boolean|undefined>;create:(id:string)=>Promise<string>;refresh?:()=>Promise<void>}
const draftKey='teloa.home-native-session/v1'
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

/** 原生会话身份不等于业务请求 UUID；冷恢复和未知回包重试必须复用同一领养请求。 */
export function homeNativeAdoptionRequestId(storage:Storage,sessionId:string,identity:()=>string=()=>crypto.randomUUID()):string{
 if(uuid.test(sessionId))return sessionId
 const key='teloa.home-native-adoption/'+sessionId,saved=storage.getItem(key)
 if(saved!==null){if(!uuid.test(saved))throw Error('待用会话接入记录无法核对。');return saved}
 const requestId=identity()
 if(!uuid.test(requestId))throw Error('待用会话接入身份不正确。')
 storage.setItem(key,requestId)
 return requestId
}

/** 这里只持久保存待用会话身份；正文、引用和附件始终归官方输入所有。 */
export class HomeNativeController{
 private readonly port:HomePort
 private pending:Promise<string>|undefined
 private ready:string|undefined
 constructor(port:HomePort){this.port=port}
 owns(sessionId:string){return this.ready===sessionId&&this.port.storage.getItem(draftKey)===sessionId}
 /** 只退役已经有真实用户回执的待用身份；迟到回执不能清掉新草稿。 */
 accept(sessionId:string){if(this.port.storage.getItem(draftKey)!==sessionId)return;this.port.storage.removeItem(draftKey);if(this.ready===sessionId)this.ready=undefined}
 /** 只认领真实核空且仍是当前作用域的初始会话，不创建、复制或改写原生输入。 */
 async claimPrepared(sessionId:string,assertCurrent:()=>void,explicit=false):Promise<boolean>{
  if(this.pending)return false
  const previous=this.port.storage.getItem(draftKey)
  assertCurrent()
  if(previous&&previous!==sessionId&&!explicit)return false
  const blank=await this.port.isBlank(sessionId)
  assertCurrent()
  if(this.pending||this.port.storage.getItem(draftKey)!==previous)throw Error('待用会话身份已变化，请重试。')
  if(blank!==true)return false
  this.port.storage.setItem(draftKey,sessionId);this.ready=sessionId
  return true
 }
 prepare():Promise<string>{
  if(this.pending)return this.pending
  const operation=(async()=>{
   await this.port.refresh?.()
   for(;;){
    let id=this.port.storage.getItem(draftKey)
    const before=id?await this.port.isBlank(id):undefined
    if(id&&before===false){this.accept(id);id=null}
    if(!id){id=this.port.identity();this.port.storage.setItem(draftKey,id);this.ready=undefined}
    if(this.ready===id){if(before!==true)throw Error('待用会话历史尚未核对，请重试。');return id}
    const actual=await this.port.create(id)
    if(actual!==id)throw Error('待用会话身份不一致，已停止接入。')
    // 创建也可能是在恢复已存在的相同身份；消息加载前不能把它开放为新草稿。
    const blank=await this.port.isBlank(actual)
    if(blank===false){this.accept(actual);continue}
    if(blank!==true)throw Error('待用会话历史尚未核对，请重试。')
    this.ready=actual;return actual
   }
  })()
  this.pending=operation
  void operation.then(()=>{this.pending=undefined},()=>{this.pending=undefined})
  return operation
 }
}

export type HomeWorkContext={sessionId:string;scopeId:string;roleId:string|null;version:number;locked:boolean}
export type HomeContextInput=Omit<HomeWorkContext,'version'|'locked'>&{expectedVersion:number}
type PendingContext=HomeContextInput&{requestId:string}
const contextKey='teloa.home-work-context/v1'
const parseContext=(value:unknown,sessionId:string):HomeWorkContext=>{
 if(!value||typeof value!=='object')throw Error('工作上下文返回格式不正确。')
 const row=value as HomeWorkContext
 if(row.sessionId!==sessionId)throw Error('工作上下文身份不一致。')
 if(typeof row.scopeId!=='string'||!row.scopeId||row.roleId!==null&&typeof row.roleId!=='string'||!Number.isSafeInteger(row.version)||row.version<1||typeof row.locked!=='boolean')throw Error('工作上下文返回格式不正确。')
 return {sessionId:row.sessionId,scopeId:row.scopeId,roleId:row.roleId,version:row.version,locked:row.locked}
}
export function createHomeContextApi(call:(endpoint:string,payload:unknown)=>Promise<unknown>,storage:Storage,identity:()=>string=()=>crypto.randomUUID()){
 let pending:PendingContext|undefined
 let writing:Promise<HomeWorkContext>|undefined
 let recoveryError:Error|undefined
 const reload=()=>{
  if(writing)return pending
  pending=undefined
  recoveryError=undefined
  try{const saved=storage.getItem(contextKey)
  if(saved){const row=JSON.parse(saved) as PendingContext;if(typeof row.requestId!=='string'||typeof row.sessionId!=='string'||typeof row.scopeId!=='string'||row.roleId!==null&&typeof row.roleId!=='string'||!Number.isSafeInteger(row.expectedVersion)||row.expectedVersion<0)throw Error('业务设置恢复记录格式不正确。');pending=row}}catch{recoveryError=Error('业务设置恢复记录无法读取，请恢复浏览器存储后重试。')}
  return pending
 }
 const clear=(requestId:string)=>{
  const saved=storage.getItem(contextKey)
  if(saved&&(JSON.parse(saved) as PendingContext).requestId===requestId)storage.removeItem(contextKey)
  if(pending?.requestId===requestId)pending=undefined
 }
 reload()
 const read=async(sessionId:string)=>{
  reload();if(recoveryError)throw recoveryError
  const value=await call('work-context/read',{sessionId}),row=value===null?null:parseContext(value,sessionId)
  reload()
  if(row&&pending&&pending.sessionId===sessionId&&row.version===pending.expectedVersion+1&&row.scopeId===pending.scopeId&&row.roleId===pending.roleId)clear(pending.requestId)
  return row
 }
 const set=(input:HomeContextInput):Promise<HomeWorkContext>=>{
  reload();if(recoveryError)return Promise.reject(recoveryError)
  if(pending&&(['sessionId','scopeId','roleId','expectedVersion'] as const).some(key=>pending![key]!==input[key]))return Promise.reject(Error('上次业务设置仍待核对，请先重试原设置，不能改投其他会话或业务。'))
  if(writing)return writing
  const request=pending??{...input,requestId:identity()};pending=request
  storage.setItem(contextKey,JSON.stringify(request))
  const operation=call('work-context/set',request).then(value=>{
   const row=parseContext(value,input.sessionId)
   if(row.scopeId!==input.scopeId||row.roleId!==input.roleId)throw Error('工作上下文回执与原设置不一致。')
   clear(request.requestId);return row
  }).catch(error=>{
   // 后端确认这些错误在事务写入前拒绝；网络或宿主未知错误仍保留原身份。
   if(error&&typeof error==='object'&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(error.code)))clear(request.requestId)
   throw error
  })
  writing=operation;void operation.then(()=>{writing=undefined},()=>{writing=undefined})
  return operation
 }
 return {read,set,pending:reload,retry:()=>{const request=reload();return request?set(request):Promise.reject(Error('没有待核对的业务设置。'))},subscribe:(listener:()=>void)=>{if(typeof window==='undefined')return()=>{};const changed=(event:StorageEvent)=>{if(event.key===contextKey)listener()};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed)}}
}
export type HomeContextApi=ReturnType<typeof createHomeContextApi>
