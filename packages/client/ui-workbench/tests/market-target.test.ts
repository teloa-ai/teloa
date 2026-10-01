import test from 'node:test'
import assert from 'node:assert/strict'
import type { CollaborationPreview, CollaborationScope } from '../src/client/collaboration-preview.ts'
import { withRoleExamples } from '../src/client/role-preview.ts'
import { marketTargets, checkMarketTarget, freezeMarketTarget, marketTargetKey, type MarketTarget } from '../src/client/market-target.ts'
import { sandboxMarket, saveMarketIntent, marketPrompt } from '../src/client/market-preview.ts'

const now = '2026-09-11T03:00:00Z'
const roles = withRoleExamples([], now)
// 群演示分支删除后，示例群构造函数已随可变状态一并移除；这里直接给出群与群消息的字面形状，
// 覆盖仍在用的群投影（marketTargets）。
const exampleNow='2026-09-10T16:00:00Z'
const exampleGroup=(id:string,name:string,scope:CollaborationScope,memberIds:string[]):CollaborationPreview['groups'][number]=>
  ({id,name,scope,memberIds,announcement:'',createdAt:exampleNow,updatedAt:exampleNow,pinned:false,archived:false,version:1})
const exampleCollaboration=():CollaborationPreview=>({
  groups:[
    exampleGroup('preview-research','产品研究协作','general',['self','researcher','twin']),
    exampleGroup('preview-soc','安全调查协作','SOC',['self','investigator']),
  ],
  messages:[
    {id:'preview-research-message',groupId:'preview-research',authorId:'self',text:'这次研究分两个话题：先核对资料来源，再讨论设计取舍。具体结论在各自话题中整理。',createdAt:exampleNow},
    {id:'preview-soc-message',groupId:'preview-soc',authorId:'self',text:'调查线索和处置决定分别跟进。请在本条消息的话题中补充证据，群回复不等于批准处置。',createdAt:exampleNow},
  ],
  drafts:{},resources:[],referenceDrafts:{},
})
const groups = exampleCollaboration()

test('市场目标取自共享目录，类型、业务和编号共同区分身份', () => {
  const targets = marketTargets(roles, groups)
  assert.equal(targets.find(target => target.kind === 'role' && target.id === 'investigator')?.version, 1)
  assert.equal(targets.find(target => target.kind === 'group' && target.id === 'preview-soc')?.title, '安全调查协作')
  assert.ok(targets.some(target => target.kind === 'business' && target.scope === 'general'))
  const role = targets.find(target => target.kind === 'role' && target.id === 'researcher')!
  assert.notEqual(marketTargetKey(role), marketTargetKey({ ...role, kind: 'group' }))
  assert.notEqual(marketTargetKey(role), marketTargetKey({ ...role, scope: 'SOC' }))
})

test('配置目标由当前目录冻结，禁止伪造名称或使用已变化版本', () => {
  const target: MarketTarget = { kind: 'role', id: 'one', scope: 'general', version: 3, title: '真实目录名称', availability: 'active' }
  const ref = freezeMarketTarget({ ...target, title: '伪造名称' }, [target])
  assert.equal(ref.title, '真实目录名称')
  assert.ok(!Object.hasOwn(ref, 'availability'))
  assert.throws(() => freezeMarketTarget({ ...target, version: 1 }, [target]), error => targetErrorStatus(error) === 'changed')
  assert.throws(() => freezeMarketTarget({ ...target, kind: 'group' }, [target]), error => targetErrorStatus(error) === 'missing')
})

test('岗位暂停、退役和群归档阻止新配置；旧快照仍保留而不变成就绪', () => {
  const target: MarketTarget = { kind: 'role', id: 'one', scope: 'SOC', version: 1, title: '调查岗', availability: 'active' }
  const ref = freezeMarketTarget(target, [target])
  for (const availability of ['paused', 'retired', 'archived'] as const) {
    const changed = { ...target, version: 2, availability }
    assert.equal(checkMarketTarget(ref, [changed]).status, 'unavailable')
    assert.throws(() => freezeMarketTarget(changed, [changed]), error => targetErrorStatus(error) === 'unavailable')
  }
  assert.equal(checkMarketTarget(ref, [{ ...target, version: 2 }]).status, 'changed')
  assert.equal(checkMarketTarget(ref, []).status, 'missing')
  assert.equal(ref.version, 1)
})

function targetErrorStatus(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'check' in error
    ? (error as { check?: { status?: unknown } }).check?.status
    : undefined
}

test('五种目标状态对三种类型只返回状态码和插值参数', () => {
  for (const kind of ['business', 'role', 'group'] as const) {
    const target: MarketTarget = { kind, id: kind, scope: 'general', version: 1, title: kind, availability: 'active' }
    const ref = { ...target }
    const checks = [
      checkMarketTarget(undefined, [target]),
      checkMarketTarget(ref, [target]),
      checkMarketTarget(ref, []),
      checkMarketTarget(ref, [{ ...target, version: 2 }]),
      checkMarketTarget(ref, [{ ...target, availability: 'paused' }]),
    ]
    assert.deepEqual(checks.map(check => check.status), ['unselected', 'current', 'missing', 'changed', 'unavailable'])
    assert.deepEqual(checks.map(check => check.params), [{}, {}, {}, {}, { state: 'paused' }])
    for (const check of checks) assert.equal(Object.hasOwn(check, 'message'), false)
  }
})

test('同名不同岗位的配置不得合并，固定目标版本并从目录取业务范围', () => {
  const a: MarketTarget = { kind: 'role', id: 'a', scope: 'SOC', version: 1, title: '调查岗', availability: 'active' }
  const b = { ...a, id: 'b' }
  const input = { id: 'intent-a', itemId: 'bundle-security', scope: 'general', target: '任意文字', targetRef: a, purpose: '配置需求', visibility: 'personal' as const, now, targets: [a, b] }
  let state = saveMarketIntent(sandboxMarket(), input)
  assert.equal(state.intents[0]?.scope, 'SOC')
  assert.equal(state.intents[0]?.targetRef?.id, 'a')
  state = saveMarketIntent(state, { ...input, id: 'intent-b', targetRef: b })
  assert.equal(state.intents.length, 2)
  assert.equal(saveMarketIntent(state, { ...input, id: 'retry' }).intents.length, 2)
  const changed = { ...a, version: 2 }
  assert.throws(() => saveMarketIntent(state, { ...input, id: 'stale', targets: [changed, b] }), error => targetErrorStatus(error) === 'changed')
  state = saveMarketIntent(state, { ...input, id: 'version-2', targetRef: changed, targets: [changed, b] })
  assert.equal(state.intents.length, 3)
  assert.equal(state.intents[0]?.targetRef?.version, 1)
  assert.match(marketPrompt(state.items.find(item => item.id === 'bundle-security')!, state.intents[0]), /role.*a.*v1/)
})
