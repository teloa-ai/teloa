import type {Agent} from '@deepseek-ai/dsh-agent'
import {WorkError} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'

type Lease={requestId:string;text:boolean;capability:string;dispose:()=>void}
const leases=new WeakMap<Agent,Lease>()
function boundary(agent:Agent,requestId:string):{accepted:boolean;ended:boolean}{
 const events=readSessionEvents(agent.session),root=events.find(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'&&Reflect.get(event.data.source,'rpcId')===requestId)
 // followup先写队列再开始turn；已入原生队列同样不能被普通清理撤销能力。
 if(!root){const accepted=events.some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(input=>{const source=Reflect.get(input,'source');return source&&typeof source==='object'&&Reflect.get(source,'kind')==='user'&&Reflect.get(source,'rpcId')===requestId}));return {accepted,ended:false}}
 const start=events.filter(event=>event.type==='turn/start'&&event.seq<=root.seq).at(-1)
 if(!start||start.type!=='turn/start')return {accepted:true,ended:false}
 const turn=start.data.turn
 return {accepted:true,ended:events.some(event=>event.type==='turn/end'&&event.seq>root.seq&&event.data.turn===turn)}
}
/** 只在同Agent下一份可信Run输入开始时替换旧租约；在途调用者不能提前撤回文本限制。 */
export function leaseRunTools(agent:Agent,requestId:string,text:boolean,install:()=>()=>void,capability=''):()=>void{
 const previous=leases.get(agent)
 if(previous&&previous.requestId!==requestId){
  if(agent.status!=='idle'||!boundary(agent,previous.requestId).ended)throw new WorkError('teloa/conflict','原运行的原生轮次尚未结束，不能替换其工具能力。')
  previous.dispose();leases.delete(agent)
 }
 let current=leases.get(agent)
 if(current){if(current.text!==text||current.capability!==capability)throw new WorkError('teloa/conflict','同一运行不能替换已冻结的执行能力。')}
 else{current={requestId,text,capability,dispose:install()};leases.set(agent,current)}
 const owned=current
 return ()=>{
  if(leases.get(agent)!==owned)return
  // 已交给原生的执行能力保持到下一份正式Run；关闭观察器或普通清理不能撤销在途守卫。
  if(boundary(agent,requestId).accepted)return
  leases.delete(agent);owned.dispose()
 }
}
