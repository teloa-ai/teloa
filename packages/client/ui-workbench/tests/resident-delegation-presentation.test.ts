import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {canReceiveTask} from '../src/client/role-preview.ts'
import {roleDelegationMessages,roleDelegationHongKongMessages} from '../src/client/i18n/locales/role-delegation.ts'

const source=readFileSync(new URL('../src/client/RoleDelegation.tsx',import.meta.url),'utf8')
const exports:Record<string,any>={}
new Function('require','exports',ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)((name:string)=>name==='./role-preview.js'?{canReceiveTask}:new Proxy({},{get:()=>()=>undefined}),exports)
const status=exports.roleDelegationStatus
const role={id:'role',kind:'twin',version:2,state:'active',scopes:['general']}
const delegation={id:'delegation',roleId:'role',ownerId:'owner',roleVersion:2,version:1,state:'active',scope:'general',groupIds:[],updatedAt:'2026-10-09T00:00:00.000Z'}
const read={roleId:'role',roleVersion:2,delegations:[delegation],consents:[],canEditExecution:false}
test('委托中间态不能宣称已停，保存分身委托也不等于本人执行确认',()=>{
 assert.equal(status(role,undefined),'roleDelegation.loading')
 assert.equal(status(role,{...read,delegations:[]}),'roleDelegation.status.draft')
 assert.equal(status(role,read),'roleDelegation.status.awaitingConsent')
 for(const state of ['pausing','paused','ending','ended'])assert.equal(status(role,{...read,delegations:[{...delegation,state}]}),'roleDelegation.status.'+state)
 assert.equal(status(role,{...read,roleVersion:1}),'roleDelegation.status.stale')
})
test('新委托词条定稿三类语言；港澳地区使用原有地区覆盖，其余语言回退英文',()=>{
 for(const locale of ['zh-CN','zh-Hant','en'] as const)assert.ok(roleDelegationMessages[locale]['roleDelegation.taskConfirm'].length>10)
 assert.equal(roleDelegationHongKongMessages['roleDelegation.refresh'],'重新載入委託狀態')
 const assembly=readFileSync(new URL('../src/client/i18n/messages.ts',import.meta.url),'utf8')
 for(const locale of ['ja','ko','vi','es','fr','de','pt'])assert.match(assembly,new RegExp(locale+': \\{[^\\n]*roleDelegationMessages\\.en'))
})
