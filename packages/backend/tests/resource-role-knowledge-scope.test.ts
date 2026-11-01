import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import type {Pool,PoolClient} from 'pg'
import {createHash} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ReferenceCatalog} from '@teloa/mcp-reference/catalog'
import {ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'

async function fixture(t:TestContext,scopes:readonly string[][],texts:readonly string[]=[]){
 const directory=await mkdtemp(join(tmpdir(),'teloa-role-scope-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 const at=new Date('2026-11-01T00:00:00.000Z'),owner='scope-test-owner'
 const rows=scopes.map((scopeIds,index)=>{const text=texts[index]??'合成依据 '+index;return {id:'10000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),owner_id:owner,spec:{title:'合成资料 '+index,sourceId:'scope-source-'+index,sourceVersion:createHash('sha256').update(text).digest('hex'),scopeIds},revision:1,status:'active',created_at:at,updated_at:at}})
 await Promise.all(rows.map((row,index)=>writeFile(join(directory,row.spec.sourceId+'.md'),texts[index]??'合成依据 '+index)))
 const catalog=new ReferenceCatalog(directory,rows.map(row=>({id:row.spec.sourceId,title:row.spec.title,file:row.spec.sourceId+'.md'})))
 const locks:string[]=[],reads:{id:string;actorScopes:readonly string[]|undefined;resourceScopes:readonly string[]|undefined}[]=[]
 const client={query:async(sql:string,params:unknown[])=>{
  assert.match(sql,/^select \* from teloa_resources where id=\$1 for share$/)
  const id=String(params[0]);locks.push(id);return {rows:rows.filter(row=>row.id===id)}
 }} as unknown as PoolClient
 const service=new ResourceService({} as Pool,{
  list:async()=>{throw Error('读取指定资料不应枚举全部来源')},
  read:async(id,version,context)=>{reads.push({id,actorScopes:context?.actor.scopeIds,resourceScopes:context?.scopeIds});return catalog.read(id,version)},
 },{id:()=>'',now:()=>at.toISOString()})
 const actor:ResourceActor={ownerId:owner,kind:'agent',scopeIds:['general','SOC']}
 return {rows,service,client,actor,locks,reads}
}

test('真实服务只读general/SOC已指定正文，AppSec与部分交叉范围只锁metadata且撤回不阻断',async t=>{
 const f=await fixture(t,[['general'],['SOC'],['AppSec'],['SOC','AppSec']]);f.rows[2]!.status='withdrawn'
 const ids=[f.rows[2]!.id,f.rows[1]!.id,f.rows[3]!.id,f.rows[0]!.id]
 const result=await f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general','SOC'],ids)
 assert.deepEqual(f.locks.slice(0,ids.length),[...ids].sort(),'先固定全部已指定ID的锁顺序')
 assert.deepEqual(result.references.map(row=>({id:row.id,version:row.version})),result.contents.map(row=>({id:row.id,version:row.version})))
 assert.deepEqual(result.contents.map(row=>row.id),[f.rows[1]!.id,f.rows[0]!.id])
 assert.deepEqual(f.reads.map(row=>row.id),['scope-source-1','scope-source-0'],'SUT未读取AppSec或部分交叉资料正文')
 assert.ok(f.reads.every(row=>JSON.stringify(row.actorScopes)==='["general","SOC"]'),'actor没有增加其它业务')
 f.reads.length=0
 const general=await f.service.executionRoleKnowledgeForScopeInTransaction(f.client,{...f.actor,scopeIds:['general']},['general'],ids)
 assert.deepEqual(general.contents.map(row=>row.id),[f.rows[0]!.id]);assert.deepEqual(f.reads.map(row=>row.id),['scope-source-0'])
})

test('正常row/source parser仍拒foreign owner、缺失与eligible撤回；ACL不因metadata筛选扩大',async t=>{
 const f=await fixture(t,[['general'],['AppSec']]),ids=f.rows.map(row=>row.id)
 f.rows[1]!.owner_id='foreign-owner'
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general'],ids),{code:'teloa/forbidden'});assert.equal(f.reads.length,0)
 f.rows[1]!.owner_id=f.actor.ownerId
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general'],[...ids,'20000000-0000-4000-8000-000000000001']),{code:'teloa/invalid-input',details:{reason:'role-knowledge-unavailable',resourceIds:['20000000-0000-4000-8000-000000000001']}})
 f.rows[0]!.status='withdrawn'
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general'],ids),{code:'teloa/resource-withdrawn'});assert.equal(f.reads.length,0)
 f.rows[0]!.status='active'
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,{...f.actor,scopeIds:['SOC']},['general'],[ids[0]!]),{code:'teloa/forbidden'})
 f.rows[0]!.spec.sourceVersion='f'.repeat(64)
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general'],[ids[0]!]),{code:'teloa/version-conflict'},'真实ReferenceCatalog拒正文摘要不符')
})

test('岗位30项保留而非Task的8项；16业务岗位不需扩成17项actor，仍守31/重复/预算/取消',async t=>{
 const roleScopes=Array.from({length:16},(_,index)=>'business-'+index)
 const f=await fixture(t,[...Array.from({length:30},()=>['general']),[roleScopes[15]!]])
 const ids=f.rows.slice(0,30).map(row=>row.id)
 const result=await f.service.executionRoleKnowledgeForScopeInTransaction(f.client,{...f.actor,scopeIds:['general']},['general'],[...ids.slice(0,29),f.rows[30]!.id])
 assert.equal(result.contents.length,29);assert.ok(f.reads.every(row=>row.actorScopes?.length===1))
 const thirty=await f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general'],ids)
 assert.equal(thirty.contents.length,30)
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general'],f.rows.map(row=>row.id)),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general'],[ids[0]!,ids[0]!]),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,{...f.actor,scopeIds:['general',...roleScopes]},['general'],ids),{code:'teloa/forbidden'})
 const aborted=new AbortController();aborted.abort();const before=f.locks.length
 await assert.rejects(f.service.executionRoleKnowledgeForScopeInTransaction(f.client,f.actor,['general'],ids,aborted.signal),{name:'AbortError'});assert.equal(f.locks.length,before)
 const large=await fixture(t,[['general'],['general'],['general']],Array.from({length:3},()=> 'a'.repeat(100*1024)))
 await assert.rejects(large.service.executionRoleKnowledgeForScopeInTransaction(large.client,large.actor,['general'],large.rows.map(row=>row.id)),{code:'teloa/invalid-input'})
})
