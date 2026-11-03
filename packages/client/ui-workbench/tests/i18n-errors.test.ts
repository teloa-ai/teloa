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
import {createResourceApiFromRpc} from '../src/client/resource-api.ts'
import {createPendingReceiptRpc} from '../src/client/pending-receipt-rpc.ts'

test('员工有未结束工作时说明收尾和暂停步骤，不将配置阻挡误报为刷新冲突',()=>{
 const error={code:'teloa/conflict',details:{reason:'role-work-outstanding'},message:'秘密任务ID及内部状态'}
 for(const [locale,next] of [['zh-CN',/完成或取消.*任务.*暂停.*计划.*委托/],['zh-Hant',/完成或取消.*工作.*暫停.*排程.*委託/],['en',/Finish or cancel.*work.*pause.*automations.*delegations/]] as const){
  const text=localizeWorkError(locale,error);assert.match(text,next);assert.doesNotMatch(text,/刷新|重新整理|Refresh|秘密|内部状态/)
 }
 assert.equal(localizeWorkError('zh-CN',{...error,code:'teloa/forbidden'}),translateMessage('zh-CN','error.forbidden'))
 assert.equal(localizeWorkError('zh-CN',{...error,details:{reason:'unknown'}}),translateMessage('zh-CN','error.conflict'))
})

test('正式资源RPC包装保留登记冲突原因，解除已拒绝的恢复记录并给出正确下一步',async()=>{
 let saved:string|null=null
 const calls:string[]=[],details={reason:'local-material-registration-mismatch'}
 const rpc=createPendingReceiptRpc(async(endpoint:string)=>{calls.push(endpoint);return{ok:false as const,error:{code:'teloa/conflict',message:'秘密原件路径',details}}},()=>assert.fail('拒绝回包不能确认成功收讫'))
 const api=createResourceApiFromRpc(rpc,{read:()=>saved,write:value=>{saved=value},clear:()=>{saved=null}})
 await assert.rejects(api.localMaterialRequests!.begin({title:'新标题',path:'说明.md',scopeIds:['general']}),error=>{
  assert.ok(error&&typeof error==='object')
  assert.equal(Reflect.get(error,'rejected'),true)
  assert.deepEqual(Reflect.get(error,'details'),details)
  const message=localizeWorkError('zh-CN',error)
  assert.match(message,/原登记名称.*范围.*草案/)
  assert.doesNotMatch(message,/秘密|原件路径|刷新/)
  return true
 })
 assert.deepEqual(calls,['resources/register-local-material'])
 assert.equal(saved,null)
 assert.equal(api.localMaterialRequests!.pending(),undefined)
})

test('本机原件重复登记冲突说明原名称和范围，不误导刷新或泄露服务端正文',()=>{
 const error={code:'teloa/conflict',details:{reason:'local-material-registration-mismatch'},message:'秘密原件路径'}
 for(const [locale,expected] of [['zh-CN',/原登记名称.*范围.*草案/],['zh-Hant',/原登記名稱.*範圍.*草稿/],['en',/original registration name.*scope.*draft/]] as const){
  const message=localizeWorkError(locale,error);assert.match(message,expected);assert.doesNotMatch(message,/秘密|原件路径|刷新|重新整理|Refresh/)
 }
 assert.equal(localizeWorkError('zh-CN',{...error,details:{reason:'unknown'}}),translateMessage('zh-CN','error.conflict'))
 assert.equal(localizeWorkError('zh-CN',{...error,code:'teloa/forbidden'}),translateMessage('zh-CN','error.forbidden'))
})

test('缺少完整交付复核时提示原记录与重新交办，不泄露原始错误或诱导后台重试',()=>{
 const error={code:'teloa/delivery-review-required',message:'秘密内部堆栈'}
 for(const [locale,next] of [['zh-CN',/原执行记录.*核对.*重新交办/],['zh-Hant',/原執行記錄.*核對.*重新交辦/],['en',/original execution record.*review.*submit the task again/]] as const){
  const message=localizeWorkError(locale,error)
  assert.match(message,next)
  assert.doesNotMatch(message,/秘密|内部堆栈|Try again later|稍后重试|稍後重試/)
 }
 assert.deepEqual(error,{code:'teloa/delivery-review-required',message:'秘密内部堆栈'})
})

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
 assert.match(localizeWorkError('zh-CN',industryPending),/原模板/)
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
