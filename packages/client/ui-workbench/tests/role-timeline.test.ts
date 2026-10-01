import assert from 'node:assert/strict'
import test from 'node:test'
import {roleTimeline} from '../src/client/role-timeline.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'

const now = '2026-09-16T01:00:00Z'
const task = (overrides: Partial<PreviewTask> & Pick<PreviewTask, 'id' | 'assigneeId'>): PreviewTask => ({
  title: 't', goal: 'g', scope: 'general', object: 'o', version: 1, state: 'running', need: null, request: '', authorId: 'self',
  assigneeHistory: [overrides.assigneeId], createdAt: now, updatedAt: now, result: '', evidence: [], history: [], supplements: [],
  approvalRequired: false, risk: '', execution: 'not_started', ...overrides,
})

test('三档顺序固定：待你决定 → 产出 → 最近工作', () => {
  const tasks = [
    task({id: 'recent-1', assigneeId: 'a', need: null}),
    task({id: 'needs-1', assigneeId: 'a', need: 'approval'}),
    task({id: 'artifact-1', assigneeId: 'a', need: null}),
  ]
  const artifacts = [{taskId: 'artifact-1'}]
  const timeline = roleTimeline('a', tasks, artifacts)
  assert.deepEqual(timeline.map(item => item.kind), ['needsYou', 'artifact', 'recent'])
  assert.deepEqual(timeline.map(item => item.task.id), ['needs-1', 'artifact-1', 'recent-1'])
})

test('taskNeeds 非空进 needsYou，含 handoff 推出的那一类', () => {
  const tasks = [task({id: 't1', assigneeId: 'a', need: null, handoff: {fromId: 'b', reason: 'r', at: now}})]
  const timeline = roleTimeline('a', tasks, [])
  assert.equal(timeline.length, 1)
  assert.equal(timeline[0]!.kind, 'needsYou')
})

test('有成果（artifacts 命中 taskId）进 artifact', () => {
  const tasks = [task({id: 't1', assigneeId: 'a', need: null})]
  const timeline = roleTimeline('a', tasks, [{taskId: 't1'}])
  assert.equal(timeline[0]!.kind, 'artifact')
})

test('既无 needs 也无成果进 recent', () => {
  const tasks = [task({id: 't1', assigneeId: 'a', need: null})]
  const timeline = roleTimeline('a', tasks, [])
  assert.equal(timeline[0]!.kind, 'recent')
})

test('authorId 命中但 assigneeId 不命中的工作不出现在时间线里', () => {
  const tasks = [task({id: 't1', assigneeId: 'b', authorId: 'a'})]
  assert.deepEqual(roleTimeline('a', tasks, []), [])
})

test('assigneeHistory 命中但当前 assigneeId 不命中的工作不出现在时间线里', () => {
  const tasks = [task({id: 't1', assigneeId: 'b', assigneeHistory: ['a', 'b']})]
  assert.deepEqual(roleTimeline('a', tasks, []), [])
})

test('同一条工作只出现一次', () => {
  const tasks = [task({id: 't1', assigneeId: 'a', need: 'approval'})]
  const timeline = roleTimeline('a', tasks, [{taskId: 't1'}])
  assert.equal(timeline.length, 1)
  assert.equal(timeline[0]!.kind, 'needsYou')
})

test('不属于该 roleId 的 artifacts 记录不影响归类', () => {
  const tasks = [task({id: 't1', assigneeId: 'a', need: null})]
  const timeline = roleTimeline('a', tasks, [{taskId: 'other'}, {}])
  assert.equal(timeline[0]!.kind, 'recent')
})

test('三档内部按 updatedAt 倒序，乱序输入也能把最近更新的排在前面', () => {
  const tasks = [
    task({id: 'need-old', assigneeId: 'a', need: 'approval', updatedAt: '2026-09-10T00:00:00Z'}),
    task({id: 'recent-new', assigneeId: 'a', need: null, updatedAt: '2026-09-15T00:00:00Z'}),
    task({id: 'need-new', assigneeId: 'a', need: 'approval', updatedAt: '2026-09-14T00:00:00Z'}),
    task({id: 'artifact-old', assigneeId: 'a', need: null, updatedAt: '2026-09-09T00:00:00Z'}),
    task({id: 'recent-old', assigneeId: 'a', need: null, updatedAt: '2026-09-11T00:00:00Z'}),
    task({id: 'artifact-new', assigneeId: 'a', need: null, updatedAt: '2026-09-13T00:00:00Z'}),
  ]
  const timeline = roleTimeline('a', tasks, [{taskId: 'artifact-old'}, {taskId: 'artifact-new'}])
  assert.deepEqual(timeline.map(item => item.task.id), ['need-new', 'need-old', 'artifact-new', 'artifact-old', 'recent-new', 'recent-old'])
})

test('缺 updatedAt 的工作排在同一档最后，档内其余顺序不变', () => {
  const tasks = [
    task({id: 'missing', assigneeId: 'a', need: null, updatedAt: '' as unknown as string}),
    task({id: 'old', assigneeId: 'a', need: null, updatedAt: '2026-09-09T00:00:00Z'}),
    task({id: 'new', assigneeId: 'a', need: null, updatedAt: '2026-09-15T00:00:00Z'}),
  ]
  assert.deepEqual(roleTimeline('a', tasks, []).map(item => item.task.id), ['new', 'old', 'missing'])
})

test('同一时刻更新的工作保持调用方给的原序（排序稳定）', () => {
  const same = '2026-09-12T00:00:00Z'
  const tasks = [
    task({id: 'first', assigneeId: 'a', need: null, updatedAt: same}),
    task({id: 'second', assigneeId: 'a', need: null, updatedAt: same}),
    task({id: 'third', assigneeId: 'a', need: null, updatedAt: same}),
  ]
  assert.deepEqual(roleTimeline('a', tasks, []).map(item => item.task.id), ['first', 'second', 'third'])
})
