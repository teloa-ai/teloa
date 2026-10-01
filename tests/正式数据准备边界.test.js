import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateIndustryManifest } from '../packages/client/ui-workbench/src/client/industry-manifest.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readSource = path => readFile(resolve(root, path), 'utf8')

const files = {
  workspace: 'scripts/准备本机工作目录.mjs',
  capabilities: 'scripts/准备正式技能能力数据.mjs',
  workbench: 'packages/client/ui-workbench/src/client/WorkbenchFrame.tsx',
}

test('正式数据准备不替用户授权，也不伪造人工审批', async () => {
  const sources = await Promise.all([readSource(files.workspace), readSource(files.capabilities)])
  const seedSource = sources.join('\n')

  assert.doesNotMatch(seedSource, /\.authorize\s*\(/, '准备脚本不得把待授权来源或工具自动改成已授权')
  assert.doesNotMatch(seedSource, /\bSecurityApprovalService\b/, '准备脚本不得调用人工审批服务')
  assert.doesNotMatch(seedSource, /impactConfirmed\s*:\s*true\b/, '准备脚本不得伪造用户已确认影响范围')
})

test('正式来源使用如实名称，不把固定展示数据包装成官方内置内容', async () => {
  const sources = await Promise.all([readSource(files.workspace), readSource(files.capabilities)])
  for (const source of sources) {
    assert.doesNotMatch(source, /Teloa\s*内置/, '本机固定内容不得标成“Teloa 内置”')
  }
})

test('幂等请求标识显式包含种子结构版本', async () => {
  const source = await readSource(files.workspace)
  const declaration = source.match(/const\s+(SEED_SCHEMA_VERSION|seedSchemaVersion|seedVersion|seedRevision)\s*=\s*['"](v\d+)['"]/)

  assert.ok(declaration, '准备脚本必须声明可独立升级的种子结构版本，例如 seedSchemaVersion="v2"')
  const requestIdSection = source.slice(source.indexOf('function requestId'), source.indexOf('const knowledgeDefinitions'))
  assert.ok(requestIdSection.includes(declaration[1]), 'requestId 的哈希输入必须包含种子结构版本')
})


test('同一模板的活动加载内容变化时必须进入显式升级流程', async () => {
  const source = await readSource(files.capabilities)

  assert.match(source, /status\s*===\s*['"]active['"][\s\S]{0,240}templateId\s*===\s*content\.logicalId|templateId\s*===\s*content\.logicalId[\s\S]{0,240}status\s*===\s*['"]active['"]/, '必须先识别同一逻辑模板的活动加载')
  assert.match(source, /contentId\s*!==\s*content\.id|contentHash\s*!==\s*content\.hash/, '必须识别活动加载与当前内容或哈希不一致')
  assert.match(source, /升级流程|先升级|需要升级/, '内容变化时必须给出明确的升级阻断信息')
})

test('正式工作台不能重新接入沙盒市场或示例数据注入器', async () => {
  const source = await readSource(files.workbench)

  assert.doesNotMatch(source, /\b(?:sandboxMarket|marketExamples|with[A-Za-z0-9_$]*Examples)\b/, 'WorkbenchFrame 正式入口只能读取持久数据')
})

// 可发布性守卫盯的是真正会进市场的那两个包。测试夹具不再是市场条目，改钉示例目录：
// 夹具就算双语齐备也不会被任何人看到，而示例合包缺一条英文名就会在市场页上露出来。
test('进入市场的安全运营与应用安全示例包具备可发布的中英文元数据', async () => {
  for (const [directory, scope] of [['安全运营', 'SOC'], ['应用安全', 'AppSec']]) {
    const raw = JSON.parse(await readSource(`examples/industry/${directory}/teloa.json`))
    const manifest = validateIndustryManifest(raw)

    assert.equal(manifest.scope, scope)
    assert.equal(manifest.domain, 'security')
    assert.equal(typeof manifest.localized?.title?.locales['zh-CN'], 'string')
    assert.equal(typeof manifest.localized?.title?.locales.en, 'string')
    assert.equal(typeof manifest.localized?.description?.locales['zh-CN'], 'string')
    assert.equal(typeof manifest.localized?.description?.locales.en, 'string')
    for (const resource of manifest.resources) {
      assert.equal(typeof resource.localized?.title?.locales['zh-CN'], 'string', `${directory}/${resource.id} 缺少简体中文名称`)
      assert.equal(typeof resource.localized?.title?.locales.en, 'string', `${directory}/${resource.id} 缺少英文名称`)
    }
    const objectTypes = manifest.resources.filter(resource => resource.kind === 'object-type').map(resource => resource.id)
    assert.ok(objectTypes.length > 0, `${directory} 没有对象类型声明，台账无从渲染`)
    const listDefinitions = await Promise.all(
      manifest.resources.filter(resource => resource.kind === 'business-view' && resource.source.kind === 'local')
        .map(async resource => JSON.parse(await readSource(`examples/industry/${directory}/${resource.source.path}`))),
    )
    for (const objectType of objectTypes) {
      assert.ok(listDefinitions.some(view => view.kind === 'list' && view.objectType === objectType), `${directory}/${objectType} 缺少对象清单视图`)
    }
  }
})

test('固定行业目录元数据升级保留既有实例并使用版本化请求', async () => {
  const source = await readSource(files.workspace)

  assert.match(source, /market:\$\{key\}:\$\{manifest\.version\}/, '同一模板的新版本必须使用新的导入请求标识')
  assert.match(source, /compareIndustryUpdateCore\(baseline,candidate\)/, '升级前必须使用正式比较核重算差异')
  assert.match(source, /localizationOnlyChange\(baselineContent,candidateContent,item\)/, '定义翻译升级必须逐字证明除 localized 与 patch 版本外没有变化')
  assert.match(source, /localizedChanges\.has\(item\.id\)\?['"]candidate['"]/, '通过逐字核验的定义翻译必须采用候选内容')
  assert.match(source, /approvedLocalDirectoryAdditions/, '本机对象清单补齐必须使用显式允许清单')
  assert.match(source, /item\.change===['"]added['"]\|\|localizedChanges\.has\(item\.id\)\?['"]candidate['"]/, '显式允许的新增对象清单必须采用候选定义')
  assert.match(source, /sourceItem\.carriedFrom\?\?sourceItem\.instanceId/, '数据源实例必须沿升级血缘查找')
  assert.match(source, /toolItem\.carriedFrom\?\?toolItem\.instanceId/, '执行工具实例必须沿升级血缘查找')
})

// 市场条目从测试夹具换成示例合包后，旧台账的 templateId 再也不会出现在任何一次导入里，
// ensureIndustry 的 stale 判定（同 templateId 不同内容）认不出它们。已有 .runtime 上重跑时
// 旧台账会与新包在同一业务范围里各留一条活动加载，同名 object-type 跨加载冲突、台账整条读不出来。
// 这条用例钉住那段显式退役：按 templateId 找活动加载，走正式卸载服务，不直接删表。
test('准备脚本按 templateId 显式卸载旧台账加载，且走正式卸载服务', async () => {
  const source = await readSource(files.workspace)

  assert.match(source, /retiredLedgerTemplateIds\s*=\s*\[\s*['"]soc-ledger['"]\s*,\s*['"]appsec-ledger['"]\s*\]/, '必须显式列出被换掉的旧台账模板标识')
  assert.match(source, /status==='active'&&retiredLedgerTemplateIds\.includes\(load\.templateId\)/, '必须按 templateId 找出仍在生效的旧台账加载')
  assert.match(source, /loads\.unload\(ownerId,\{requestId:requestId\('retire-fixture-ledger:'\+load\.templateId\)/, '退役必须走正式卸载服务并使用可复放的请求标识')
  assert.match(source, /expectedMappingHash:load\.mappingHash/, '卸载必须带上映射指纹，避免误卸掉已经变化的加载')
  assert.match(source, /unloaded\.status!=='unloaded'/, '卸载结果必须核对到 unloaded，不能与旧台账并存')
  assert.doesNotMatch(source, /delete\s+from\s+teloa_industry_loads/i, '退役不得绕过卸载服务直接删表')
  assert.match(source, /const retiredLedgers=await retireFixtureLedgerLoads\(\)/, '退役必须发生在导入示例合包之前')
  assert.ok(
    source.indexOf('retireFixtureLedgerLoads()') < source.indexOf("ensureIndustry('soc'"),
    '退役必须排在安全运营合包导入之前',
  )
  // 市场内容唯一键含来源指纹，加载表唯一键只含 content_hash：同一批字节换个来源名会多出一行内容、
  // 拿到另一个 contentId。按 contentId 认领会在旧库上同时判成「没认领到」和「同版本不可升级」，
  // 既建不了新加载（同字节已占用加载表唯一键）又走不了升级，整条初始化卡死。
  assert.match(source, /value\.status==='active'&&value\.contentHash===imported\.content\.hash/, '认领既有加载必须按内容字节摘要，不能按 contentId')
  assert.match(source, /value\.templateId===imported\.content\.logicalId&&value\.contentHash!==imported\.content\.hash/, 'stale 判定必须按内容字节摘要，不能按 contentId')
})
