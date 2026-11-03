import assert from 'node:assert/strict'
import test from 'node:test'
import {readComposerSuggestionAnswer} from '../src/client/composer-suggestion-events.ts'

const user=(seq:number,kind='user')=>({event:{type:'user/message',seq,surfaceOp:'append',data:{source:{kind}}}})
const answer=(seq:number,turn=1,text='同一段回复')=>({event:{type:'assistant/message',seq,data:{turn,message:{content:[{type:'text',text}]}}}})
const end=(seq:number,turn=1,kind='completed')=>({event:{type:'turn/end',seq,data:{turn,reason:{kind}}}})

test('只有本人发起且同轮完成的非空回复才提供身份',()=>{
 assert.equal(readComposerSuggestionAnswer([answer(3),end(4)]),null)
 assert.equal(readComposerSuggestionAnswer([user(1,'runtime-context'),answer(3),end(4)]),null)
 assert.equal(readComposerSuggestionAnswer([user(1),answer(3)]),null)
 assert.equal(readComposerSuggestionAnswer([user(1),answer(3),end(4,2)]),null)
 assert.equal(readComposerSuggestionAnswer([user(1),answer(3),end(4,1,'cancelled')]),null)
 assert.equal(readComposerSuggestionAnswer([user(1),answer(3,1,''),end(4)]),null)
 assert.equal(readComposerSuggestionAnswer([user(1),answer(3),end(4)]),3)
})

test('新本人输入与新轮开始立即清掉旧身份，运行上下文不冒充新问题',()=>{
 const rows=[user(1),answer(3),end(4)]
 assert.equal(readComposerSuggestionAnswer([...rows,user(5)]),null)
 assert.equal(readComposerSuggestionAnswer([...rows,{event:{type:'turn/start',seq:5,data:{turn:2}}}]),null)
 assert.equal(readComposerSuggestionAnswer([...rows,user(5,'runtime-context')]),3)
 assert.equal(readComposerSuggestionAnswer([...rows,user(5),answer(7,2),end(8,2)]),7)
})
