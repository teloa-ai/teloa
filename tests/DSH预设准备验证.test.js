import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { verifyConfig } from '../scripts/准备DSH插件.mjs'
import { compositionEntries } from '../packages/harness-dsh/tests/fixtures/production-host.ts'

const { stringify } = createRequire(new URL('../packages/harness-dsh/package.json', import.meta.url))('yaml')

function configRows() {
  const names = {
    'session-telemetry-otel': '@deepseek-ai/dsh-session-telemetry-otel',
    'sandbox-policy': '@deepseek-ai/dsh-sandbox-policy',
    approval: '@deepseek-ai/dsh-user-approval',
    tools: '@deepseek-ai/dsh-tools',
    'tool-workflow': '@deepseek-ai/dsh-tool-workflow',
    'tool-ralph': '@deepseek-ai/dsh-tool-ralph',
  }
  return [
    ...[...compositionEntries().entries()].map(entry => ({ ...entry.options, disabled: entry.disabled, name: entry.options.name ?? names[entry.options.id], ...(entry.options.id === 'agent-preset-registry' ? { inject: ['loader', 'sessionProjections', 'teloaToolResourceProvenance'] } : {}) })),
    ...['ui-layout', 'ui-sidebar', 'ui-settings-general', 'ui-settings-plugins', 'client-hmr'].map(id => ({ id, name: '@deepseek-ai/dsh-' + (id.startsWith('client-') ? id : 'client-' + id), disabled: true })),
    { id: 'connection', name: '@deepseek-ai/dsh-client-connection', inject: ['webRuntime', 'webServer'] },
    { id: 'session-query-sqlite', name: '@deepseek-ai/dsh-session-query-sqlite', config: { openAt: 'first-search', path: 'session-search.sqlite' } },
    { id: 'teloa-ui-workbench', name: '@teloa/client-ui-workbench' },
    { id: 'teloa-harness-dsh', name: '@teloa/harness-dsh' },
    { id: 'teloa-tool-resource-provenance', name: '@teloa/harness-dsh/tool-resource-provenance' },
    { id: 'teloa-reference-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'teloa_reference', cwd: { __jsExpr: 'process.env.TELOA_PROJECT_ROOT' }, failOnStartupError: true, maxInstructionBytes: 2048 } },
  ]
}

const dump = rows => stringify(rows).replace(/name: "(@[^"\n]+)"/g, "name: '$1'")

test('插件准备接受官方注册器和五份核对过的声明，导入验证函数不会运行安装', () => {
  assert.doesNotThrow(() => verifyConfig(dump(configRows())))
})

test('插件准备拒绝正文追加执行器、声明冒名和关闭官方预设', () => {
  for (const mutate of [
    rows => rows.find(row => row.id === 'teloa-agent-preset').config.plugins.push({ id: 'bypass', name: '@deepseek-ai/dsh-tool-workflow' }),
    rows => { rows.find(row => row.id === 'teloa-agent-preset').name = '@vendor/preset' },
    rows => { rows.find(row => row.id === 'preset-ptc').disabled = true },
    rows => rows.push({ id: 'new-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'unsafe', plugins: [] } }),
    rows => rows.find(row => row.id === 'agent-preset-registry').inject.push('unknownDependency'),
    rows => rows.find(row => row.id === 'agent-preset-registry').inject.pop(),
    rows => { rows.find(row => row.id === 'teloa-tool-resource-provenance').name = '@vendor/provenance' },
  ]) {
    const rows = structuredClone(configRows())
    mutate(rows)
    assert.throws(() => verifyConfig(dump(rows)), /原生预设|未保留/)
  }
})

test('插件准备保留原生提醒服务，拒绝关闭、替换、删除及重复挂载', () => {
  for (const mutate of [
    rows => { rows.find(row => row.id === 'schedule').disabled = true },
    rows => { rows.find(row => row.id === 'schedule').name = '@vendor/schedule' },
    rows => rows.splice(rows.findIndex(row => row.id === 'schedule'), 1),
    rows => rows.push({ id: 'schedule', name: '@deepseek-ai/dsh-schedule' }),
    rows => rows.push({ id: 'another-service', name: '@deepseek-ai/dsh-schedule' }),
  ]) {
    const rows = configRows()
    mutate(rows)
    assert.throws(() => verifyConfig(dump(rows)), /提醒服务/)
  }
})

test('插件准备拒绝重新启用原生自动化页及通过别名挂载相同入口', () => {
  for (const mutate of [
    rows => { rows.find(row => row.id === 'ui-schedule').disabled = false },
    rows => { delete rows.find(row => row.id === 'ui-schedule').disabled },
    rows => rows.splice(rows.findIndex(row => row.id === 'ui-schedule'), 1),
    rows => rows.push({ id: 'another-ui', name: '@deepseek-ai/dsh-client-ui-schedule' }),
  ]) {
    const rows = configRows()
    mutate(rows)
    assert.throws(() => verifyConfig(dump(rows)), /自动化入口/)
  }
})

test('插件准备拒绝宿主及嵌套组合重新挂载原生提醒写工具', () => {
  for (const tool of [
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    { id: 'another-tool', name: '@deepseek-ai/dsh-tool-schedule' },
  ]) {
    for (const target of ['host', 'group', 'preset']) {
      const rows = configRows()
      if (target === 'preset') rows.find(row => row.id === 'preset-standard').config.plugins.push(tool)
      else rows.push(target === 'group' ? { id: 'additional-group', name: 'cordis:group', group: true, config: [tool] } : tool)
      assert.throws(() => verifyConfig(dump(rows)), /提醒工具/)
    }
  }
})
