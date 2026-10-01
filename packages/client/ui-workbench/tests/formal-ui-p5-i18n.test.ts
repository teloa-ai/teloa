import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'

const root=new URL('../src/client/',import.meta.url)
const fixedUi=[
  'TaskExecutions.tsx','HomeResourcePicker.tsx','HomeSkillPicker.tsx','RoleToolGrants.tsx',
  'PlanSkipHistory.tsx','RoleLifecycle.tsx','PlanTemplateOrigin.tsx','TwinDraftEditor.tsx',
  'RoleConfigurationOverview.tsx',
  'role-configuration-relations.ts','task-run-context-presentation.ts','task-run-flow-presentation.ts',
] as const

test('P5 非市场页面的固定界面文案全部走词典',async()=>{
  for(const name of fixedUi){
    const source=await readFile(new URL(name,root),'utf8')
    if(name.endsWith('.tsx'))assert.match(source,/useI18n\(/,name)
    assert.deepEqual(chineseUiLiterals(source,name),[],name)
    assert.doesNotMatch(source,/toLocaleString\(\s*['"]zh-CN['"]|toLocaleString\(\s*\)/,name)
    assert.doesNotMatch(source,/instanceof Error\s*\?[^\n;]*\.message/,name)
  }
})

test('已保存协作与任务交接不向用户直出异常正文',async()=>{
  for(const name of ['SavedCollaborationPage.tsx','TaskHandoffs.tsx']){
    const source=await readFile(new URL(name,root),'utf8')
    assert.match(source,/localizeWorkError\(locale,/,name)
    assert.doesNotMatch(source,/instanceof Error\s*\?[^\n;]*\.message/,name)
  }
})

test('WorkbenchFrame 固定界面错误、准备状态与示例提示使用词典',async()=>{
  const source=await readFile(new URL('WorkbenchFrame.tsx',root),'utf8')
  assert.deepEqual(chineseUiLiterals(source,'WorkbenchFrame.tsx'),[])
  assert.doesNotMatch(source,/document\.title[^\n]*app\.edition\.personal/)
  assert.doesNotMatch(source,/css\.previewLabel|__TELOA_VERSION__/,'版本号只在关于页展示，避免占用每页顶栏')
})

test('P5 词典按十语顺序接入主词典',async()=>{
  const locale=await readFile(new URL('i18n/locales/formal-ui-p5.ts',root),'utf8').catch(()=> '')
  const core=await readFile(new URL('i18n/locales/core-pages.ts',root),'utf8')
  assert.match(locale,/export const FORMAL_UI_P5_MESSAGE_ROWS/)
  assert.match(locale,/assertLocaleRows\(FORMAL_UI_P5_MESSAGE_ROWS\)/)
  assert.match(core,/FORMAL_UI_P5_MESSAGE_ROWS/)
})
