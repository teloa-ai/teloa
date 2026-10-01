import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'

const root=new URL('../src/client/',import.meta.url)

test('P6 固定组件文案与错误提示全部走当前词典',async()=>{
  for(const name of ['ApprovalNotes.tsx','GuidedSetup.tsx','PreparedPromptCard.tsx','TaskArtifactPicker.tsx']){
    const source=await readFile(new URL(name,root),'utf8')
    assert.match(source,/useI18n\(/,name)
    assert.deepEqual(chineseUiLiterals(source,name),[],name)
    assert.doesNotMatch(source,/instanceof Error\s*\?[^\n;]*\.message/,name)
  }
  const prepared=await readFile(new URL('PreparedPromptCard.tsx',root),'utf8')
  assert.match(prepared,/localizeWorkError\(locale,/, 'PreparedPromptCard.tsx')
})

test('P6 正式页面直接消费的展示层只返回词典结果或稳定语义键',async()=>{
  for(const name of ['plan-source-presentation.ts','work-presentation.ts']){
    const source=await readFile(new URL(name,root),'utf8')
    assert.deepEqual(chineseUiLiterals(source,name),[],name)
  }
})

test('P6 preview 状态真源使用 message key',async()=>{
  const business=await readFile(new URL('business-preview.ts',root),'utf8')
  const continuous=await readFile(new URL('continuous-preview.ts',root),'utf8')
  assert.match(business,/pending:'task\.detail\.operation\.pending'/)
  assert.match(continuous,/planNotificationPolicyKeys[^\n]*always:'continuous\.form\.notification\.always'/)
})

test('P6 十语词典接入主词典',async()=>{
  const locale=await readFile(new URL('i18n/locales/formal-ui-p6.ts',root),'utf8').catch(()=> '')
  const core=await readFile(new URL('i18n/locales/core-pages.ts',root),'utf8')
  assert.match(locale,/export const FORMAL_UI_P6_MESSAGE_ROWS/)
  assert.match(locale,/assertLocaleRows\(FORMAL_UI_P6_MESSAGE_ROWS\)/)
  assert.match(core,/FORMAL_UI_P6_MESSAGE_ROWS/)
})
