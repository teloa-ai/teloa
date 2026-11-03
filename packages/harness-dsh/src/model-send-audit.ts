import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash,randomUUID} from 'node:crypto'
import {lstat,mkdir,open,readFile,readdir,realpath} from 'node:fs/promises'
import {isAbsolute,join,resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm'
import {WorkError} from '@teloa/contract'
import type {LaunchEnv} from './launch-env.ts'

export type ModelSendAuditBinding=Readonly<{schema:'teloa.model-send-audit/v1';ownerId:string;groupId:string;roleId:string;ownerRequestId:string;provider:'minimax';model:string;reasoningEffort:string;outputDirectory:string}>
/** 仅由宿主正式只读 Run/source 复验提供；不能从模型消息或会话名称推断。 */
export type ModelSendAuditRun=Readonly<{ownerId:string;groupId:string;roleId:string;ownerRequestId:string;provider:string;model:string;reasoningEffort:string;runId:string;sessionId:string;nativeRequestId:string}>
type ImageDigest=Readonly<{mime:string;decodedBytes:number;sha256:string}>
export type ModelSendAuditEvent=Readonly<{phase:'send'|'response'|'no-response'|'stream-complete'|'stream-rejected';bindingSha256:string;auditStreamId:string;httpAttemptId:string;runId:string;sessionId:string;nativeRequestId:string;at:string;images?:readonly ImageDigest[];status?:number;noResponseCategory?:'aborted'|'transport-error'}>
type Resolver=(sessionId:string,binding:ModelSendAuditBinding)=>Promise<ModelSendAuditRun|null>
type Ports={resolve:Resolver;write:(event:ModelSendAuditEvent)=>Promise<void>;read?:()=>Promise<readonly ModelSendAuditEvent[]>;bindingSha256?:string;pin?:(run:ModelSendAuditRun)=>Promise<void>}
type Scope={run:ModelSendAuditRun;auditStreamId:string;active:boolean;finishedGood:boolean;sealed:boolean}
export type ModelSendAudit=ReturnType<typeof createModelSendAudit>
declare module '@deepseek-ai/cordis'{interface Context{teloaModelSendAudit:ModelSendAudit}}
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const invalid=()=>new WorkError('teloa/invalid-input','模型发送审计配置或图像载体无效。')
const denied=()=>new WorkError('teloa/conflict','模型发送审计的原运行身份已变化，本次未发送。')
const unavailable=()=>new WorkError('teloa/storage-unavailable','模型发送前的审计证据未保存，本次未发送。')
const unknown=()=>new WorkError('teloa/execution-pending','模型发送已尝试但回执未完整保存，请核对原请求，不要重新发送。')
const row=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>}
const token=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\s\x00-\x1f\x7f]/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const bindingKeys=['schema','ownerId','groupId','roleId','ownerRequestId','provider','model','reasoningEffort','outputDirectory'] as const
const runKeys=['ownerId','groupId','roleId','ownerRequestId','provider','model','reasoningEffort','runId','sessionId','nativeRequestId'] as const

export function readModelSendAuditBinding(value:unknown):ModelSendAuditBinding{
 const data=row(value)
 if(Object.keys(data).length!==bindingKeys.length||Object.keys(data).some(key=>!bindingKeys.includes(key as typeof bindingKeys[number]))||data.schema!=='teloa.model-send-audit/v1'||data.provider!=='minimax'||!token(data.ownerId)||!uuid(data.groupId)||!uuid(data.roleId)||!uuid(data.ownerRequestId)||!token(data.model)||!token(data.reasoningEffort)||typeof data.outputDirectory!=='string'||!isAbsolute(data.outputDirectory)||resolve(data.outputDirectory)!==data.outputDirectory)throw invalid()
 return Object.freeze({schema:data.schema,ownerId:data.ownerId,groupId:data.groupId,roleId:data.roleId,ownerRequestId:data.ownerRequestId,provider:data.provider,model:data.model,reasoningEffort:data.reasoningEffort,outputDirectory:data.outputDirectory})
}
const same=(a:ModelSendAuditRun,b:ModelSendAuditRun)=>runKeys.every(key=>a[key]===b[key])
const matches=(run:ModelSendAuditRun,binding:ModelSendAuditBinding)=>['ownerId','groupId','roleId','ownerRequestId','provider','model','reasoningEffort'].every(key=>Reflect.get(run,key)===Reflect.get(binding,key))
function checkedRun(value:ModelSendAuditRun):ModelSendAuditRun{
 if(!uuid(value.runId)||!uuid(value.nativeRequestId)||!token(value.sessionId))throw denied()
 return Object.freeze(Object.fromEntries(runKeys.map(key=>[key,value[key]]))) as ModelSendAuditRun
}

/** 只解析已序列化的实际 Anthropic JSON；绝不返回或保存文本、base64、headers。 */
function imageDigests(input:RequestInfo|URL,init:RequestInit|undefined,model:string):readonly ImageDigest[]{
 if(typeof input!=='string'&&!(input instanceof URL))throw invalid()
 const url=new URL(input)
 const query=[...url.searchParams]
 if(url.origin!=='https://api.minimax.io'||url.pathname!=='/anthropic/v1/messages'||query.length>1||query.some(([key,value])=>key!=='beta'||value!=='true')||init?.method?.toUpperCase()!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>64*1024*1024)throw invalid()
 let data:Record<string,unknown>;try{data=row(JSON.parse(init.body))}catch{throw invalid()}
 if(data.model!==model||!Array.isArray(data.messages))throw invalid()
 const images:ImageDigest[]=[]
 const visit=(content:unknown):void=>{
  if(!Array.isArray(content))return
  for(const value of content){
   const block=row(value)
   if(block.type==='tool_result'){visit(block.content);continue}
   if(block.type!=='image')continue
   const source=row(block.source)
   if(source.type!=='base64'||!['image/png','image/jpeg','image/gif','image/webp'].includes(String(source.media_type))||typeof source.data!=='string'||!source.data||source.data.length>24*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data))throw invalid()
   const bytes=Buffer.from(source.data,'base64')
   if(!bytes.length||bytes.toString('base64')!==source.data||images.length>=8)throw invalid()
   images.push(Object.freeze({mime:source.media_type as string,decodedBytes:bytes.length,sha256:hash(bytes)}))
  }
 }
 for(const message of data.messages)visit(row(message).content)
 if(!images.length)throw invalid()
 return Object.freeze(images)
}

export function createModelSendAudit(input:ModelSendAuditBinding,ports:Ports){
 const binding=readModelSendAuditBinding(input),storage=new AsyncLocalStorage<Scope>(),bindingSha256=ports.bindingSha256??hash(JSON.stringify(binding)),journal:ModelSendAuditEvent[]=[]
 let fixed:ModelSendAuditRun|undefined,closed=false,inSend=false,poisoned=false
 // 这些状态明确拒绝了模型请求；其余非2xx不推断远端是否已受理。
 const rejected=(status:number|undefined)=>status!==undefined&&[400,401,402,403,404,405,406,413,415,422,429].includes(status)
 const accepted=(status:number|undefined)=>status!==undefined&&status>=200&&status<300
 async function records():Promise<readonly ModelSendAuditEvent[]>{
  let saved:readonly ModelSendAuditEvent[];try{saved=await ports.read?.()??[]}catch{throw unknown()}
  const merged=new Map<string,ModelSendAuditEvent>()
  for(const event of [...saved,...journal]){
   if(event.bindingSha256!==bindingSha256||!fixed||event.runId!==fixed.runId||event.nativeRequestId!==fixed.nativeRequestId||event.sessionId!==fixed.sessionId)throw unknown()
   const key=event.httpAttemptId+':'+event.phase,prior=merged.get(key)
   if(prior&&JSON.stringify(prior)!==JSON.stringify(event))throw unknown()
   merged.set(key,event)
  }
  return [...merged.values()]
 }
 async function persist(event:ModelSendAuditEvent){
  // 先在内存保留意图；文件创建/后置写失败都不能让本宿主再试原请求。
  if(event.phase==='send')journal.push(event)
  try{await ports.write(event)}catch(error){poisoned=true;throw error}
  if(event.phase!=='send')journal.push(event)
 }
 async function assertClear(){
  if(poisoned)throw unknown()
  const saved=await records(),issued=saved.filter(event=>event.phase==='send')
  for(const event of saved)if(event.phase!=='send'&&!issued.some(start=>start.httpAttemptId===event.httpAttemptId&&start.auditStreamId===event.auditStreamId))throw unknown()
  for(const start of issued){
   const sameAttempt=saved.filter(event=>event.httpAttemptId===start.httpAttemptId),response=sameAttempt.find(event=>event.phase==='response')
   if(sameAttempt.some(event=>event.phase==='no-response')||!response)throw unknown()
   if(rejected(response.status))continue
   if(!accepted(response.status)||!saved.some(event=>event.auditStreamId===start.auditStreamId&&event.phase==='stream-complete'))throw unknown()
  }
 }
 async function seal(scope:Scope){
  if(scope.sealed)return
  if(poisoned)throw unknown()
  const saved=(await records()).filter(event=>event.auditStreamId===scope.auditStreamId),issued=saved.filter(event=>event.phase==='send'),last=issued.at(-1)
  if(!last)return
  const statuses=issued.map(start=>saved.find(event=>event.httpAttemptId===start.httpAttemptId&&event.phase==='response')?.status)
  if(saved.some(event=>event.phase==='no-response')||statuses.some(status=>!accepted(status)&&!rejected(status)))return
  const phase=statuses.every(rejected)?'stream-rejected':scope.finishedGood?'stream-complete':undefined
  if(!phase)return
  const {bindingSha256,auditStreamId,httpAttemptId,runId,sessionId,nativeRequestId}=last
  try{await persist(Object.freeze({bindingSha256,auditStreamId,httpAttemptId,runId,sessionId,nativeRequestId,phase,at:new Date().toISOString()}))}catch{throw unknown()}
  scope.sealed=true
 }
 function boundIterator(source:()=>AsyncIterable<StreamChunk>,scope?:Scope):AsyncIterableIterator<StreamChunk>{
  const enter=<T>(call:()=>T):T=>scope?storage.run(scope,call):storage.exit(call)
  const iterator=enter(()=>source()[Symbol.asyncIterator]())
  const end=()=>{if(scope)scope.active=false}
  return {
   [Symbol.asyncIterator](){return this},
   next:()=>enter(async()=>{try{const result=await iterator.next();if(scope&&!result.done&&result.value.type==='finish')scope.finishedGood=['stop','tool-calls','max-tokens'].includes(result.value.reason.kind);if(result.done){if(scope)await seal(scope);end()}return result}catch(error){end();throw error}}),
   return:value=>enter(async()=>{try{const result=iterator.return?await iterator.return(value):{done:true as const,value};if(scope&&result.done===true)await seal(scope);return result}finally{end()}}),
   throw:error=>enter(async()=>{try{if(iterator.throw)return await iterator.throw(error);throw error}catch(cause){end();throw cause}}),
  }
 }
 async function* stream(options:GenerateOptions,next:()=>AsyncIterable<StreamChunk>):AsyncIterable<StreamChunk>{
  if(closed||options.purpose!==undefined||options.provider!==binding.provider||options.model!==binding.model||options.reasoningEffort!==undefined&&options.reasoningEffort!==binding.reasoningEffort||!options.sessionId){yield* boundIterator(next);return}
  const candidate=await ports.resolve(String(options.sessionId),binding)
  if(!candidate||!matches(candidate,binding)){yield* boundIterator(next);return}
  const run=checkedRun(candidate)
  if(run.sessionId!==options.sessionId||fixed&&!same(fixed,run))throw denied()
  // 同步固定内存身份先于任何await，防两个并发Run争用同一绑定。
  fixed??=run
  try{await ports.pin?.(run)}catch{throw unavailable()}
  await assertClear()
  const scope:Scope={run,auditStreamId:randomUUID(),active:true,finishedGood:false,sealed:false}
  try{yield* boundIterator(next,scope)}finally{scope.active=false}
 }
 const send: (input:RequestInfo|URL,init:RequestInit|undefined,next:typeof globalThis.fetch)=>Promise<Response>=async(input,init,next)=>{
  const scope=storage.getStore()
  if(!scope)return next(input,init)
  if(closed||!scope.active)throw denied();if(inSend)throw unknown()
  inSend=true
  try{
   const current=await ports.resolve(scope.run.sessionId,binding)
   if(!current||!same(scope.run,current)||!scope.active)throw denied()
   await assertClear()
   const images=imageDigests(input,init,binding.model),httpAttemptId=randomUUID()
   const base={bindingSha256,auditStreamId:scope.auditStreamId,httpAttemptId,runId:scope.run.runId,sessionId:scope.run.sessionId,nativeRequestId:scope.run.nativeRequestId}
   try{await persist(Object.freeze({...base,phase:'send',at:new Date().toISOString(),images}))}catch{throw unavailable()}
   if(!scope.active)throw unknown()
   let response:Response
   try{response=await next(input,init)}catch{
    try{await persist(Object.freeze({...base,phase:'no-response',at:new Date().toISOString(),noResponseCategory:init?.signal?.aborted?'aborted':'transport-error'}))}catch{throw unknown()}
    throw unknown()
   }
   try{await persist(Object.freeze({...base,phase:'response',at:new Date().toISOString(),status:response.status}))}catch{throw unknown()}
   return response
  }finally{inSend=false}
 }
 return Object.freeze({stream,send,close(){closed=true}})
}

async function writeExclusive(path:string,value:unknown){
 const file=await open(path,'wx',0o600)
 try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync()}finally{await file.close()}
}
/** env必须来自securityEnv启动快照；无配置时不读写任何文件、不安装观察器。 */
export async function loadModelSendAudit(env:LaunchEnv,ports:{resolve:Resolver}):Promise<ModelSendAudit|null>{
 const configured=env.TELOA_MODEL_SEND_AUDIT_BINDING
 if(configured===undefined)return null
 let config:Record<string,unknown>;try{config=row(JSON.parse(configured))}catch{throw invalid()}
 if(Object.keys(config).length!==2||typeof config.path!=='string'||!isAbsolute(config.path)||resolve(config.path)!==config.path||typeof config.sha256!=='string'||!/^[a-f0-9]{64}$/.test(config.sha256))throw invalid()
 const stat=await lstat(config.path)
 if(!stat.isFile()||stat.size>64*1024||await realpath(config.path)!==config.path)throw invalid()
 const bytes=await readFile(config.path)
 if(hash(bytes)!==config.sha256)throw invalid()
 let binding:ModelSendAuditBinding;try{binding=readModelSendAuditBinding(JSON.parse(bytes.toString('utf8')))}catch{throw invalid()}
 await mkdir(binding.outputDirectory,{recursive:true,mode:0o700})
 const directory=await lstat(binding.outputDirectory)
 if(!directory.isDirectory()||directory.isSymbolicLink()||await realpath(binding.outputDirectory)!==binding.outputDirectory)throw invalid()
 return createModelSendAudit(binding,{resolve:ports.resolve,bindingSha256:config.sha256,
  pin:async run=>{
   const path=join(binding.outputDirectory,'run-binding.json'),identity={bindingSha256:config.sha256,runId:run.runId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId}
   try{await writeExclusive(path,identity)}catch(error){
    if(!error||typeof error!=='object'||Reflect.get(error,'code')!=='EEXIST')throw error
    if(!(await lstat(path)).isFile()||await realpath(path)!==path)throw denied()
    if(JSON.stringify(JSON.parse(await readFile(path,'utf8')))!==JSON.stringify(identity))throw denied()
   }
  },
  read:async()=>{
   const events:ModelSendAuditEvent[]=[]
   for(const name of await readdir(binding.outputDirectory)){
    if(name==='run-binding.json')continue
    if(!/^[a-f0-9-]{36}-(send|response|no-response|stream-complete|stream-rejected)\.json$/.test(name))throw unknown()
    const path=join(binding.outputDirectory,name),stat=await lstat(path)
    if(!stat.isFile()||stat.size>64*1024||await realpath(path)!==path)throw unknown()
    const event=row(JSON.parse(await readFile(path,'utf8')))
    if(typeof event.httpAttemptId!=='string'||name!==`${event.httpAttemptId}-${event.phase}.json`||!uuid(event.httpAttemptId)||!uuid(event.auditStreamId)||!uuid(event.runId)||!uuid(event.nativeRequestId)||!token(event.sessionId)||event.bindingSha256!==config.sha256)throw unknown()
    if(event.phase==='response'&&(!Number.isInteger(event.status)||(event.status as number)<100||(event.status as number)>599))throw unknown()
    const extra=event.phase==='send'?['images']:event.phase==='response'?['status']:event.phase==='no-response'?['noResponseCategory']:[]
    const keys=['phase','bindingSha256','auditStreamId','httpAttemptId','runId','sessionId','nativeRequestId','at',...extra]
    if(Object.keys(event).length!==keys.length||Object.keys(event).some(key=>!keys.includes(key))||typeof event.at!=='string'||!Number.isFinite(Date.parse(event.at)))throw unknown()
    if(event.phase==='no-response'&&!['aborted','transport-error'].includes(String(event.noResponseCategory)))throw unknown()
    if(event.phase==='send'){
     if(!Array.isArray(event.images)||!event.images.length||event.images.length>8)throw unknown()
     for(const value of event.images){const image=row(value);if(Object.keys(image).length!==3||typeof image.mime!=='string'||!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mime)||!Number.isSafeInteger(image.decodedBytes)||(image.decodedBytes as number)<=0||typeof image.sha256!=='string'||!/^[a-f0-9]{64}$/.test(image.sha256))throw unknown()}
    }
    events.push(event as ModelSendAuditEvent)
   }
   return events
  },
  write:event=>writeExclusive(join(binding.outputDirectory,`${event.httpAttemptId}-${event.phase}.json`),event),
 })
}

export async function installModelSendAudit(ctx:Context,env:LaunchEnv,ports:{resolve:Resolver}):Promise<()=>void>{
 const audit=await loadModelSendAudit(env,ports)
 if(!audit)return ()=>{}
 const release=ctx.provide('teloaModelSendAudit',audit)
 const off=ctx.on('llm/stream',async function*(options,next){yield* audit.stream(options,next)},{global:true,prepend:true})
 return ()=>{audit.close();off();release()}
}
