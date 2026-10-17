import test from 'node:test'
import assert from 'node:assert/strict'
import {parseHarnessDirective,harnessDirectiveDenial} from '../src/harness-routing.ts'

test('本人清晰的自然语言指令选择本次引擎，模型名称不充当引擎',()=>{
 for(const [text,engine] of [
  ['这次用 Codex 检查代码','codex'],['请让 Claude Agent 分析这些文件','claude-code'],
  ['本次使用 Claude Code 修复问题','claude-code'],['Please use Codex to review this patch','codex'],
  ['请用 DSH 继续这个任务','dsh'],['把模型换成 gpt-5.6-sol',undefined],
  ['请用“Codex”检查代码','codex'],
  ['> 引用说明\n# 本次任务\n用 Codex 检查代码','codex'],
 ] as const){
  const directive=parseHarnessDirective(text)
  assert.deepEqual(directive.engines,engine?[engine]:[],text)
  assert.equal(directive.mode,engine?'specified':'auto',text)
 }
})

test('否定、明确改用、自动选择和多个明确分工保持本人约束',()=>{
 const directive=parseHarnessDirective('不要用 Codex，改用 Claude Agent 分析这些文件')
 assert.ok(harnessDirectiveDenial(directive,'codex'))
 assert.equal(harnessDirectiveDenial(directive,'claude-code'),undefined)
 assert.equal(harnessDirectiveDenial(parseHarnessDirective('这次用 DSH'),'codex')?.includes('DSH'),true)
 assert.equal(harnessDirectiveDenial(parseHarnessDirective('这次用 Codex，自动选择合适引擎'),'claude-code'),undefined)
 assert.ok(harnessDirectiveDenial(parseHarnessDirective('不要用 Codex，自动选择引擎'),'codex'))
 assert.deepEqual(parseHarnessDirective('请用 Codex 和 Claude Agent 分别审查这两个模块').engines,['codex','claude-code'])
 assert.deepEqual(parseHarnessDirective('用 Codex 检查 Claude Agent 的配置').engines,['codex'])
 assert.ok(harnessDirectiveDenial(parseHarnessDirective('用 Codex，不要用 Codex'),'claude-code'))
 assert.equal(parseHarnessDirective('用 Codex 还是 Claude Agent？').mode,'ambiguous')
 assert.deepEqual(parseHarnessDirective("Don't use Codex, don't use Claude Agent").excluded,['codex','claude-code'])
})

test('讨论、条件、引用和代码内的引擎名称不是选择指令',()=>{
 for(const text of [
  'Codex 和 Claude Agent 有什么区别？','怎么用 Codex？','如果用 Codex 会怎么样？',
  '以下是文档：\n> 这次用 Codex 检查代码',
  '解释字符串“这次用 Codex 检查代码”',
  '审查这段代码：\n```text\n用 Codex 检查代码\n```',
  '请输出 `用 Codex 检查代码` 这段文本',
  '“不要用 Codex”这句话是什么含义？',
  '审查未写完的文档：\n```text\n用 Codex 检查代码',
  '审查这段 Markdown 代码：\n\n    用 Codex 检查代码',
  '审查这段代码：\n\n\t让 Claude Agent 分析文件',
  '<blockquote>\n让 Claude Agent 分析这些文件\n</blockquote>',
  '引用如下：\n> 原文\n用 Codex 检查代码',
  '请解释代码片段 ``包含反引号 `\n用 Codex 检查代码\n`` 的含义',
 ])assert.equal(parseHarnessDirective(text).mode,'auto',text)
})
