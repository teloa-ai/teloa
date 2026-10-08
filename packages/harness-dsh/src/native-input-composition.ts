/**
 * 原生输入组合：供启用原生输入准入的宿主在启动前调用，社区版自身组合不调用。
 *
 * 宿主要把官方会话控制器与子代理的宿主行换成本包的受管提供方。官方客户端发现
 * （dsh-client-modules）只读启用行入口所在包根的 `dsh.client`；受管行的入口是本包子路径，
 * 不是浏览器模块，被替换官方包的浏览器面会随之丢失，工作台缺少会话服务而整页加载失败。
 * 本模块把三件事收在一处：兼容能力核对、行替换补丁、浏览器面载体。替换声明了浏览器面的
 * 官方行时必定同时插入载体行（独立一行，之后再替换受管行也不受影响）；组合完成后按同一
 * 发现规则核对生效树，缺失即拒绝启动。
 */
import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,isAbsolute,join,relative,resolve as resolvePath,sep} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import type {SessionController} from '@deepseek-ai/dsh-api-session-controller'
import type {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import type {TeloaNativeInput,nativeInputRecoveryCandidate} from './native-input-provider.ts'

/** 宿主据此确认所加载的核心提供本接口及以下语义。 */
export const nativeInputCompositionVersion=1

export class NativeInputCompositionError extends Error{
 override readonly name='NativeInputCompositionError'
 constructor(reason:string,options?:ErrorOptions){super('原生输入组合未通过核对，拒绝启动：'+reason,options)}
}
const refuse=(reason:string,cause?:unknown)=>new NativeInputCompositionError(reason,cause===undefined?undefined:{cause})
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
const code=(error:unknown)=>record(error)?error.code:undefined
const table=(value:Record<string,string[]>)=>Object.freeze(Object.fromEntries(Object.entries(value).map(([name,apis])=>[name,Object.freeze([...apis])]))) as Readonly<Record<string,readonly string[]>>

/** 原生输入准入依赖的官方兼容补丁能力：包名 → 该包补丁清单 `api` 中的能力名。 */
export const nativeInputRequiredAPIs=table({
 '@deepseek-ai/dsh-session':['requireAppendAdmission()','installAppendAdmission(policy)'],
 '@deepseek-ai/dsh-api-session-controller':['requireInputAdmission()','installInputAdmission(policy)'],
 '@deepseek-ai/dsh-subagent':['SubagentRuntime.requirePromptAdmission','SubagentRuntime.installPromptAdmission'],
 '@deepseek-ai/dsh-subagent-in-process-driver':['startInProcessRun (unchanged signature)'],
 '@deepseek-ai/dsh-agent-loop':['AgentLoop.requireWorkAdmission','AgentLoop.installWorkAdmission','AgentLoop.requireRestoreAdmission','AgentLoop.installRestoreAdmission'],
 '@deepseek-ai/dsh-agent':['AgentRegistry.announce'],
 '@deepseek-ai/dsh-session-persistence':['SessionPersistence.openWithAdmission'],
 '@deepseek-ai/dsh-session-persistence-jsonl':['JsonlSessionPersistence.openWithAdmission'],
 '@deepseek-ai/dsh-llm':['LlmRuntime.requireStreamAdmission','LlmRuntime.installStreamAdmission'],
 '@deepseek-ai/dsh-tools':['ToolRuntime.requireWorkAdmission','ToolRuntime.installWorkAdmission'],
 '@deepseek-ai/dsh-compaction-basic':['BasicCompactionEngine.summaryRequestOwner'],
})
/** 宿主提供持久确认（输入与进度检查点）时另需的能力。 */
export const nativeInputCheckpointAPIs=table({
 '@deepseek-ai/dsh-agent-loop':['AgentLoop.requireInputCheckpoint','AgentLoop.installInputCheckpoint','AgentLoop.requireProgressCheckpoint','AgentLoop.installProgressCheckpoint'],
})

export type NativeInputProviders=Readonly<{
 input:typeof TeloaNativeInput
 controller:typeof SessionController
 subagent:typeof SubagentRuntime
 /** 仅在 requireCheckpoint 时提供：只读的冷恢复候选筛选。 */
 recoveryCandidate?:typeof nativeInputRecoveryCandidate
}>
export type NativeInputLoadOptions=Readonly<{
 /** 宿主已核对并应用的官方兼容补丁清单：包名 → 清单 `api`。 */
 compatibilityAPIs:unknown
 requireCheckpoint?:boolean
}>
/** 只有经本模块兼容核对后导入的提供方才能用于组合与启动核对。 */
const loaded=new WeakSet<object>()

/**
 * 核对兼容能力后导入固定的受管提供方。核对不通过时不导入任何执行模块。
 * @throws {NativeInputCompositionError} 兼容能力缺失或选项无效。
 */
export async function loadNativeInputProviders(options:NativeInputLoadOptions):Promise<NativeInputProviders>{
 const requireCheckpoint:unknown=options?.requireCheckpoint===undefined?false:options.requireCheckpoint
 if(typeof requireCheckpoint!=='boolean')throw refuse('持久确认选项无效。')
 const apis=options?.compatibilityAPIs
 if(!record(apis))throw refuse('宿主没有提供已应用的官方兼容能力清单。')
 for(const required of requireCheckpoint?[nativeInputRequiredAPIs,nativeInputCheckpointAPIs]:[nativeInputRequiredAPIs]){
  for(const [name,names] of Object.entries(required)){
   const declared=Object.hasOwn(apis,name)?apis[name]:undefined
   if(!Array.isArray(declared)||!names.every(api=>declared.includes(api)))throw refuse('缺少原生输入准入所需的官方兼容能力（'+name+'）。')
  }
 }
 const [input,controller,subagent]=await Promise.all([import('./native-input-provider.ts'),import('./managed-session-controller.ts'),import('./managed-subagent.ts')])
 const base={input:input.TeloaNativeInput,controller:controller.ManagedSessionController,subagent:subagent.ManagedSubagentRuntime}
 const providers:NativeInputProviders=Object.freeze(requireCheckpoint?{...base,recoveryCandidate:input.nativeInputRecoveryCandidate}:base)
 loaded.add(providers)
 return providers
}

type Row=Record<string,unknown>
type Located=Readonly<{row:Row;parent:string|undefined}>
type Resolve=(specifier:string)=>string
type Provider=Readonly<{id:string;source:string;target:string;name:string;face:string;label:string}>
const providerRows:readonly Provider[]=[
 {id:'session-controller',source:'@deepseek-ai/dsh-api-session-controller',target:'teloa-managed-session-controller',name:'@teloa/harness-dsh/managed-session-controller',face:'teloa-client-face-session-controller',label:'会话控制器'},
 {id:'subagent',source:'@deepseek-ai/dsh-subagent',target:'teloa-managed-subagent',name:'@teloa/harness-dsh/managed-subagent',face:'teloa-client-face-subagent',label:'子代理'},
]
const inputRowId='teloa-native-input'
const reserved=new Set([inputRowId,...providerRows.flatMap(row=>[row.target,row.face])])
const moduleRequire=createRequire(import.meta.url)
const defaultResolve:Resolve=specifier=>moduleRequire.resolve(specifier)

export type NativeInputCompositionOptions=Readonly<{
 /** loadNativeInputProviders 的返回值。 */
 providers:NativeInputProviders
 /** 宿主私有运行目录（已存在的规范绝对路径）；载体写在其下 native-client-faces/。 */
 runtimeRoot:string
 /** `teloa-native-input` 行的模块；默认 `@teloa/harness-dsh/native-input-provider`。 */
 inputProvider?:string
 /** 解析实际安装（已应用兼容补丁）的官方包；默认按本包依赖解析，与受管类继承的官方类同源。 */
 resolve?:Resolve
}>

/**
 * 按官方补丁算法得到的完整生效树（含父组）生成原生输入组合补丁：插入原生输入准入服务；
 * 停用官方会话控制器与子代理行，在原父组插入保留原配置的受管行；给 agent-loop 加准入依赖并
 * 强制恢复准入；给 typert-loader 补原包的远程调用描述；为声明了浏览器面的官方包插入载体行。
 * 不改动传入的行。
 * @throws {NativeInputCompositionError} 提供方未经核对、组合树不符合预期或载体无法核对。
 */
export async function composeNativeInput(rows:readonly unknown[],options:NativeInputCompositionOptions):Promise<Record<string,unknown>[]>{
 if(!record(options)||!loaded.has(options.providers))throw refuse('提供方未经兼容核对，请先调用 loadNativeInputProviders。')
 const inputProvider=options.inputProvider??'@teloa/harness-dsh/native-input-provider'
 if(typeof inputProvider!=='string'||!inputProvider)throw refuse('原生输入准入服务的模块名无效。')
 const runtimeRoot=await canonicalRoot(options.runtimeRoot),resolve=options.resolve??defaultResolve
 const tree=indexRows(rows)
 const loop=only(tree,'agent-loop','@deepseek-ai/dsh-agent-loop','代理循环').row
 const loopConfig=loop.config??{}
 if(!record(loopConfig))throw refuse('代理循环的配置格式无效。')
 const loader=only(tree,'typert-loader','@deepseek-ai/dsh-typert-loader','远程调用描述加载器').row
 const loaderConfig=loader.config??{},listed=record(loaderConfig)?loaderConfig.packages??[]:undefined
 if(!Array.isArray(listed)||listed.some(name=>typeof name!=='string'||!name))throw refuse('远程调用描述加载器的配置格式无效。')
 const patches:Record<string,unknown>[]=[
  {insert:[{id:inputRowId,name:inputProvider}]},
  // 代理循环自身也能启动代理，不能只让会话控制器等待准入。
  {id:'agent-loop',name:'@deepseek-ai/dsh-agent-loop',inject:withNativeInput(loop.inject),config:{...structuredClone(loopConfig),requireRestoreAdmission:true}},
  // 官方加载器不从子路径入口发现远程调用描述，显式沿用原包生成的描述。
  {id:'typert-loader',name:'@deepseek-ai/dsh-typert-loader',config:{...structuredClone(loaderConfig),packages:[...new Set([...listed as string[],...providerRows.map(row=>row.source)])]}},
 ]
 const placements=providerRows.map(provider=>{
  const found=only(tree,provider.id,provider.source,provider.label)
  if(found.parent!==undefined&&tree.get(found.parent)?.length!==1)throw refuse('官方'+provider.label+'行所在的组不唯一（'+provider.id+'）。')
  const placement=found.parent===undefined?{}:{id:found.parent}
  patches.push({id:provider.id,name:provider.source,disabled:true},{...placement,insert:[{...structuredClone(found.row),id:provider.target,name:provider.name}]})
  return {provider,placement}
 })
 // 替换即保面：声明了浏览器面的官方包必定同时插入载体行，宿主不能只取替换。组合树全部核对通过后才写载体。
 for(const {provider,placement} of placements){
  const face=await prepareClientFace(provider,resolve,runtimeRoot)
  if(face!==undefined)patches.push({...placement,insert:[{id:provider.face,name:face}]})
 }
 return patches
}

/**
 * 组合后核对：传入宿主应用全部补丁（含之后任何再替换）后的最终生效树。被替换的官方包若声明了
 * 浏览器面，启用行中必须恰好有一个按官方发现规则提供该浏览器面的来源。只读，不改动传入的行。
 * 相对路径入口依赖所属子树的解析基址，这里不计入。
 * @throws {NativeInputCompositionError} 浏览器面缺失或来源不唯一。
 */
export function assertNativeInputClientFaces(rows:readonly unknown[],options:Readonly<{resolve?:Resolve}>={}):void{
 if(!Array.isArray(rows))throw refuse('生效组合树格式无效。')
 const resolve=options?.resolve??defaultResolve
 for(const provider of providerRows){
  if(!webFace(officialManifest(provider,resolve).manifest))continue
  const sources=faceSources(rows,provider.source)
  if(sources===0)throw refuse('缺少'+provider.label+'的浏览器面（'+provider.source+'），工作台将无法使用相应服务。')
  if(sources>1)throw refuse(provider.label+'的浏览器面来源不唯一（'+provider.source+'）。')
 }
}

/** 启动后核对：实际装配的服务必须是经核对导入的受管提供方（或其子类）。 */
export function assertNativeInputProviders(ctx:Readonly<{get:(name:string)=>unknown}>,providers:NativeInputProviders):void{
 if(!loaded.has(providers))throw refuse('提供方未经兼容核对。')
 const expected=[['teloaNativeInput',providers.input,'原生输入准入服务'],['sessionController',providers.controller,'会话控制器'],['subagents',providers.subagent,'子代理']] as const
 for(const [service,type,label] of expected)if(!(ctx.get(service) instanceof type))throw refuse('启动后的'+label+'不是受管提供方。')
}

function indexRows(rows:unknown):Map<string,Located[]>{
 if(!Array.isArray(rows))throw refuse('生效组合树格式无效。')
 const byId=new Map<string,Located[]>()
 const visit=(entries:readonly unknown[],parent:string|undefined)=>{
  for(const row of entries){
   if(!record(row))throw refuse('生效组合树格式无效。')
   if(row.id!==undefined){
    if(typeof row.id!=='string'||!row.id)throw refuse('生效组合树含无效的行编号。')
    if(reserved.has(row.id))throw refuse('组合树已含原生输入组合的保留行，不能重复组合。')
    byId.set(row.id,[...byId.get(row.id)??[],{row,parent}])
   }
   if(row.group&&Array.isArray(row.config)){
    if(typeof row.id!=='string')throw refuse('生效组合树含没有编号的组。')
    visit(row.config,row.id)
   }
  }
 }
 visit(rows,undefined)
 return byId
}

function only(tree:Map<string,Located[]>,id:string,name:string,label:string):Located{
 const matches=tree.get(id),found=matches?.length===1?matches[0]:undefined
 if(!found)throw refuse('需要唯一的官方'+label+'行（'+id+'）。')
 if(found.row.name!==name||found.row.group||found.row.disabled!==undefined&&found.row.disabled!==false)throw refuse('官方'+label+'行（'+id+'）已被替换、停用或带启用条件。')
 return found
}

function withNativeInput(value:unknown):unknown{
 if(value===undefined)return ['teloaNativeInput']
 if(Array.isArray(value)&&value.every(name=>typeof name==='string'&&name))return [...new Set([...value,'teloaNativeInput'])]
 if(record(value))return {...structuredClone(value),teloaNativeInput:null}
 throw refuse('代理循环的依赖声明格式无效。')
}

async function canonicalRoot(value:unknown):Promise<string>{
 const invalid='载体运行目录必须是已存在的规范绝对路径。'
 if(typeof value!=='string'||!isAbsolute(value)||resolvePath(value)!==value)throw refuse(invalid)
 let real:string
 try{real=await realpath(value)}catch(error){throw refuse(invalid,error)}
 if(real!==value)throw refuse(invalid)
 return value
}

function officialManifest(provider:Provider,resolve:Resolve):{path:string;manifest:Row}{
 let path:string,manifest:unknown
 try{path=resolve(provider.source+'/package.json');manifest=JSON.parse(readFileSync(path,'utf8'))}
 catch(error){throw refuse('无法读取实际安装的官方'+provider.label+'包（'+provider.source+'）。',error)}
 if(!record(manifest)||manifest.name!==provider.source)throw refuse('实际安装的官方'+provider.label+'包身份不符（'+provider.source+'）。')
 return {path,manifest}
}
const clientDeclaration=(manifest:Row)=>record(manifest.dsh)?manifest.dsh.client:undefined
const webFace=(manifest:Row)=>{const client=clientDeclaration(manifest);return record(client)&&client.platform==='web'}
const inside=(parent:string,child:string)=>{const value=relative(parent,child);return value!==''&&value.split(sep)[0]!=='..'&&!isAbsolute(value)}

/** 官方按包发布懒加载分块（与 client 同目录）；载体只承载单文件浏览器面。 */
const clientChunk=/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
const hostHalf='// 只承载固定官方包的浏览器面；宿主服务由受管提供方提供，本模块不启动任何服务。\nexport function apply(){}\n'

/**
 * 从实际安装、已应用兼容补丁的官方包读取浏览器面，在运行目录生成载体包：名称与版本同官方，
 * 只含官方 client.js 与 dsh.client 声明，宿主一半为空。目录名取内容摘要，先在同级临时目录写好
 * 再整体改名；已有载体逐项核对，任何变化都保留现场并拒绝。
 * @returns 载体入口的 file URL；官方包未声明浏览器面时为 undefined。
 */
async function prepareClientFace(provider:Provider,resolve:Resolve,runtimeRoot:string):Promise<string|undefined>{
 const {path,manifest}=officialManifest(provider,resolve),client=clientDeclaration(manifest),subject='官方'+provider.label+'包（'+provider.source+'）'
 if(client===undefined)return undefined
 if(manifest.version!==coreDshVersion())throw refuse('实际安装的'+subject+'不是核心固定的 DSH 版本。')
 if(!record(client)||client.platform!=='web')throw refuse(subject+'的浏览器面声明无效。')
 const entry=record(manifest.exports)?manifest.exports['./client']:undefined
 const declared=typeof entry==='string'?entry:record(entry)&&typeof entry.default==='string'?entry.default:undefined
 const packageRoot=await realpath(dirname(path)),clientPath=declared===undefined?undefined:resolvePath(packageRoot,declared)
 let real:string|undefined
 try{if(clientPath!==undefined&&inside(packageRoot,clientPath))real=await realpath(clientPath)}catch(error){throw refuse(subject+'的浏览器面无法读取。',error)}
 if(real===undefined||!inside(packageRoot,real)||!(await lstat(real)).isFile())throw refuse(subject+'的浏览器面不在包内。')
 if((await readdir(dirname(real))).some(name=>clientChunk.test(name)))throw refuse(subject+'的浏览器面带有分块文件，载体无法完整承载。')
 const bytes=await readFile(real)
 const carrier={name:provider.source,version:manifest.version,type:'module',...(typeof manifest.license==='string'?{license:manifest.license}:{}),exports:{'.':'./index.mjs','./client':'./client.js'},dsh:{client},teloaClientFace:{schema:'teloa.native-client-face/v1',source:provider.source,sha256:sha256(bytes)}}
 const files=new Map<string,Uint8Array>([['client.js',bytes],['index.mjs',Buffer.from(hostHalf)],['package.json',Buffer.from(JSON.stringify(carrier,null,2)+'\n')]])
 const base=join(runtimeRoot,'native-client-faces'),target=join(base,provider.id+'-'+sha256(JSON.stringify([...files].map(([name,content])=>[name,sha256(content)]))).slice(0,16))
 await privateDirectory(base)
 let present=true
 try{await lstat(target)}catch(error){if(code(error)!=='ENOENT')throw refuse('无法读取浏览器面载体。',error);present=false}
 if(!present){
  const staging=await mkdtemp(join(base,'.staging-'))
  try{
   for(const [name,content] of files)await writeFile(join(staging,name),content,{flag:'wx',mode:0o600})
   await rename(staging,target)
  }catch(error){
   await rm(staging,{recursive:true,force:true})
   // 并发启动已先写好同一载体时以已有载体为准，随后逐项核对。
   if(code(error)!=='EEXIST'&&code(error)!=='ENOTEMPTY')throw refuse('无法写入浏览器面载体。',error)
  }
 }
 await verifyFace(target,files)
 return pathToFileURL(join(target,'index.mjs')).href
}

function coreDshVersion():string{
 const version:unknown=(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {engines?:{dsh?:unknown}}).engines?.dsh
 if(typeof version!=='string'||!version)throw refuse('核心没有声明固定的 DSH 版本。')
 return version
}

async function privateDirectory(path:string):Promise<void>{
 try{await mkdir(path,{mode:0o700})}catch(error){if(code(error)!=='EEXIST')throw refuse('无法建立浏览器面载体目录。',error)}
 const info=await lstat(path)
 if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||await realpath(path)!==path)throw refuse('浏览器面载体目录的类型或权限无效。')
}

async function verifyFace(target:string,files:ReadonlyMap<string,Uint8Array>):Promise<void>{
 const changed=()=>refuse('浏览器面载体已变化，保留现场。')
 const info=await lstat(target)
 if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||await realpath(target)!==target)throw changed()
 if(JSON.stringify((await readdir(target)).sort())!==JSON.stringify([...files.keys()].sort()))throw changed()
 for(const [name,content] of files){
  const path=join(target,name),file=await lstat(path)
  if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.mode&0o077||!Buffer.from(content).equals(await readFile(path)))throw changed()
 }
}

/** 按官方发现规则数启用行里提供某包浏览器面的来源；条件启用按可能启用计。 */
function faceSources(rows:readonly unknown[],packageName:string):number{
 let count=0
 const visit=(entries:readonly unknown[])=>{
  for(const row of entries){
   if(!record(row))throw refuse('生效组合树格式无效。')
   if(row.disabled!==undefined&&row.disabled!==false&&!record(row.disabled))continue
   if(typeof row.name==='string'&&providesFace(row.name,packageName))count++
   if(row.group&&Array.isArray(row.config))visit(row.config)
  }
 }
 visit(rows)
 return count
}

/** 裸包名即包身份；文件入口取最近的 package.json；子路径、相对路径与 cordis 内置入口都不是浏览器模块。 */
function providesFace(name:string,packageName:string):boolean{
 if(name===packageName)return true
 if(!name.startsWith('file:')&&!isAbsolute(name))return false
 let directory:string
 try{directory=dirname(name.startsWith('file:')?fileURLToPath(name):name)}catch{return false}
 for(;;){
  const candidate=join(directory,'package.json')
  if(existsSync(candidate)){
   try{
    const manifest:unknown=JSON.parse(readFileSync(candidate,'utf8'))
    if(record(manifest)&&typeof manifest.name==='string')return manifest.name===packageName&&webFace(manifest)
   }catch{}
  }
  const parent=dirname(directory)
  if(parent===directory)return false
  directory=parent
 }
}
