import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('任务执行结果按会话身份精确打开，不依赖普通工作目录',async()=>{
  const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
  const start=source.indexOf("<TaskExecutions key={'executions-'")
  const end=source.indexOf('/>:null}',start)
  assert.notEqual(start,-1)
  assert.notEqual(end,-1)
  const wiring=source.slice(start,end)
  assert.match(wiring,/await work\.openSession\(sessionId\)/)
  assert.doesNotMatch(wiring,/refreshDirectory\(\)/)
  assert.doesNotMatch(wiring,/executionConversationUnavailable/)
})

test('任务关联区允许打开专用运行会话，同时仍拦截真正缺失的普通会话',async()=>{
  const objectSource=await readFile(new URL('../src/client/ObjectConversations.tsx',import.meta.url),'utf8')
  const frameSource=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
  assert.match(objectSource,/taskRun=row\.sessionId\.startsWith\('task-run-'\)/)
  assert.match(objectSource,/disabled=\{busy\|\|archived\|\|\(!conversation&&!taskRun\)\}/)
  assert.match(objectSource,/open\(row\.sessionId\)/)
  assert.match(frameSource,/open=\{async\(sessionId:string\)=>\{await work\.openSession\(sessionId\)/)
})
