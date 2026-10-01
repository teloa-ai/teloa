import type {ImAuditRow} from '../src/core/audit.ts'
import type {ImBinding} from '../src/core/bindings.ts'
import type {ApprovalCard,ImChannelAdapter,ImInbound} from '../src/core/types.ts'
import {bindingOf} from './router-fakes.ts'

/** 桩适配器：记录 send/sendCard/editMessage/ack；卡片 messageId 依次为 card-1、card-2…… */
export function recordingCardAdapter(id:'telegram'|'slack'|'feishu'='telegram',options:{maxMessageLength?:number;failCard?:boolean;holdCard?:Promise<unknown>;holdSend?:Promise<unknown>}={}){
 const sent:{chatId:string;text:string}[]=[]
 const cards:{chatId:string;card:ApprovalCard;messageId:string}[]=[]
 const edits:{chatId:string;messageId:string;text:string}[]=[]
 const acks:{messageId:string;text?:string}[]=[]
 const state:{handler?:(m:ImInbound)=>Promise<void>}={}
 const adapter:ImChannelAdapter={
  id,label:id,
  capabilities:{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:options.maxMessageLength??4096,rateLimitPerMinute:20},
  async start(handler){state.handler=handler},
  async stop(){},
  async send(chatId,text){
   if(options.holdSend)await options.holdSend
   sent.push({chatId,text});return {messageId:`msg-${sent.length}`}
  },
  async sendCard(chatId,card){
   if(options.failCard)throw new Error('network')
   if(options.holdCard)await options.holdCard
   const messageId=`card-${cards.length+1}`
   cards.push({chatId,card,messageId})
   return {messageId}
  },
  async editMessage(chatId,messageId,text){edits.push({chatId,messageId,text})},
  async ack(m,text){acks.push({messageId:m.messageId,...(text===undefined?{}:{text})})},
  status(){return {connected:true}},
 }
 return {adapter,sent,cards,edits,acks,state}
}

/** 可手动推进的定时器。 */
export function fakeTimers(){
 let seq=0
 const timers=new Map<number,{fn:()=>void;ms:number}>()
 return {
  setTimeout:(fn:()=>void,ms:number):unknown=>{const id=++seq;timers.set(id,{fn,ms});return id},
  clearTimeout:(id:unknown)=>{timers.delete(id as number)},
  /** 触发全部已登记定时器。 */
  fire(){const due=[...timers.values()];timers.clear();for(const t of due)t.fn()},
  size:()=>timers.size,
  ms:()=>[...timers.values()].map(t=>t.ms),
 }
}

export const tick=async(n=5)=>{for(let i=0;i<n;i+=1)await new Promise(resolve=>setImmediate(resolve))}
/** 按条件等待：真实插件装载的发卡要走异步文件读写，固定轮数在高负载下会等不够。超时即失败，报出等的是什么。 */
/** 只等正向信号：时限只决定失败要多久才报出来，不拖慢通过的用例；与其它套件高负载并跑时不给调度抖动留 5 秒这样的窄余量。 */
export const until=async(condition:()=>boolean,what:string,timeoutMs=30_000)=>{
 const deadline=Date.now()+timeoutMs
 while(!condition()){
  if(Date.now()>deadline)throw Error('等待超时：'+what)
  await new Promise(resolve=>setTimeout(resolve,5))
 }
}

/** 可控 Promise：测试决定何时 resolve/reject。 */
export function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(error:unknown)=>void
 const promise=new Promise<T>((a,b)=>{resolve=a;reject=b})
 return {promise,resolve,reject}
}

/** 结果探针：settled 前 value 为 undefined。 */
export function probe<T>(promise:Promise<T>){
 const state:{settled:boolean;value?:T;error?:unknown}={settled:false}
 promise.then(value=>{state.settled=true;state.value=value},error=>{state.settled=true;state.error=error})
 return state
}

/** 带会话的请求方：会话事件里有 callId 对应的 tool/call（arguments 为 JSON 原文）；args 为 undefined 时没有该事件。 */
export function agentWith(args:string|undefined,callId='call-1',id='sess-abc',name='bash'){
 const events=args===undefined?[]:[{type:'tool/call',seq:0,data:{callId,name,arguments:args}}]
 return {id,session:{snapshotEvents:()=>events}}
}

export function approvalHarness(options:{bindings?:ImBinding[];online?:string[];adapters?:Record<string,ImChannelAdapter>;maxMessageLength?:number;failCard?:boolean;holdCard?:Promise<unknown>;holdSend?:Promise<unknown>;workbenchUrl?:string}={}){
 const tg=recordingCardAdapter('telegram',options)
 const adapters:Record<string,ImChannelAdapter>={telegram:tg.adapter,...options.adapters}
 const rows=options.bindings??[bindingOf({chatId:'100'})]
 const audit:ImAuditRow[]=[]
 const timers=fakeTimers()
 let n=0
 const deps={
  bindings:{list:async(channelId?:string)=>rows.filter(row=>channelId===undefined||row.channelId===channelId)},
  adapter:(channelId:string)=>adapters[channelId],
  onlineChannels:()=>options.online??['telegram'],
  ownerId:'local:teloa-owner',
  audit:{record:async(row:ImAuditRow)=>{audit.push(row)}},
  now:()=>Date.parse('2026-09-26T00:00:00Z'),
  timeoutMs:30*60_000,
  random:()=>(++n).toString(16).padStart(8,'0'),
  setTimeout:timers.setTimeout,
  clearTimeout:timers.clearTimeout,
  workbenchUrl:()=>options.workbenchUrl,
 }
 return {deps,tg,audit,timers,rows}
}

export const click=(patch:Partial<ImInbound>&{callbackId:string;value?:'approve'|'reject'}):ImInbound=>{
 const {callbackId,value,...rest}=patch
 return {
  channelId:'telegram',chatId:'100',chatKind:'direct',messageId:'card-1',
  sender:{imUserId:'u1',displayName:'张三'},text:'',mentions:[],media:[],
  action:{callbackId,value:value??'approve',callbackToken:'q1'},
  at:'2026-09-26T00:00:00.000Z',raw:{},
  ...rest,
 }
}
