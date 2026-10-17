import type {Context} from '@deepseek-ai/cordis'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {isRecord} from '@teloa/contract'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import type {ConversationWorkAuthorizationPorts} from './conversation-work-tools.ts'
import {resultPresentationGuide} from './work-prompts/result-presentation.ts'
import {voiceToolsName} from './voice-tool-loading.ts'

const memberStates={received:'已收到回复',waiting:'尚未收到最终回复',unavailable:'员工不可用',failed:'执行失败',stopped:'已停止'} as const
const taskStates={ready:'待开始',running:'进行中',paused:'已暂停',waiting:'待验收',blocked:'受阻',completed:'已验收完成',cancelled:'已取消'} as const
const label=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=512

/** 仅摘取正式工作回执的名称和独立状态；不转述员工正文，也不推断业务完成。 */
function workSummary(raw:unknown):string{
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>131072)return ''
 let value:unknown
 try{value=JSON.parse(raw)}catch{return ''}
 const items=Array.isArray(value)?value:[value],lines:string[]=[]
 for(const item of items.slice(0,32)){
  if(!isRecord(item)||!label(item.title)||!Array.isArray(item.members)||item.members.length>1000)continue
  const members:string[]=[]
  for(const member of item.members.slice(0,32)){
   if(!isRecord(member)||!label(member.name)||typeof member.status!=='string'||!Object.hasOwn(memberStates,member.status))continue
   const execution=memberStates[member.status as keyof typeof memberStates],task=member.task
   const acceptance=isRecord(task)&&typeof task.state==='string'&&Object.hasOwn(taskStates,task.state)?taskStates[task.state as keyof typeof taskStates]:undefined
   const next=member.status==='received'&&isRecord(task)&&task.state==='waiting'?'\n下一步：从本会话交办卡的工作名称打开原任务核对结果。':''
   members.push(`${member.name}：${execution}${acceptance?'；任务状态：'+acceptance:''}${next}`)
  }
  if(members.length)lines.push(`${item.title}${item.approvalState==='approved'?'（本次交办审批已通过）':''}\n${members.join('\n')}`)
 }
 return lines.length?'\n本次回包的可读状态（仅列当前摘取项，不代表全部工作或业务已验收）：\n'+lines.join('\n\n'):''
}

/** 官方工具结果的后续上下文，不改回包/历史，不在空步骤注入或唤醒额外用户轮次。 */
export function registerConversationResultPresentation(ctx:Context,ports:ConversationWorkAuthorizationPorts){
 return ctx.on('tools/post-execute',async(exec,result,next)=>{
  const decision=await next()
  if(exec.name===voiceToolsName||!exec.name.startsWith('teloa_')||!exec.agent||exec.signal.aborted||result.isError||result.concludesTurn||decision.kind!=='accept'||decision.content!==undefined||decision.value!==undefined)return decision
  try{
   await authorizeOrdinaryConversationMutation({...ports,agent:exec.agent,signal:exec.signal},'结果说明')
   const id=exec.agent.session.id
   if(await ports.isRoleConversation(id)||await ports.isTaskConversation?.(id)||await ports.isPendingDaily?.(id))return decision
  }catch{return decision}
  if(exec.signal.aborted)return decision
  const summary=exec.name.startsWith('teloa_work_')?workSummary(result.value):''
  const notice=createUserMessage({source:{kind:'plugin:teloa.work',form:'notice',summary:'本次结果的名称与状态说明'},content:[{type:'text',text:resultPresentationGuide+summary}]})
  return {...decision,additionalContexts:[...decision.additionalContexts??[],notice]}
 })
}
