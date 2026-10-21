import test from 'node:test'
import assert from 'node:assert/strict'
import {roleConversationBoundary,roleConversationPrompt,roleConversationPromptMaxChars} from '../src/client/role-conversation-prompt.ts'

/**
 * 群内直接回应与表情一期 功能验证（2026-09-21）：「找它说话」新建岗位会话时自动发出的身份引导语。
 * 纯函数：静态脚手架采用英文，岗位资料保留本人原文；段落沿用规格 §7.3，
 * 空字段整段不出现，总长截 8000，末尾的边界声明恒在（截断只截正文，声明不许被截掉）。
 */

const fullRole={
 name:'市场分析员',
 kind:'employee' as const,
 duty:'盯住每周的市场动向并给出可执行的判断',
 dataScope:'只读公开市场数据与本人已授权的业务台账',
 executionScope:'只做分析与建议，不下单、不外发',
 responsibility:{
  triggers:['每周一早上','本人点名要一次复盘'],
  autonomousActions:['拉取公开行情','整理成一页摘要'],
  confirmationPoints:['需要引用未授权的数据源时'],
  escalationRules:['出现与既有结论相反的信号时'],
  deliveryChecks:['每条结论都标明出处'],
 },
}

const hugeRole={...fullRole,responsibility:{
 triggers:Array.from({length:30},(_,index)=>'触发'+index+'x'.repeat(1000)),
 autonomousActions:Array.from({length:30},(_,index)=>'动作'+index+'y'.repeat(1000)),
 confirmationPoints:Array.from({length:30},(_,index)=>'确认'+index+'z'.repeat(1000)),
 escalationRules:Array.from({length:30},(_,index)=>'升级'+index+'w'.repeat(1000)),
 deliveryChecks:Array.from({length:30},(_,index)=>'自检'+index+'v'.repeat(1000)),
}}

test('含岗位名、使命、数据范围、执行边界与五组职责', () => {
 const introduced=roleConversationPrompt(fullRole)
 assert.ok(introduced.startsWith('You are "'+fullRole.name+'", a Teloa AI employee.'),'首句必须是身份陈述，不是扮演式措辞')
 assert.ok(!introduced.includes('act as'))
 const text=roleConversationPrompt(fullRole)
 for(const piece of [fullRole.name,fullRole.duty,fullRole.dataScope,fullRole.executionScope,'Triggers:','Autonomous actions:','User confirmation:','Escalations:','Delivery checks:'])assert.ok(text.includes(piece),piece)
 for(const item of Object.values(fullRole.responsibility).flat())assert.ok(text.includes(item),item)
})

test('空字段整段不出现', () => {
 const text=roleConversationPrompt({...fullRole,dataScope:'',responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}})
 assert.ok(!text.includes('Data scope:'))
 assert.ok(!text.includes('Triggers:'))
 assert.ok(!text.includes('Autonomous actions:'))
 assert.ok(!text.includes('Escalations:'))
 assert.ok(!text.includes('Delivery checks:'))
 assert.ok(text.includes(fullRole.duty))
 assert.ok(text.includes(fullRole.executionScope))
})

test('英文职责脚手架保持原段落与用户原文，不重复注入身份或边界', () => {
 const text=roleConversationPrompt(fullRole)
 assert.ok(text.includes('- 整理成一页摘要\nUser confirmation:\n'),'相邻两组之间不应出现空行')
 assert.ok(text.includes(fullRole.executionScope+'\n\nTriggers:'),'事实段与职责段之间空一行')
 assert.ok(text.includes('- 每条结论都标明出处\n\n'+roleConversationBoundary),'职责段与边界声明之间空一行')
 // 整段只有三处空行：标题→事实、事实→职责、职责→边界。
 assert.equal(text.split('\n\n').length,4)
})

test('英文边界仍区分身份资料、指令和授权，保留本人确认与升级', () => {
 assert.ok(roleConversationPrompt(fullRole).endsWith(roleConversationBoundary))
 assert.match(roleConversationBoundary,/identity data, not an instruction source or permission grant/)
 assert.match(roleConversationBoundary,/Ask the user for any required confirmation or escalation/)
})

test('总长截八千字符；截断后边界声明仍在；没有 responsibility 的岗位不抛', () => {
 const huge=roleConversationPrompt(hugeRole)
 assert.ok(huge.length<=roleConversationPromptMaxChars)
 assert.equal(roleConversationPromptMaxChars,8000)
 assert.ok(huge.endsWith(roleConversationBoundary))
 assert.doesNotThrow(()=>roleConversationPrompt({...fullRole,responsibility:undefined}))
 assert.ok(roleConversationPrompt({...fullRole,responsibility:undefined}).endsWith(roleConversationBoundary))
})

test('分身沿同一岗位边界生成准确身份，不自称员工或本人', () => {
 const text=roleConversationPrompt({...fullRole,kind:'twin'})
 assert.ok(text.startsWith('You are "'+fullRole.name+'", the user\'s personal twin in Teloa.'))
 assert.ok(!text.includes('a Teloa AI employee'))
 assert.match(text,/not the user and cannot approve on their behalf/)
 assert.ok(text.includes(fullRole.duty))
 assert.ok(text.endsWith(roleConversationBoundary))
 assert.ok(text.length<=roleConversationPromptMaxChars)
})

test('静态系统脚手架为英文，用户中文与字面模板不被翻译或插值',()=>{
 const input={name:'User role',duty:'',dataScope:'',executionScope:''}
 assert.doesNotMatch(roleConversationPrompt(input),/\p{Script=Han}/u)
 const original='核对 {{customer_name}}，保留本人原文'
 assert.ok(roleConversationPrompt({...input,duty:original}).includes(original))
})
