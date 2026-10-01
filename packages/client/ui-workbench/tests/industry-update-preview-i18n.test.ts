import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {INDUSTRY_UPDATE_PREVIEW_MESSAGE_ROWS} from '../src/client/i18n/locales/industry-update-preview.ts'

const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('行业模板更新预览的固定界面、日期和异常全部使用词典',async()=>{
  const source=await readFile(new URL('../src/client/IndustryUpdatePreview.tsx',import.meta.url),'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,'IndustryUpdatePreview.tsx'),[])
  assert.doesNotMatch(source,/toLocale(?:Date|Time|String)\(['"]zh-CN['"]|instanceof Error\s*\?\s*\w+\.message/)
  assert.match(source,/triggerLabel\(plan\.fields\.trigger,t\)/)
})

test('行业更新预览词典提供十套本地化文案并保留动态参数',()=>{
  for(const row of INDUSTRY_UPDATE_PREVIEW_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    const placeholders=[...(row[3]?.match(/\{[^}]+\}/g)??[])].sort()
    for(const [index,locale] of locales.entries()){
      assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
      if(index>=3)assert.deepEqual([...(row[index+1]?.match(/\{[^}]+\}/g)??[])].sort(),placeholders,`${row[0]}: ${locale}`)
    }
    const englishProse=row[3]!.replace(/\{[^}]+\}/g,'')
    if(/[A-Za-z]{3}/.test(englishProse)&&!/^(?:Skill|MCP|ID|SHA-256)$/.test(englishProse.trim()))assert.ok(row.slice(4).some(value=>value!==row[3]),`${row[0]} copied English`)
  }
})
