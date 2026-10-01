import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessSpaceApi,readBusinessSpaceRecord} from '../src/client/business-space-api.ts'

const record={id:'11111111-1111-4111-8111-111111111111',name:'我的工作空间',description:'本人的唯一空间',version:3,kind:'personal',createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}

test('本人空间回包严格读取：完整回包通过，多余键、非 personal 与坏时间戳一律拒绝',()=>{
 assert.deepEqual(readBusinessSpaceRecord({...record}),record)
 assert.throws(()=>readBusinessSpaceRecord({...record,scopes:[]}),/格式不正确/)
 assert.throws(()=>readBusinessSpaceRecord({...record,kind:'team'}),/格式不正确/)
 assert.throws(()=>readBusinessSpaceRecord({...record,updatedAt:'2026-09-12'}),/格式不正确/)
 const {description,...missing}=record
 assert.throws(()=>readBusinessSpaceRecord(missing),/格式不正确/)
 assert.throws(()=>readBusinessSpaceRecord({...record,version:0}),/格式不正确/)
 assert.throws(()=>readBusinessSpaceRecord({...record,name:''}),/格式不正确/)
})

test('current 只读，rename 只提交四个字段并核对版本已推进',async()=>{
 const sent:Array<[string,unknown]>=[]
 const api=createBusinessSpaceApi(async(endpoint,payload)=>{sent.push([endpoint,payload]);return endpoint==='business-spaces/current'?record:{...record,name:'调查工作空间',version:4}})
 assert.deepEqual(await api.current(),record)
 assert.deepEqual(sent[0],['business-spaces/current',{}])
 const renamed=await api.rename({requestId:'22222222-2222-4222-8222-222222222222',expectedVersion:3,name:' 调查工作空间 ',description:' 说明 '})
 assert.equal(renamed.version,4)
 assert.deepEqual(sent[1],['business-spaces/rename',{requestId:'22222222-2222-4222-8222-222222222222',expectedVersion:3,name:'调查工作空间',description:'说明'}])
})

test('改名请求与回包都不放过异常：非法入参不发请求，版本没推进的回包判为不一致',async()=>{
 const api=createBusinessSpaceApi(async()=>record)
 await assert.rejects(api.rename({requestId:'not-a-uuid',expectedVersion:1,name:'名称',description:''}),/请求格式不正确/)
 await assert.rejects(api.rename({requestId:'22222222-2222-4222-8222-222222222222',expectedVersion:1,name:'  ',description:''}),/1～80/)
 await assert.rejects(api.rename({requestId:'22222222-2222-4222-8222-222222222222',expectedVersion:3,name:'名称',description:''}),/回包与原请求不一致/)
})
