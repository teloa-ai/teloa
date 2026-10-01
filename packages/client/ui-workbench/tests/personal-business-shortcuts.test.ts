import test from 'node:test'
import assert from 'node:assert/strict'
import {businessShortcutKey,businessShortcutLimit,changeBusinessShortcuts,normalizeBusinessShortcutTarget,normalizeBusinessShortcuts} from '../src/client/personal-business-shortcuts.ts'
import {BUSINESS_SHORTCUT_MESSAGE_ROWS} from '../src/client/i18n/locales/business-shortcuts.ts'

test('个人业务快捷入口只接受稳定面板，重复项与详情字段都会被归一化',()=>{
 const shortcuts=normalizeBusinessShortcuts([
  {target:{scope:'SOC',section:'data',id:'alert-1'}},
  {target:{scope:'SOC',section:'data'}},
  {target:{scope:' AppSec ',section:'analysis'}},
  {target:{scope:'SOC',section:'continuous'}},
  {target:{scope:'',section:'overview'}},
 ])
 assert.deepEqual(shortcuts,[{target:{scope:'SOC',section:'data'}},{target:{scope:'AppSec',section:'analysis'}}])
 assert.equal(businessShortcutKey(shortcuts[0]!.target),'["SOC","data"]')
})

test('固定、取消固定和上限均为幂等操作',()=>{
 let shortcuts=changeBusinessShortcuts([],{type:'pin',target:{scope:'SOC',section:'overview'}})
 shortcuts=changeBusinessShortcuts(shortcuts,{type:'pin',target:{scope:'SOC',section:'overview'}})
 assert.equal(shortcuts.length,1)
 for(let index=0;index<businessShortcutLimit+2;index++)shortcuts=changeBusinessShortcuts(shortcuts,{type:'pin',target:{scope:'业务'+index,section:'data'}})
 assert.equal(shortcuts.length,businessShortcutLimit)
 assert.deepEqual(changeBusinessShortcuts(shortcuts,{type:'unpin',target:{scope:'SOC',section:'overview'}}).some(row=>row.target.scope==='SOC'),false)
})

test('看板可按看板标识分别固定，非看板栏目丢弃看板标识，旧存储值照读',()=>{
 const ops={scope:'SOC',section:'dashboards' as const,dashboardId:'soc-ops'},risk={...ops,dashboardId:'soc-risk'}
 assert.notEqual(businessShortcutKey(ops),businessShortcutKey(risk))
 let shortcuts=changeBusinessShortcuts([],{type:'pin',target:ops})
 shortcuts=changeBusinessShortcuts(shortcuts,{type:'pin',target:risk})
 assert.deepEqual(shortcuts.map(row=>row.target),[ops,risk])
 assert.deepEqual(normalizeBusinessShortcutTarget({scope:'SOC',section:'data',dashboardId:'soc-ops'}),{scope:'SOC',section:'data'})
 assert.deepEqual(normalizeBusinessShortcutTarget({scope:'SOC',section:'dashboards',dashboardId:'soc:ops'}),{scope:'SOC',section:'dashboards'})
 assert.deepEqual(normalizeBusinessShortcuts([{target:{scope:'SOC',section:'analysis'}}]),[{target:{scope:'SOC',section:'analysis'}}])
 assert.equal(businessShortcutKey({scope:'SOC',section:'analysis'}),'["SOC","analysis"]')
 for(let index=0;index<businessShortcutLimit+2;index++)shortcuts=changeBusinessShortcuts(shortcuts,{type:'pin',target:{scope:'SOC',section:'dashboards',dashboardId:'board-'+index}})
 assert.equal(shortcuts.length,businessShortcutLimit)
})

test('固定入口的词条覆盖全部产品语言',()=>{
 for(const row of BUSINESS_SHORTCUT_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.ok(row.slice(1).every(value=>value.trim()),row[0])
 }
})
