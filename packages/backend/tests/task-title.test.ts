import test from 'node:test'
import assert from 'node:assert/strict'
import {groupTaskTitle,groupTaskTitleLimit} from '../src/work/task-title.ts'
/** 代理对不能被切开：结果必须是良构 UTF-16。 */
const wellFormed=(value:string)=>assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value),`标题含孤立代理项：${JSON.stringify(value)}`)
test('群任务标题沿用首行纯文本并加统一前缀，不改写原文',()=>{
 assert.equal(groupTaskTitle('排查登录失败'),'群任务：排查登录失败')
 assert.equal(groupTaskTitle('  排查   登录\t失败  '),'群任务：排查 登录 失败')
 assert.equal(groupTaskTitleLimit,120)
})
test('群任务标题取 Markdown 第一段有效标题，不带入其后段落',()=>{
 assert.equal(groupTaskTitle('# 排查登录失败 #\n\n详细描述：用户反馈无法登录。\n- 步骤一'),'群任务：排查登录失败')
 assert.equal(groupTaskTitle('\n\n---\n\n## 本周巡检\n正文'),'群任务：本周巡检')
 assert.equal(groupTaskTitle('> **紧急**：数据库连接池耗尽\n补充说明'),'群任务：紧急：数据库连接池耗尽')
 assert.equal(groupTaskTitle('1. 整理证据\n2. 归档工单'),'群任务：整理证据')
 assert.equal(groupTaskTitle('第一行\n第二行'),'群任务：第一行')
})
test('空白或仅 Markdown 符号的消息退回固定标题',()=>{
 assert.equal(groupTaskTitle(''),'群任务')
 assert.equal(groupTaskTitle('   \n\n'),'群任务')
 assert.equal(groupTaskTitle('---\n***\n```'),'群任务')
})
test('群任务标题最多 120 个 UTF-16 单元，超出以省略号截断',()=>{
 const long='甲'.repeat(300),title=groupTaskTitle(long)
 assert.equal(title.length,groupTaskTitleLimit);assert.ok(title.startsWith('群任务：甲甲'));assert.ok(title.endsWith('…'))
 const exact='乙'.repeat(groupTaskTitleLimit-'群任务：'.length)
 assert.equal(groupTaskTitle(exact),'群任务：'+exact,'恰好到上限不截断')
})
test('截断不切断代理对',()=>{
 // 前缀 4 单元 + 114 个 a + 😀(2 单元) + bb = 122 单元；按 119 截会落在高位代理项中间。
 const body='a'.repeat(114)+'😀'+'bb',title=groupTaskTitle(body)
 wellFormed(title);assert.ok(title.length<=groupTaskTitleLimit);assert.ok(title.endsWith('…'))
 assert.equal(title,'群任务：'+'a'.repeat(114)+'…')
 // 代理对恰好压线时整对保留。
 const fits='a'.repeat(114)+'😀',kept=groupTaskTitle(fits)
 wellFormed(kept);assert.equal(kept,'群任务：'+fits);assert.equal(kept.length,groupTaskTitleLimit)
})
