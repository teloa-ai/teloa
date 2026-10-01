import test from 'node:test'
import assert from 'node:assert/strict'
import {MAIN_LOCALES} from '../lib/types/client/i18n/locale.js'
import {translateMessage} from '../lib/types/client/i18n/messages.js'

test('员工导航、添加入口和身份标签覆盖十种产品语言',()=>{
 const expected=[
  ['员工','添加 AI 员工','AI 员工'],
  ['員工','新增 AI 員工','AI 員工'],
  ['Employees','Add AI employee','AI employee'],
  ['従業員','AI 従業員を追加','AI 従業員'],
  ['직원','AI 직원 추가','AI 직원'],
  ['Nhân viên','Thêm nhân viên AI','Nhân viên AI'],
  ['Empleados','Añadir empleado de IA','Empleado de IA'],
  ['Employés','Ajouter un employé IA','Employé IA'],
  ['Mitarbeitende','KI-Mitarbeiter hinzufügen','KI-Mitarbeiter'],
  ['Funcionários','Adicionar funcionário de IA','Funcionário de IA'],
 ]
 for(const [index,locale]of MAIN_LOCALES.entries()){
  const [navigation,add,identity]=expected[index]!
  for(const key of ['navigation.team','navigation.v2.colleagues'] as const)assert.equal(translateMessage(locale,key),navigation)
  for(const key of ['team.action.new','team.form.newRole','home.action.newRole'] as const)assert.equal(translateMessage(locale,key),add)
  assert.equal(translateMessage(locale,'team.form.employee'),identity)
  assert.ok(translateMessage(locale,'team.profile.title').trim())
 }
})

test('长期员工、分身与临时任务助手在界面中保持明确区别',()=>{
 assert.equal(translateMessage('zh-CN','team.profile.title'),'员工档案')
 assert.match(translateMessage('zh-CN','team.form.twin'),/分身/)
 assert.match(translateMessage('zh-CN','subagent.grant.title'),/临时任务助手/)
 assert.match(translateMessage('en','subagent.grant.title'),/temporary task assistants/)
})
