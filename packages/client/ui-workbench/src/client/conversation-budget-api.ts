import {readWorkBudgetPolicy,taskInput,workUuid,type WorkBudgetPolicy} from '@teloa/contract'

export type ConversationBudgetSettings={sessionId:string;version:number;configured:boolean;policy:WorkBudgetPolicy}
type Command={sessionId:string;requestId:string;expectedVersion:number;policy:WorkBudgetPolicy}
const validSession=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
function read(value:unknown,sessionId:string):ConversationBudgetSettings{
 const row=taskInput(value,['sessionId','version','configured','policy'])
 if(row.sessionId!==sessionId||!Number.isSafeInteger(row.version)||Number(row.version)<0||typeof row.configured!=='boolean'||(row.configured?Number(row.version)<1:row.version!==0))throw Error('新任务额度回执与当前会话不一致。')
 const policy=readWorkBudgetPolicy(row.policy)
 if(policy.money!==null)throw Error('新任务额度不支持金额设置。')
 return {sessionId,version:Number(row.version),configured:row.configured,policy}
}
export function createConversationBudgetApi(call:(endpoint:string,payload:unknown)=>Promise<unknown>,id=()=>crypto.randomUUID()){
 const pending=new Map<string,Command>(),busy=new Set<string>()
 const send=async(sessionId:string)=>{
  const command=pending.get(sessionId)
  if(!command||busy.has(sessionId))throw Error('请先核对原新任务额度请求。')
  busy.add(sessionId)
  try{
   const result=read(await call('conversation-budgets/configure',command),sessionId)
   if(result.version!==command.expectedVersion+1||!result.configured||Object.entries(command.policy).some(([key,value])=>JSON.stringify(value)!==JSON.stringify(result.policy[key as keyof WorkBudgetPolicy])))throw Error('新任务额度回执与保存内容不一致。')
   pending.delete(sessionId);return result
  }catch(error){
   if(error&&typeof error==='object'&&'rejected'in error&&error.rejected===true)pending.delete(sessionId)
   throw error
  }finally{busy.delete(sessionId)}
 }
 return {
  async read(sessionId:string){if(!validSession(sessionId))throw Error('会话身份不正确。');return read(await call('conversation-budgets/read',{sessionId}),sessionId)},
  configure(current:ConversationBudgetSettings,policy:WorkBudgetPolicy){
   if(!validSession(current.sessionId)||!Number.isSafeInteger(current.version)||current.version<0||pending.has(current.sessionId))throw Error('请先核对上次新任务额度保存结果。')
   const requestId=id(),validated=readWorkBudgetPolicy(policy)
   if(!workUuid(requestId)||validated.money!==null)throw Error('新任务额度请求不正确。')
   pending.set(current.sessionId,{sessionId:current.sessionId,requestId,expectedVersion:current.version,policy:validated})
   return send(current.sessionId)
  },
  pending:(sessionId:string)=>pending.has(sessionId),
  recover:send,
 }
}
export type ConversationBudgetApi=ReturnType<typeof createConversationBudgetApi>
