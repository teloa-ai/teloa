import {createHash} from 'node:crypto'
import {mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {renderSkillContent,type SkillDefinition} from '@deepseek-ai/dsh-skill'
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem'
import {WorkError} from '@teloa/contract'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {readSessionEvents} from './session-events.ts'

/**
 * Teloa 内置技能创建器（官方目录条目 openai.skill-creator 的适配版）。
 *
 * - 字节来自随发行固定的官方目录快照，物化到宿主运行目录后由官方文件解析器解析一次；
 * - 只登记到本人普通会话的 agent 层，global 层与员工运行、岗位技能选择都看不到它；
 * - 技能草案保存前核对「创建器正文当前在模型可见上下文中且与固定版本逐字一致」，证据只认宿主生成的事件。
 */
export const builtinSkillCreatorName='teloa-skill-creator'
/** 一个内置技能：官方解析器读出的定义与其固定渲染正文。 */
export type BuiltinSkill={readonly definition:SkillDefinition;readonly rendered:string}
export type BuiltinSkillCreator=BuiltinSkill
export type BuiltinSkillCreatorPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
}
type EvidenceSession={inheritedEventCount:number;surface:{nodes:Iterable<number>};seq?:number;snapshotEvents:()=>readonly SessionEvent[]}

const unavailable=(message='技能创建器不可用，暂不能生成技能草案。')=>new WorkError('teloa/dependency-unavailable',message)
const missing=()=>new WorkError('teloa/forbidden','保存技能草案前需要先加载技能创建器：请调用 skill 工具加载 '+builtinSkillCreatorName+'，按其流程生成后再保存。')
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')

async function listFiles(root:string,base=root):Promise<string[]>{
 const output:string[]=[]
 for(const entry of await readdir(root,{withFileTypes:true})){
  const path=join(root,entry.name)
  if(entry.isDirectory())output.push(...await listFiles(path,base))
  else output.push(relative(base,path).split(sep).join('/'))
 }
 return output.sort()
}

/** 已物化目录与固定字节逐文件一致才复用；任何差异（含多出文件）整体重写。 */
async function materialize(directory:string,files:readonly {path:string;bytes:Uint8Array}[]):Promise<void>{
 const expected=new Map(files.map(file=>[file.path,sha(file.bytes)]))
 try{
  const present=await listFiles(directory)
  if(present.length===expected.size&&(await Promise.all(present.map(async path=>expected.get(path)===sha(await readFile(join(directory,path)))))).every(Boolean))return
 }catch{}
 await rm(directory,{recursive:true,force:true})
 for(const file of files){
  const target=resolve(directory,file.path)
  if(!target.startsWith(directory+sep))throw unavailable()
  await mkdir(dirname(target),{recursive:true});await writeFile(target,file.bytes)
 }
}

/** 物化并用官方文件解析器读出内置技能定义（技能名须与 SKILL.md 一致）；失败时抛出，由宿主决定停用哪条能力。 */
export async function prepareBuiltinSkill(ctx:Context,input:{name:string;runtimeRoot:string;treeHash:string;files:readonly {path:string;bytes:Uint8Array}[]}):Promise<BuiltinSkill>{
 if(!isAbsolute(input.runtimeRoot)||!/^[0-9a-f]{64}$/.test(input.treeHash)||!/^teloa-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name))throw unavailable()
 const catalogRoot=join(resolve(input.runtimeRoot),'builtin-skills',input.treeHash.slice(0,16)),directory=join(catalogRoot,input.name),path=join(directory,'SKILL.md')
 await materialize(directory,input.files)
 const controller=new AbortController()
 const provider=new FileSystemSkillProvider(ctx,{signal:controller.signal,invalidate:()=>{}},{providerName:'teloa-builtin',includeDefaultRoots:false,customSkillDirs:[catalogRoot],watch:false,watchFollowSymlinks:false})
 try{
  const observation=await provider.list({}),candidates=Array.isArray(observation)?observation:observation.candidates
  const matches=candidates.filter(candidate=>candidate.path===path)
  if(matches.length!==1)throw unavailable()
  const definition=await provider.get(matches[0]!,{})
  if(!definition||definition.name!==input.name||definition.provider!=='teloa-builtin'||definition.path!==path||definition.resourceBase?.kind!=='directory'||definition.resourceBase.path!==directory)throw unavailable()
  const fixed=Object.freeze({...definition,invocation:{modelInvocable:true,userInvocable:true}})
  return Object.freeze({definition:fixed,rendered:renderSkillContent(fixed)})
 }finally{controller.abort();await provider.dispose()}
}

/** 物化并用官方文件解析器读出创建器定义；失败时抛出，宿主据此停用技能草案而不静默退回。 */
export async function prepareBuiltinSkillCreator(ctx:Context,input:{runtimeRoot:string;treeHash:string;files:readonly {path:string;bytes:Uint8Array}[]}):Promise<BuiltinSkillCreator>{
 return prepareBuiltinSkill(ctx,{name:builtinSkillCreatorName,...input})
}

/** 与页内新建工具同一判据：本人绑定、就绪、非子 Agent、没有任务执行策略。判定失败按「不是普通会话」处理。 */
type Verdict='ordinary'|'never'|'not-yet'
async function ordinaryConversation(agent:Agent,ports:BuiltinSkillCreatorPorts,signal:AbortSignal):Promise<Verdict>{
 const session=agent.session,header=session.header as {origin?:string}
 if(header.origin==='subagent')return 'never'
 let policy:Awaited<ReturnType<TaskToolPolicyReader>>
 try{policy=await ports.readTaskPolicy(session.id,signal)}catch{return 'not-yet'}
 // 任务执行会话是专用会话，之后不会变成普通会话：判定一次后不再逐步读库。
 if(policy!==null)return 'never'
 try{
  const binding=await ports.conversation(session.id)
  return binding.ownerId===ports.owner&&binding.sessionId===session.id&&binding.status==='ready'?'ordinary':'not-yet'
 }catch{return 'not-yet'}
}

/** 在官方 tool-skill 读取目录之前（next 之前）把内置技能登记到本人普通会话的 agent 层。 */
export function registerBuiltinSkill(ctx:Context,skill:BuiltinSkill,ports:BuiltinSkillCreatorPorts){
 const decided=new WeakSet<Agent>()
 return ctx.on('agent/pre-step',async({agent,signal},next)=>{
  if(!decided.has(agent)){
   const verdict=await ordinaryConversation(agent,ports,signal)
   signal.throwIfAborted()
   if(verdict==='ordinary')agent.ctx.get('skills')!.register({...skill.definition,provider:'teloa-builtin'})
   // 未绑定或暂未就绪的会话下一步再判；已登记与永不登记的会话不再重复读库。
   if(verdict!=='not-yet')decided.add(agent)
  }
  return next()
 })
}

/** 把创建器登记到本人普通会话的 agent 层。 */
export function registerBuiltinSkillCreator(ctx:Context,creator:BuiltinSkillCreator,ports:BuiltinSkillCreatorPorts){
 return registerBuiltinSkill(ctx,creator,ports)
}

const text=(content:unknown):string|undefined=>Array.isArray(content)&&content.length===1&&content[0]?.type==='text'&&typeof content[0].text==='string'?content[0].text:undefined

/**
 * 当前模型可见上下文里是否有本会话自己产生的创建器正文：显式调用注入，或原生 skill 工具的成功结果。
 * 继承自父会话的事件、已不可见的事件、用户自己粘贴的同文文本都不算。
 */
export function assertSkillCreatorLoaded(session:EvidenceSession,creator:BuiltinSkillCreator):void{
 const visible=new Set(session.surface.nodes),events=readSessionEvents(session),skillCalls=new Set<string>()
 for(const event of events){
  if(event.seq<session.inheritedEventCount)continue
  if(event.type==='tool/call'){
   if(event.data.name!=='skill')continue
   try{const args=JSON.parse(event.data.arguments) as {name?:unknown};if(args?.name===builtinSkillCreatorName)skillCalls.add(event.data.callId)}catch{}
   continue
  }
  if(!visible.has(event.seq))continue
  if(event.type==='user/message'){
   const source=event.data.source as {kind:string;name?:string;form?:string}
   if(source.kind==='skill-invocation'&&source.name===builtinSkillCreatorName&&source.form==='instructions'&&text(event.data.content)===creator.rendered)return
   continue
  }
  if(event.type==='tool/result'){
   const message=event.data.message
   if(!message.isError&&skillCalls.has(message.toolCallId)&&text(message.content)===creator.rendered)return
  }
 }
 throw missing()
}
