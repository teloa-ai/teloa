import assert from 'node:assert/strict'
import test from 'node:test'
import {SlotCore,type PropsRenderSlots} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {nativeFeedbackDialog} from '../src/client/TeloaFeedbackBridge.ts'

test('通过公开槽位读取原生对话框状态，只借用开关，不调用原生提交',()=>{
  const slots=new SlotCore(),state={target:{kind:'session'}},listeners=new Set<()=>void>()
  let submitted=0,closed=0,session=''
  slots.register({name:'root',children:{'conversation.input.overlay':{kind:'list',scope:'session'}}},
    ({renderSlot}:PropsRenderSlots<'conversation.input.overlay'>)=>renderSlot('conversation.input.overlay',{}))
  const remove=slots.register({name:'conversation.input.overlay',id:'feedback-dialog',inject:id=>{
    session=id
    return {hooks:{dialog:{getSnapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener)}}},dismiss:()=>{closed++},submit:()=>{submitted++}}
  }},()=>null)
  slots.register({name:'conversation.input.overlay',id:'feedback-dialog',priority:-100},()=>null)
  const face=nativeFeedbackDialog(slots.entries('conversation.input.overlay'),'session-a')
  assert.ok(face)
  assert.equal(session,'session-a')
  assert.equal(face.nativeDialog.getSnapshot(),state)
  face.dismissNative()
  assert.equal(closed,1)
  assert.equal(submitted,0)
  remove()
  assert.equal(nativeFeedbackDialog(slots.entries('conversation.input.overlay'),'session-a'),null)
})

test('公开接口形状不匹配时拒绝适配，不猜测内部方法',()=>{
  assert.equal(nativeFeedbackDialog([{component:()=>null,options:{id:'feedback-dialog'},inject:()=>({submit:()=>{throw Error('must not submit')}})}],'session-a'),null)
})
