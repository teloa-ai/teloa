/**
 * 提问旁路 answerer（dsh-user-questions `user-questions/request`，规格 §6）：以 `{global:true,prepend:true}` 挂在最前，
 * 先把问题以编号文本发到绑定者私聊，再 `next()` 交工作台，二者竞速，与审批同一口径：
 * - 真实回答（IM 回复完全部问题，或工作台给出答案）先到者生效；工作台先答则在 IM 回「已在网页回答」；
 * - 工作台 `next()` 抛错（链尾默认是 reject UserQuestionError NO_PROVIDER，见 dsh-user-questions/lib/index.js noAnswerer；
 *   或工作台已连接但未接收）不算回答：记下后继续等 IM，30 分钟超时撤下并原样抛出记下的错误；
 * - 每个 (渠道, 聊天) 同时只挂一个提问，其余直接交工作台；只认绑定者本人在该私聊里的回复。
 */
import type {AskUserQuestionAnswer,AskUserQuestionAnswerItem,AskUserQuestionItem,AskUserQuestionRequestEvent} from '@deepseek-ai/dsh-user-questions/types'
import {pickTarget,withWorkbenchLink,withinSendLimit,type ApprovalDeps} from './approval.ts'
import {redact} from './audit.ts'
import type {ImBinding} from './bindings.ts'
import {truncate} from './truncate.ts'
import type {ImInbound} from './types.ts'

type Race={side:'im';answer:AskUserQuestionAnswer}|{side:'workbench';ok:true;answer:AskUserQuestionAnswer}|{side:'workbench';ok:false;error:unknown}|{side:'timeout'}|{side:'abort'}|{side:'withdrawn'}
type Pending={channelId:string;chatId:string;imUserId:string;questions:AskUserQuestionItem[];answers:AskUserQuestionAnswerItem[];settled:boolean;withdraw:()=>void;answered:(answer:AskUserQuestionAnswer)=>void}

const customMax=2000
const footer=(item:AskUserQuestionItem)=>item.options?.length?(item.multiSelect?'回复编号（可多选，用逗号分隔）或直接输入':'回复编号或直接输入'):'直接输入回答'

/** 问题 + 编号选项 + 提示；正文按审计口径脱敏，按渠道上限截断（提示行保留）。 */
function questionText(item:AskUserQuestionItem,index:number,total:number,max:number):string{
 const body=[
  ...(total>1?[`（${index+1}/${total}）`]:[]),
  ...(item.header?[item.header]:[]),
  item.question,
  ...(item.detail?[item.detail]:[]),
  ...(item.options??[]).map((option,i)=>`${i+1}. ${option.label}${option.description?` — ${option.description}`:''}`),
 ].join('\n')
 const tail=footer(item)
 return `${truncate(redact(body),Math.max(1,max-tail.length-1))}\n${tail}`
}

/** 纯编号且都在范围内 → 选项；单选只认一个编号；其余按自由文本。 */
function parseAnswer(item:AskUserQuestionItem,text:string):AskUserQuestionAnswerItem{
 const options=item.options??[]
 if(options.length&&/^\d+(?:\s*[,，、\s]\s*\d+)*$/.test(text)){
  const picks=[...new Set(text.split(/[,，、\s]+/).map(Number))]
  if(picks.every(n=>n>=1&&n<=options.length)&&(item.multiSelect||picks.length===1))return {id:item.id,selected:picks.map(n=>options[n-1]!.label)}
 }
 return {id:item.id,selected:[],custom:truncate(text,customMax)}
}

export function createImQuestions(deps:ApprovalDeps){
 const pending=new Map<string,Pending>()
 const keyOf=(channelId:string,chatId:string)=>`${channelId}\n${chatId}`
 const send=(row:Pick<Pending,'channelId'|'chatId'>,text:string)=>deps.adapter(row.channelId)?.send(row.chatId,text).then(()=>{},()=>{})
 const expiredText=()=>withWorkbenchLink(deps,'已过期，请到工作台回答')
 const maxOf=(channelId:string)=>deps.adapter(channelId)?.capabilities.maxMessageLength??4000
 const withdrawWhere=async(match:(row:Pending)=>boolean,text:string)=>{
  const rows=[...pending.values()].filter(match)
  for(const row of rows)row.withdraw()
  await Promise.all(rows.map(row=>send(row,text)))
 }

 return {
  async answerer(this:unknown,request:AskUserQuestionRequestEvent,next:()=>Promise<AskUserQuestionAnswer>):Promise<AskUserQuestionAnswer>{
   const target=await pickTarget(deps,'text')
   if(!target||!request.questions.length)return next()
   const {adapter,binding}=target
   const key=keyOf(binding.channelId,binding.chatId)
   if(pending.has(key))return next()
   let settleRace!:(race:Race)=>void
   const signal=new Promise<Race>(resolve=>{settleRace=resolve})
   const settle=(race:Race)=>{
    if(row.settled)return
    row.settled=true
    if(pending.get(key)===row)pending.delete(key)
    settleRace(race)
   }
   const row:Pending={
    channelId:binding.channelId,chatId:binding.chatId,imUserId:binding.imUserId,questions:request.questions,answers:[],settled:false,
    withdraw:()=>settle({side:'withdrawn'}),
    answered:answer=>settle({side:'im',answer}),
   }
   // 先占位再发：发送期间同一聊天的新提问直接交工作台。
   pending.set(key,row)
   // 至多等 5 秒：超时立即交工作台，迟到送达的提问补一条转工作台文案（文字消息无法撤回）。
   const sent=await withinSendLimit(deps,adapter.send(binding.chatId,questionText(request.questions[0]!,0,request.questions.length,maxOf(binding.channelId))),
    ()=>void send(row,withWorkbenchLink(deps,'发送超时，请到工作台回答'))).catch(()=>undefined)
   if(!sent){
    if(pending.get(key)===row)pending.delete(key)
    return next()
   }
   const onAbort=()=>settle({side:'abort'})
   request.signal?.addEventListener('abort',onAbort,{once:true})
   if(request.signal?.aborted)onAbort()
   const timer=deps.setTimeout(()=>settle({side:'timeout'}),deps.timeoutMs)
   const workbench=next().then(answer=>({side:'workbench',ok:true,answer}) as Race,(error:unknown)=>({side:'workbench',ok:false,error}) as Race)
   const cleanup=()=>{
    row.settled=true
    if(pending.get(key)===row)pending.delete(key)
    deps.clearTimeout(timer)
    request.signal?.removeEventListener('abort',onAbort)
   }
   let failed:{error:unknown}|undefined
   /** IM 侧已结束但未回答：工作台已失败就抛出 reason（取消时为取消原因），否则继续等工作台。 */
   const fallBack=async(reason?:unknown):Promise<AskUserQuestionAnswer>=>{
    if(failed)throw reason??failed.error
    const result=await workbench
    if(result.side==='workbench'&&result.ok)return result.answer
    throw result.side==='workbench'&&!result.ok?result.error:new Error('user-questions: no answer')
   }
   for(;;){
    const race=await Promise.race(failed?[signal]:[signal,workbench])
    switch(race.side){
     case 'im':
      cleanup()
      return race.answer
     case 'workbench':
      if(race.ok){
       cleanup()
       await send(row,'已在网页回答')
       return race.answer
      }
      // 链尾默认错误或工作台未接收，不算回答；继续等 IM 直到超时。
      failed={error:race.error}
      continue
     case 'timeout':
      cleanup()
      await send(row,expiredText())
      return fallBack()
     case 'abort':
      cleanup()
      await send(row,'提问已取消')
      return fallBack(request.signal?.reason??new Error('aborted'))
     case 'withdrawn':
      cleanup()
      return fallBack()
    }
   }
  },
  /** 绑定者本人在该私聊里的回复 → 当前问题的回答；答完最后一题才交回 dsh。 */
  async tryAnswer(channelId:string,m:ImInbound,binding:ImBinding):Promise<boolean>{
   const row=pending.get(keyOf(channelId,m.chatId))
   if(!row||row.settled||m.sender.imUserId!==row.imUserId||binding.channelId!==row.channelId||binding.imUserId!==row.imUserId)return false
   const text=m.text.trim()
   const item=row.questions[row.answers.length]!
   if(!text){await send(row,footer(item));return true}
   row.answers.push(parseAnswer(item,text))
   await deps.audit.record({at:new Date(deps.now()).toISOString(),channelId,chatId:m.chatId,imUserId:m.sender.imUserId,messageId:m.messageId,action:'question-answer',result:'ok'}).catch(()=>{})
   const index=row.answers.length
   if(index<row.questions.length){
    await send(row,questionText(row.questions[index]!,index,row.questions.length,maxOf(channelId)))
    return true
   }
   row.answered({answers:row.answers})
   return true
  },
  withdrawChannel(channelId:string):Promise<void>{
   return withdrawWhere(row=>row.channelId===channelId,'渠道已停用，请到工作台处理')
  },
  withdrawUser(channelId:string,imUserId:string):Promise<void>{
   return withdrawWhere(row=>row.channelId===channelId&&row.imUserId===imUserId,'已失效')
  },
  /** 插件释放：全部提问发停止文案并撤下，不产生回答。 */
  withdrawAll():Promise<void>{
   return withdrawWhere(()=>true,'IM 通道已停止，请到工作台处理')
  },
  pendingCount():number{
   return pending.size
  },
 }
}
