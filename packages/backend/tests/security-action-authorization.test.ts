import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type BusinessObjectSnapshot} from '@teloa/contract'
import {createSecurityEndpointIsolateDefinition,securityParamFingerprint,securityTargetFingerprint} from '../src/security/action-authorization.ts'

const snapshot:BusinessObjectSnapshot={
  scope:'SOC',type:'security-alert',id:'alert-017',version:1,snapshotHash:'a'.repeat(64),
  title:'检测到横向移动',source:'security-alert-http',observedAt:'2026-09-13T08:00:00.000Z',receivedAt:'2026-09-13T08:00:01.000Z',quality:'complete',summary:'端点需要隔离。',
  fields:[{label:'资产',value:'prod-03'},{label:'来源地址',value:'10.0.0.8'}],
}

test('隔离声明固定风险、可逆性、剧本并只接受快照资产',()=>{
  const definition=createSecurityEndpointIsolateDefinition()
  assert.deepEqual(definition.authorize(snapshot,['prod-03'],{reason:'横向移动'}),{
    tool:'security.endpoint.isolate',playbookVersion:'security.endpoint.isolate/v1',
    riskTier:'high',reversible:'reversible',targetSet:['prod-03'],params:{reason:'横向移动'},
  })
  assert.throws(()=>definition.authorize(snapshot,['db-01'],{reason:'横向移动'}),error=>error instanceof WorkError&&error.code==='teloa/forbidden')
})

test('隔离声明拒绝不完整快照、额外参数和不可控理由',()=>{
  const definition=createSecurityEndpointIsolateDefinition()
  assert.throws(()=>definition.authorize({...snapshot,fields:[{label:'资产',value:'prod-03'},{label:'资产',value:'prod-04'}]},['prod-03'],{reason:'横向移动'}),{code:'teloa/forbidden'})
  assert.throws(()=>definition.authorize(snapshot,['prod-03'],{reason:''}),{code:'teloa/invalid-input'})
  assert.throws(()=>definition.authorize(snapshot,['prod-03'],{reason:'横向\n移动'}),{code:'teloa/invalid-input'})
  assert.throws(()=>definition.authorize(snapshot,['prod-03'],{reason:'ok',dryRun:true}),{code:'teloa/invalid-input'})
  assert.throws(()=>definition.authorize(snapshot,['prod-03'],{reason:'a\u0000b'}),{code:'teloa/invalid-input'})
})

test('参数指纹按对象键稳定排序、数组保序并拒绝非 JSON 值',()=>{
  assert.equal(securityParamFingerprint({b:2,a:{z:true,y:['second','first']}}),'sha256:a717261b753e2788749371ec3aa4a05e380f5568fa90ec3bf529a5da2824f9ca')
  assert.notEqual(securityParamFingerprint({a:{y:['first','second'],z:true},b:2}),securityParamFingerprint({a:{y:['second','first'],z:true},b:2}))
  assert.equal(securityTargetFingerprint(['prod-03','prod-01']),'sha256:936c01eaba5c586c98dff7e0ebf8ca5277ebb456925b62ff88f3b505431a52c8')
  assert.throws(()=>securityParamFingerprint({bad:Infinity}),{code:'teloa/storage-corrupt'})
})
