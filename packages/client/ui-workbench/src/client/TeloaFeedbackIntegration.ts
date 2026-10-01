import {createElement} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import type {StoredEntry} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {TeloaI18n} from './i18n/index.js'
import {I18nProvider} from './i18n/provider.js'
import {TeloaFeedback,type TeloaFeedbackProps} from './TeloaFeedback.js'
import {TeloaFeedbackModel} from './TeloaFeedbackClient.js'
import {nativeFeedbackDialog} from './TeloaFeedbackBridge.js'

/** 仅覆盖官方公开槽位单元；官方服务继续管理菜单入口及每会话打开状态。 */
export function installTeloaFeedback(ctx:Context,runtime:()=>TeloaI18n):void{
  const models=new Map<string,TeloaFeedbackModel>()
  ctx.effect(()=>()=>models.clear(),'teloa: 反馈草稿生命周期')
  ctx.slots.inject('conversation.input.overlay',()=>{
    let source:StoredEntry|undefined,remove:(()=>void)|undefined
    const View=(props:TeloaFeedbackProps)=>createElement(I18nProvider,{runtime:runtime()},createElement(TeloaFeedback,props))
    const refresh=()=>{
      const entries=ctx.slots.entries('conversation.input.overlay')
      const next=entries.find(entry=>entry.options.id==='feedback-dialog'&&(entry.options.priority??0)===0)
      if(next===source)return
      remove?.();remove=undefined;source=next
      if(!source)return
      remove=ctx.slots.register({name:'conversation.input.overlay',id:'feedback-dialog',order:2,priority:-100,
        inject:sessionId=>{
          const native=nativeFeedbackDialog(ctx.slots.entries('conversation.input.overlay'),sessionId)
          if(!native)throw new Error('DSH feedback public interface is unavailable')
          let model=models.get(sessionId)
          if(!model){model=new TeloaFeedbackModel(undefined,__TELOA_VERSION__);models.set(sessionId,model)}
          return {...native,model}
        },
      },View)
    }
    const off=ctx.slots.subscribe('conversation.input.overlay',refresh)
    refresh()
    return ()=>{off();remove?.()}
  })
}
