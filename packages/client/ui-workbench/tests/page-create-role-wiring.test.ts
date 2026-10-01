import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

test('同事页把数字员工草案接到既有三问表单，真实岗位保存成功后才返回落地身份',async()=>{
 const source=await readFile(new URL('../src/client/TeamPage.tsx',import.meta.url),'utf8')
 assert.match(source,/<CreateEntry entity="role"/)
 assert.match(source,/onConfirm=\{confirmRoleDraft\}/)
 assert.match(source,/initial=\{pendingRoleDraft\?\.initial/)
 assert.match(source,/const id = persistence&&!isSandbox \? await persistence\.create\(fields\)/)
 assert.match(source,/pending\.resolve\(id\)/)
 assert.ok(source.indexOf('await persistence.create(fields)')<source.indexOf('pending.resolve(id)'))
 assert.match(source,/if\(persistence&&!isSandbox\)\{setCreating\(false\);setQuery\(''\);setStatus\('all'\);select\(id\);return\}/)
})

test('工作台把真实草案接口和会话预备路径传给同事页',async()=>{
 const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(source,/pageCreate=\{\{api:pageCreateApi,prepare:prompt=>requestCreation\(\{goal:prompt\.text\}\),openMarket:\(\)=>actions\.openMarket\(\)\}\}/)
})
