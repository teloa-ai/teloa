import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {HOME_SECONDARY_MESSAGE_ROWS} from '../src/client/i18n/locales/home-secondary.ts'

const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('工作首页的快捷入口、负责人和会话状态全部通过词典呈现',async()=>{
  const source=await readFile(new URL('../src/client/WorkHome.tsx',import.meta.url),'utf8')
  assert.deepEqual(chineseUiLiterals(source,'WorkHome.tsx'),[])
  assert.doesNotMatch(source,/workStatusLabels/)
})

test('工作首页补充词典覆盖十套主语言',()=>{
  assert.ok(HOME_SECONDARY_MESSAGE_ROWS.length>=22)
  for(const row of HOME_SECONDARY_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
  }
  const rows=new Map(HOME_SECONDARY_MESSAGE_ROWS.map(row=>[row[0],row]))
  assert.equal(rows.get('home.quick.alert')?.[3],'Investigate alert')
  assert.equal(rows.get('home.assignee.self')?.[3],'{name} · Me')
  assert.equal(rows.get('home.recent.open')?.[3],'Continue: {title}')
  assert.equal(rows.get('home.recent.genericContext')?.[3],'Conversation')
  assert.equal(rows.get('home.overview.colleaguesActiveDescription')?.[3],"{count} work items are assigned to {people} employees.")
  assert.equal(rows.get('home.overview.colleaguesEmpty')?.[3],"No unfinished work is currently assigned to an employee.")
  assert.equal(rows.get('business.scope.general')?.[3],'General work')
})

test('最近会话不再把通用工作与本人硬编码成所有会话的归属',async()=>{
  const source=await readFile(new URL('../src/client/WorkHome.tsx',import.meta.url),'utf8')
  assert.match(source,/homeRecentContext\(conversation,conversationLinks,workTasks,colleagues,scopeNames/)
  assert.match(source,/home\.recent\.genericContext/)
  assert.doesNotMatch(source,/scope:scopeNames\.general,owner:t\('home\.owner\.me'\)/)
})
