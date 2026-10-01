import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {GROUP_REACTION_MESSAGE_ROWS} from '../src/client/i18n/locales/group-reaction.ts'

// 群内直接回应与表情一期 功能验证 → T16 收口：`group.routing.*`（3）+ `group.reaction.*`（5）+
// `collaboration.composer.*`（4）+ `role.conversation.*`（1）= 13 行；2026-09-21 作者与身份修复轮
// 又补了重新介绍按钮、成功回执和当前语言的短请求，共 19 行。
// 这些键落在 `i18n-orphan-keys.test.ts` 受管的 `group.`／`collaboration.` 命名空间下，
// 在 T12（表情条接线）/T13（输入框工具栏接线）/T14（岗位身份接线）落地前，orphan 守卫会
// 对这批新键报红——这是预期状态，不通过加豁免名单或改守卫来压绿，红灯由 T14 收工时一并解除。
// T16 按编排者裁定删掉了第 14 条 `group.routing.stopped`：那句停下文案由后端常量
// `groupRelayStopText` 写进群消息正文，客户端没有消费面，词条留着只会造出第二个事实源。
const EXPECTED_KEYS=[
 'group.routing.pending',
 'group.routing.pendingNamed',
 'group.routing.stoppedHint',
 'group.reaction.add',
 'group.reaction.pick',
 'group.reaction.mine',
 'group.reaction.by',
 'group.reaction.failed',
 'collaboration.composer.emoji',
 'collaboration.composer.mention',
 'collaboration.composer.references',
 'collaboration.composer.enterHint',
 'role.conversation.identity',
 'role.conversation.reintroduce',
 'role.conversation.reintroduced',
 'role.conversation.introducePrompt',
 'role.conversation.details',
 'role.conversation.close',
 'collaboration.message.sourceDetails',
]

test('群内直接回应与表情词表 19 行十一列齐全，十种语言无空串，接入主词典',async()=>{
 assert.equal(GROUP_REACTION_MESSAGE_ROWS.length,19)
 const forbidden=/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/
 const keys=new Set<string>()
 for(const row of GROUP_REACTION_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.equal(keys.has(row[0]),false,row[0])
  keys.add(row[0])
  assert.equal(row.slice(1).every(value=>typeof value==='string'&&value.trim().length>0),true,row[0])
  assert.doesNotMatch(row[1],forbidden,row[0])
 }
 assert.deepEqual([...keys].sort(),[...EXPECTED_KEYS].sort())
 const prompt=GROUP_REACTION_MESSAGE_ROWS.find(row=>row[0]==='role.conversation.introducePrompt')!
 assert.match(prompt[1],/岗位职责与边界/)
 assert.match(prompt[3],/responsibilities and boundaries/)
 const core=await readFile(new URL('../src/client/i18n/locales/core-pages.ts',import.meta.url),'utf8')
 assert.match(core,/GROUP_REACTION_MESSAGE_ROWS/)
})

test('group.reaction.by / group.routing.pendingNamed / role.conversation.identity 各含一个占位符',()=>{
 const byKey=(key:string)=>GROUP_REACTION_MESSAGE_ROWS.find(row=>row[0]===key)!
 for(const key of ['group.reaction.by','group.routing.pendingNamed','role.conversation.identity']){
  const row=byKey(key)
  const zhCn=row[1]
  const placeholders=zhCn.match(/\{[a-zA-Z]+\}/g)??[]
  assert.equal(placeholders.length,1,key)
 }
})
