import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {createResourceApi} from '../src/client/resource-api.ts'
import type {WorkResource} from '@teloa/contract'

const text='\ufeff# 本机原件\n\n本人登记的 **准确正文**。\n',at='2026-10-09T00:00:00.000Z'
const resource:WorkResource={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',title:'工作材料',sourceId:'local_material_22222222-2222-4222-8222-222222222222',sourceVersion:createHash('sha256').update(text).digest('hex'),scopeIds:['general'],version:1,status:'active',createdAt:at,updatedAt:at}

test('本机原件正文只读固定当前资料和来源版本，并拒绝替换或损坏正文',async()=>{
 const calls:Array<[string,unknown,AbortSignal|undefined]>=[],signal=new AbortController().signal
 const api=createResourceApi(async(endpoint,payload,requestSignal)=>{calls.push([endpoint,payload,requestSignal]);return {resource,text}})
 assert.ok(api.readContent)
 assert.deepEqual(await api.readContent(resource,signal),{resource,text})
 assert.deepEqual(calls,[['resources/read-content',{resourceId:resource.id,expectedVersion:resource.version,sourceVersion:resource.sourceVersion},signal]])
 for(const value of [
  {resource:{...resource,ownerId:'other'},text},
  {resource:{...resource,id:'33333333-3333-4333-8333-333333333333'},text},
  {resource:{...resource,version:2},text},
  {resource:{...resource,sourceVersion:'a'.repeat(64)},text},
  {resource:{...resource,scopeIds:['SOC']},text},
  {resource:{...resource,status:'withdrawn'},text},
  {resource:{...resource,knowledgeId:resource.id},text},
  {resource,text:'新版替换正文'},
  {resource,text:'x'.repeat(128*1024+1)},
  {resource,text,path:'private.md'},
 ])await assert.rejects(createResourceApi(async()=>value).readContent!(resource,signal),/格式/)
 let requests=0
 await assert.rejects(createResourceApi(async()=>{requests++;return {resource,text}}).readContent!({...resource,sourceId:'knowledge_'+resource.id},signal),/格式/)
 assert.equal(requests,0)
 const controller=new AbortController();controller.abort()
 await assert.rejects(api.readContent(resource,controller.signal),{name:'AbortError'})
 assert.equal(calls.length,1)
 const conflict=Object.assign(Error('版本冲突'),{code:'teloa/version-conflict'})
 await assert.rejects(createResourceApi(async()=>{throw conflict}).readContent!(resource,signal),error=>error===conflict)
})

test('本机原件复用只读 Markdown 预览，导航撤销旧读取且不冒充知识版本',async()=>{
 const source=await readFile(new URL('../src/client/KnowledgeDocument.tsx',import.meta.url),'utf8')
 assert.match(source,/isLocalMaterialSourceId\(resource\.sourceId\)/)
 assert.match(source,/api\.readContent\(resource,controller\.signal\)/)
 assert.match(source,/controller\.abort\(\)/)
 assert.match(source,/resource\.id,resource\.version,resource\.sourceVersion/)
 assert.match(source,/<KnowledgeMarkdownEditor[^>]+value=\{localContent\.text\}[^>]+readOnly/)
 assert.match(source,/knowledge\.local\.preview/)
 assert.match(source,/knowledge\.local\.changed/)
})
