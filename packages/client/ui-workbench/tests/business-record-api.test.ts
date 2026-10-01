import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
const source=new URL('../src/client/business-record-api.ts',import.meta.url)
const requestId='12345678-1234-4234-8234-123456789012'
const snapshot={scope:'SOC',type:'ticket',id:'record-one',version:1,snapshotHash:'a'.repeat(64),title:'工单一',summary:'说明',source:'records',observedAt:'2026-09-29T00:00:00.000Z',receivedAt:'2026-09-29T00:00:00.000Z',quality:'complete',fields:[{label:'original state',value:'open'}]}
test('记录API核对请求和共享快照回包，不接受错范围/类型/版本',async()=>{
 assert.ok(existsSync(source),'缺少严格记录API')
 const {createBusinessRecordApi}=await import('../src/client/business-record-api.ts')
 const calls:unknown[]=[],api=createBusinessRecordApi(async(method,input)=>{calls.push({method,input});return snapshot})
 const create={scope:'SOC',type:'ticket',requestId,title:'工单一',summary:'说明',fields:[{name:'state',value:'open'}]}
 assert.equal((await api.create(create)).id,'record-one')
 await assert.rejects(api.create({...create,unexpected:true} as typeof create));assert.equal(calls.length,1)
 await assert.rejects(api.get({scope:'Other',type:'ticket',id:'record-one'}))
 await assert.rejects(api.get({scope:'SOC',type:'other',id:'record-one'}))
 await assert.rejects(api.get({scope:'SOC',type:'ticket',id:'record-one',version:2}))
 await assert.rejects(api.archive({scope:'SOC',type:'ticket',id:'record-one',requestId,expectedVersion:1}))
})
test('list严格读共享page并核对type；receipt只允许null或合法快照',async()=>{
 assert.ok(existsSync(source),'缺少严格记录API')
 const {createBusinessRecordApi}=await import('../src/client/business-record-api.ts')
 const page={schema:'teloa.business-data-page/v1',sourceId:'records',capturedAt:'2026-09-29T00:00:00.000Z',items:[snapshot]}
 assert.equal((await createBusinessRecordApi(async()=>page).list({scope:'SOC',type:'ticket',limit:20})).items.length,1)
 await assert.rejects(createBusinessRecordApi(async()=>page).list({scope:'SOC',type:'other',limit:20}))
 assert.equal(await createBusinessRecordApi(async()=>null).receipt({requestId}),null)
 await assert.rejects(createBusinessRecordApi(async()=>undefined).receipt({requestId}))
})
