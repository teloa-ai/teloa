import test from 'node:test'
import assert from 'node:assert/strict'
import type {Pool,PoolClient} from 'pg'
import {createHash} from 'node:crypto'
import {roleDefinition} from '@teloa/contract'
import {readRunKnowledge} from '../src/work/task-run-knowledge.ts'
import {ResourceService,type ResourceActor,type ResourceSourceCatalog} from '../src/capabilities/resources.ts'

test('岗位资料非法主体、身份或预取消在借用连接前拒绝',async()=>{
  let checkouts=0
  const pool={connect:async()=>{checkouts++;throw Error('database unavailable')}} as unknown as Pool
  const sources={} as ResourceSourceCatalog
  const service=new ResourceService(pool,sources,{id:()=>'',now:()=>''})
  const actor:ResourceActor={ownerId:'owner',kind:'agent',scopeIds:['general']}
  await assert.rejects(service.executionKnowledge({...actor,scopeIds:['invalid scope']},['general'],[]),{code:'teloa/forbidden'})
  await assert.rejects(service.executionKnowledgeReferences(actor,['general'],['invalid-id']),{code:'teloa/invalid-input'})
  const canceled=new AbortController();canceled.abort()
  await assert.rejects(service.executionKnowledge(actor,['general'],[],canceled.signal),{name:'AbortError'})
  assert.equal(checkouts,0)
})

test('合法员工12/30引用元数据和正文可读取并固定，31拒绝且不截断引用',async()=>{
 const owner='isolated-owner',actor:ResourceActor={ownerId:owner,kind:'agent',scopeIds:['general']},texts=new Map<string,string>(),at=new Date('2026-10-14T00:00:00.000Z')
 const rows=Array.from({length:31},(_,index)=>{const id='10000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),text='固定依据 '+index;const sourceId='source-'+index;const sourceVersion=createHash('sha256').update(text).digest('hex');texts.set(sourceId,text);return {id,owner_id:owner,spec:{title:'依据 '+index,sourceId,sourceVersion,scopeIds:['general']},revision:1,status:'active',created_at:at,updated_at:at}})
 let reads=0
 const client={query:async(_sql:string,params:unknown[])=>({rows:rows.filter(row=>row.id===params[0])})} as unknown as PoolClient
 const service=new ResourceService({} as Pool,{list:async()=>({schema:'teloa.reference-list/v1',references:[]}),read:async(id,version)=>{reads++;const text=texts.get(id)!;return {schema:'teloa.reference/v1',id,title:'固定依据',source:id,version,bytes:Buffer.byteLength(text),text}}},{id:()=>'',now:()=>''})
 for(const count of [12,30]){
  const ids=rows.slice(0,count).map(row=>row.id),role=roleDefinition({name:'固定模板员工',kind:'employee',scopes:['general'],duty:'核对来源',dataScope:'固定来源',executionScope:'只读',skills:[],knowledge:ids})
  const metadata=await service.executionKnowledgeRoleReferencesInTransaction(client,actor,['general'],role.knowledge)
  assert.deepEqual(metadata.map(row=>row.id),ids);assert.equal(reads,count===12?0:12,'元数据目录不读取正文')
  const knowledge=await service.executionKnowledgeInTransaction(client,actor,['general'],ids)
  assert.deepEqual(knowledge.map(row=>row.id),ids);assert.equal(readRunKnowledge(knowledge).length,count)
 }
 const tooMany=rows.map(row=>row.id)
 await assert.rejects(service.executionKnowledgeRoleReferencesInTransaction(client,actor,['general'],tooMany),{code:'teloa/invalid-input'})
 await assert.rejects(service.executionKnowledgeInTransaction(client,actor,['general'],tooMany),{code:'teloa/invalid-input'})
})

test('30引用支持仍保留归属、范围、撤回、重复、正文总预算与固定摘要拒绝',async()=>{
 const owner='owner',actor:ResourceActor={ownerId:owner,kind:'agent',scopeIds:['general','design']},at=new Date('2026-10-14T00:00:00.000Z')
 let text='a'.repeat(256*1024),scopeIds=['general'],status='active'
 const ids=Array.from({length:31},(_,index)=>'10000000-0000-4000-8000-'+String(index+1).padStart(12,'0'))
 const client={query:async(_sql:string,params:unknown[])=>({rows:[{id:params[0],owner_id:owner,spec:{title:'固定依据',sourceId:'fixed',sourceVersion:createHash('sha256').update(text).digest('hex'),scopeIds},revision:1,status,created_at:at,updated_at:at}]})} as unknown as PoolClient
 const service=new ResourceService({} as Pool,{list:async()=>({schema:'teloa.reference-list/v1',references:[]}),read:async(id,version)=>({schema:'teloa.reference/v1',id,title:'固定依据',source:id,version,bytes:Buffer.byteLength(text),text})},{id:()=>'',now:()=>''})
 assert.equal((await service.executionKnowledgeInTransaction(client,actor,['general'],[ids[0]!]))[0]!.text.length,256*1024)
 text+='a';await assert.rejects(service.executionKnowledgeInTransaction(client,actor,['general'],[ids[0]!]),{code:'teloa/invalid-input'})
 text='a'.repeat(9*1024);await assert.rejects(service.executionKnowledgeInTransaction(client,actor,['general'],ids.slice(0,30)),{code:'teloa/invalid-input'})
 text='small'
 for(const list of [ids,[ids[0]!,ids[0]!]])await assert.rejects(service.executionKnowledgeRoleReferencesInTransaction(client,actor,['general'],list),{code:'teloa/invalid-input'})
 await assert.rejects(service.executionKnowledgeRoleReferencesInTransaction(client,{...actor,ownerId:'other'},['general'],[ids[0]!]),{code:'teloa/forbidden'})
 scopeIds=['design'];await assert.rejects(service.executionKnowledgeRoleReferencesInTransaction(client,actor,['general'],[ids[0]!]),{code:'teloa/forbidden'})
 scopeIds=['general'];status='withdrawn';await assert.rejects(service.executionKnowledgeRoleReferencesInTransaction(client,actor,['general'],[ids[0]!]),{code:'teloa/resource-withdrawn'})
 status='active';const knowledge=await service.executionKnowledgeInTransaction(client,actor,['general'],ids.slice(0,30))
 assert.equal(readRunKnowledge(knowledge).length,30)
 assert.throws(()=>readRunKnowledge([...knowledge,{...knowledge[0],id:ids[30]}]),{code:'teloa/storage-corrupt'})
 assert.throws(()=>readRunKnowledge(knowledge.map((row,index)=>index===0?{...row,text:'changed'}:row)),{code:'teloa/storage-corrupt'})
 assert.throws(()=>readRunKnowledge(knowledge.map(row=>({...row,text:'a'.repeat(9*1024),sourceVersion:createHash('sha256').update('a'.repeat(9*1024)).digest('hex')}))),{code:'teloa/storage-corrupt'})
})
