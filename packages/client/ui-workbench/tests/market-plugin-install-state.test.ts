import test from 'node:test'
import assert from 'node:assert/strict'
import {marketPluginCanEnable, marketPluginEnableSpec, marketPluginInstallAction, marketPluginInstallInterrupted, marketPluginInstallStatus, mergeMarketPluginInstallation} from '../src/client/market-plugin-install-state.ts'
import type {MarketPluginInstallation} from '../src/client/market-plugin-install-api.ts'

const source={registry:'npm' as const,packageName:'@example/visualize',version:'1.2.3'}
const preview={schema:'teloa.market-plugin-install-preview/v1' as const,source,trust:{status:'verified' as const,publisher:'Example',integrity:'sha512-'+Buffer.from('integrity').toString('base64')},bundleHash:'a'.repeat(64),permissionSummary:{permissions:[]}}
const observationStatus={'installed-active':'active','installed-restart-required':'restart-required','installed-pending-enable':'pending-enable'} as const
const succeededReceipt={schema:'teloa.market-plugin-install-receipt/v1' as const,outcome:'succeeded' as const}
// 待启用状态默认带上"已核对成功"的回执，代表安装完整走完的正常路径；中断态的测试显式不传回执来复刻它。
const record=(state:MarketPluginInstallation['state'],attempt=1,receipt=state==='installed-pending-enable'?succeededReceipt:undefined):MarketPluginInstallation=>({id:'11111111-1111-4111-8111-111111111111',ownerId:'self',preview,state,attempt,...(receipt?{receipt}:{}),...(state==='unknown'||state==='failed'?{failure:{code:state==='unknown'?'install-unknown' as const:'install-failed' as const,message:'需要核对',retryable:true}}:{}),...(state==='installed-active'||state==='installed-restart-required'||state==='installed-pending-enable'?{observation:{schema:'teloa.market-plugin-install-observation/v1' as const,status:observationStatus[state],source,bundleHash:preview.bundleHash,permissionSummary:preview.permissionSummary}}:{}),createdAt:'2026-09-13T00:00:00.000Z',updatedAt:'2026-09-13T00:00:00.000Z'})

test('插件安装状态明确区分准备、待启用、可用、需重启、失败与未知',()=>{
 assert.deepEqual(marketPluginInstallStatus(record('preparing')),{key:'preparing',canInstall:false,canReconcile:true})
 assert.deepEqual(marketPluginInstallStatus(record('installed-pending-enable')),{key:'pending-enable',canInstall:false,canReconcile:true})
 assert.deepEqual(marketPluginInstallStatus(record('installed-active')),{key:'active',canInstall:false,canReconcile:true})
 assert.deepEqual(marketPluginInstallStatus(record('installed-restart-required')),{key:'restart-required',canInstall:false,canReconcile:true})
 assert.deepEqual(marketPluginInstallStatus(record('failed')),{key:'failed',canInstall:true,canReconcile:true})
 assert.deepEqual(marketPluginInstallStatus(record('unknown')),{key:'unknown',canInstall:false,canReconcile:true})
 assert.equal(marketPluginInstallAction(record('unknown')),'reconcile')
 assert.equal(marketPluginInstallAction(record('failed')),'install')
})

test('同一插件的迟到回包不可以用较少尝试次数覆盖未知或已激活记录',()=>{
 const active=record('installed-active',2)
 assert.equal(mergeMarketPluginInstallation(active,record('unknown',1)),active)
 assert.equal(mergeMarketPluginInstallation(record('unknown',2),active),active)
})

test('只有回执已确认成功的已安装 · 待启用记录才能启用',()=>{
 assert.equal(marketPluginCanEnable(record('installed-pending-enable')),true)
 assert.equal(marketPluginCanEnable(record('installed-restart-required')),false)
 assert.equal(marketPluginCanEnable(record('installed-active')),false)
 assert.equal(marketPluginCanEnable(record('preparing')),false)
 assert.equal(marketPluginCanEnable(record('failed')),false)
 assert.equal(marketPluginCanEnable(record('unknown')),false)
})

test('回执不是成功的待启用记录判为安装被中断，可重装不可启用',()=>{
 const {receipt:_discarded,...baseRecord}=record('installed-pending-enable') as MarketPluginInstallation
 assert.equal(marketPluginInstallInterrupted(baseRecord),true)
 assert.equal(marketPluginCanEnable(baseRecord),false)
 assert.deepEqual(marketPluginInstallStatus(baseRecord),{key:'pending-enable-interrupted',canInstall:true,canReconcile:true})
})

test('回执成功的待启用记录照常可启用',()=>{
 const baseRecord=record('installed-pending-enable',1,succeededReceipt)
 assert.equal(marketPluginInstallInterrupted(baseRecord),false)
 assert.equal(marketPluginCanEnable(baseRecord),true)
 assert.deepEqual(marketPluginInstallStatus(baseRecord),{key:'pending-enable',canInstall:false,canReconcile:true})
})

test('启用请求只提交契约白名单字段：schema、requestId、固定预览原样带回、action 为 enable',()=>{
 const spec=marketPluginEnableSpec(record('installed-pending-enable'),'44444444-4444-4444-8444-444444444444')
 assert.deepEqual(Object.keys(spec).sort(),['action','preview','requestId','schema'])
 assert.equal(spec.schema,'teloa.market-plugin-install-spec/v1')
 assert.equal(spec.action,'enable')
 assert.equal(spec.requestId,'44444444-4444-4444-8444-444444444444')
 assert.deepEqual(spec.preview,preview)
})
