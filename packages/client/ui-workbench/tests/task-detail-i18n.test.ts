import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {registerHooks} from 'node:module'
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/i18n/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {translateMessage}=await import('../src/client/i18n/messages.ts')
import {chineseUiLiterals} from './i18n-ast.ts'
import {TASK_DETAIL_MESSAGE_ROWS} from '../src/client/i18n/locales/task-details.ts'

const sourceFile=new URL('../src/client/TaskPage.tsx',import.meta.url)
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

function messageRow(key:string):readonly string[]{
  const row=TASK_DETAIL_MESSAGE_ROWS.find(value=>value[0]===key)
  assert.ok(row,`missing ${key}`)
  return row
}

test('TaskPage 目录之后的固定用户界面中文全部通过详情词典呈现',async()=>{
  const source=await readFile(sourceFile,'utf8')
  assert.deepEqual(chineseUiLiterals(await readFile(new URL('../src/client/TaskDetail.tsx',import.meta.url),'utf8'),'TaskDetail.tsx'),[])
  assert.match(source,/const \{locale,t,dateTime\}=useI18n\(\)/)
  assert.match(source,/const \{locale,t\}=useI18n\(\)/)
})

test('任务详情定稿简繁英完整，既有七语保留或按实际词表回退英文',()=>{
  for(const row of TASK_DETAIL_MESSAGE_ROWS){
    assert.ok(row.length===4||row.length===locales.length+1,row[0]+' 必须为三语定稿或既有十语，不能少列/错位')
    for(const [index,locale] of locales.entries()){
      const declared=row[index+1]
      if(index<3)assert.ok(declared?.trim(),`${row[0]}: ${locale}`)
      if(declared!==undefined)assert.ok(declared.trim(),`${row[0]}: ${locale} 既有翻译不能为空`)
      assert.equal(translateMessage(locale,row[0] as Parameters<typeof translateMessage>[1]),declared??row[3],`${row[0]}:${locale} 实际呈现保持翻译或英文回退，不能显示键名`)
    }
  }
  assert.deepEqual(messageRow('task.detail.currentOwnerLabel'),[
    'task.detail.currentOwnerLabel','当前负责','目前負責','Current owner','現在の担当','현재 담당','Người phụ trách hiện tại','Responsable actual','Responsable actuel','Derzeit zuständig','Responsável atual',
  ])
  assert.deepEqual(messageRow('task.detail.materialSource'),[
    'task.detail.materialSource','资料来源','資料來源','Material source','資料の出所','자료 출처','Nguồn tài liệu','Fuente del material','Source du document','Materialquelle','Fonte do material',
  ])
  assert.deepEqual(messageRow('task.form.goalScope'),[
    'task.form.goalScope','目标与范围','目標與範圍','Goal and scope','目標と範囲','목표 및 범위','Mục tiêu và phạm vi','Objetivo y alcance','Objectif et périmètre','Ziel und Umfang','Objetivo e escopo',
  ])
})

test('已保存任务详情呈现服务端给出的具体待办原因',async()=>{
  const source=await readFile(sourceFile,'utf8')
  assert.match(source,/attentionReason=\{actualAttention\?taskAttentionDescription\(actualAttention\.reason,t\):pendingHandoff\(task\)\?\.reason\}/)
  assert.match(await readFile(new URL('../src/client/TaskDetail.tsx',import.meta.url),'utf8'),/data-teloa-attention-reason/)
  assert.ok(messageRow('task.detail.attentionReason'))
})

test('外部动作和新增错误十语完整，不把受理翻译为完成',()=>{
 for(const key of ['security.title','security.execution.accepted','security.execution.effect_unknown','security.execution.succeeded','security.recover','security.attention.execution-required','error.dependencyUnavailable','error.invalidHostResponse','error.storageCorrupt'])assert.equal(messageRow(key).length,11)
 assert.equal(messageRow('security.title')[1],'外部动作')
 assert.equal(messageRow('security.execution.accepted')[1],'目标系统已受理')
})
test('外部动作风险、可逆性、目标效果和恢复命令不泄露未翻译的状态码',()=>{
 for(const key of ['security.risk.high','security.risk.med','security.risk.low','security.reversible.readonly','security.reversible.reversible','security.reversible.irreversible','security.target.unknown','security.target.failed','security.target.succeeded','security.command.withdraw-approval'])assert.equal(messageRow(key).length,11)
})
