import {readSavedPlan,type PlanApi,type SavedPlan} from './plan-api.ts'

type Snapshot={status:'loading'|'ready'|'failed';plans:readonly SavedPlan[]}
/** 只缓存同一计划服务的读回值；会话入口不复制计划或改变调度目的地。 */
export function createConversationPlanDirectory(api:Pick<PlanApi,'list'>){
 let snapshot:Snapshot={status:'loading',plans:[]},generation=0
 const listeners=new Set<()=>void>(),openers=new Set<(id:string)=>void>()
 const publish=(next:Snapshot)=>{snapshot=next;listeners.forEach(listener=>listener())}
 return {
  getSnapshot:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
  onOpen:(listener:(id:string)=>void)=>{openers.add(listener);return()=>{openers.delete(listener)}},
  open:(id:string)=>{openers.forEach(listener=>listener(id))},
  merge:(rows:readonly SavedPlan[])=>{
   const plans=[...snapshot.plans];let changed=false
   for(const row of rows){const index=plans.findIndex(plan=>plan.id===row.id);if(index>=0&&plans[index]!.version>=row.version)continue;if(index>=0)plans[index]=row;else plans.push(row);changed=true}
   if(changed)publish({...snapshot,plans})
  },
  refresh:async()=>{
   const current=++generation
   try{const plans=await api.list();if(current===generation)publish({status:'ready',plans:plans.map(row=>{const cached=snapshot.plans.find(plan=>plan.id===row.id);return cached&&cached.version>row.version?cached:row})});return plans}
   catch(error){if(current===generation)publish({status:'failed',plans:[]});throw error}
  },
 }
}
export type ConversationPlanDirectory=ReturnType<typeof createConversationPlanDirectory>
export const plansForConversation=(plans:readonly SavedPlan[],sessionId:string)=>plans.filter(plan=>plan.state!=='archived'&&(plan.source.kind==='manual'?plan.source.sessionId===sessionId:plan.source.kind==='method-reuse'&&plan.source.acceptedSource?.sessionId===sessionId))

export type ConversationPlanEvents={entries:readonly {event:{type:string;seq:number;data:unknown}}[]}
/** 只从该轮已落盘且匹配调用的成功回执取身份，不能由助手文本生成计划入口。 */
export function conversationTurnPlanIds(entries:ConversationPlanEvents['entries'],turn:number):string[]{
 const calls=new Set<string>(),ids=new Set<string>()
 for(const {event} of entries){
  if(!event.data||typeof event.data!=='object')continue
  const data=event.data as {turn?:number;name?:string;callId?:string;error?:unknown;message?:{toolCallId?:string;isError?:boolean;content?:{type:string;text?:string}[]}}
  if(data.turn!==turn)continue
  if(event.type==='tool/call'&&['teloa_plans_create','teloa_plans_change','teloa_plans_update'].includes(data.name??'')&&data.callId)calls.add(data.callId)
  if(event.type==='tool/result'&&data.message?.toolCallId&&calls.has(data.message.toolCallId)&&!data.message.isError&&!data.error)try{const value=JSON.parse(data.message.content?.filter(item=>item.type==='text').map(item=>item.text??'').join('\n')??'');ids.add(readSavedPlan(value.plan).id)}catch{/* 损坏或非计划回执不生成入口。 */}
 }
 return [...ids]
}
