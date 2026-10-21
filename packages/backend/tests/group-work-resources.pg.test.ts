import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {startDatabase} from './business-widget-fixture.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {readResourceRelations} from '../src/work/resource-relations.ts'
import {readRunGroupContext,readStoredRunGroupContext,runGroupContextHash,type RunGroupFilePorts} from '../src/work/task-run-group-context.ts'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import {MarkdownKnowledgeCatalog,markdownKnowledgeReferenceId} from '../src/capabilities/markdown-knowledge-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {isMessageReference,type MessageReference} from '@teloa/contract'

let state:Awaited<ReturnType<typeof startDatabase>>,root:string
let clock=Date.parse('2026-10-21T12:00:00.000Z')
const identity={id:randomUUID,now:()=>new Date(clock++).toISOString()},rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
before(async()=>{state=await startDatabase();root=await mkdtemp(join(tmpdir(),'teloa-group-work-resource-'))},{timeout:120000})
after(async()=>{await state?.reader.end();await state?.pool.end();await state?.container.stop();if(root)await rm(root,{recursive:true,force:true})})
async function fixture(){
 const owner=randomUUID(),pool=state.pool,user={ownerId:owner,kind:'human' as const,scopeIds:['general']},groups=new CollaborationService(pool,identity)
 const knowledge=new MarkdownKnowledgeService(pool,root,'default',identity),resources=new ResourceService(pool,new MarkdownKnowledgeCatalog(knowledge),identity)
 const saved=await knowledge.createPaste(user,{requestId:randomUUID(),title:'固定知识',category:'sop',topics:[],scopeIds:['general'],markdown:'# 原始知识\n\n只使用这一版。\n'})
 const draft=await resources.create(user,{requestId:randomUUID(),title:saved.item.title,sourceId:markdownKnowledgeReferenceId(saved.item.id),sourceVersion:saved.version.contentHash,scopeIds:['general']})
 const resource=await resources.apply(user,{draftId:draft.id,expectedVersion:draft.version})
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核验员',kind:'employee',scopes:['general'],duty:'核验',dataScope:'固定知识',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'知识协作群',scope:'general',announcement:'只核对已授权知识。',rules,memberRoleIds:[role.id]}})
 const reference:MessageReference={kind:'work-resource',id:resource.id,version:resource.version}
 const send=(patch:Record<string,unknown>={})=>groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'核对原知识',references:[reference],...patch})
 const ports:RunGroupFilePorts={readAttachmentBytes:async()=>{throw Error('不得读取附件')},readWorkResourceReferences:(db,actor,scope,references)=>resources.executionKnowledgeReferencesInTransaction(db,{ownerId:actor,kind:'agent',scopeIds:[scope]},[scope],references)}
 return {owner,user,groups,knowledge,resources,saved,resource,role,group,reference,send,ports,grants:new GroupAgentGrantService(pool,identity.now),tasks:new GroupTaskService(pool,identity,new TaskService(pool,identity))}
}
test('群发送固定全局资料身份且幂等，反向引用只统计真实消息和确切版本',async()=>{
 const f=await fixture(),requestId=randomUUID(),first=await f.send({requestId,references:[{...f.reference,id:f.resource.id.toUpperCase()}]})
 assert.equal(isMessageReference(first.references[0]),true);assert.deepEqual(first.references,[f.reference])
 assert.deepEqual(await f.send({requestId}),first)
 const second=await f.send({rootId:first.id})
 // 群资料的同UUID及文字中的ID均不是全局知识引用。
 await f.groups.saveResource(f.owner,{requestId:randomUUID(),groupId:f.group.id,resourceId:f.resource.id,expectedVersion:0,title:'固定知识',markdown:'# 相同名称不等于同一来源\n'})
 await f.send({references:[{kind:'group-resource',id:f.resource.id,version:1}]})
 await f.send({text:f.resource.id,references:[]})
 const result=await readResourceRelations(state.pool,f.owner,f.resource.id,['general'])
 assert.deepEqual(result.items,[{kind:'group',id:f.group.id,title:f.group.name,scope:'general',messageId:second.id,rootId:first.id,version:1,count:2}]);assert.equal(result.more,false)
 // 合法的已存资源修订可独立存在；旧引用的统计不能被现行修订覆盖。
 await state.pool.query('update teloa_resources set revision=2 where id=$1',[f.resource.id])
 const next=await f.send({rootId:first.id,references:[{...f.reference,version:2}]})
 const versions=(await readResourceRelations(state.pool,f.owner,f.resource.id,['general'])).items
 assert.deepEqual(versions.map(row=>row.kind==='group'?[row.version,row.count,row.messageId]:null),[[1,2,second.id],[2,1,next.id]])
 assert.deepEqual((await readResourceRelations(state.pool,'other',f.resource.id,['general'])).items,[])
 assert.deepEqual((await readResourceRelations(state.pool,f.owner,f.resource.id,[])).items,[])
 await state.pool.query("update teloa_groups set definition=jsonb_set(definition,'{scope}','\"private\"'::jsonb) where id=$1",[f.group.id])
 assert.deepEqual((await readResourceRelations(state.pool,f.owner,f.resource.id,['general'])).items,[])
})
test('跨本人、错版本、错范围和撤回均不能新增群引用；原历史与固定正文仍可追溯',async()=>{
 const f=await fixture(),foreign=await fixture(),requestId=randomUUID(),message=await f.send({requestId})
 for(const reference of [{...f.reference,version:2},foreign.reference])await assert.rejects(f.send({references:[reference]}),{code:'teloa/forbidden'})
 await state.pool.query("update teloa_resources set spec=jsonb_set(spec,'{scopeIds}','[\"private\"]'::jsonb) where id=$1",[f.resource.id])
 await assert.rejects(f.send(),{code:'teloa/forbidden'})
 await state.pool.query("update teloa_resources set spec=jsonb_set(spec,'{scopeIds}','[\"general\"]'::jsonb) where id=$1",[f.resource.id])
 await f.resources.withdraw(f.user,{resourceId:f.resource.id,expectedVersion:1})
 await assert.rejects(f.send(),{code:'teloa/forbidden'})
 assert.deepEqual(await f.send({requestId}),message,'撤回后原请求只读恢复旧回执，不新增引用')
 const historical=await f.groups.messages(f.owner,{groupId:f.group.id})
 assert.deepEqual(historical.find(row=>row.id===message.id)?.references,[f.reference])
 assert.equal((await f.knowledge.readVersion(f.user,{knowledgeId:f.saved.item.id,version:1})).contentHash,f.saved.version.contentHash)
 const related=(await readResourceRelations(state.pool,f.owner,f.resource.id,['general'])).items
 assert.equal(related.length,1);assert.equal(related[0]?.kind==='group'&&related[0].count,1)
 assert.equal((await state.pool.query('select count(*)::int n from teloa_group_messages where owner_id=$1 and group_id=$2',[f.owner,f.group.id])).rows[0].n,1)
})
test('默认授权不扩大；明确授予固定知识版本后执行复用原Reader、source hash及撤回检查',async()=>{
 const f=await fixture(),message=await f.send(),input={requestId:randomUUID(),groupId:f.group.id,messageId:message.id,expectedGroupVersion:f.group.version,goal:'只读核对知识',assignee:{roleId:f.role.id,expectedVersion:f.role.version}}
 await assert.rejects(f.tasks.create(f.owner,input),{code:'teloa/forbidden'})
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'save',resources:[f.reference],canPost:true,canAutoRun:true})
 const created=await f.tasks.create(f.owner,input),context=async(ports:RunGroupFilePorts|undefined=f.ports)=>{const db=await state.pool.connect();try{await db.query('begin');const value=await readRunGroupContext(db,f.owner,created.task,f.role,ports,state.pool);await db.query('commit');return value}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 const fixed=await context();assert.ok(fixed);assert.equal(fixed.workResources?.[0]?.id,f.resource.id);assert.equal(fixed.workResources?.[0]?.version,1)
 assert.equal(fixed.workResources?.[0]?.sourceVersion,f.saved.version.contentHash);assert.equal(fixed.workResources?.[0]?.text,f.saved.version.markdown)
 assert.deepEqual(readStoredRunGroupContext(fixed),fixed);assert.equal(runGroupContextHash(fixed),runGroupContextHash(JSON.parse(JSON.stringify(fixed))))
 const sessionId=randomUUID(),inspect=async()=>({id:sessionId,sessionId,ownerId:f.owner,status:'ready'})
 await new ObjectConversationService(state.pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(state.pool,identity,inspect,{allowedTools:[],groupContext:(db,owner,task,role)=>readRunGroupContext(db,owner,task,role,f.ports,state.pool)})
 const run=await runs.prepare(f.owner,{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'default-agent')
 assert.deepEqual(run.groupContext?.workResources,fixed.workResources)
 assert.equal(JSON.parse(run.inputText).groupContext.workResources[0].sourceVersion,f.saved.version.contentHash)
 await runs.withdraw(f.owner,{runId:run.id})
 await assert.rejects(context({readAttachmentBytes:async()=>new Uint8Array()}),{code:'teloa/dependency-unavailable'})
 const path=join(root,'workspaces/default/knowledge',f.saved.item.id,'versions',f.saved.version.contentHash+'.md')
 await writeFile(path,'# 损坏原件\n');await assert.rejects(context(),{code:'teloa/storage-corrupt'});await writeFile(path,f.saved.version.markdown)
 await f.resources.withdraw(f.user,{resourceId:f.resource.id,expectedVersion:1})
 assert.equal((await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.role.id})).status,'invalidated')
 await assert.rejects(context(),{code:'teloa/resource-withdrawn'})
 assert.equal((await f.knowledge.readVersion(f.user,{knowledgeId:f.saved.item.id,version:1})).markdown,f.saved.version.markdown)
})
