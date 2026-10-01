import test from 'node:test'
import assert from 'node:assert/strict'
import {businessShareEnglishResourceNotice,businessShareExclusionText,businessSharePublicationNotice,businessShareReady} from '../src/client/business-share-flow.ts'

test('分享流程只在包身份完整且至少有一个对象类型时允许生成',()=>{
 const base={packageId:'soc-ledger',packageVersion:'1.0.0',title:'SOC 台账',description:'声明包',objectTypes:[{localId:'alert',version:'1.0.0',body:{}}]}
 assert.equal(businessShareReady(base),true)
 assert.equal(businessShareReady({...base,objectTypes:[]}),false)
 assert.equal(businessShareReady({...base,title:'  '}),false)
})

test('英文门面缺省时明确只允许本地固定与 ZIP 分享',()=>{
 assert.equal(businessSharePublicationNotice(undefined),'local-only')
 assert.equal(businessSharePublicationNotice({title:'SOC ledger',description:'Declarations only'}),undefined)
 assert.equal(businessShareEnglishResourceNotice(undefined),undefined)
 assert.equal(businessShareEnglishResourceNotice({title:'SOC ledger',description:'Declarations only'}),'source-title-fallback')
})

test('排除项保留标识和服务器式可读原因，不静默省略',()=>{
 assert.equal(businessShareExclusionText({kind:'business-action',localId:'isolate-endpoint',reason:'缺少任务模板 endpoint-isolation-record。'}),'isolate-endpoint：缺少任务模板 endpoint-isolation-record。')
})
