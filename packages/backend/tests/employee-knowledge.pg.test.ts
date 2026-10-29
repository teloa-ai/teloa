import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,rm} from 'node:fs/promises'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {initializeRoles} from '../src/work/roles.ts'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import {MarkdownKnowledgeCatalog} from '../src/capabilities/markdown-knowledge-catalog.ts'
import {ResourceService,assertRoleKnowledgeReferences,type ResourceActor,type ResourceSourceCatalog} from '../src/capabilities/resources.ts'
import {EmployeeKnowledgeService,resolveEmployeeKnowledgeReferences,employeeKnowledgeReferenceOrigins,removedEmployeeKnowledgeReferences,previewEmployeeKnowledgeImportResetInTransaction,confirmEmployeeKnowledgeImportResetInTransaction,replaceEmployeeKnowledgeImportBaselineInTransaction,stageEmployeeKnowledgeImportBaselinesInTransaction,cancelEmployeeKnowledgeImportBaselinesInTransaction,retireEmployeeKnowledgeImportDocumentsInTransaction} from '../src/capabilities/employee-knowledge.ts'
import {WorkError,isEmployeeKnowledgeContent,isEmployeeKnowledgeRevision} from '@teloa/contract'
import {createFixedRunKnowledgeRead,type FixedRunKnowledgeRead} from '../src/capabilities/fixed-run-knowledge-read.ts'

let container:StartedPostgreSqlContainer,pool:Pool,root:string
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool);await initializeRoles(pool);root=await mkdtemp(join(tmpdir(),'teloa-employee-knowledge-'))
},{timeout:180_000})
after(async()=>{await pool?.end();await stopTestContainer(container);if(root)await rm(root,{recursive:true,force:true})})

async function fixture(){
 const actor:ResourceActor={ownerId:randomUUID(),kind:'human',scopeIds:['general']},knowledge=new MarkdownKnowledgeService(pool,root,'default',identity),markdown=new MarkdownKnowledgeCatalog(knowledge)
 const body='# 市场原知识\n退款期限为 30 天。\n',sourceId='fixture_'+randomUUID(),sourceVersion=createHash('sha256').update(body).digest('hex')
 const source={id:sourceId,title:'退款规则',source:'fixture:market',version:sourceVersion,bytes:Buffer.byteLength(body)}
 const fixedSources=new Map([[sourceId,{...source,text:body}]])
 const sources:ResourceSourceCatalog={list:async context=>({schema:'teloa.reference-list/v1',references:[...fixedSources.values(),...(await markdown.list(context)).references]}),read:async(id,version,context)=>{if(id.startsWith('knowledge_'))return markdown.read(id,version,context);const fixed=fixedSources.get(id);if(!fixed||fixed.version!==version)throw new WorkError('teloa/source-unavailable','合成来源不存在');return {schema:'teloa.reference/v1',...fixed}}}
 const resources=new ResourceService(pool,sources,identity),service=new EmployeeKnowledgeService(pool,knowledge,resources,identity)
 const draft=await resources.create(actor,{requestId:randomUUID(),title:source.title,sourceId,sourceVersion,scopeIds:['general']}),resource=await resources.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
 const createRole=async()=>{const id=randomUUID(),fields={name:'退款客服',kind:'employee',scopes:['general'],duty:'核对退款',dataScope:'已授权知识',executionScope:'代拟',skills:[],knowledge:[resource.id]},now=new Date();await pool.query("insert into teloa_roles values($1,$2,$3,$4,$4,1,'active',$5,$5)",[id,actor.ownerId,randomUUID(),JSON.stringify(fields),now]);return id}
 const roleId=await createRole(),otherRoleId=await createRole()
 const createResource=async(text:string,prefix='fixture_')=>{const id=prefix+randomUUID(),version=createHash('sha256').update(text).digest('hex'),source={id,title:'新包退款规则',source:'fixture:import',version,bytes:Buffer.byteLength(text),text};fixedSources.set(id,source);const draft=await resources.create(actor,{requestId:randomUUID(),title:source.title,sourceId:id,sourceVersion:version,scopeIds:['general']});return resources.apply(actor,{draftId:draft.id,expectedVersion:draft.version})}
 return {actor,knowledge,resources,service,resource,body,roleId,otherRoleId,sourceId,createResource}
}
const edit=(f:Awaited<ReturnType<typeof fixture>>,extra={})=>({requestId:randomUUID(),roleId:f.roleId,resourceId:f.resource.id,expectedBodyVersion:1,expectedContentHash:f.resource.sourceVersion,markdown:'# 员工校正\n退款期限为 7 天。\n',...extra})

test('读取不建副本；首次写入COW仅改变当前员工，原包与另一员工不变，岗位版本保持不变',async()=>{
 const f=await fixture(),target={roleId:f.roleId,resourceId:f.resource.id},before=await f.service.read({...f.actor,kind:'agent'},target)
 assert.ok(isEmployeeKnowledgeContent(before));assert.equal(before.knowledgeId,null);assert.equal(before.editing,'fork-on-write')
 assert.equal((await pool.query('select count(*)::int n from teloa_employee_knowledge_bindings where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
 const input=edit(f),saved=await f.service.revise(f.actor,input)
 assert.ok(isEmployeeKnowledgeRevision(saved));assert.equal(saved.forked,true);assert.equal(saved.document.bodyVersion,2);assert.equal(saved.document.markdown,input.markdown)
 assert.equal(saved.document.documentId,before.documentId);assert.equal(saved.document.resourceId,f.resource.id);assert.notEqual(saved.document.resource.id,f.resource.id)
 assert.equal((await f.service.read(f.actor,{roleId:f.otherRoleId,resourceId:f.resource.id})).markdown,f.body)
 assert.equal((await f.resources.getResource(f.actor,{resourceId:f.resource.id})).status,'active')
 assert.equal((await pool.query('select version from teloa_roles where id=$1',[f.roleId])).rows[0].version,1)
 assert.deepEqual(await resolveEmployeeKnowledgeReferences(pool,f.actor.ownerId,f.roleId,[f.resource.id]),[saved.document.resource.id])
 assert.deepEqual(await employeeKnowledgeReferenceOrigins(pool,f.actor.ownerId,f.roleId,[saved.document.resource.id]),[f.resource.id])
 assert.equal((await f.service.read(f.actor,{...target,version:1})).markdown,f.body)
 assert.deepEqual((await f.service.versions(f.actor,target)).map(row=>row.version),[1,2])
 const other=await f.service.revise(f.actor,edit(f,{roleId:f.otherRoleId}))
 assert.notEqual(other.document.knowledgeId,saved.document.knowledgeId)
})

test('修订、恢复均追加不可变版本，重试回读原回执，global directory隐藏历史副本但固定读取仍有效',async()=>{
 const f=await fixture(),input=edit(f),first=await f.service.revise(f.actor,input)
 assert.deepEqual(await f.service.revise(f.actor,input),first);assert.deepEqual(await f.service.status(f.actor,{requestId:input.requestId}),first)
 const restored=await f.service.restore(f.actor,{requestId:randomUUID(),roleId:f.roleId,resourceId:f.resource.id,expectedBodyVersion:2,expectedContentHash:first.document.contentHash,restoreVersion:1})
 assert.equal(restored.forked,false);assert.equal(restored.document.bodyVersion,3);assert.equal(restored.document.markdown,f.body)
 assert.equal((await f.resources.getResource(f.actor,{resourceId:first.document.resource.id})).status,'active')
 assert.deepEqual(await employeeKnowledgeReferenceOrigins(pool,f.actor.ownerId,f.roleId,[first.document.resource.id]),[f.resource.id])
 const directory=await f.resources.list(f.actor)
 assert.ok(!directory.resources.some(row=>row.id===first.document.resource.id));assert.ok(directory.resources.some(row=>row.id===f.resource.id));assert.ok(directory.resources.some(row=>row.id===restored.document.resource.id))
 assert.equal((await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id,version:2})).markdown,input.markdown)
 assert.deepEqual(await f.service.revise(f.actor,input),first)
 await assert.rejects(pool.query('update teloa_employee_knowledge_versions set bytes=1 where owner_id=$1',[f.actor.ownerId]),/immutable/)
 await assert.rejects(pool.query('delete from teloa_employee_knowledge_operations where owner_id=$1',[f.actor.ownerId]),/immutable/)
})

test('并发相同请求恰好一个副本；不同请求CAS只接受一个，重用请求更改内容被拒绝',async()=>{
 const f=await fixture(),input=edit(f),results=await Promise.all([f.service.revise(f.actor,input),f.service.revise(f.actor,input)])
 assert.deepEqual(results[0],results[1]);assert.equal((await pool.query('select count(*)::int n from teloa_employee_knowledge_bindings where owner_id=$1',[f.actor.ownerId])).rows[0].n,1)
 await assert.rejects(f.service.revise(f.actor,{...input,markdown:'另一份修改'}),{code:'teloa/conflict'})
 await assert.rejects(f.service.revise(f.actor,{...input,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 const g=await fixture(),outcomes=await Promise.allSettled([g.service.revise(g.actor,edit(g)),g.service.revise(g.actor,edit(g,{markdown:'并发另一份正文'}))])
 assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);assert.equal((await pool.query('select count(*)::int n from teloa_knowledge_items where owner_id=$1',[g.actor.ownerId])).rows[0].n,1)
})

test('本人、员工原绑定及范围从服务端核验；模型不可写，伪造字段、跨员工、跨本人或跨范围读取拒绝',async()=>{
 const f=await fixture(),input=edit(f)
 await assert.rejects(f.service.revise({...f.actor,kind:'agent'},input),{code:'teloa/forbidden'})
 await assert.rejects(f.service.revise(f.actor,{...input,ownerId:'forged'}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.read({...f.actor,ownerId:randomUUID()},{roleId:f.roleId,resourceId:f.resource.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.read({...f.actor,scopeIds:[]},{roleId:f.roleId,resourceId:f.resource.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.read(f.actor,{roleId:randomUUID(),resourceId:f.resource.id}),{code:'teloa/forbidden'})
 const saved=await f.service.revise(f.actor,input)
 assert.equal(await f.service.status({...f.actor,ownerId:randomUUID()},{requestId:input.requestId}),null)
 await assert.rejects(f.service.read(f.actor,{roleId:f.otherRoleId,resourceId:saved.document.resource.id}),{code:'teloa/forbidden'})
 await pool.query("update teloa_roles set definition=jsonb_set(definition,'{knowledge}','[]') where id=$1",[f.roleId])
 await assert.rejects(f.service.status(f.actor,{requestId:input.requestId}),{code:'teloa/forbidden'})
})

test('投影失败回滚知识、绑定与回执；重试可正式发布，不留半成品',async()=>{
 const f=await fixture(),publish=f.resources.publishEmployeeKnowledgeInTransaction.bind(f.resources),input=edit(f)
 f.resources.publishEmployeeKnowledgeInTransaction=async(...args)=>{await publish(...args);throw new WorkError('teloa/storage-unavailable','合成事务失败')}
 await assert.rejects(f.service.revise(f.actor,input),{code:'teloa/storage-unavailable'})
 for(const table of ['teloa_knowledge_items','teloa_employee_knowledge_bindings','teloa_employee_knowledge_operations'])assert.equal((await pool.query(`select count(*)::int n from ${table} where owner_id=$1`,[f.actor.ownerId])).rows[0].n,0)
 f.resources.publishEmployeeKnowledgeInTransaction=publish
 assert.equal((await f.service.revise(f.actor,input)).document.bodyVersion,2)
})

test('持久化继承已加入检索的来源，新正文保存成功仍pending；真正撤回阻止新任务和在途旧版授权',async()=>{
 const f=await fixture();await pool.query('insert into teloa_retrieval_enrollments values($1,$2,$3)',[f.actor.ownerId,f.sourceId,new Date()])
 const saved=await f.service.revise(f.actor,edit(f))
 assert.equal(saved.document.indexState,'pending');assert.equal((await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id})).indexState,'pending')
 const restarted=new EmployeeKnowledgeService(pool,f.knowledge,f.resources,identity)
 assert.equal((await restarted.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id})).indexState,'pending')
 assert.ok((await pool.query('select 1 from teloa_retrieval_enrollments where owner_id=$1 and source_id=$2',[f.actor.ownerId,saved.document.resource.sourceId])).rowCount)
 await f.resources.withdraw(f.actor,{resourceId:saved.document.resource.id,expectedVersion:saved.document.resource.version})
 await assert.rejects(resolveEmployeeKnowledgeReferences(pool,f.actor.ownerId,f.roleId,[f.resource.id]),{code:'teloa/resource-withdrawn'})
 await assert.rejects(employeeKnowledgeReferenceOrigins(pool,f.actor.ownerId,f.roleId,[saved.document.resource.id]),{code:'teloa/resource-withdrawn'})
 await assert.rejects(restarted.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id}),{code:'teloa/resource-withdrawn'})
})

test('包导入确认固定本地版本与alias；重置后candidate成为v1，旧知识历史与恢复全部不可访问，包外知识保留',async()=>{
 const f=await fixture(),unrelated=await fixture(),input=edit(f),first=await f.service.revise(f.actor,input)
 const scope={roleIds:[f.roleId,f.otherRoleId],originResourceIds:[f.resource.id]},stale=await previewEmployeeKnowledgeImportResetInTransaction(pool,f.actor.ownerId,scope)
 const second=await f.service.revise(f.actor,edit(f,{expectedBodyVersion:2,expectedContentHash:first.document.contentHash,markdown:'最后一版本地修改'}))
 const candidate=await f.createResource('# 新包正文\n退款期限为 14 天。\n')
 const reset=async(expectedDigest:string)=>{const client=await pool.connect();try{await client.query('begin');await confirmEmployeeKnowledgeImportResetInTransaction(client,f.actor.ownerId,{...scope,expectedDigest,resetId:randomUUID(),now:identity.now()});await replaceEmployeeKnowledgeImportBaselineInTransaction(client,f.actor.ownerId,{previousResourceId:f.resource.id,resourceId:candidate.id,now:identity.now()});await client.query('commit')}catch(error){await client.query('rollback');throw error}finally{client.release()}}
 await assert.rejects(reset(stale.digest),{code:'teloa/version-conflict'})
 assert.equal((await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id})).bodyVersion,3)
 const preview=await previewEmployeeKnowledgeImportResetInTransaction(pool,f.actor.ownerId,scope)
 assert.deepEqual(preview.documents.map(row=>row.knowledgeId),[first.document.knowledgeId]);await reset(preview.digest)
 const current=await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id})
 assert.equal(current.bodyVersion,1);assert.equal(current.knowledgeId,null);assert.equal(current.resource.id,candidate.id);assert.equal(current.markdown,'# 新包正文\n退款期限为 14 天。\n')
 assert.deepEqual((await f.service.versions(f.actor,{roleId:f.roleId,resourceId:f.resource.id})).map(row=>row.version),[1])
 await assert.rejects(f.knowledge.readVersion(f.actor,{knowledgeId:first.document.knowledgeId,version:2}),{code:'teloa/not-found'})
 await assert.rejects(f.knowledge.listVersions(f.actor,{knowledgeId:first.document.knowledgeId}),{code:'teloa/not-found'})
 await assert.rejects(f.service.status(f.actor,{requestId:input.requestId}),{code:'teloa/not-found'})
 await assert.rejects(f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id,version:2}),{code:'teloa/not-found'})
 assert.ok(!(await f.knowledge.list(f.actor,{})).some(row=>row.id===first.document.knowledgeId))
 assert.ok(!(await f.resources.list(f.actor)).resources.some(row=>row.id===second.document.resource.id))
 assert.equal((await unrelated.service.read(unrelated.actor,{roleId:unrelated.roleId,resourceId:unrelated.resource.id})).markdown,unrelated.body)
 assert.deepEqual(await resolveEmployeeKnowledgeReferences(pool,f.actor.ownerId,f.roleId,[f.resource.id]),[candidate.id])
 assert.deepEqual(await employeeKnowledgeReferenceOrigins(pool,f.actor.ownerId,f.roleId,[second.document.resource.id]),[f.resource.id])
 assert.equal((await pool.query('select version from teloa_roles where id=$1',[f.roleId])).rows[0].version,1)
 assert.ok(!(await f.resources.list(f.actor)).resources.some(row=>row.id===f.resource.id),'已切换基线的旧包资料不重复展示')
 const outsideRoleId=randomUUID(),outsideFields={name:'包外员工',kind:'employee',scopes:['general'],duty:'读取独立旧资料',dataScope:'已有授权',executionScope:'代拟',skills:[],knowledge:[f.resource.id]},now=new Date()
 await pool.query("insert into teloa_roles values($1,$2,$3,$4,$4,1,'active',$5,$5)",[outsideRoleId,f.actor.ownerId,randomUUID(),JSON.stringify(outsideFields),now])
 assert.ok((await f.resources.list(f.actor)).resources.some(row=>row.id===f.resource.id),'其他员工仍直接使用旧原件时必须保持其可见')
 assert.equal((await f.service.read(f.actor,{roleId:outsideRoleId,resourceId:f.resource.id})).markdown,f.body)
 const revised=await f.service.revise(f.actor,edit(f,{expectedContentHash:current.contentHash,markdown:'新导入基线上的独立修订'}))
 assert.equal(revised.document.bodyVersion,2);assert.notEqual(revised.document.knowledgeId,first.document.knowledgeId)
 assert.equal((await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id,version:1})).markdown,current.markdown)
 // 后续导入仍用当前包resource识别原员工逻辑身份，digest覆盖alias当前版本。
 const nextScope={roleIds:scope.roleIds,originResourceIds:[candidate.id]},nextPreview=await previewEmployeeKnowledgeImportResetInTransaction(pool,f.actor.ownerId,nextScope)
 assert.equal(nextPreview.documents.length,1);assert.equal(nextPreview.documents[0]?.resourceId,f.resource.id)
})

test('导入后旧正文不再能通过普通知识来源回读；只有真实执行引用可读取归档固定版本',async()=>{
 const f=await fixture(),first=await f.service.revise(f.actor,edit(f)),scope={roleIds:[f.roleId],originResourceIds:[f.resource.id]},preview=await previewEmployeeKnowledgeImportResetInTransaction(pool,f.actor.ownerId,scope)
 const client=await pool.connect();try{await client.query('begin');await confirmEmployeeKnowledgeImportResetInTransaction(client,f.actor.ownerId,{...scope,expectedDigest:preview.digest,resetId:randomUUID(),now:identity.now()});await client.query('commit')}finally{client.release()}
 const agent={...f.actor,kind:'agent' as const}
 await assert.rejects(f.resources.executionKnowledge(agent,['general'],[first.document.resource.id]),{code:'teloa/not-found'})
 await assert.rejects(assertRoleKnowledgeReferences(pool,f.actor.ownerId,[first.document.resource.id]),{code:'teloa/invalid-input'})
 const runId=randomUUID(),references=[{id:first.document.resource.id,sourceId:first.document.resource.sourceId,sourceVersion:first.document.contentHash,text:first.document.markdown}]
 await pool.query('create table if not exists teloa_task_runs(id uuid primary key,owner_id text not null,role_knowledge jsonb not null)')
 await pool.query('insert into teloa_task_runs values($1,$2,$3)',[runId,f.actor.ownerId,JSON.stringify(references)])
 await assert.rejects(f.resources.executionKnowledge(agent,['general'],[first.document.resource.id]),{code:'teloa/not-found'})
 await assert.rejects(f.resources.executionKnowledge(agent,['general'],[first.document.resource.id],undefined,{runId} as unknown as FixedRunKnowledgeRead),{code:'teloa/not-found'})
 const capability=createFixedRunKnowledgeRead(f.actor.ownerId,runId,references)
 assert.equal((await f.resources.executionKnowledge(agent,['general'],[first.document.resource.id],undefined,capability))[0]?.text,first.document.markdown)
 await assert.rejects(f.resources.executionKnowledge(agent,['general'],[first.document.resource.id],undefined,createFixedRunKnowledgeRead(f.actor.ownerId,randomUUID(),references)),{code:'teloa/not-found'})
 await assert.rejects(f.resources.executionKnowledge(f.actor,['general'],[first.document.resource.id]),{code:'teloa/not-found'})
})

test('带BOM/CRLF的导入正文首次fork后，首版本正文、摘要与固定资源保持一致',async()=>{
 const f=await fixture(),source=await f.createResource('\ufeff# 新原文\r\n规则正文\r\n')
 await pool.query("update teloa_roles set definition=jsonb_set(definition,'{knowledge}',$2::jsonb) where id=$1",[f.roleId,JSON.stringify([source.id])])
 const before=await f.service.read(f.actor,{roleId:f.roleId,resourceId:source.id}),saved=await f.service.revise(f.actor,{requestId:randomUUID(),roleId:f.roleId,resourceId:source.id,expectedBodyVersion:1,expectedContentHash:before.contentHash,markdown:'# 编辑后\n'})
 const first=await f.service.read(f.actor,{roleId:f.roleId,resourceId:source.id,version:1})
 assert.ok(isEmployeeKnowledgeContent(first));assert.equal(first.markdown,'# 新原文\n规则正文\n');assert.equal(first.contentHash,first.resource.sourceVersion)
 assert.equal(saved.document.bodyVersion,2)
})

test('导入接入窗口持久pending阻止写旧版和新任务，旧正文仍可查看，失败重试完成或卸载解除',async()=>{
 const f=await fixture(),loadId=randomUUID(),client=await pool.connect()
 try{await client.query('begin');await stageEmployeeKnowledgeImportBaselinesInTransaction(client,f.actor.ownerId,{previousResourceIds:[f.resource.id],loadId,now:identity.now()});await client.query('commit')}finally{client.release()}
 assert.equal((await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id})).markdown,f.body)
 assert.equal((await f.service.list(f.actor,{roleId:f.roleId})).length,1)
 await assert.rejects(f.service.list(f.actor,{roleId:f.roleId,requireReady:true}),error=>error instanceof WorkError&&error.details?.reason==='employee-knowledge-import-pending')
 await assert.rejects(f.service.list(f.actor,{roleId:f.roleId,requireReady:false}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.revise(f.actor,edit(f)),error=>error instanceof WorkError&&error.details?.reason==='employee-knowledge-import-pending')
 await assert.rejects(resolveEmployeeKnowledgeReferences(pool,f.actor.ownerId,f.roleId,[f.resource.id]),error=>error instanceof WorkError&&error.details?.reason==='employee-knowledge-import-pending')
 const candidate=await f.createResource('导入新版权威正文'),failed=await pool.connect()
 try{await failed.query('begin');await replaceEmployeeKnowledgeImportBaselineInTransaction(failed,f.actor.ownerId,{previousResourceId:f.resource.id,resourceId:candidate.id,now:identity.now()});await failed.query('rollback')}finally{failed.release()}
 await assert.rejects(f.service.revise(f.actor,edit(f)),{code:'teloa/conflict'})
 const retry=await pool.connect();try{await retry.query('begin');await replaceEmployeeKnowledgeImportBaselineInTransaction(retry,f.actor.ownerId,{previousResourceId:f.resource.id,resourceId:candidate.id,now:identity.now()});await retry.query('commit')}finally{retry.release()}
 const current=await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id});assert.equal(current.bodyVersion,1);assert.equal(current.markdown,'导入新版权威正文')
 assert.equal((await f.service.list(f.actor,{roleId:f.roleId,requireReady:true}))[0]?.resource.id,candidate.id)
 assert.equal((await f.service.revise(f.actor,edit(f,{expectedContentHash:current.contentHash}))).document.bodyVersion,2)
 const nextLoad=randomUUID(),unload=await pool.connect();try{await unload.query('begin');await stageEmployeeKnowledgeImportBaselinesInTransaction(unload,f.actor.ownerId,{previousResourceIds:[candidate.id],loadId:nextLoad,now:identity.now()});await cancelEmployeeKnowledgeImportBaselinesInTransaction(unload,f.actor.ownerId,nextLoad,identity.now());await unload.query('commit')}finally{unload.release()}
 assert.ok((await resolveEmployeeKnowledgeReferences(pool,f.actor.ownerId,f.roleId,[f.resource.id]))[0])
})

test('真正撤回历史版本后，回执与历史正文均不得绕过撤回；当前新版本继续可用',async()=>{
 const f=await fixture(),input=edit(f),first=await f.service.revise(f.actor,input),next=await f.service.revise(f.actor,edit(f,{expectedBodyVersion:2,expectedContentHash:first.document.contentHash,markdown:'当前有效新版'}))
 await f.resources.withdraw(f.actor,{resourceId:first.document.resource.id,expectedVersion:first.document.resource.version})
 await assert.rejects(f.service.status(f.actor,{requestId:input.requestId}),{code:'teloa/resource-withdrawn'})
 await assert.rejects(f.service.revise(f.actor,input),{code:'teloa/resource-withdrawn'})
 await assert.rejects(f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id,version:2}),{code:'teloa/resource-withdrawn'})
 assert.equal((await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id})).contentHash,next.document.contentHash)
})

test('candidate移除资料后仅冻结Run可读旧源，list/未来解析/公共目录/新role拒旧源，包外adopted副本保留',async()=>{
 const f=await fixture(),adopted=await f.createResource(f.body,'adopted_'),client=await pool.connect()
 try{await client.query('begin');await retireEmployeeKnowledgeImportDocumentsInTransaction(client,f.actor.ownerId,{previousLoadId:randomUUID(),loadId:randomUUID(),resources:[{resourceId:f.resource.id,localId:'guide'}],now:identity.now()});await client.query('commit')}finally{client.release()}
 assert.deepEqual(await f.service.list(f.actor,{roleId:f.roleId,requireReady:true}),[])
 await assert.rejects(f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id}),{code:'teloa/not-found'})
 assert.deepEqual(await resolveEmployeeKnowledgeReferences(pool,f.actor.ownerId,f.roleId,[f.resource.id]),[])
 assert.deepEqual(await employeeKnowledgeReferenceOrigins(pool,f.actor.ownerId,f.roleId,[f.resource.id]),[f.resource.id])
 assert.deepEqual(await removedEmployeeKnowledgeReferences(pool,f.actor.ownerId,f.roleId,[f.resource.id,adopted.id]),[f.resource.id])
 await assert.rejects(assertRoleKnowledgeReferences(pool,f.actor.ownerId,[f.resource.id]),{code:'teloa/invalid-input'})
 await assertRoleKnowledgeReferences(pool,f.actor.ownerId,[adopted.id])
 const directory=await f.resources.list(f.actor);assert.ok(!directory.resources.some(row=>row.id===f.resource.id));assert.ok(directory.resources.some(row=>row.id===adopted.id))
 const sources=await f.resources.sourceDirectory(f.actor);assert.ok(!sources.some(row=>row.id===f.resource.sourceId));assert.ok(sources.some(row=>row.id===adopted.sourceId))
 const agent={...f.actor,kind:'agent' as const};await assert.rejects(f.resources.executionKnowledge(agent,['general'],[f.resource.id]),{code:'teloa/not-found'})
 const runId=randomUUID(),references=[{id:f.resource.id,sourceId:f.resource.sourceId,sourceVersion:f.resource.sourceVersion,text:f.body}]
 await pool.query('create table if not exists teloa_task_runs(id uuid primary key,owner_id text not null,role_knowledge jsonb not null)');await pool.query('insert into teloa_task_runs values($1,$2,$3)',[runId,f.actor.ownerId,JSON.stringify(references)])
 assert.equal((await f.resources.executionKnowledge(agent,['general'],[f.resource.id],undefined,createFixedRunKnowledgeRead(f.actor.ownerId,runId,references)))[0]?.text,f.body)
 const reintroduced=await f.createResource('重新引入的权威正文'),restore=await pool.connect();try{await restore.query('begin');await replaceEmployeeKnowledgeImportBaselineInTransaction(restore,f.actor.ownerId,{previousResourceId:f.resource.id,resourceId:reintroduced.id,now:identity.now()});await restore.query('commit')}finally{restore.release()}
 assert.equal((await f.service.list(f.actor,{roleId:f.roleId,requireReady:true}))[0]?.resource.id,reintroduced.id)
 assert.equal((await f.service.read(f.actor,{roleId:f.roleId,resourceId:f.resource.id})).bodyVersion,1)
 await assertRoleKnowledgeReferences(pool,f.actor.ownerId,await resolveEmployeeKnowledgeReferences(pool,f.actor.ownerId,f.roleId,[f.resource.id]))
 await assert.rejects(assertRoleKnowledgeReferences(pool,f.actor.ownerId,[f.resource.id]),{code:'teloa/invalid-input'},'新员工不能以旧来源身份绕过当前导入基线')
 await assert.rejects(f.resources.executionKnowledge(agent,['general'],[f.resource.id]),{code:'teloa/not-found'},'重新引入新版本不能重新开放旧来源')
})
