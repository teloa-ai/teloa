import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessSpaceHandler,readBusinessSpaceRecord,readEditionInfo} from '../src/business-spaces.ts'
import type {BusinessSpaceService} from '@teloa/backend'

const record={id:'6f1b1f7e-0b6a-4a1e-9f7a-2a0c3a5b7c11',name:'我的工作空间',description:'',version:1,kind:'personal' as const,createdAt:'2026-09-15T00:00:00.000Z',updatedAt:'2026-09-15T00:00:00.000Z'}

test('业务空间 RPC 只回本人空间与个人版，异常回包一律拒绝',async()=>{
 const calls:unknown[][]=[]
 const service={current:async(...args:unknown[])=>{calls.push(['current',...args]);return record},rename:async(...args:unknown[])=>{calls.push(['rename',...args]);return {...record,name:'新名字',version:2}}} as unknown as BusinessSpaceService
 const handler=createBusinessSpaceHandler('local:teloa-owner',async()=>service,()=>'personal')
 assert.deepEqual(await handler('app/edition',{}),{edition:'personal'})
 assert.deepEqual(await handler('business-spaces/current',{}),record)
 assert.deepEqual(calls[0],['current','local:teloa-owner'])
 await assert.rejects(handler('business-spaces/list',{}),{code:'teloa/not-found'})
 for(const value of [{...record,kind:'team'},{...record,kind:'personal',extra:'x'},{...record,version:0},{...record,name:''},{...record,createdAt:'2026-09-15'},{id:record.id}])assert.throws(()=>readBusinessSpaceRecord(value),{code:'teloa/invalid-host-response'})
 for(const value of [{edition:'enterprise'},{edition:'personal',extra:'x'},{},'personal'])assert.throws(()=>readEditionInfo(value),{code:'teloa/invalid-host-response'})
})

test('改名入参只接受四个字段，kind 与 spaceId 在入口就被拒',async()=>{
 const calls:unknown[][]=[]
 const service={current:async()=>record,rename:async(...args:unknown[])=>{calls.push(args);return {...record,name:'新名字',version:2}}} as unknown as BusinessSpaceService
 const handler=createBusinessSpaceHandler('local:teloa-owner',async()=>service,()=>'personal')
 const input={requestId:'0f5c2a1e-9d3b-4c6e-8a2f-1b4d6e8a0c33',expectedVersion:1,name:'新名字',description:''}
 assert.deepEqual(await handler('business-spaces/rename',input),{...record,name:'新名字',version:2})
 assert.deepEqual(calls[0],['local:teloa-owner',input])
 for(const value of [{...input,kind:'team'},{...input,spaceId:record.id},{...input,name:''},{requestId:input.requestId,expectedVersion:1,name:'新名字'},null])await assert.rejects(handler('business-spaces/rename',value),{code:'teloa/invalid-input'})
 assert.equal(calls.length,1)
})
