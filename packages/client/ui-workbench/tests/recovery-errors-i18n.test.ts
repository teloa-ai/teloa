import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskRunApi} from '../src/client/task-run-api.ts'
import {createArtifactApi} from '../src/client/artifact-api.ts'
import {createTaskApi} from '../src/client/task-api.ts'
import {createTaskTransitionApi} from '../src/client/task-transition-api.ts'
import {createRoleApi} from '../src/client/role-api.ts'
import {createRoleLifecycleApi} from '../src/client/role-lifecycle-api.ts'
import {createHandoffApi} from '../src/client/handoff-api.ts'
import {localizeWorkError} from '../lib/types/client/i18n/errors.js'
import {translateMessage} from '../lib/types/client/i18n/messages.js'

const call=async()=>{throw Error('不应调用服务端')}
const corruptJournal={read:()=>'{broken',write:(_value:string)=>{},clear:()=>{}}

test('恢复日志损坏统一暴露稳定错误码并按当前语言显示',()=>{
 const errors=[
  createTaskRunApi(call,corruptJournal).recoveryMessage(),
  createArtifactApi(call,corruptJournal).recoveryMessage(),
  createTaskApi(call,corruptJournal).recoveryMessage(),
  createTaskTransitionApi(call,corruptJournal).recoveryMessage(),
  createRoleApi(call,corruptJournal).recoveryMessage(),
  createRoleLifecycleApi(call,corruptJournal).recoveryMessage(),
  createHandoffApi(call,corruptJournal).recoveryMessage(),
  createHandoffApi(call,undefined,corruptJournal).changeRecoveryMessage(),
 ]
 for(const error of errors){
  assert.ok(error&&typeof error==='object'&&'code' in error)
  assert.equal(error.code,'teloa/storage-corrupt')
  assert.equal(localizeWorkError('en',error),'Cannot read the recovery record in this browser. Reload and try again.')
 }
})

test('丢弃入口的三句文案在十种语言下齐全且不回落',()=>{
 for(const locale of ['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const)
  for(const key of ['recovery.discard','recovery.discarded','recovery.nextStep'] as const){
   const text=translateMessage(locale,key)
   assert.ok(text&&text.trim().length>0,`${locale} 缺 ${key}`)
   if(locale!=='en')assert.notEqual(text,translateMessage('en',key),`${locale} 的 ${key} 回落到英文`)
  }
})

test('服务端记录损坏不引导用户修复浏览器存储',()=>{
 const message=localizeWorkError('zh-CN',{code:'teloa/storage-corrupt'})
 assert.match(message,/保存的记录未通过校验/)
 assert.doesNotMatch(message,/浏览器/)
})
