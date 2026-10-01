import test from 'node:test'
import assert from 'node:assert/strict'
import {
  errorMessageKey,
  localizeWorkError,
  type WorkErrorLike,
} from '../lib/types/client/i18n/errors.js'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import {createRoleApi} from '../src/client/role-api.ts'
import {createIndustryRoleApi} from '../src/client/industry-role-api.ts'

test('稳定错误 code 映射到稳定 message key', () => {
  assert.equal(errorMessageKey('teloa/invalid-input'), 'error.invalidInput')
  assert.equal(errorMessageKey('teloa/forbidden'), 'error.forbidden')
  assert.equal(errorMessageKey('teloa/not-found'), 'error.notFound')
  assert.equal(errorMessageKey('teloa/conflict'), 'error.conflict')
  assert.equal(errorMessageKey('teloa/version-conflict'), 'error.versionConflict')
  assert.equal(errorMessageKey('teloa/source-unavailable'), 'error.sourceUnavailable')
  assert.equal(errorMessageKey('teloa/storage-unavailable'), 'error.storageUnavailable')
  assert.equal(errorMessageKey('teloa/run-configuration-failed'), 'error.configurationFailed')
  assert.equal(errorMessageKey('vendor/unknown'), 'error.unknown')
})

test('英文界面不显示服务端中文 message，且不修改错误对象', () => {
  const error: WorkErrorLike = {code: 'teloa/forbidden', message: '服务端中文：禁止访问'}
  const before = structuredClone(error)
  assert.equal(localizeWorkError('en', error), 'You do not have permission to perform this action.')
  assert.deepEqual(error, before)
  assert.equal(localizeWorkError('en', {code: 'vendor/unknown', message: '服务端中文：内部异常'}), 'The operation did not finish. Try again later.')
})

test('无稳定 code 的普通异常使用安全通用词条', () => {
  assert.equal(localizeWorkError('zh-TW', new Error('原始作者内容不得展示')), '操作未完成，請稍後再試。')
  assert.equal(localizeWorkError('ja', null), '操作を完了できませんでした。後でもう一度お試しください。')
})

test('目标检查错误按当前语言和状态参数展示', () => {
  const error: WorkErrorLike = {code:'teloa/market-target-check',message:'market-target/unavailable',check:{status:'unavailable',params:{state:'paused'}}}
  for(const locale of ['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt']){
    const state=translateMessage(locale,'capability.targetState.paused')
    assert.equal(localizeWorkError(locale,error),translateMessage(locale,'capability.targetCheck.unavailable',{state}))
  }
})

test('群聊贴密钥拒收按 details.reason 本地化',()=>{
 assert.equal(localizeWorkError('en',{code:'teloa/invalid-input',details:{reason:'secret-in-message'}}),translateMessage('en','error.secretInMessage'))
 assert.equal(localizeWorkError('en',{code:'teloa/invalid-input'}),translateMessage('en','error.invalidInput'))
})

test('添加同事的未知、并发和浏览器存储错误使用安全明确的本地化词条',async()=>{
 const fields={name:'同事',kind:'employee' as const,scopes:['general'],duty:'整理',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
 const api=createRoleApi(async()=>{throw Error('秘密内部堆栈')})
 let pending:unknown;try{await api.create(fields)}catch(error){pending=error}
 assert.match(localizeWorkError('zh-CN',pending),/原内容.*核对|核对.*原内容/)
 assert.doesNotMatch(localizeWorkError('zh-CN',pending),/秘密|稍后再试/)
 const industry=createIndustryRoleApi(async()=>{throw Object.assign(Error('秘密内部堆栈'),{rejected:true,code:'teloa/forbidden'})})
 let industryPending:unknown;try{await industry.instantiate({requestId:'11111111-1111-4111-8111-111111111111',loadId:'22222222-2222-4222-8222-222222222222',itemInstanceId:'33333333-3333-4333-8333-333333333333'})}catch(error){industryPending=error}
 assert.match(localizeWorkError('zh-CN',industryPending),/原方案/)
 for(const [code,hint] of [['teloa/role-create-busy','正在'],['teloa/recovery-write-failed','保存'],['teloa/recovery-clear-failed','清理']])assert.ok(localizeWorkError('zh-CN',{code,message:'秘密内部堆栈'}).includes(hint!))
 for(const code of ['teloa/role-create-pending','teloa/industry-role-pending','teloa/role-create-busy','teloa/recovery-write-failed','teloa/recovery-clear-failed']){
  assert.notEqual(errorMessageKey(code),'error.unknown')
  for(const locale of ['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt']){
   const text=localizeWorkError(locale,{code,message:'秘密内部堆栈'});assert.ok(text.trim());assert.doesNotMatch(text,/秘密/)
   if(locale!=='en')assert.notEqual(text,localizeWorkError('en',{code}))
  }
 }
})

test('新增角色错误词条不会令错误翻译器信任任意字符串',()=>{
 assert.equal(localizeWorkError('en','任意服务器信息'),'The operation did not finish. Try again later.')
 assert.equal(localizeWorkError('en',localizeWorkError('zh-CN',{code:'teloa/forbidden'})),'The operation did not finish. Try again later.')
})
