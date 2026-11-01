import assert from 'node:assert/strict'
import test from 'node:test'
import {ComposerSuggestionController} from '../src/client/composer-suggestion-controller.ts'

const answered=(c:ComposerSuggestionController,seq=7)=>{c.completeAnswer(seq);c.setCandidate(seq,'要，请继续。');return c}

test('等待模型时不显示本地模板，宿主结果决定实际候选',()=>{
 const c=new ComposerSuggestionController(true)
 c.completeAnswer(12)
 assert.equal(c.snapshot.text,null)
 assert.equal(c.decision,'hidden-empty')
 c.setCandidate(12,'我准备好了，请继续。')
 assert.equal(c.snapshot.text,'我准备好了，请继续。')
})

test('上一条回复的迟到候选不能覆盖当前回复',()=>{
 const c=new ComposerSuggestionController(true)
 c.completeAnswer(12);c.completeAnswer(18)
 c.setCandidate(12,'旧建议')
 assert.equal(c.snapshot.answerSeq,18)
 assert.equal(c.snapshot.text,null)
 c.setCandidate(18,null)
 c.setCandidate(18,'不能用重复请求补成建议')
 assert.equal(c.snapshot.text,null)
})

test('回复结束后给出候选，但只有空且未聚焦时才可见',()=>{
 const c=answered(new ComposerSuggestionController(true))
 assert.equal(c.decision,'show')
 assert.equal(c.snapshot.text,'要，请继续。')
})

test('Tab 采纳只交出文字，绝不发送；采纳后候选清空',()=>{
 const c=answered(new ComposerSuggestionController(true))
 const accepted=c.accept()
 assert.equal(accepted,'要，请继续。')
 assert.equal(c.snapshot.text,null,'采纳后候选必须清空')
 // 调用方把文字放进草稿：此时建议已经藏起来，且没有任何发送动作。
 c.setDraft(accepted!)
 assert.notEqual(c.decision,'show','采纳后候选不得再显示')
 assert.equal(c.snapshot.draft,'要，请继续。')
})

test('主动丢弃让候选消失，且同一条回复不再弹',()=>{
 const c=answered(new ComposerSuggestionController(true))
 c.dismiss()
 assert.notEqual(c.decision,'show')
 assert.deepEqual(c.snapshot.dismissed,[7])
 // 同一条回复再"完成"一次也不会复活
 c.completeAnswer(7)
 assert.notEqual(c.decision,'show')
 // 换一条新回复才允许重新给
 c.completeAnswer(8)
 c.setCandidate(8,'请列出核验步骤。')
 assert.equal(c.decision,'show')
})

test('直接开始输入暂隐候选，且不覆盖本人输入',()=>{
 const c=answered(new ComposerSuggestionController(true))
 c.setDraft('我自己的问题')
 assert.equal(c.snapshot.draft,'我自己的问题')
 assert.notEqual(c.decision,'show')
})

test('Escape 丢弃当前候选',()=>{
 const c=answered(new ComposerSuggestionController(true))
 c.escape()
 assert.notEqual(c.decision,'show')
})

test('开关关闭时不给候选、Tab 也不吃键',()=>{
 const c=answered(new ComposerSuggestionController(false))
 assert.equal(c.decision,'hidden-disabled')
 assert.equal(c.accept(),null)
})

test('回复没有可核对的下一步时不给候选（不编造）',()=>{
 const c=new ComposerSuggestionController(true)
 c.completeAnswer(9)
 assert.equal(c.snapshot.text,null)
 assert.equal(c.decision,'hidden-empty')
})

test('输入只临时隐藏，删回空后同一条回复的候选重新出现',()=>{
 const c=new ComposerSuggestionController(true)
 c.completeAnswer(7)
 c.setCandidate(7,'要，请继续。')
 assert.equal(c.decision,'show')
 c.setDraft('我想想')
 assert.equal(c.decision,'hidden-busy')
 c.setDraft('')
 assert.equal(c.decision,'show')
 // 但 Escape 仍是永久丢弃：删空也不回来
 c.escape()
 c.setDraft('')
 assert.notEqual(c.decision,'show')
})

