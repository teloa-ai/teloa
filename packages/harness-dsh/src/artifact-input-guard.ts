import type {Context} from '@deepseek-ai/cordis'
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm'
import {ArtifactAvailabilityService,type TaskRun} from '@teloa/backend'
import {WorkError,groupRoutingInputSchema,readArtifactInputSourceMarker,type ArtifactInputSourceReference} from '@teloa/contract'

export type ArtifactInputReference=ArtifactInputSourceReference
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
/** 只认受管引用的结构/标记；识别本身不授予读取权限，裸 UUID 或相似正文不作为来源。 */
export function artifactInputSources(value:unknown):{references:ArtifactInputReference[];groupMessageIds:string[];revisionRequestIds:string[]}{
 const references=new Map<string,ArtifactInputReference>(),visited=new WeakSet<object>(),groupMessageIds=new Set<string>(),revisionRequestIds=new Set<string>()
 const add=(id:unknown,version:unknown)=>{if(uuid(id)&&Number.isSafeInteger(version)&&Number(version)>0){const reference={artifactId:id.toLowerCase(),version:Number(version)};references.set(reference.artifactId+':'+reference.version,reference)}}
 const visit=(input:unknown,depth:number,decode=true):void=>{
  if(depth>64)throw new WorkError('teloa/conflict','成果输入来源嵌套过深，请整理固定引用后再继续。')
  if(typeof input==='string'){
   for(const line of input.split('\n')){const source=readArtifactInputSourceMarker(line.trim());if(source)add(source.artifactId,source.version)}
   for(const match of input.matchAll(/\[teloa-method-source:([a-f0-9-]{36}):v([1-9][0-9]*)\]/gi))add(match[1],Number(match[2]))
   for(const match of input.matchAll(/\[teloa-revision:([a-f0-9-]{36})\]/gi))if(uuid(match[1]))revisionRequestIds.add(match[1].toLowerCase())
   if(!decode)return
   const trimmed=input.trim()
   if(trimmed.startsWith('{')||trimmed.startsWith('['))try{const parsed:unknown=JSON.parse(trimmed);visit(parsed,depth+1,false);return}catch(error){if(error instanceof WorkError)throw error}
   // 兼容既有 Reader 预填的单行固定 JSON，以及附加说明后的 Run JSON。
   for(const line of input.split('\n'))if(line!==trimmed&&/^\s*[\[{]/.test(line))try{visit(JSON.parse(line),depth+1,false)}catch(error){if(error instanceof WorkError)throw error}
   return
  }
  if(!input||typeof input!=='object'||visited.has(input))return
  visited.add(input)
  if(Array.isArray(input)){for(const item of input)visit(item,depth+1,decode);return}
  const row=input as Record<string,unknown>
  if(row.kind==='artifact')add(row.id,row.version)
  if(uuid(row.messageId))groupMessageIds.add(row.messageId.toLowerCase())
  if(row.kind==='group-message'&&uuid(row.id))groupMessageIds.add(row.id.toLowerCase())
  if(row.artifactId!==undefined)add(row.artifactId,row.version??row.number??row.baseVersion)
  // 独立副本的历史谱系不等于继续引用原对象；活动来源由真实读口/固定输入另行登记。
  for(const [key,item] of Object.entries(row))if(!['origin','provenance','copyOrigin','localCopyOrigin'].includes(key))visit(item,depth+1,false)
 }
 visit(value,0)
 return {references:[...references.values()].sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||a.version-b.version),groupMessageIds:[...groupMessageIds].sort(),revisionRequestIds:[...revisionRequestIds].sort()}
}
export function artifactInputReferences(value:unknown):ArtifactInputReference[]{return artifactInputSources(value).references}
const textParts=(content:unknown):string[]=>typeof content==='string'?[content]:Array.isArray(content)?content.flatMap(block=>block?.type==='text'&&typeof block.text==='string'?[block.text]:[]):[]
/** 本人自然语言只认正式标记及旧Reader的固定整行引用，不把JSON例子当来源。 */
function declaredInputSources(content:unknown):unknown[]{
 const result:unknown[]=[]
 for(const text of textParts(content))for(const line of text.split('\n')){
  const value=line.trim()
  if(readArtifactInputSourceMarker(value)||/^\[teloa-(?:method-source:[a-f0-9-]{36}:v[1-9][0-9]*|revision:[a-f0-9-]{36})\]$/i.test(value)){result.push(value);continue}
  if(!value.startsWith('{'))continue
  let parsed:Record<string,unknown>;try{parsed=JSON.parse(value)}catch{continue}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))continue
  if(parsed.schema===groupRoutingInputSchema){
   const trigger=parsed.trigger as {messageId?:unknown}|undefined,topic=parsed.topic
   result.push({messageId:trigger?.messageId},...(Array.isArray(topic)?topic.map(row=>({messageId:row?.messageId})):[]));continue
  }
  const source=parsed.source as {kind?:unknown;id?:unknown}|undefined
  if(uuid(parsed.artifactId)&&Number.isSafeInteger(parsed.version)&&source&&['session','task'].includes(String(source.kind))&&typeof source.id==='string'&&Object.keys(parsed).every(key=>['artifactId','version','source','file'].includes(key)))result.push(parsed)
 }
 return result
}
/** 旧 surface 已压缩时只回看原生的声明/方法调用元数据，不把其他工具读出的副本正文追认为原引用。 */
function sessionSources(events:unknown){
 const inputs:unknown[]=[],artifactIds=new Set<string>()
 if(!Array.isArray(events))throw new WorkError('teloa/storage-corrupt','当前会话的成果来源历史无法核对。')
 for(const event of events){
  const data=event?.data
  if(event?.type==='user/message'&&['user','runtime-context'].includes(data?.source?.kind))inputs.push(...declaredInputSources(data.content))
  if(event?.type!=='assistant/message'||!Array.isArray(data?.message?.content))continue
  for(const block of data.message.content){
   if(block?.type!=='tool-call'||!['teloa_method_source','teloa_method_reuse'].includes(block.name)||typeof block.arguments!=='string')continue
   let args:Record<string,unknown>;try{args=JSON.parse(block.arguments)}catch{continue}
   if(!args||typeof args!=='object')continue
   const source=(block.name==='teloa_method_source'?args:args.source) as Record<string,unknown>|undefined
   if(!source||!uuid(source.artifactId))continue
   if(source.version===undefined)artifactIds.add(source.artifactId.toLowerCase())
   else if(Number.isSafeInteger(source.version)&&Number(source.version)>0)inputs.push(source)
  }
 }
 return {...artifactInputSources(inputs),artifactIds:[...artifactIds].sort()}
}
/** 由实际读口传入核验后的固定来源与真实会话，不暴露为模型可指定会话的 RPC。 */
export async function bindArtifactInputSources(owner:string,pool:ArtifactAvailabilityService['pool'],sessionId:string,sources:unknown):Promise<void>{
 const admission=await new ArtifactAvailabilityService(pool,()=>new Date().toISOString()).admitInput(owner,{sessionId,...artifactInputSources(sources)})
 await admission.release()
}
/** 只消费宿主声明的输入面；不扫描任意工具文件正文或技能系统说明里的历史 origin。 */
function requestSources(request:GenerateOptions,run:TaskRun|null){
 const inputs:unknown[]=[run?.inputText],calls=new Map<string,string>()
 for(const message of request.messages)if(message.role==='assistant')for(const block of message.content)if(block.type==='tool-call')calls.set(block.id,block.name)
 for(const message of request.messages){
  if(message.role==='tool'){
   if(['teloa_method_source','teloa_method_reuse','teloa_role_day_evidence'].includes(calls.get(message.toolCallId)??''))inputs.push(...textParts(message.content))
   continue
  }
  if(message.role!=='user')continue
  inputs.push(...declaredInputSources(message.content))
 }
 return artifactInputSources(inputs)
}
export function installArtifactInputGuard(ctx:Context,options:{owner:string;pool:ArtifactAvailabilityService['pool'];resolveRun:(sessionId:string)=>Promise<TaskRun|null>;history?:(sessionId:string)=>unknown}):()=>void{
 const availability=new ArtifactAvailabilityService(options.pool,()=>new Date().toISOString())
 return ctx.on('llm/stream',async function*(request,next):AsyncIterable<StreamChunk>{
  request.signal?.throwIfAborted()
  const run=request.sessionId?await options.resolveRun(request.sessionId):null
  const current=requestSources(request,run),history=sessionSources(request.sessionId&&options.history?await options.history(request.sessionId):[])
  const sources={references:[...current.references,...history.references],artifactIds:history.artifactIds,groupMessageIds:[...new Set([...current.groupMessageIds,...history.groupMessageIds])],revisionRequestIds:[...new Set([...current.revisionRequestIds,...history.revisionRequestIds])]}
  const admission=await availability.admitInput(options.owner,{...(request.sessionId?{sessionId:request.sessionId}:{}),...sources})
  try{
   request.signal?.throwIfAborted()
   // SDK 公开 StreamChunk 是 adapter 的内容/用量/结束输出；首块前仍持有头锁。
   // 先前已经准入的在途外发不在撤回可追回范围内。
   for await(const chunk of next()){await admission.release();yield chunk}
  }finally{await admission.release()}
 },{global:true})
}
