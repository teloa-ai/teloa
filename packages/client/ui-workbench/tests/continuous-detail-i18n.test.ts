import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {CONTINUOUS_DETAIL_MESSAGE_ROWS} from '../src/client/i18n/locales/continuous-details.ts'

const sourceFile=new URL('../src/client/ContinuousPage.tsx',import.meta.url)
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

function messageRow(key:string):readonly string[]{
  const row=CONTINUOUS_DETAIL_MESSAGE_ROWS.find(value=>value[0]===key)
  assert.ok(row,`missing ${key}`)
  return row
}

test('ContinuousPage 目录之后的固定用户界面中文全部通过详情词典呈现',async()=>{
  const source=await readFile(sourceFile,'utf8')
  assert.deepEqual(chineseUiLiterals(source.slice(source.indexOf('\nfunction PlanDetail')),'ContinuousPage.tsx'),[])
  assert.match(source,/function PlanDetail[\s\S]*?const \{locale,t,dateTime\}=useI18n\(\)/)
  assert.match(source,/function PlanForm[\s\S]*?const \{locale,t\}=useI18n\(\)/)
  assert.match(source,/function SchedulePreview[\s\S]*?const \{dateTime,t\}=useI18n\(\)/)
  for(const preserved of ['plan.fields.title','plan.fields.goal','run.input','run.result','run.output','display.summary'])assert.match(source,new RegExp(`\\{${preserved.replaceAll('.','\\.')}\\}`),preserved)
})

test('持续计划详情词条按十语顺序完整提供真实翻译',()=>{
  assert.ok(CONTINUOUS_DETAIL_MESSAGE_ROWS.length>0)
  for(const row of CONTINUOUS_DETAIL_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]!.trim(),`${row[0]}: ${locale}`)
  }
  assert.deepEqual(messageRow('continuous.detail.goal'),['continuous.detail.goal','工作目标','工作目標','Work goal','作業目標','작업 목표','Mục tiêu công việc','Objetivo del trabajo','Objectif du travail','Arbeitsziel','Objetivo do trabalho'])
  assert.deepEqual(messageRow('continuous.run.resultAndOutput'),['continuous.run.resultAndOutput','结果与工作成果','結果與工作成果','Result and work output','結果と成果物','결과 및 작업 산출물','Kết quả và sản phẩm công việc','Resultado y producto del trabajo','Résultat et livrable','Ergebnis und Arbeitsergebnis','Resultado e produto do trabalho'])
  assert.deepEqual(messageRow('continuous.form.notificationPolicy'),['continuous.form.notificationPolicy','通知策略','通知策略','Notification policy','通知ポリシー','알림 정책','Chính sách thông báo','Política de notificaciones','Politique de notification','Benachrichtigungsrichtlinie','Política de notificações'])
})
