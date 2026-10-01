import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {taskRunStopWaitSeconds} from '../src/client/task-run-presentation.ts'
import {FORMAL_UI_P5_MESSAGE_ROWS} from '../src/client/i18n/locales/formal-ui-p5.ts'
import type {RunView} from '../src/client/task-run-api.ts'

const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const
const requested='2026-09-20T09:00:00.000Z',now=Date.parse('2026-09-20T09:00:45.000Z')
const run=(value:Partial<RunView>)=>({state:'active',stopRequestedAt:null,...value} as RunView)

test('已请求停止且仍在执行时给出等待秒数，终态与未请求都不显示',()=>{
 assert.equal(taskRunStopWaitSeconds(run({stopRequestedAt:requested}),now),45)
 assert.equal(taskRunStopWaitSeconds(run({stopRequestedAt:requested}),Date.parse(requested)),0)
 assert.equal(taskRunStopWaitSeconds(run({}),now),undefined)
 assert.equal(taskRunStopWaitSeconds(run({state:'ended',stopRequestedAt:requested}),now),undefined)
 assert.equal(taskRunStopWaitSeconds(run({state:'accepted',stopRequestedAt:requested}),now),undefined)
})

test('执行记录把「停止中」做成可刷新的状态，并在等待期间停用停止按钮',async()=>{
 const source=await readFile(new URL('../src/client/TaskExecutions.tsx',import.meta.url),'utf8')
 assert.match(source,/const stopWait=taskRunStopWaitSeconds\(row,now\)/)
 assert.match(source,/t\('taskExecution\.phase\.stopping',\{seconds:stopWait\}\)/)
 assert.match(source,/includes\('stop'\)&&<button type="button" disabled=\{busy\|\|stopWait!==undefined\}/)
})

test('首屏拉取依赖任务状态，空列表也排一次重读，挂载时为空不再永远空着',async()=>{
 const source=await readFile(new URL('../src/client/TaskExecutions.tsx',import.meta.url),'utf8')
 assert.match(source,/api\.list\(taskId\)[\s\S]*?\},\[taskId,taskState,api,locale\]\)/)
 assert.match(source,/scheduleTaskRunRefresh\(rows,api,[\s\S]*?undefined,\(\)=>api\.list\(taskId\)\)/)
})

test('「停止中 · 已等待」按十语提供真实翻译，并保留秒数占位',()=>{
 const row=FORMAL_UI_P5_MESSAGE_ROWS.find(item=>item[0]==='taskExecution.phase.stopping')
 assert.ok(row,'缺少停止中词条')
 assert.equal(row!.length,locales.length+1)
 for(const [index,locale] of locales.entries())assert.ok(row![index+1]?.includes('{seconds}'),`${locale} 缺少等待秒数`)
 assert.equal(row![1],'停止中 · 已等待 {seconds} 秒')
})
