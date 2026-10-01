import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {configurationGuideUrl} from '../src/client/settings-configuration.ts'

test('配置指南按界面语言选择已提供的中文或英文文档',()=>{
  for(const locale of ['zh-CN','zh-Hant'] as const)assert.equal(configurationGuideUrl(locale),'https://docs.teloa.ai/guides/settings')
  for(const locale of ['en','ja','ko','vi','es','fr','de','pt'] as const)assert.equal(configurationGuideUrl(locale),'https://docs.teloa.ai/en/guides/settings')
})

test('设置保留文档入口，不再嵌入配置步骤卡片',async()=>{
  const [guide,shell]=await Promise.all([
    readFile(new URL('../src/client/SettingsConfigurationGuide.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/SettingsShell.tsx',import.meta.url),'utf8'),
  ])

  assert.match(guide,/href=\{configurationGuideUrl\(locale\)\}/)
  assert.match(guide,/target="_blank" rel="noopener noreferrer"/)
  assert.doesNotMatch(guide,/GuidedSetup|<details|configurationGuideSteps/)
  assert.match(shell,/renderSlot\('settings\.general\.item',\{\}\)<\/section>|renderSlot\('settings\.general\.item',\{\}\).*<SettingsConfigurationGuide\/>/s)
  assert.doesNotMatch(shell,/SettingsConfigurationGuide sections=/)
})
