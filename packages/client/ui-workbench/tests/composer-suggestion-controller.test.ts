import assert from 'node:assert/strict'
import test from 'node:test'
import {ComposerSuggestionController,createSuggestionValidity} from '../src/client/composer-suggestion-controller.ts'

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



test('缓存撤回/异常即清候选，重复轮询共享读取且 dispose 后迟答无效',async()=>{
 let resolve!:(text:string|null)=>void,calls=0,invalidated=0,signal:AbortSignal|undefined
 const c=answered(new ComposerSuggestionController(true))
 const v=createSuggestionValidity(s=>{calls++;signal=s;return new Promise(done=>{resolve=done})},c.snapshot.text!,()=>{invalidated++;c.dismiss()})
 const first=v.check(),duplicate=v.check();assert.equal(first,duplicate)
 await Promise.resolve();assert.equal(calls,1)
 resolve(null);assert.equal(await first,false);assert.notEqual(c.decision,'show');assert.equal(invalidated,1)
 const late=createSuggestionValidity(s=>{signal=s;return new Promise(done=>{resolve=done})},'旧候选',()=>{invalidated++})
 const pending=late.check();await Promise.resolve();late.dispose();assert.equal(signal?.aborted,true)
 resolve(null);assert.equal(await pending,false);assert.equal(invalidated,1)
 const failed=createSuggestionValidity(async()=>{throw Error('unavailable')},'候选',()=>{invalidated++})
 assert.equal(await failed.check(),false);assert.equal(invalidated,2)
})

test('Tab 独立 fresh 检查使旧轮询乱序回执无效；等待期间编辑使原快照失效',async()=>{
 const reads:Array<{signal:AbortSignal;resolve:(text:string|null)=>void}>=[]
 let invalidated=0
 const c=answered(new ComposerSuggestionController(true)),candidate=c.snapshot
 const v=createSuggestionValidity(signal=>new Promise(resolve=>reads.push({signal,resolve})),candidate.text!,()=>{invalidated++;c.dismiss()})
 const background=v.check();await Promise.resolve()
 const tab=v.check(true);await Promise.resolve();assert.equal(reads.length,2);assert.equal(reads[0]!.signal.aborted,true)
 reads[0]!.resolve(null);assert.equal(await background,false);assert.equal(invalidated,0)
 c.setDraft('本人等待期间继续输入')
 reads[1]!.resolve(candidate.text);assert.equal(await tab,true)
 assert.notEqual(c.snapshot,candidate,'Dock 必须在 await 后比对原快照，不能覆盖本人新稿')
 assert.equal(c.accept(),null)
 assert.equal(c.snapshot.draft,'本人等待期间继续输入')
 v.dispose()
})
