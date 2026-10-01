import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createBusinessDataHandler,readBusinessDataPage} from '../src/business-data.ts'
import type {BusinessDataService,BusinessDataPage} from '@teloa/backend'

const snapshot={scope:'SOC',type:'alert',id:'evt-1842',version:1,title:'异常脚本与外联',source:'EDR',observedAt:'2026-09-12T01:00:00.000Z',receivedAt:'2026-09-12T01:00:01.000Z',quality:'complete' as const,summary:'待调查',fields:[{label:'资产',value:'prod-03'}]}
const item={...snapshot,snapshotHash:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}
const page:BusinessDataPage={schema:'teloa.business-data-page/v1',sourceId:'security-alert-http',capturedAt:'2026-09-12T01:00:02.000Z',items:[item],nextCursor:'next'}

test('业务数据 RPC 只使用宿主本人和 SOC 授权范围',async()=>{
 const calls:unknown[][]=[],service={query:async(...args:unknown[])=>{calls.push(args);return page}} as unknown as BusinessDataService,handler=createBusinessDataHandler('local:teloa-owner',async()=>service),controller=new AbortController(),input={scope:'SOC',limit:20}
 assert.deepEqual(await handler('business-data/query',input,controller.signal),page)
 assert.equal(calls.length,1);assert.deepEqual(calls[0]![0],{ownerId:'local:teloa-owner',scopeIds:['SOC']});assert.equal(calls[0]![1],input);assert.equal(calls[0]![2],controller.signal)
 await assert.rejects(handler('business-data/list',input),{code:'teloa/not-found'})
 await assert.rejects(handler('business-data/query',{limit:20}),{code:'teloa/invalid-input'})
})

test('RPC 拒绝跨范围、重复对象、额外字段及坏快照回包',()=>{
 for(const value of [
  {...page,items:[{...item,scope:'AppSec'}]},
  {...page,items:[item,item]},
  {...page,items:[{...item,snapshotHash:'bad'}]},
  {...page,items:[{...item,fields:[{label:'资产',value:'prod-03',secret:'x'}]}]},
  {...page,sourceId:'other'},
  {...page,secret:'x'},
 ])assert.throws(()=>readBusinessDataPage(value,'SOC','security-alert-http'),{code:'teloa/invalid-host-response'})
})

test('服务失败与取消原样保留，不生成空页',async()=>{
 const failure=Object.assign(Error('source down'),{code:'teloa/source-unavailable'}),service={query:async()=>{throw failure}} as unknown as BusinessDataService,handler=createBusinessDataHandler('owner',async()=>service)
 await assert.rejects(handler('business-data/query',{scope:'SOC',limit:10}),error=>error===failure)
 const controller=new AbortController();controller.abort();await assert.rejects(handler('business-data/query',{scope:'SOC',limit:10},controller.signal),{name:'AbortError'})
})
