import test from 'node:test'
import assert from 'node:assert/strict'
import {readPageCreatePlanDraft} from '@teloa/contract'
import {planDraftGuide} from '../src/plan-draft-guide.ts'
import {planDraftBody} from '../src/plan-draft-parameters.ts'

test('模型可见计划示例由正式reader验证，区分有来源方法与原配置，并保持默认暂停',()=>{
 const inputs=[...planDraftGuide.matchAll(/正文示例：\n([^\n]+)\n/g)].map(match=>JSON.parse(match[1]!))
 assert.equal(Object.hasOwn(inputs[0].definition,'roleId'),false)
 assert.equal(Object.hasOwn(inputs[0].work.budget,'money'),false)
 assert.equal(Object.hasOwn(inputs[1].work.budget,'money'),true)
 const examples=inputs.map(input=>readPageCreatePlanDraft(planDraftBody(input)))
 assert.equal(examples.length,2)
 for(const example of examples)assert.equal(example.intent,'save-paused')
 assert.ok('definition'in examples[0]!&&examples[0].definition.roleId===null)
 assert.ok('kind'in examples[1]!&&examples[1].kind==='configure-work')
 assert.match(planDraftGuide,/身份必须来自正式业务对象或同步映射/)
})
