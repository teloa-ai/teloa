import assert from 'node:assert/strict'
import {test} from 'node:test'
import {groupReactionEmojis,isGroupReactionActor,isGroupReactionSummary,groupReactionListInput,groupReactionToggleInput,groupReactionMessageIdsMax} from '../src/group-reactions.ts'

const MID='11111111-1111-4111-8111-111111111111'
const RID='22222222-2222-4222-8222-222222222222'
const GID='33333333-3333-4333-8333-333333333333'
const REQ='44444444-4444-4444-8444-444444444444'

test('表情集恰好十二个且互不重复', () => {
 assert.equal(groupReactionEmojis.length, 12)
 assert.equal(new Set(groupReactionEmojis).size, 12)
})

test('❤️ 字面量必须携带 VS16（U+FE0F），不是纯黑白心形', () => {
 const heart=groupReactionEmojis.find(e=>e.startsWith('❤'))
 assert.equal(heart, '❤️')
})

test('isGroupReactionActor 恰两键，self 的 actorId 只能是 self', () => {
 assert.equal(isGroupReactionActor({actorKind:'self',actorId:'self'}), true)
 assert.equal(isGroupReactionActor({actorKind:'self',actorId:RID}), false)
 assert.equal(isGroupReactionActor({actorKind:'role',actorId:RID}), true)
 assert.equal(isGroupReactionActor({actorKind:'role',actorId:'self'}), false)
 assert.equal(isGroupReactionActor({actorKind:'self',actorId:'self',extra:1}), false)
 assert.equal(isGroupReactionActor({actorKind:'other',actorId:RID}), false)
})

test('isGroupReactionSummary 恰五键，count 不得小于 actors 条数', () => {
 const base={messageId:MID,emoji:'👍',count:1,mine:true,actors:[{actorKind:'self',actorId:'self'}]}
 assert.equal(isGroupReactionSummary(base), true)
 assert.equal(isGroupReactionSummary({...base,count:0}), false)
 assert.equal(isGroupReactionSummary({...base,count:0.5}), false)
 assert.equal(isGroupReactionSummary({...base,emoji:'🐛'}), false)
 assert.equal(isGroupReactionSummary({...base,extra:1}), false)
 assert.equal(isGroupReactionSummary({...base,actors:[{actorKind:'self',actorId:'self'},{actorKind:'self',actorId:'self'}]}), false)
 assert.equal(isGroupReactionSummary({...base,count:1,actors:[{actorKind:'self',actorId:'self'},{actorKind:'role',actorId:RID}]}), false)
 assert.equal(isGroupReactionSummary({...base,count:99,actors:[{actorKind:'self',actorId:'self'}]}), true)
})

test('groupReactionToggleInput 白名单恰四键，emoji 必须在十二个里', () => {
 assert.deepEqual(groupReactionToggleInput({requestId:REQ,groupId:GID,messageId:MID,emoji:'✅'}), {requestId:REQ,groupId:GID,messageId:MID,emoji:'✅'})
 assert.throws(()=>groupReactionToggleInput({requestId:REQ,groupId:GID,messageId:MID,emoji:'🐛'}), {code:'teloa/invalid-input'})
 assert.throws(()=>groupReactionToggleInput({requestId:REQ,groupId:GID,messageId:MID,emoji:'✅',extra:1}), {code:'teloa/invalid-input'})
 assert.throws(()=>groupReactionToggleInput({requestId:REQ,groupId:GID,messageId:MID}), {code:'teloa/invalid-input'})
})

test('groupReactionListInput 的 messageIds 上限两百且去重', () => {
 const ids=Array.from({length:groupReactionMessageIdsMax},(_,i)=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`)
 assert.equal(groupReactionListInput({groupId:GID,messageIds:ids}).messageIds.length, groupReactionMessageIdsMax)
 assert.throws(()=>groupReactionListInput({groupId:GID,messageIds:[...ids,MID]}), {code:'teloa/invalid-input'})
 assert.throws(()=>groupReactionListInput({groupId:GID,messageIds:[MID,MID]}), {code:'teloa/invalid-input'})
 assert.throws(()=>groupReactionListInput({groupId:GID,messageIds:[]}), {code:'teloa/invalid-input'})
})
