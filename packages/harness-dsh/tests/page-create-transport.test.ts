import assert from 'node:assert/strict'
import test from 'node:test'
import {pageCreateEntities,type PageCreateEntity} from '@teloa/contract'
import {createPageCreateDraftHandler} from '../src/page-create-drafts.ts'
// 浏览器读取器与真实宿主路由贯通，避免前后端各自维护的实体白名单漂移。
import {createPageCreateApi} from '../../client/ui-workbench/lib/types/client/page-create-api.js'

test('所有契约新建实体经真实客户端读取器与宿主目录路由保持本人和范围，share也可读取',async()=>{
 const calls:unknown[]=[],stamp='2026-10-15T00:00:00.000Z'
 const handler=createPageCreateDraftHandler('local:owner',async()=>['general','SOC'],async()=>({drafts:{directory:async(actor,input,signal)=>{
  calls.push({actor,input});assert.equal(signal?.aborted,false)
  const request=input as {entity:PageCreateEntity;scope?:string}
  return {schema:'teloa.page-create-drafts/v1',entity:request.entity,...(request.scope?{scope:request.scope}:{}),readAt:stamp,drafts:[]}
 },settle:async()=>{throw Error('目录读取不能写入')}},preview:{preview:async()=>{throw Error('目录读取不能读取草稿正文')}}}))
 const api=createPageCreateApi(handler)
 for(const entity of pageCreateEntities){
  const scope=['role','skill','extension','share'].includes(entity)?undefined:'SOC'
  const result=await api.directory({entity,...(scope?{scope}:{})},new AbortController().signal)
  assert.equal(result.entity,entity);assert.equal(result.scope,scope);assert.deepEqual(result.drafts,[])
  assert.deepEqual(calls.at(-1),{actor:{ownerId:'local:owner',scopeIds:['SOC']},input:{entity,...(scope?{scope}:{})}},'每种正式实体均核对本人和范围，不依赖契约数组顺序')
 }
 assert.equal(calls.length,pageCreateEntities.length)
 await assert.rejects(handler('page-create-drafts/directory',{entity:'not-an-entity'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('page-create-drafts/directory',{entity:'share',ownerId:'someone-else'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,pageCreateEntities.length,'未知类型和自报身份不能触达目录服务')
})

test('原稿续改来源只读核对本人、固定摘要和原普通会话，不创建会话或写草稿',async()=>{
 const owner='local:owner',draftId='10000000-0000-4000-8000-000000000001',bodyHash='a'.repeat(64),controller=new AbortController(),calls:unknown[]=[]
 let source={ownerId:owner,sessionId:'original-chat',status:'ready',purpose:'work'}
 const services={drafts:{directory:async()=>{throw Error('不得读目录')},settle:async()=>{throw Error('不得落定')},origin:async(actor:unknown,input:unknown,signal?:AbortSignal)=>{assert.equal(signal,controller.signal);calls.push({actor,input});return {draftId,bodyHash,sessionId:'original-chat'}}},preview:{preview:async()=>{throw Error('不得预览')}}}
 const handler=createPageCreateDraftHandler(owner,async()=>['general','SOC'],async()=>services,async()=>source as never)
 assert.deepEqual(await handler('page-create-drafts/origin',{draftId,expectedBodyHash:bodyHash},controller.signal),{draftId,bodyHash,sessionId:'original-chat'})
 assert.deepEqual(calls,[{actor:{ownerId:owner,scopeIds:['SOC']},input:{draftId,expectedBodyHash:bodyHash}}])
 for(const patch of [{ownerId:'someone-else'},{sessionId:'other-chat'},{status:'pending'},{purpose:'task-run'}]){
  source={ownerId:owner,sessionId:'original-chat',status:'ready',purpose:'work',...patch}
  await assert.rejects(handler('page-create-drafts/origin',{draftId,expectedBodyHash:bodyHash},controller.signal),{code:'teloa/source-unavailable'})
 }
 const reached=calls.length
 await assert.rejects(handler('page-create-drafts/origin',{draftId,expectedBodyHash:bodyHash,ownerId:owner},controller.signal),{code:'teloa/invalid-input'})
 await assert.rejects(handler('page-create-drafts/origin',{draftId,expectedBodyHash:'stale'},controller.signal),{code:'teloa/invalid-input'})
 assert.equal(calls.length,reached)
 await assert.rejects(createPageCreateDraftHandler(owner,async()=>[],async()=>services)('page-create-drafts/origin',{draftId,expectedBodyHash:bodyHash},controller.signal),{code:'teloa/dependency-unavailable'})
 source={ownerId:owner,sessionId:'original-chat',status:'ready',purpose:'work'};controller.abort()
 await assert.rejects(handler('page-create-drafts/origin',{draftId,expectedBodyHash:bodyHash},controller.signal),{name:'AbortError'})
})
