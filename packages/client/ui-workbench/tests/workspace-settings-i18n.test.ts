import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {WORKSPACE_SETTINGS_MESSAGE_ROWS} from '../src/client/i18n/locales/workspace-settings.ts'

test('本机工作区设置的固定界面文案全部来自词典',async()=>{
  const source=await readFile(new URL('../src/client/WorkspaceSettings.tsx',import.meta.url),'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,'WorkspaceSettings.tsx'),[])
  assert.match(source,/localizeWorkError\(locale,operationError\)/)
  assert.match(source,/localizeWorkError\(locale,state\.sourceError\)/)
  assert.doesNotMatch(source,/>\{state\.error\|\|state\.sourceError\}</)
  assert.doesNotMatch(source,/>\{state\.notice\}</)
})

test('本机工作区设置词典为十种主语言提供完整翻译',()=>{
  const keys=new Set<string>()
  for(const row of WORKSPACE_SETTINGS_MESSAGE_ROWS){
    assert.equal(row.length,11,row[0])
    assert.equal(keys.has(row[0]),false,row[0])
    keys.add(row[0])
    for(const value of row.slice(1))assert.ok(value.trim(),row[0])
    assert.notEqual(row[1],row[3],`${row[0]} en`)
    assert.notEqual(row[1],row[4],`${row[0]} ja`)
    assert.notEqual(row[1],row[5],`${row[0]} ko`)
    assert.notEqual(row[1],row[6],`${row[0]} vi`)
  }
  const messageKeys=new Set(WORKSPACE_SETTINGS_MESSAGE_ROWS.map(row=>row[0]))
  for(const key of [
    'workspaceSettings.error.connection','workspaceSettings.error.removed','workspaceSettings.error.pathRequired',
    'workspaceSettings.error.nameChanged','workspaceSettings.error.nameInvalid','workspaceSettings.error.identityMismatch',
    'workspaceSettings.error.removeConfirmation','workspaceSettings.notice.added','workspaceSettings.notice.nameSaved',
    'workspaceSettings.notice.removed','workspaceSettings.notice.orderSaved',
  ] as const)assert.ok(messageKeys.has(key),key)
})
