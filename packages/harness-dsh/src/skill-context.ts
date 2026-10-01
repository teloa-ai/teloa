import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import { isRecord } from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'

// 原生工具仍执行校验和读取；只收敛已经存在于当前模型上下文的重复文本。
export function registerSkillContextDedup(ctx:Context):void {
  ctx.on('tools/post-execute',async(exec,result,next)=>{
    const decision=await next()
    if(exec.name!=='skill'||!exec.agent||exec.signal.aborted||result.isError||decision.kind!=='accept'||decision.content!==undefined||decision.value!==undefined)return decision
    if(!isRecord(exec.arguments)||typeof exec.arguments.name!=='string'||!isRecord(result.value)||result.value.name!==exec.arguments.name)return decision
    const content=result.content
    if(content.length!==1||content[0]?.type!=='text')return decision
    const session=exec.agent.session,visible=new Set(session.surface.nodes),events=readSessionEvents(session)
    for(let i=events.length-1;i>=0;i--){
      const event=events[i]!
      if(event.type!=='user/message'||!visible.has(event.seq)||event.data.source.kind!=='skill-invocation'||event.data.source.name!==exec.arguments.name||event.data.source.form!=='instructions')continue
      // 最近一份同名指令是比较依据，不能命中更早但已被新正文取代的版本。
      const original=event.data.content
      if(original.length!==1||original[0]?.type!=='text'||original[0].text!==content[0].text)return decision
      return {...decision,content:[{type:'text',text:'Skill '+exec.arguments.name+' 已在当前上下文提供（原生消息 seq '+event.seq+'）；本次原生校验通过，正文一致，请沿用该指令。'}]}
    }
    return decision
  })
}
