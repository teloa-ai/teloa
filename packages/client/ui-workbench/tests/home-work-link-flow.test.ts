import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'

const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
const conversations=readFileSync(new URL('../src/client/ObjectConversations.tsx',import.meta.url),'utf8')
const home=readFileSync(new URL('../src/client/WorkHome.tsx',import.meta.url),'utf8')

test('首页正常发送只进入原生输入，任务关联仍保留核对恢复入口',()=>{
  assert.doesNotMatch(frame,/startGoal|homeWorkIntent|pinHomeWorkResources/)
  assert.doesNotMatch(home,/<textarea|modeSwitch/)
  assert.match(frame,/renderSlot\('teloa\.conversation'/)
  assert.match(conversations,/['"]objectConversations\.continue['"]/)
})

test('从任务新建关联会话后自动准备固定任务与业务对象上下文',()=>{
  const create=frame.indexOf('async function createWork')
  const link=frame.indexOf("await ensureHomeObjectContext(objectConversationApi,object,row.sessionId,intent.scope)",create)
  const prepare=frame.indexOf('await prepareTaskConversation(object,conversation,canContinue)',link)
  assert.ok(link>create)
  assert.ok(prepare>link)
})

test('新建角色与任务的迟到后续只使用已有会话，任务读取后再次核对导航权',()=>{
 assert.match(frame,/const canContinue=\(\)=>mayContinueHomeCreation\(creationLocation,latestState\.current,mainSession\.getSnapshot\(\),conversation\.sessionId\)/)
 assert.match(frame,/if\(!canContinue\(\)\)\{intent\.resolve/)
 assert.match(frame,/await prepareTaskConversation\(object,conversation,canContinue\)/)
 assert.doesNotMatch(frame,/sendRoleIdentity\(object,conversation,canContinue\)/)
 const task=frame.slice(frame.indexOf('const prepareTaskConversation='),frame.indexOf('const persistentObjectConversations='))
 assert.match(task,/await objectConversationApi\.taskContext[\s\S]*?if\(canContinue\?\.\(\)===false\)return[\s\S]*?if\(!canContinue\)await work\.openConversation/)
})


test('首页原生空会话用固定身份显式加入工作目录，目录仅隐藏仍空白的行',()=>{
 const index=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8'),directory=readFileSync(new URL('../src/client/WorkDirectory.tsx',import.meta.url),'utf8')
 assert.match(index,/call\('conversations\/adopt',\{sessionId:id,requestId:id,title:/)
 assert.match(directory,/filter\(item=>item\.status!=='blank'&&managed\.archived/)
})
