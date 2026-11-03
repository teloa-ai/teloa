import test from 'node:test'
import assert from 'node:assert/strict'
import {Pool} from 'pg'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import type {ResourceActor} from '../src/capabilities/resources.ts'

const owner='owner',knowledgeId='11111111-1111-4111-8111-111111111111',sourceId='22222222-2222-4222-8222-222222222222'
const actor:ResourceActor={ownerId:owner,kind:'human',scopeIds:['general']}
const row={id:knowledgeId,owner_id:owner,source_id:sourceId,source_type:'paste',workspace_id:'default',title:'固定知识',category:'reference',topics:[],scope_ids:['general'],current_version:1,status:'active',created_at:new Date('2026-09-12T00:00:00.000Z'),updated_at:new Date('2026-09-12T00:00:00.000Z'),head_number:1,head_source_id:sourceId}

test('真实知识服务按知识ID、本人与workspace精确读取，更新后仍读新head',async t=>{
 const pool=new Pool(),calls:unknown[][]=[];let current={...row}
 t.mock.method(pool,'connect',()=>{throw Error('不应连接真实PG')})
 t.mock.method(pool,'query',async(sql:string,values:unknown[])=>{
  if(sql==="select to_regclass('teloa_employee_knowledge_archives') as present")return {rows:[{present:'teloa_employee_knowledge_archives'}]}
  if(sql==='select 1 from teloa_employee_knowledge_archives where owner_id=$1 and knowledge_id=$2'){assert.deepEqual(values,[owner,knowledgeId]);return {rows:[],rowCount:0}}
  assert.match(sql,/where i\.id=\$1 and i\.owner_id=\$2 and i\.workspace_id=\$3$/)
  calls.push(values);return {rows:[current]}
 })
 const service=new MarkdownKnowledgeService(pool,'/unused-knowledge-root','default',{id:()=>{throw Error('只读不分配ID')},now:()=>{throw Error('只读不写时间')}})
 assert.equal((await service.get(actor,{knowledgeId})).currentVersion,1)
 current={...row,current_version:2,head_number:2,title:'新版知识'}
 assert.equal((await service.get(actor,{knowledgeId})).currentVersion,2)
 assert.deepEqual(calls,[[knowledgeId,owner,'default'],[knowledgeId,owner,'default']])
 await pool.end()
})

test('指定知识元数据不绕过owner/workspace/scope与版本完整性，未知ID拒绝',async t=>{
 const pool=new Pool();let current={...row}
 t.mock.method(pool,'connect',()=>{throw Error('不应连接真实PG')})
 t.mock.method(pool,'query',async(sql:string,values:unknown[])=>{
  if(sql==="select to_regclass('teloa_employee_knowledge_archives') as present")return {rows:[{present:'teloa_employee_knowledge_archives'}]}
  if(sql==='select 1 from teloa_employee_knowledge_archives where owner_id=$1 and knowledge_id=$2')return {rows:[],rowCount:0}
  assert.match(sql,/where i\.id=\$1 and i\.owner_id=\$2 and i\.workspace_id=\$3$/)
  return {rows:current.id===values[0]&&current.owner_id===values[1]&&current.workspace_id===values[2]?[current]:[]}
 })
 const service=new MarkdownKnowledgeService(pool,'/unused-knowledge-root','default',{id:()=>{throw Error('只读')},now:()=>{throw Error('只读')}})
 for(const changed of [{...row,owner_id:'other'},{...row,workspace_id:'other'},{...row,scope_ids:['private']}]){
  current=changed;await assert.rejects(service.get(actor,{knowledgeId}),{code:'teloa/forbidden'})
 }
 current={...row};await assert.rejects(service.get(actor,{knowledgeId:sourceId}),{code:'teloa/forbidden'})
 current={...row,head_number:2};await assert.rejects(service.get(actor,{knowledgeId}),{code:'teloa/storage-corrupt'})
 await assert.rejects(service.get(actor,{knowledgeId:'not-an-id'}),{code:'teloa/invalid-input'})
 await pool.end()
})
