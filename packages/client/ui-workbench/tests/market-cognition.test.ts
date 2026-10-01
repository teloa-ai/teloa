import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const sources=await Promise.all([
  'MarketPage.tsx',
  'CapabilityBindings.tsx',
  'market-page-guidance.ts',
  'capability-preview.ts',
].map(file=>readFile(new URL('../src/client/'+file,import.meta.url),'utf8')))
const relatedMarketCopy=(await Promise.all([
  'TeamCapabilitiesPage.tsx',
  'Capabilities.tsx',
  'WorkbenchFrame.tsx',
  'TaskPage.tsx',
  'MarketResourceCatalog.tsx',
  'market-runtime-state.ts',
  'market-preview.ts',
].map(file=>readFile(new URL('../src/client/'+file,import.meta.url),'utf8')))).join('\n')

test('市场把底层草案状态翻译成用户可操作的能力使用方案',()=>{
  const [market,,guidance]=sources
  assert.match(market!,/market\.intent\.awaitingConfiguration/)
  assert.doesNotMatch(market!,/配置草案/)
  assert.doesNotMatch(guidance!,/配置草案/)
  assert.doesNotMatch(relatedMarketCopy,/配置草案/)
  assert.match(guidance!,/待应用方案/)
})

test('能力绑定用模拟动作表达示例流程，不把演示应用写成真实状态',()=>{
  const [,bindings,,preview]=sources
  assert.match(bindings!,/>\{t\('capability\.action\.activate',\{version:versionNumber\}\)\}<\/button>/)
  assert.match(bindings!,/<strong>\{t\('capability\.demo\.label'\)\}<\/strong>/)
  assert.doesNotMatch(bindings!,/演示应用/)
  assert.doesNotMatch(preview!,/演示启用配置/)
})

test('正式安装维护默认打开真实 Skill 目录，且不依赖旧模拟状态机',()=>{
  const [market]=sources
  assert.match(market!,/const mode=selected\?\.startsWith\('plugin:'\)\?'plugins':'skills'/)
  assert.match(market!,/onClick=\{\(\)=>props\.installations\.open\('skill:directory'\)\}/)
  assert.doesNotMatch(market!,/onClick=\{\(\)=>props\.installations\.open\('examples'\)\}/)
  assert.doesNotMatch(market!,/MarketInstallations\.js/)
  assert.doesNotMatch(market!,/installations\.preview/)
})

test('Skill 市场目录不重复嵌入全局安装维护目录',()=>{
  const [market]=sources
  assert.doesNotMatch(market!,/SkillInstallDirectory/)
})
