import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {setupRoleWork,identity} from './role-work-test-fixture.ts'
import {ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'

const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const industryId=()=>`industry_${randomUUID()}_${randomUUID()}`

test('员工包资料来源允许本人只读预览，其他来源仍拒绝',{timeout:30000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close())
 const owner=randomUUID(),actor:ResourceActor={ownerId:owner,kind:'human',scopeIds:['general']}
 const text='# 员工包资料\n固定版本正文\n',version=sha(text),sourceId=industryId()
 const catalog={
  read:async(id:string,expected:string)=>{if(expected!==version)throw Error('source-version');return {schema:'teloa.reference/v1' as const,id,title:'员工包资料',source:'market:fixture',version,bytes:Buffer.byteLength(text),text}},
  list:async()=>({schema:'teloa.reference-list/v1' as const,references:[]}),
 }
 const service=new ResourceService(f.pool,catalog as never,identity)
 const draft=await service.create(actor,{requestId:randomUUID(),title:'员工包资料',sourceId,sourceVersion:version,scopeIds:['general']})
 const resource=await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
 assert.deepEqual(await service.readContent(actor,{resourceId:resource.id,expectedVersion:resource.version,sourceVersion:version}),{resource,text})
 // 非员工包、非本机源仍走同一拒绝路径，不能借这个入口读其他来源。
 const otherId='knowledge_'+randomUUID()
 const otherDraft=await service.create(actor,{requestId:randomUUID(),title:'普通知识',sourceId:otherId,sourceVersion:version,scopeIds:['general']})
 const other=await service.apply(actor,{draftId:otherDraft.id,expectedVersion:otherDraft.version})
 await assert.rejects(service.readContent(actor,{resourceId:other.id,expectedVersion:other.version,sourceVersion:version}),{code:'teloa/forbidden'})
})
