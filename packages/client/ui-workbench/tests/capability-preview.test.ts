import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyCapabilityPreview, createCapabilityBinding, changeCapabilityBinding, bindingAvailability, type BindingFields } from '../src/client/capability-preview.ts'
import { sandboxMarket, saveMarketIntent } from '../src/client/market-preview.ts'
import type { MarketTarget } from '../src/client/market-target.ts'

const now = '2026-09-11T04:00:00Z'
const target: MarketTarget = { kind: 'role', id: 'researcher', scope: 'general', title: '研究助理', version: 1, availability: 'active' }
const targets = [target]
const market = saveMarketIntent(sandboxMarket(), { id: 'intent', itemId: 'resource-mcp', scope: 'general', target: target.title, targetRef: target, targets, purpose: '读取获准资料', visibility: 'personal', now })
const fields: BindingFields = { runtimeRef: 'teloa_reference', usage: 'read', dataScope: '团队已提交资料', executionScope: '不执行外部写入' }
const created = () => createCapabilityBinding(emptyCapabilityPreview(), market, 'intent', targets, 'binding', now)

test('市场需求创建同一绑定，不复制来源或目标，不允许资源包冒充原生安装', () => {
  const state = created()
  assert.equal(state.bindings.length, 1)
  assert.equal(state.bindings[0]?.source.intentId, 'intent')
  assert.equal(state.bindings[0]?.activeVersion, null)
  assert.equal(createCapabilityBinding(state, market, 'intent', targets, 'retry', now).bindings.length, 1)
  const packageMarket = { ...market, intents: market.intents.map(intent => ({ ...intent, itemId: 'bundle-general' })) }
  assert.throws(() => createCapabilityBinding(emptyCapabilityPreview(), packageMarket, 'intent', targets, 'other', now), /资源包|安装/)
})

test('配置版本和检查分别固定；编辑不替换旧生效版本，失败新版本不能应用', () => {
  let state = created()
  const change = (value: Parameters<typeof changeCapabilityBinding>[1]) => { state = changeCapabilityBinding(state, value, targets) }
  assert.throws(() => change({ id: 'binding', expectedRevision: 1, type: 'activate', version: 1, now }), /核验/)
  change({ id: 'binding', expectedRevision: 1, type: 'edit', fields, now })
  change({ id: 'binding', expectedRevision: 2, type: 'check', version: 2, result: 'passed', note: '模拟核验通过', now })
  change({ id: 'binding', expectedRevision: 3, type: 'activate', version: 2, now })
  assert.equal(state.bindings[0]?.activeVersion, 2)
  change({ id: 'binding', expectedRevision: 4, type: 'edit', fields: { ...fields, dataScope: '另一资料范围' }, now })
  assert.equal(state.bindings[0]?.activeVersion, 2)
  assert.equal(state.bindings[0]?.versions[2]?.check, undefined)
  change({ id: 'binding', expectedRevision: 5, type: 'check', version: 3, result: 'failed', note: '来源无法访问', now })
  assert.throws(() => change({ id: 'binding', expectedRevision: 6, type: 'activate', version: 3, now }), /核验/)
  assert.equal(state.bindings[0]?.versions[1]?.fields.dataScope, fields.dataScope)
  assert.match(bindingAvailability(state.bindings[0]!, targets), /v2/)
  assert.throws(() => change({ id: 'binding', expectedRevision: 1, type: 'disable', reason: '旧表单', now }), /版本/)
})

test('暂停目标即时阻断原绑定，停用保留历史，解除不能删除市场资源', () => {
  let state = created()
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 1, type: 'edit', fields, now }, targets)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 2, type: 'check', version: 2, result: 'passed', note: '模拟通过', now }, targets)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 3, type: 'activate', version: 2, now }, targets)
  const paused = [{ ...target, availability: 'paused' as const, version: 2 }]
  assert.equal(bindingAvailability(state.bindings[0]!, paused), 'unavailable')
  assert.throws(() => changeCapabilityBinding(state, { id: 'binding', expectedRevision: 4, type: 'activate', version: 2, now }, paused), error => (
    error !== null && typeof error === 'object' && 'check' in error && (error as {check?:{status?:unknown}}).check?.status === 'unavailable'
  ))
  assert.throws(() => changeCapabilityBinding(state, { id: 'binding', expectedRevision: 4, type: 'remove', reason: '移除', now }, targets), /停用/)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 4, type: 'disable', reason: '停止后续使用', now }, paused)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 5, type: 'remove', reason: '解除关系', now }, paused)
  assert.equal(state.bindings.length, 1)
  assert.equal(state.bindings[0]?.removed, true)
  assert.equal(state.bindings[0]?.activeVersion, 2)
  assert.equal(market.items.length, sandboxMarket().items.length)
  assert.throws(() => changeCapabilityBinding(state, { id: 'binding', expectedRevision: 6, type: 'activate', version: 2, now }, targets), /解除/)
})

test('生效版本核验失败后停止演示使用，恢复核验不自动重新启用', () => {
  let state = created()
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 1, type: 'edit', fields, now }, targets)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 2, type: 'check', version: 2, result: 'passed', note: '模拟通过', now }, targets)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 3, type: 'activate', version: 2, now }, targets)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 4, type: 'check', version: 2, result: 'failed', note: '连接失效', now }, targets)
  assert.equal(state.bindings[0]?.disabled, true)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 5, type: 'check', version: 2, result: 'passed', note: '重新核对', now }, targets)
  assert.equal(state.bindings[0]?.disabled, true)
  state = changeCapabilityBinding(state, { id: 'binding', expectedRevision: 6, type: 'activate', version: 2, now }, targets)
  assert.equal(state.bindings[0]?.disabled, false)
})
