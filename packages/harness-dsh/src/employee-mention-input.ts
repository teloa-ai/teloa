import type {Agent} from '@deepseek-ai/dsh-agent'
import type {UserMessage} from '@deepseek-ai/dsh-llm'
import {WorkError,singleEmployeeMention} from '@teloa/contract'
import type {EmployeeMentionContextPorts} from './employee-mention-context.ts'

export type EmployeeMentionInputPreflight={prepare:(agent:Agent,message:UserMessage)=>Promise<void>}
declare module '@deepseek-ai/cordis'{interface Context{readonly teloaEmployeeMentionInput:EmployeeMentionInputPreflight}}
/** 正常 Controller 在发布输入前调用；不发送、不保存草稿、不重放未知回执。 */
export function createEmployeeMentionInputPreflight(ports:Pick<EmployeeMentionContextPorts,'applies'|'resolve'>):EmployeeMentionInputPreflight{
 return {async prepare(agent,message){
  if(message.source.kind!=='user')return
  // 固定Task/岗位/子任务仍由原准入拥有身份；其原指令可含父会话的员工引用。
  if(agent.session.header.origin==='subagent'||!await ports.applies(agent.session.id))return
  const text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
  let selected:boolean
  try{selected=singleEmployeeMention(text)!==undefined}catch(error){throw new WorkError('teloa/forbidden',error instanceof Error?error.message:'员工引用无法核对，原文已保留。')}
  if(!selected)return
  const selection=await ports.resolve(agent.session.id,text)
  if(!selection)throw new WorkError('teloa/forbidden','所选员工来源无法核对；原文已保留。')
  await selection.assertCurrent()
 }}
}
/** 未完成宿主装配时也不能把手输/粘贴的 canonical 引用当普通名字接收。 */
export async function prepareEmployeeMentionOwnerInput(agent:Agent,message:UserMessage):Promise<void>{
 if(message.source.kind!=='user')return
 const text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
 if(!text.includes('[teloa-employee:'))return
 const preflight=agent.ctx.get('teloaEmployeeMentionInput')
 if(!preflight)throw new WorkError('teloa/unavailable','员工沟通服务正在准备；原文已保留，请稍后再发。')
 await preflight.prepare(agent,message)
}
