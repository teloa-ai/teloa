import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {brandString} from '@deepseek-ai/dsh-brand'
import {BlockAssembler,createUserMessage,type GenerateOptions} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {WorkError,taskInput} from '@teloa/contract'
import {projectRuntimeExposure} from './project-runtime-context.ts'
import {readSessionEvents} from './session-events.ts'

// 消息来源按官方"merge-extensible"约定在本模块登记，和 title 插件同一写法；
// 这条只用于一次辅助请求，不进入会话记录。
declare module '@deepseek-ai/dsh-llm'{
 interface MessageSourceMap{'teloa-composer-suggestion':{kind:'teloa-composer-suggestion'}}
}

/**
 * 输入框「下一条建议」（对齐 Codex Composer predictions）。
 *
 * 行为契约见 plans/社区版/2026-10-24-输入框下一条建议实施计划.md：
 * - 只在助手回复结束后算一次，同一 `(sessionId, 最后助手消息 seq)` 复用同一结果；
 * - 事实不足就返回 null（不显示），绝不用模板填空代替推断；
 * - 建议不进会话记录、不产生消息、不触发执行。
 */

export const composerSuggestionEndpoint='composer-suggestion/read'
/** 只允许一句用户口吻的下一步输入；超过这个长度视为不合格（宁可不显示）。 */
export const composerSuggestionMaxChars=200
/** 事实不足时模型必须回这个标记，命中即按 null 处理。 */
const noneMarker='NONE'
const factMaxChars=900
const callTimeoutMs=8_000
const maxTokens=120

export type ComposerSuggestion={text:string|null}
type MessageLikeSource={id:string;seq:number}
function freezeMessage(message:ReturnType<typeof createUserMessage>):ReturnType<typeof createUserMessage>{
 const content=Object.freeze(message.content.map(part=>Object.freeze({...part})))
 return Object.freeze({...message,content}) as ReturnType<typeof createUserMessage>
}

/** 从会话事件里取最近一轮的用户问题与助手回答；取不到就是"事实不足"。 */
export function readSuggestionFacts(events:readonly {seq:number;type:string;data?:unknown}[]):{question:string;answer:string;answerSeq:number}|null{
 let question='',answer='',answerSeq=-1
 for(const event of events){
  if(event.type==='user/message'){
   if((event.data as {source?:{kind?:unknown}})?.source?.kind!=='user')continue
   const content=(event.data as {content?:unknown})?.content
   if(!Array.isArray(content))continue
   const text=content.filter(part=>(part as {type?:string})?.type==='text').map(part=>String((part as {text?:unknown}).text??'')).join('\n').trim()
   // 来源身份由宿主事件确定，不凭用户文本的前缀猜测身份。
   if(!text)continue
   question=text
   answer=''
   answerSeq=-1
   continue
  }
  if(event.type==='assistant/message'){
   const content=(event.data as {message?:{content?:unknown}})?.message?.content
   if(!Array.isArray(content))continue
   const text=content.filter(part=>(part as {type?:string})?.type==='text').map(part=>String((part as {text?:unknown}).text??'')).join('').trim()
   if(!text)continue
   answer=text
   answerSeq=event.seq
  }
 }
 if(!question||!answer||answerSeq<0)return null
 return {question:question.slice(0,factMaxChars),answer:answer.slice(0,factMaxChars),answerSeq}
}

/**
 * 建议正文的合格性：一句、不超长、不含换行；`NONE` 或任何多句都按 null。
 * 这条判据只在宿主侧，客户端不做二次猜测。
 */
export function normalizeSuggestion(raw:string):string|null{
 const flattened=raw.replace(/```[a-z]*/gi,'').replace(/\s*\n+\s*/g,' ').trim().replace(/^["“]|["”]$/g,'').trim()
 if(!flattened||flattened===noneMarker)return null
 // 与 Codex 一致：建议可以是完整的一段，不强制一句话；只做长度与"别塞代码块"的收口。
 return flattened.length>composerSuggestionMaxChars?flattened.slice(0,composerSuggestionMaxChars):flattened
}



export type ComposerSuggestionPorts={
 /** 宿主真实 owner 身份：辅助模型调用的受理证明按它核对。 */
 owner:string
 /** 该会话当前模型调用的完整配置（含适配器默认值）；取不到就不发这次辅助调用。 */
 model:(sessionId:string)=>Promise<object|undefined>
}

/**
 * 生成一条建议。任何失败（无会话、无事实、模型不可用、超时、回包不合格）都返回 null：
 * 这一层只做锦上添花，绝不打断会话，也不把错误抛给界面。
 */
export async function readComposerSuggestion(ctx:Context,ports:ComposerSuggestionPorts,payload:unknown,signal?:AbortSignal):Promise<ComposerSuggestion>{
 const input=taskInput(payload,['sessionId'])
 const sessionId=String(input.sessionId)
 const diagnosticId=createHash('sha256').update(sessionId).digest('hex').slice(0,12)
 // 运维只记录固定阶段/状态和内部错误码，不记录事实、建议、provider 原始异常或凭据。
 let stage='session'
 const report=(outcome:string,code='none')=>{
  const args=[diagnosticId,outcome,stage,code] as const
  if(outcome==='failed')ctx.logger.warn('Teloa 输入建议状态：%s %s %s %s',...args)
  else ctx.logger.info('Teloa 输入建议状态：%s %s %s %s',...args)
 }
 const failure=(error:unknown)=>{report('failed',error instanceof WorkError?error.code:error instanceof Error&&['AbortError','TimeoutError'].includes(error.name)?error.name:'unexpected');return {text:null}}
 const skip=(reason:string)=>{report('skipped',reason);return {text:null as string|null}}
 const agent=ctx.agents.get(brandString<SessionId>(sessionId))
 if(!agent)return skip('no-agent')
 signal?.throwIfAborted()
 let events
 try{events=readSessionEvents(agent.session)}catch(error){return failure(error)}
 const facts=readSuggestionFacts(events)
 if(!facts)return skip('no-facts')
 stage='model-prepare'
 let config:object|undefined
 try{config=await ports.model(sessionId)}catch(error){return failure(error)}
 const route=config as {provider?:unknown;model?:unknown}|undefined
 if(!route||typeof route.provider!=='string'||typeof route.model!=='string')return skip('no-model')
 // 辅助模型调用必须挂在**真实受理过的用户消息**上，否则会被最终因果闸拒绝（实测）。
 const live=ctx.agents.get(brandString<SessionId>(sessionId))
 if(!live||live!==agent)return skip('stale-agent')
 let source:MessageLikeSource|undefined,completed=false
 for(const event of events){
  if(event.type==='user/message'){
   const row=event.data as {id?:string;source?:{kind?:string}|null}
   // surfaceOp 在**事件**上，不在 data 里（实测踩过：写在 data 上永远匹配不到真实用户消息）。
   const op=(event as {surfaceOp?:unknown}).surfaceOp
   if(op==='append'&&row.source?.kind==='user'&&typeof row.id==='string'){source={id:row.id,seq:event.seq};completed=false}
  }else if(event.type==='turn/end'&&source){
   const reason=(event.data as {reason?:{kind?:string}}).reason
   if(reason?.kind==='completed')completed=true
  }
 }
 if(!source||!completed)return skip('no-completed-source')
 const factsHash=createHash('sha256').update(facts.question+'\n'+facts.answer).digest('hex')
 let text:string|null=null
 try{
  const deadline=AbortSignal.timeout(callTimeoutMs),requestSignal=signal?AbortSignal.any([signal,deadline]):deadline
  const message=freezeMessage(createUserMessage({source:{kind:'user'},content:[{type:'text',text:`用户问题：${facts.question}\n\n助手回答：${facts.answer}`}]}))
  const options=Object.freeze({...(config as Record<string,unknown>),sessionId:live.session.id,messages:Object.freeze([message]),system:systemPrompt,maxTokens,signal:requestSignal}) as unknown as Readonly<GenerateOptions>
  // 受理证明：每次被核验时都重新读会话，确认这条用户消息仍是最近一次已完成的受理。
  const lease=Object.freeze({assertCurrent:()=>{
   requestSignal.throwIfAborted()
   if(ctx.agents.get(brandString<SessionId>(sessionId))!==live)throw new Error('composer-suggestion-stale')
   const now=readSessionEvents(live.session) as readonly {type:string;seq:number;data?:unknown}[]
   let latest:string|undefined,ended=false
   for(const event of now){
    if(event.type==='user/message'){
     const row=event.data as {id?:string;source?:{kind?:string}|null}
     const op=(event as {surfaceOp?:unknown}).surfaceOp
     if(op==='append'&&row.source?.kind==='user'&&typeof row.id==='string'){latest=row.id;ended=false}
    }else if(event.type==='turn/end'&&latest){const reason=(event.data as {reason?:{kind?:string}}).reason;if(reason?.kind==='completed')ended=true}
   }
   const current=readSuggestionFacts(now)
   if(latest!==source!.id||!ended||current?.answerSeq!==facts.answerSeq||createHash('sha256').update(current.question+'\n'+current.answer).digest('hex')!==factsHash)throw new Error('composer-suggestion-stale')
  }})
  // 走 Teloa 受管的辅助模型通路：必须挂在"已准备的项目/工作上下文"上，
 // 与项目记忆提炼同一条准入链（withAuxiliaryContext + withAuxiliaryModel），
 // 不绕开因果闸，也不另开 HTTP 直连。
 const hooks=projectRuntimeExposure()
 stage='project-context'
 if(!hooks)return skip('no-runtime')
 const prepared=hooks.preparedForSession(sessionId)
 if(!prepared)return skip('no-prepared-context')
 // 缓存只是计算复用，不能替代当前来源和会话的读取许可。异步数据库复核必须等待。
 await hooks.assertPreparedCurrent(prepared)
 const combinedLease=Object.freeze({assertCurrent:()=>{hooks.assertPreparedCurrentSync(prepared);lease.assertCurrent()}})
 combinedLease.assertCurrent()
 const key=`${ports.owner}\0${sessionId}\0${source.id}\0${facts.answerSeq}\0${factsHash}\0${prepared.manifestId}\0${prepared.binding.generation}`
 const cache=cacheFor(ctx)
 if(cache.results.has(key)){report('cached');return {text:cache.results.get(key)??null}}
 let pending=cache.pending.get(key)
 if(!pending){
  // 同一回复的并发读取共享计算；发起者取消时本次计算作废，后来者可重新请求。
  const forgetPending=()=>{if(cache.pending.get(key)===pending)cache.pending.delete(key)}
  pending=Promise.resolve().then(async()=>{
   const nativeInput=ctx.teloaNativeInput.input
   const dispatch=()=>{stage='native-admission';return nativeInput.withAuxiliaryModel({source:{ownerId:ports.owner,sessionId,messageId:source!.id,eventId:'composer-suggestion:'+source!.id},options:options as never,lease:combinedLease as never},()=>{stage='model-stream';return ctx.llm.stream(options as never)})}
   const assembler=new BlockAssembler()
   for await(const chunk of hooks.withAuxiliaryContext(prepared,options,dispatch as never) as AsyncIterable<{type?:string;text?:string}>)assembler.push(chunk as never)
   // 官方流会把 adapter 异常变为 finish.error/aborted，正常迭代结束不等于成功。
   // 失败或截断的部分正文不能采纳，也不缓存为已成功计算的空建议。
   stage='model-result'
   if(assembler.finish.kind!=='stop'){
    report('failed',['error','aborted','max-tokens','tool-calls'].includes(assembler.finish.kind)?assembler.finish.kind:'unsupported-terminal')
    return null
   }
   const blocks=assembler.blocks() as {type?:string;text?:string}[]
   stage='result-validation'
   await hooks.assertPreparedCurrent(prepared)
   combinedLease.assertCurrent()
   const raw=blocks.filter(block=>block.type==='text').map(block=>String(block.text??'')).join('')
   const value=normalizeSuggestion(raw)
   stage='result';report(value!==null?'generated':raw.trim()===noneMarker?'abstained':'empty')
   remember(cache.results,key,value)
   return value
  }).finally(()=>{requestSignal.removeEventListener('abort',forgetPending);forgetPending()})
  cache.pending.set(key,pending)
  // 调用方先收到取消时，adapter 可能仍在清理；不能让重试继续等待旧调用。
  requestSignal.addEventListener('abort',forgetPending,{once:true})
 }
 text=await waitForSuggestion(pending,requestSignal)
 // 等待别人的计算也不能继承对方的读取许可或忽略本次请求取消。
 await hooks.assertPreparedCurrent(prepared)
 combinedLease.assertCurrent()
 }catch(error){return failure(error)}
 
 return {text}
}

type SuggestionCache={results:Map<string,string|null>;pending:Map<string,Promise<string|null>>}
let caches=new WeakMap<Context,SuggestionCache>()
const cacheLimit=256
function cacheFor(ctx:Context){let cache=caches.get(ctx);if(!cache){cache={results:new Map(),pending:new Map()};caches.set(ctx,cache)}return cache}
function waitForSuggestion(pending:Promise<string|null>,signal:AbortSignal):Promise<string|null>{
 signal.throwIfAborted()
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason)}
  signal.addEventListener('abort',abort,{once:true})
  pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
 })
}
function remember(cache:Map<string,string|null>,key:string,value:string|null){
 if(cache.size>=cacheLimit){const oldest=cache.keys().next();if(!oldest.done)cache.delete(oldest.value)}
 cache.set(key,value)
}
/** 只给测试用：清掉跨用例的同键缓存。 */
export function clearComposerSuggestionCache(){caches=new WeakMap()}

/**
 * 系统提示只描述"用户接下来会怎么说"，并给出明确的放弃条件；
 * 不引入任何新的事实来源，也不允许它编造待办。
 */
const systemPrompt=[
 'You predict the user\'s single next message in a chat with an AI employee.',
 'Use only the user question and assistant answer provided. Do not invent tasks, files, dates or numbers.',
 'Output exactly one short sentence in the user\'s own voice, at most 30 words, no quotes, no code block, no explanation.',
 'If the assistant is waiting for the user to provide material, a file, a list or an answer, write the sentence the user would send to provide it or to say to proceed (e.g. "我把清单发给你。", "按你说的继续。").',
 'If the assistant just delivered a result or file and nothing is pending, still suggest the short sentence the user would most likely send next (e.g. "我先打开看看效果。", "按这个版本继续。", "再调整一版。"), choosing only what the answer supports.',
 'Only output exactly NONE when even such a next sentence would be pure invention (for example a purely informational answer with no deliverable and no pending question).',
].join(' ')

export const composerSuggestionFailure=()=>new WorkError('teloa/unavailable','下一条建议暂不可用。')
