import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {MARKET_INSTALLATION_MESSAGE_ROWS} from '../src/client/i18n/locales/market-installations.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const files=['MarketPluginInstallations.tsx','SavedIndustryDirectory.tsx','MarketForms.tsx','RealSkillInstallations.tsx','SkillUpgradePanel.tsx'] as const
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('市场安装、行业保存与 Skill 升级子流程的固定界面文案全部来自词典',async()=>{
  for(const file of files){
    const source=await readFile(new URL('../src/client/'+file,import.meta.url),'utf8')
    assert.match(source,/useI18n\(/,file)
    assert.deepEqual(chineseUiLiterals(source,file),[],file)
    assert.doesNotMatch(source,/(?:error|cause) instanceof Error\?(?:error|cause)\.message/,file)
    assert.doesNotMatch(source,/\{(?:api\.recoveryMessage\(\)|githubRecovery)\}|\|\|api\.recoveryMessage\(\)/,file)
    if(file==='RealSkillInstallations.tsx')assert.doesNotMatch(source,/(?:installationDirectoryMeta|skillInstallationSourceLabel)\(/)
    if(file==='MarketPluginInstallations.tsx')assert.doesNotMatch(source,/useMarketPluginInstallI18n/,file)
  }
})

test('市场安装子流程词典按十语顺序完整提供人工翻译',()=>{
  const rows=[...MARKET_INSTALLATION_MESSAGE_ROWS]
  assert.ok(rows.length>=80)
  for(const row of rows){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
  }
  assert.deepEqual(rows.find(row=>row[0]==='market.plugin.install.title'),[
    'market.plugin.install.title','DSH 扩展安装','DSH 擴充安裝','DSH extension installation','DSH 拡張機能のインストール','DSH 확장 기능 설치','Cài đặt tiện ích mở rộng DSH','Instalación de extensiones DSH','Installation de l’extension DSH','Installation von DSH-Erweiterungen','Instalação da extensão DSH',
  ])
  const pluginRows=rows.filter(row=>row[0].startsWith('market.plugin.install.'))
  assert.ok(pluginRows.length>=35)
  for(const [offset,locale] of locales.slice(3).entries())assert.ok(pluginRows.filter(row=>row[offset+4]!==row[3]).length>=30,`${locale} mostly copied English`)
})
