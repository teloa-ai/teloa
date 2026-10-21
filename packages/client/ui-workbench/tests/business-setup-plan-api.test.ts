import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createBusinessBuilderApi} from '../src/client/business-builder-api.ts'

const row=()=>({draftId:randomUUID(),scope:'support',title:'客户支持',revision:1,sessionId:'session-support'})
test('业务方案目录只接受固定本人业务的有界唯一身份，不以任意字符串导航',async()=>{
 const item=row(),api=createBusinessBuilderApi(async()=>({items:[item]}))
 assert.deepEqual(await api.setupPlans({scope:'support'}),{items:[item]})
 for(const mutation of [{draftId:'fake'},{scope:'other'},{revision:0},{revision:1.5},{sessionId:''},{sessionId:'x'.repeat(201)},{sessionId:' target '},{title:''},{title:'x'.repeat(121)},{ownerId:'other'}]){
  await assert.rejects(createBusinessBuilderApi(async()=>({items:[{...item,...mutation}]})).setupPlans({scope:'support'}),{code:'teloa/invalid-host-response'})
 }
 for(const result of [{items:[item,item]},{items:[item,{...row(),sessionId:item.sessionId}]},{items:[],extra:true}])await assert.rejects(createBusinessBuilderApi(async()=>result).setupPlans({scope:'support'}),{code:'teloa/invalid-host-response'})
})
test('目录请求的未知字段及通用/非法范围在请求前拒绝',async()=>{
 let calls=0;const api=createBusinessBuilderApi(async()=>{calls++;return {items:[]}})
 for(const input of [{scope:'general'},{scope:'客户支持'},{scope:'support',ownerId:'other'}])await assert.rejects(api.setupPlans(input),{code:'teloa/invalid-host-response'})
 assert.equal(calls,0)
})
