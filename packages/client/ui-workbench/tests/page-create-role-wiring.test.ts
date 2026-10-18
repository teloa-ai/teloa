import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

test('员工主新建使用Markdown草案，旧未完成提交仍有恢复表单',async()=>{
 const source=await readFile(new URL('../src/client/TeamPage.tsx',import.meta.url),'utf8')
 assert.match(source,/onClick=\{\(\) => setCreating\(true\)\}/)
 assert.match(source,/creating&&pageCreate&&persistence&&!isSandbox&&!persistence.pendingFields\(\)/)
 assert.match(source,/<EmployeeCreateEntry/)
 assert.match(source,/:creating&&<RoleForm/)
 assert.match(source,/pendingFields\(\).*creationDraft/)
 assert.match(source,/await persistence\.create\(fields\)/)
 assert.ok(source.indexOf('await persistence.create(fields)')<source.indexOf('setCreationDraft(undefined);setCreating(false);select(id)'))
 assert.match(source,/sourceMode==='import'/)
 assert.match(source,/accept="\.txt,\.md,text\/plain,text\/markdown"/)
})

test('工作台把真实草案接口和会话预备路径传给同事页',async()=>{
 const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(source,/pageCreate=\{\{api:pageCreateApi,prepare:\(prompt,scope\)=>preparePageCreation\(prompt,scope\),openMarket:\(\)=>actions\.openMarket\(\)\}\}/)
})
