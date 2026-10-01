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
    ...[...compositionEntries().entries()].map(entry => ({ ...entry.options, disabled: entry.disabled, name: entry.options.name ?? names[entry.options.id] })),
    ...['ui-layout', 'ui-sidebar', 'ui-settings-general', 'ui-settings-plugins', 'client-hmr'].map(id => ({ id, name: '@deepseek-ai/dsh-' + (id.startsWith('client-') ? id : 'client-' + id), disabled: true })),
    { id: 'connection', name: '@deepseek-ai/dsh-client-connection', inject: ['webRuntime', 'webServer'] },
    { id: 'session-query-sqlite', name: '@deepseek-ai/dsh-session-query-sqlite', config: { openAt: 'first-search', path: 'session-search.sqlite' } },
    { id: 'teloa-ui-workbench', name: '@teloa/client-ui-workbench' },
    { id: 'teloa-harness-dsh', name: '@teloa/harness-dsh' },
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
  ]) {
    const rows = structuredClone(configRows())
    mutate(rows)
    assert.throws(() => verifyConfig(dump(rows)), /原生预设|未保留/)
  }
})
