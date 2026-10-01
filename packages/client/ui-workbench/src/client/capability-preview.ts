import { checkMarketTarget, freezeMarketTarget, marketTargetKey, MarketTargetCheckError, type MarketTarget, type MarketTargetRef } from './market-target.ts'
import type { MarketState } from './market-preview.ts'

export type BindingFields = { runtimeRef: string; usage: 'read' | 'draft' | 'execute'; dataScope: string; executionScope: string }
export type BindingVersion = { version: number; fields: BindingFields; createdAt: string; check?: { result: 'passed' | 'failed'; note: string; at: string } }
export type CapabilityBinding = {
  id: string; revision: number; title: string; source: { itemId: string; itemVersion: string; intentId: string; intentVersion: number };
  target: MarketTargetRef; versions: BindingVersion[]; activeVersion: number | null; disabled: boolean; removed: boolean;
  history: { text: string; at: string }[];
}
export type CapabilityPreview = { bindings: CapabilityBinding[] }
export type BindingChange = { id: string; expectedRevision: number; now: string } & (
  { type: 'edit'; fields: BindingFields } | { type: 'check'; version: number; result: 'passed' | 'failed'; note: string } |
  { type: 'activate'; version: number } | { type: 'disable' | 'remove'; reason: string }
)
export const emptyCapabilityPreview = (): CapabilityPreview => ({ bindings: [] })
const text = (value: string, label: string, max = 2000) => {
  const result = value.trim()
  if (!result || result.length > max) throw Error(label + '不能为空且不能超过 ' + max + ' 字。')
  return result
}
const time = (now: string) => { if (!Number.isFinite(Date.parse(now))) throw Error('时间无效。') }
function validateFields(fields: BindingFields): BindingFields {
  if (!['read', 'draft', 'execute'].includes(fields.usage)) throw Error('能力用途无效。')
  return { runtimeRef: text(fields.runtimeRef, '原生能力引用', 300), usage: fields.usage, dataScope: text(fields.dataScope, '数据范围'), executionScope: text(fields.executionScope, '执行边界') }
}

export function createCapabilityBinding(state: CapabilityPreview, market: MarketState, intentId: string, targets: readonly MarketTarget[], id: string, now: string): CapabilityPreview {
  time(now)
  const intent = market.intents.find(item => item.id === intentId)
  if (!intent || intent.status !== 'draft' || !intent.targetRef) throw Error('请选择已指定目标的有效能力使用方案。')
  const item = market.items.find(item => item.id === intent.itemId)
  if (!item || item.version !== intent.itemVersion) throw Error('来源版本已变化。')
  if (!['skill', 'resource'].includes(item.kind)) throw Error('此入口只配置技能或连接使用关系；行业模板须建立待安装方案。')
  const target = freezeMarketTarget(intent.targetRef, targets)
  const same = state.bindings.find(binding => !binding.removed && binding.source.itemId === item.id && binding.source.itemVersion === item.version && marketTargetKey(binding.target) === marketTargetKey(target) && binding.target.version === target.version)
  if (same) return state
  const bindingId = text(id, '绑定编号', 200)
  if (state.bindings.some(binding => binding.id === bindingId)) throw Error('绑定编号冲突。')
  const binding: CapabilityBinding = {
    id: bindingId, revision: 1, title: item.title, source: { itemId: item.id, itemVersion: item.version, intentId, intentVersion: intent.version }, target,
    versions: [{ version: 1, fields: { runtimeRef: '', usage: 'read', dataScope: intent.purpose, executionScope: '仅查询或代拟；具体写操作另行审批。' }, createdAt: now }],
    activeVersion: null, disabled: false, removed: false, history: [{ text: '从市场使用方案创建待核验绑定；未安装、未授权。', at: now }],
  }
  return { bindings: [...state.bindings, binding] }
}
export function changeCapabilityBinding(state: CapabilityPreview, change: BindingChange, targets: readonly MarketTarget[]): CapabilityPreview {
  time(change.now)
  const binding = state.bindings.find(binding => binding.id === change.id)
  if (!binding || binding.revision !== change.expectedRevision) throw Error('绑定版本已变化，请重新核对。')
  if (binding.removed) throw Error('此绑定已解除，历史保留。')
  let next = binding, note = ''
  if (change.type === 'edit') {
    const fields = validateFields(change.fields), version = binding.versions.length + 1
    next = { ...binding, versions: [...binding.versions, { version, fields, createdAt: change.now }] }
    note = '保存配置 v' + version + '；原生连接参数未改变，原生效版本保留。'
  } else if (change.type === 'check' || change.type === 'activate') {
    const check = checkMarketTarget(binding.target, targets)
    if (check.status !== 'current') throw new MarketTargetCheckError(check)
    const version = binding.versions.find(version => version.version === change.version)
    if (!version) throw Error('配置版本不存在。')
    if (change.type === 'check') {
      validateFields(version.fields)
      if (!['passed', 'failed'].includes(change.result)) throw Error('核验结果无效。')
      note = text(change.note, '核验说明')
      next = { ...binding, disabled: binding.disabled || (change.result === 'failed' && binding.activeVersion === version.version), versions: binding.versions.map(row => row.version === version.version ? { ...row, check: { result: change.result, note, at: change.now } } : row) }
      note = '模拟核验 v' + version.version + '：' + (change.result === 'passed' ? '通过' : '失败') + '；' + note
    } else {
      if (version.check?.result !== 'passed') throw Error('当前配置版本尚未通过核验。')
      if (binding.activeVersion === version.version && !binding.disabled) return state
      next = { ...binding, activeVersion: version.version, disabled: false }
      note = '模拟启用配置 v' + version.version + '；未授予真实读取或执行权限。'
    }
  } else if (change.type === 'disable') {
    if (binding.disabled) return state
    next = { ...binding, disabled: true }
    note = '模拟停用后续使用：' + text(change.reason, '停用原因') + '；不取消在途工作，不删除共享资源。'
  } else {
    if (binding.activeVersion !== null && !binding.disabled) throw Error('请先停用绑定，再核对解除影响。')
    next = { ...binding, removed: true }
    note = '模拟解除绑定：' + text(change.reason, '解除原因') + '；来源、版本和历史仍保留，未卸载原生组件。'
  }
  next = { ...next, revision: binding.revision + 1, history: [...binding.history, { text: note, at: change.now }] }
  return { bindings: state.bindings.map(row => row.id === next.id ? next : row) }
}
export function bindingAvailability(binding: CapabilityBinding, targets: readonly MarketTarget[]): string {
  if (binding.removed) return '示例中已解除'
  if (binding.disabled) return '示例中已停用'
  const target = checkMarketTarget(binding.target, targets)
  if (target.status !== 'current') return target.status
  if (binding.activeVersion === null) return '待配置'
  const active = binding.versions.find(version => version.version === binding.activeVersion)
  if (active?.check?.result !== 'passed') return '示例中核验失败，已暂停使用'
  return '示例中已启用 v' + binding.activeVersion + (binding.activeVersion !== binding.versions.length ? ' · 有未应用版本' : '')
}
