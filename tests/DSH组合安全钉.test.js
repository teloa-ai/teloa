import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compositionRefusalMessage, compositionSnapshot, compositionViolations, readPresetBodyFacts } from '../packages/harness-dsh/src/composition-safety.ts'
import { pendingPackageNames, readPendingPlugins } from '../packages/harness-dsh/src/pending-plugins.ts'
import { deniedPatchRowIds } from '../packages/harness-dsh/src/dsh-plugin-install-adapter.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const starter = fileURLToPath(new URL('../scripts/启动DSH.mjs', import.meta.url))
/**
 * 转储用的环境：与 `tests/宿主就绪自检.test.js` 的 starterEnv 同一口径——
 * 开发机上残留的 profile、运行目录、验收开关与桩宿主都不能把转储结果带偏，
 * 否则这些安全钉会在一份不是正式组合树的东西上通过。
 */
function dumpEnv() {
  const env = { ...process.env }
  for (const name of ['TELOA_DSH_PROFILE', 'TELOA_DSH_HOME', 'TELOA_RUNTIME_ROOT', 'TELOA_WORKSPACE_ROOT', 'TELOA_DSH_PORT', 'TELOA_DSH_STUB_HOST', 'TELOA_BROWSER_ACCEPTANCE']) delete env[name]
  return env
}

let cached
/** `--dump-config` 不启动应用也不占端口；一次转储供全部用例复用。 */
function dump() {
  if (cached) return cached
  const result = spawnSync(process.execPath, [starter, '--dump-config'], { cwd: root, env: dumpEnv(), encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, 'DSH 组合配置转储失败：' + (result.stderr || '').trim())
  assert.equal(/- id: teloa-harness-dsh/.test(result.stdout), true, '当前 profile 尚未接入 Teloa 插件，请先运行 pnpm setup:dsh')
  cached = result.stdout
  return cached
}

/** 取组合树里某一行的整块文本。 */
function dumpBlock(id) {
  const blocks = []
  let current
  for (const line of dump().split('\n')) {
    const match = line.match(/^- id: (.+)$/)
    if (match) { current = match[1] === id ? [line] : undefined; if (current) blocks.push(current) }
    else if (current) current.push(line)
  }
  assert.equal(blocks.length, 1, '组合配置中的 ' + id + ' 应唯一存在，实际 ' + blocks.length + ' 项。')
  return blocks[0].join('\n')
}

/** 完整解析原生声明，表达式保持为 Loader 的数据节点，不执行其中代码。 */
function dumpRows() {
  const { parse } = createRequire(new URL('../packages/harness-dsh/package.json', import.meta.url))('yaml')
  return parse(dump(), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: source => ({ __jsExpr: source }) }] })
    .map(row => ({ ...row, disabled: row.disabled === true }))
}

const profileDir = fileURLToPath(new URL('../.runtime/dsh/profiles/teloa/', import.meta.url))

/** profile 仅提供 bundles 与待启用清单；HMR 关闭取自生效组合。 */
async function profileFacts() {
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  return {
    pending: { bundles: manifest.dsh?.profile?.bundles ?? [], packages: pendingPackageNames(await readPendingPlugins(profileDir)) },
  }
}

test('正式组合树上的部署安全钉全部成立（与宿主装配期同一判据）', async () => {
  const facts = await profileFacts()
  const violations = compositionViolations(compositionSnapshot(dumpRows(), facts.pending))
  assert.deepEqual(violations, [], '组合树里的部署安全钉已被改动：' + violations.join('、'))
})

test('判据函数本身仍会对每一条被改回上游取值的钉子报警', async () => {
  const safe = compositionSnapshot(dumpRows(), (await profileFacts()).pending)
  assert.deepEqual(compositionViolations(safe), [])
  assert.deepEqual(compositionViolations({ ...safe, telemetryMode: 'FEEDBACK_ONLY' }), ['telemetry'])
  assert.deepEqual(compositionViolations({ ...safe, sessionLogUploadDisabled: false }), ['telemetry'])
  assert.deepEqual(compositionViolations({ ...safe, productAnalyticsPinned: false }), ['telemetry'])
  assert.deepEqual(compositionViolations({ ...safe, sandboxMode: 'danger-full-access' }), ['sandbox'])
  assert.deepEqual(compositionViolations({ ...safe, approvalPolicy: 'never' }), ['approval'])
  assert.deepEqual(compositionViolations({ ...safe, toolsMode: 'ptc' }), ['tools'])
  // 宿主入口关闭，由预设作用域提供工具；引擎行 ptc-runtime 必须启用。
  assert.deepEqual(compositionViolations({ ...safe, toolWorkflowDisabled: false }), ['tools'])
  assert.deepEqual(compositionViolations({ ...safe, toolRalphDisabled: false }), ['tools'])
  for (const key of ['scheduleServicePinned', 'scheduleUiDisabled', 'scheduleToolsDisabled']) {
    assert.equal(safe[key], true)
    assert.deepEqual(compositionViolations({ ...safe, [key]: false }), ['tools'])
    assert.deepEqual(compositionViolations({ ...safe, [key]: undefined }), ['tools'])
  }
  assert.deepEqual(compositionViolations({ ...safe, agentPresetDefault: 'standard' }), ['agentPresets'])
  assert.deepEqual(compositionViolations({ ...safe, agentPresetRegistryPinned: false }), ['agentPresets'])
  assert.deepEqual(compositionViolations({ ...safe, agentPresetDeclarationPinned: false }), ['agentPresets'])
  assert.deepEqual(compositionViolations({ ...safe, hmrDisabled: false }), ['patchReload'])
  // 待启用插件被补回组合：本人没点过启用的第三方代码会在下次启动被 import。
  assert.deepEqual(compositionViolations({ ...safe, pendingPluginsExcluded: false }), ['pendingPlugins'])
  // Agent 预设**正文**里的三个判据：roster 只钉住选中哪个 id，正文自己被改动时四键判据看不出来。
  assert.deepEqual(compositionViolations({ ...safe, presetToolPresentationMode: 'ptc' }), ['tools'])
  assert.deepEqual(compositionViolations({ ...safe, presetToolWorkflowDisabled: true }), ['tools'])
  assert.deepEqual(compositionViolations({ ...safe, presetToolRalphDisabled: true }), ['tools'])
  assert.deepEqual(compositionViolations({ ...safe, presetToolWorkflowDisabled: undefined }), ['tools'])
  // 整份正文的规范化摘要：三键之外的任何一行被改、被删、被新增都会体现为摘要不符。
  assert.deepEqual(compositionViolations({ ...safe, presetBodyDigestMatches: false }), ['tools'])
  assert.deepEqual(compositionViolations({ ...safe, presetBodyDigestMatches: undefined }), ['tools'])
  // 第 9 枚：上网的 provider 选择与抓取边界值。换掉 fetchProvider 等于换掉上游那整套 SSRF 保护，
  // 而边界值被放大等于把跳转链、响应体与等待时间的面积交回给补丁层，所以两者钉在一起。
  assert.deepEqual(compositionViolations({ ...safe, webSearchProvider: 'bing' }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webSearchProvider: undefined }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webFetchProvider: 'something-else' }), ['web'])
  // 检索端点与凭据引用：上游是 `config.baseURL ?? $DEEPSEEK_SEARCH_BASE_URL ?? 默认`，
  // 端点被改写等于把检索词连同 DEEPSEEK_API_KEY 一起改投到别处。
  assert.deepEqual(compositionViolations({ ...safe, webSearchBaseUrl: 'https://example.com/v1' }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webSearchBaseUrl: undefined }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webSearchApiKeyEnv: 'OTHER_KEY' }), ['web'])
  // 前面所有取值都只按 id 定位：同一个 id 的 name 被换成第三方实现时，config 逐字对得上，
  // provider 却已被整包顶替——三条 name 判据就是为这件事加的。
  assert.deepEqual(compositionViolations({ ...safe, webRowName: '@vendor/web' }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webSearchRowName: '@vendor/search' }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webFetchRowName: '@vendor/fetch' }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webFetchRowName: undefined }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webFetchMaxResponseBytes: 5000000000 }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webFetchTimeoutMs: 600000 }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webFetchMaxRedirects: 50 }), ['web'])
  // userAgent 是每次外发对目标站点的自我披露，SECURITY.md 逐字承诺了它；伪装成浏览器同样判违规。
  assert.deepEqual(compositionViolations({ ...safe, webFetchUserAgent: 'Mozilla/5.0' }), ['web'])
  // 缺行/缺键同样判违规：取不到这一行就无从证明边界值没被改。
  assert.deepEqual(compositionViolations({ ...safe, webFetchMaxBodyChars: undefined }), ['web'])
  assert.deepEqual(compositionViolations({ ...safe, webFetchUserAgent: undefined }), ['web'])
  // 钉与标签必须同步：漏了标签，拒绝消息里会出现 undefined。
  assert.match(compositionRefusalMessage(['web']), /上网 provider 选择与抓取边界值/)
})

test('预设正文规范化摘要与钉住的字面量一致——改文件必须同步 composition-safety.ts 的 presetBodyDigest', async () => {
  // readPresetBodyFacts() 真实读仓库内那份文件、重新解析、重算摘要并与字面量比对；
  // 这条测试只是把这件事从"compositionViolations 恰好是 []"这个间接信号里显式钉出来——
  // 改预设正文（哪怕只改一个字符、只改一行的 name）却忘了同步这个常量，这条测试会先红。
  const facts = await readPresetBodyFacts()
  assert.ok(facts, '装配期必须能真实读到 Teloa 自带预设正文')
  assert.equal(facts.digestMatches, true, 'teloa-standard/agent.cordis.yml 已改动但 composition-safety.ts 的 presetBodyDigest 常量未同步更新')
})

test('正式组合的原生提醒安全钉拒绝顶层别名和嵌套预设、group 的执行入口', async () => {
  const baseline = dumpRows()
  const pending = (await profileFacts()).pending
  assert.deepEqual(compositionViolations(compositionSnapshot(baseline, pending)), [])
  for (const name of ['@deepseek-ai/dsh-schedule', '@deepseek-ai/dsh-client-ui-schedule', '@deepseek-ai/dsh-tool-schedule']) {
    const alias = { id: 'alias-reminder', name, disabled: false }
    const variants = [
      [...baseline, alias],
      [...baseline, { id: 'extra-group', group: true, disabled: true, config: [alias] }],
      baseline.map(row => row.id === 'preset-standard' ? { ...row, config: { ...row.config, plugins: [...row.config.plugins, alias] } } : row),
    ]
    for (const rows of variants) {
      const snapshot = compositionSnapshot(rows, pending)
      const key = name === '@deepseek-ai/dsh-schedule' ? 'scheduleServicePinned' : name === '@deepseek-ai/dsh-client-ui-schedule' ? 'scheduleUiDisabled' : 'scheduleToolsDisabled'
      assert.equal(snapshot[key], false)
      assert.ok(compositionViolations(snapshot).includes('tools'))
    }
  }
})

test('Teloa 自己在 cordis.patch.yml 打了补丁的每个 id 都必须在拒绝清单里', async () => {
  // 反过来钉住这件事：以后 Teloa 自己新钉一行却忘了同步 deniedPatchRowIds，这条测试先红——
  // 而不是要等到复审逐条比对才发现"自己钉了、却允许第三方插件改"。
  const patch = await readFile(new URL('../packages/bundle/cordis.patch.yml', import.meta.url), 'utf8')
  const ours = [...patch.matchAll(/^- id: (\S+)$/gm)].map(match => match[1])
  assert.ok(ours.length > 10, 'cordis.patch.yml 的解析范围看起来不对，行数过少')
  for (const id of ours)
    assert.ok(deniedPatchRowIds.has(id) || id.startsWith('teloa-'), id + ' 是 Teloa 自己在 cordis.patch.yml 钉的行，必须同时进拒绝清单（teloa- 前缀行走另一条 change.id.startsWith 规则，不必进这张表）')
})

test('组合树里没有任何把这些钉子交回环境变量的入口', () => {
  // !!js 表达式会把取值交回运行环境；这几行必须是字面量。
  for (const id of ['session-telemetry-otel', 'sandbox-policy', 'approval', 'tools', 'web', 'web-search-deepseek', 'web-fetch-http']) {
    assert.doesNotMatch(dumpBlock(id), /^\s+(?:mode|policy|searchProvider|fetchProvider|baseURL|apiKeyEnv|maxResponseBytes|maxBodyChars|timeoutMs|maxRedirects|userAgent): !!js/m, id + ' 的取值不能由 !!js 表达式决定')
  }
  // 后三个是上游 dsh-web / dsh-web-search-deepseek 在 config 缺键时的回落入口：
  // provider 与检索端点都已写成字面量，这几个名字也不该留在组合树里。
  for (const name of ['DSH_TELEMETRY_MODE', 'DSH_TELEMETRY_OTLP_URL', 'DSH_PERMISSION_MODE', 'DSH_TOOLS_MODE', 'DSH_WEB_SEARCH_PROVIDER', 'DSH_WEB_FETCH_PROVIDER', 'DEEPSEEK_SEARCH_BASE_URL']) {
    assert.doesNotMatch(dump(), new RegExp(name), '组合树里不得留下 ' + name + ' 这个覆盖入口')
  }
  // 关闭态的遥测不该再留着对外端点。
  assert.doesNotMatch(dumpBlock('session-telemetry-otel'), /exporter|https?:\/\//, '关闭态不应保留 exporter 或上传端点')
})

test('补丁以字面量钉住这些取值', async () => {
  const patch = await readFile(new URL('../packages/bundle/cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: session-telemetry-otel\n\s+config:\n\s+mode: DISABLED\n/, '补丁必须以字面量钉住 DISABLED')
  assert.match(patch, /- id: session-log-deepseek\n\s+disabled: true\n\s+config:\n\s+enabled: false\n/, '动态日志开关不能重新启用已停用的上传插件')
  assert.match(patch, /- id: sandbox-policy\n(?:\s*#.*\n)*\s+config:\n\s+mode: workspace-write\n\s+workspaceRoot: !!js process\.cwd\(\)\n/, '补丁必须钉住 workspace-write 与 process.cwd() 兜底根')
  assert.match(patch, /- id: tools\n\s+config:\n\s+mode: native\n/, '补丁必须以字面量钉住 native')
  assert.match(patch, /- id: tool-workflow\n\s+disabled: true\n/, '补丁必须以字面量关闭 workflow 工具入口')
  assert.match(patch, /- id: tool-ralph\n\s+disabled: true\n/, '补丁必须以字面量关闭 ralph 工具入口')
  // 引擎行反过来必须留着：Agent 预设把 workflowEngine 绑在 workflow-ptc 上，关掉它任何会话都建不起来。
  assert.match(patch, /- id: ptc-runtime\n\s+disabled: false\n/, '补丁必须保持 ptc-runtime 启用')
  assert.match(patch, /- id: agent-preset-registry\n(?:\s*#.*\n)*\s+inject:\n\s+- loader\n\s+- sessionProjections\n\s+- teloaToolResourceProvenance\n\s+config:\n\s+default: teloa-standard\n/, '补丁必须保持官方注册器、明确来源依赖与运行身份')
  for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'])
    assert.match(patch, new RegExp('- id: ' + id + '\\n\\s+disabled: false\\n'), '官方原生预设必须启用')
  // 第三方 MCP instructions 进系统提示的上限基线。
  assert.match(patch, /- id: teloa-reference-mcp\n(?:.*\n)*?\s+maxInstructionBytes: 2048\n/, '参考 MCP 行必须设定 maxInstructionBytes 基线')
  // 上网的三行：provider 选择、检索端点与凭据引用、抓取边界值与外发披露，逐条是字面量。
  assert.match(patch, /- id: web\n\s+config:\n\s+searchProvider: deepseek-official\n\s+fetchProvider: http\n/, '补丁必须以字面量钉住两个上网 provider')
  assert.match(patch, /- id: web-search-deepseek\n\s+config:\n\s+baseURL: https:\/\/api\.deepseek\.com\/anthropic\/v1\n\s+apiKeyEnv: DEEPSEEK_API_KEY\n/, '补丁必须以字面量钉住检索端点与凭据引用')
  assert.match(patch, /- id: web-fetch-http\n\s+config:\n\s+maxResponseBytes: 5000000\n\s+maxBodyChars: 100000\n\s+timeoutMs: 30000\n\s+maxRedirects: 3\n\s+userAgent: deepseek-harness\/0\.0\.1 \(\+https:\/\/github\.com\/deepseek-ai\)\n/, '补丁必须以字面量钉住抓取边界值与外发 User-Agent')
})

test('Teloa 自带预设面向日常协作，启用受管 workflow 和显式 Ralph', async () => {
  const root = new URL('../packages/bundle/agent-presets/', import.meta.url)
  const composition = await readFile(new URL('teloa-standard/agent.cordis.yml', root), 'utf8')
  // workflow 是「在受沙箱约束的新 Node 进程里跑任意 JS」的工具入口，ralph 是子 Agent 自循环。
  assert.match(composition, /- id: tool-workflow\n\s+name: '@deepseek-ai\/dsh-tool-workflow'\n\s+disabled: false\n/, '自带预设应提供 tool-workflow')
  assert.match(composition, /- id: tool-ralph\n\s+name: '@deepseek-ai\/dsh-tool-ralph'\n\s+disabled: false\n/, '自带预设应提供 tool-ralph')
  // agent 作用域的呈现选择器钉成 native：`mode: ptc` 会把整个工具面换成单一 run_code。
  assert.match(composition, /- id: tool-presentation\n\s+name: '@deepseek-ai\/dsh-agent-tool-presentation'\n\s+config:\n\s+mode: native\n/, '自带预设必须把工具呈现钉成 native')
  // Teloa 标准保持直接工具呈现；程序化呈现由官方 PTC 预设提供。
  const rows = composition.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(rows, /mode: (?:ptc|both)/, '自带预设不得出现 ptc / both 呈现模式')
  const declaration = dumpRows().find(row => row.id === 'teloa-agent-preset')
  // 持续分工迁到官方 Team；四个旧模型工具入口关闭，宿主旧子会话服务仍保留。
  const delegation = declaration.config.plugins.find(row => row.id === 'delegation').config
  for (const id of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']) {
    assert.equal(delegation.find(row => row.id === id)?.disabled, true, id + ' 应由官方 Team 工具替代')
  }
  assert.doesNotMatch(dumpBlock('subagent'), /^\s+disabled: true$/m, '旧子会话的原生读取与控制服务应保留')
  assert.equal(declaration.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(declaration.config.name, 'Teloa 标准模式')
})

test('组合树上 ptc-runtime 保持启用，两条工具入口保持关闭', () => {
  assert.doesNotMatch(dumpBlock('ptc-runtime'), /^\s+disabled: true$/m, 'ptc-runtime 关闭会让 Agent 预设挂载失败、任何 sessions.create 都失败')
  for (const id of ['tool-workflow', 'tool-ralph']) {
    assert.match(dumpBlock(id), /^\s+disabled: true$/m, id + ' 应由预设作用域提供，宿主入口必须关闭')
  }
})

test('组合树中五份预设可用，注册器部署默认身份保持不变', () => {
  const rows = dumpRows()
  const registry = rows.find(row => row.id === 'agent-preset-registry')
  assert.equal(registry.name, '@deepseek-ai/dsh-agent-preset-registry')
  assert.equal(registry.config.default, 'teloa-standard')
  const active = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset' && !row.disabled)
  assert.deepEqual(active.map(row => row.config.id).sort(), ['cordis', 'minimal', 'ptc', 'standard', 'teloa-standard'])
  assert.equal(rows.some(row => row.id === 'agent-presets'), false)
})

test('参考 MCP 的 instructions 上限已收窄到基线', () => {
  assert.match(dumpBlock('teloa-reference-mcp'), /^\s+maxInstructionBytes: 2048$/m, 'MCP instructions 会逐字进系统提示，必须设上限')
})
