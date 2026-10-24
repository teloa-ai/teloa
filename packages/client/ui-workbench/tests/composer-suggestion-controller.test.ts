import assert from 'node:assert/strict'
import test from 'node:test'
import {ComposerSuggestionController} from '../src/client/composer-suggestion-controller.ts'

const answered=(c:ComposerSuggestionController,seq=7,text='清单已核对完。要不要我接着按前缀分组再出一版？')=>{c.completeAnswer(seq,text);return c}

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

test('点进输入框就让候选消失，且同一条回复不再弹',()=>{
 const c=answered(new ComposerSuggestionController(true))
 c.focus()
 assert.notEqual(c.decision,'show')
 assert.deepEqual(c.snapshot.dismissed,[7])
 // 同一条回复再"完成"一次也不会复活
 c.completeAnswer(7,'清单已核对完。要不要我接着按前缀分组再出一版？')
 assert.notEqual(c.decision,'show')
 // 换一条新回复才允许重新给
 c.completeAnswer(8,'请把清单原件发过来，我按六步跑完。')
 assert.equal(c.decision,'show')
})

test('直接开始输入也等于放弃候选，且不覆盖本人输入',()=>{
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
 c.completeAnswer(9,'本批核验已完成，结论可追溯。')
 assert.equal(c.snapshot.text,null)
 assert.equal(c.decision,'hidden-empty')
})

test('输入只临时隐藏，删回空后同一条回复的候选重新出现',()=>{
 const c=new ComposerSuggestionController(true)
 c.completeAnswer(7,'清单已核对完。要不要我接着按前缀分组再出一版？')
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

