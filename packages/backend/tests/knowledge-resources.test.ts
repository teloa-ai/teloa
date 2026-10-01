import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as backend from '../src/index.ts'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import {MarkdownKnowledgeCatalog,markdownKnowledgeReferenceId} from '../src/capabilities/markdown-knowledge-catalog.ts'
import {ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {isKnowledgeResourceRevision} from '@teloa/contract'

type RevisionService={
 revise(actor:ResourceActor,input:unknown):Promise<unknown>
 restore(actor:ResourceActor,input:unknown):Promise<unknown>
}
type RevisionConstructor=new(pool:Pool,knowledge:MarkdownKnowledgeService,resources:ResourceService)=>RevisionService

let container:StartedPostgreSqlContainer,pool:Pool,root:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool)
 root=await mkdtemp(join(tmpdir(),'teloa-knowledge-resources-'))
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})

const actor=():ResourceActor=>({ownerId:randomUUID(),kind:'human',scopeIds:['general']})
const identity=(ids?:string[])=>{
 let tick=0
 return {id:()=>ids?.shift()??randomUUID(),now:()=>new Date(Date.parse('2026-09-12T10:00:00.000Z')+tick++*1000).toISOString()}
}
async function fixture(ids?:string[]){
 const user=actor(),idsource=identity(ids),knowledge=new MarkdownKnowledgeService(pool,root,'default',idsource),catalog=new MarkdownKnowledgeCatalog(knowledge),resources=new ResourceService(pool,catalog,idsource)
 const saved=await knowledge.createPaste(user,{requestId:randomUUID(),title:'发布规范',category:'sop',topics:['发布'],scopeIds:['general'],markdown:'# 第一版\n'})
 const draft=await resources.create(user,{requestId:randomUUID(),title:saved.item.title,sourceId:markdownKnowledgeReferenceId(saved.item.id),sourceVersion:saved.version.contentHash,scopeIds:saved.item.scopeIds})
 const resource=await resources.apply(user,{draftId:draft.id,expectedVersion:draft.version})
 const Constructor=Reflect.get(backend,'KnowledgeResourceService') as RevisionConstructor|undefined
 assert.equal(typeof Constructor,'function','后端必须提供知识版本与可引用资源一体化修订服务')
 return {user,knowledge,resources,saved,resource,revisions:Constructor?new Constructor(pool,knowledge,resources):undefined}
}

test('修订与恢复在一个命令内切换唯一活动 WorkResource，并保留旧引用版本',async()=>{
 const value=await fixture();if(!value.revisions)return
 const requestId=randomUUID(),input={requestId,knowledgeId:value.saved.item.id,expectedKnowledgeVersion:1,resourceId:value.resource.id,expectedResourceVersion:1,markdown:'# 第二版\n'}
 const first=await value.revisions.revise(value.user,input)
 assert.equal(isKnowledgeResourceRevision(first),true)
 if(!isKnowledgeResourceRevision(first))return
 assert.equal(first.knowledge.item.currentVersion,2)
 assert.equal(first.knowledge.version.markdown,'# 第二版\n')
 assert.notEqual(first.resource.id,value.resource.id)
 assert.equal(first.resource.sourceVersion,first.knowledge.version.contentHash)
 const retry=await value.revisions.revise(value.user,input)
 assert.deepEqual(retry,first,'回包丢失后沿用 requestId 必须恢复同一知识版本和资源身份')
 const rows=(await pool.query('select id,status,revision,spec from teloa_resources where owner_id=$1 order by created_at,id',[value.user.ownerId])).rows
 assert.equal(rows.filter(row=>row.status==='active').length,1)
 assert.equal(rows.find(row=>row.id===value.resource.id)?.status,'withdrawn')
 assert.equal(rows.find(row=>row.id===value.resource.id)?.revision,2)
 assert.equal((await pool.query('select count(*)::int as count from teloa_knowledge_versions where owner_id=$1 and knowledge_id=$2',[value.user.ownerId,value.saved.item.id])).rows[0].count,2)
 await assert.rejects(value.revisions.revise(value.user,{...input,markdown:'# 另一意图\n'}),{code:'teloa/conflict'})

 const restored=await value.revisions.restore(value.user,{requestId:randomUUID(),knowledgeId:value.saved.item.id,expectedKnowledgeVersion:2,resourceId:first.resource.id,expectedResourceVersion:1,restoreVersion:1})
 assert.equal(isKnowledgeResourceRevision(restored),true)
 if(!isKnowledgeResourceRevision(restored))return
 assert.equal(restored.knowledge.item.currentVersion,3)
 assert.equal(restored.knowledge.version.markdown,'# 第一版\n')
 assert.equal((await pool.query("select count(*)::int as count from teloa_resources where owner_id=$1 and status='active'",[value.user.ownerId])).rows[0].count,1)
})

test('知识和资源任一 CAS 失败都不发布新版本，旧资源持续 active',async()=>{
 const value=await fixture();if(!value.revisions)return
 await assert.rejects(value.revisions.revise(value.user,{requestId:randomUUID(),knowledgeId:value.saved.item.id,expectedKnowledgeVersion:1,resourceId:value.resource.id,expectedResourceVersion:2,markdown:'# 不应发布\n'}),{code:'teloa/version-conflict'})
 assert.equal((await value.knowledge.listVersions(value.user,{knowledgeId:value.saved.item.id})).length,1)
 assert.equal((await value.resources.getResource(value.user,{resourceId:value.resource.id})).status,'active')
 const [left,right]=await Promise.allSettled([
  value.revisions.revise(value.user,{requestId:randomUUID(),knowledgeId:value.saved.item.id,expectedKnowledgeVersion:1,resourceId:value.resource.id,expectedResourceVersion:1,markdown:'# 并发 A\n'}),
  value.revisions.revise(value.user,{requestId:randomUUID(),knowledgeId:value.saved.item.id,expectedKnowledgeVersion:1,resourceId:value.resource.id,expectedResourceVersion:1,markdown:'# 并发 B\n'}),
 ])
 assert.equal([left,right].filter(result=>result.status==='fulfilled').length,1)
 assert.equal((left.status==='rejected'?left:right).status,'rejected')
 assert.equal(((left.status==='rejected'?left:right) as PromiseRejectedResult).reason.code,'teloa/version-conflict')
 assert.equal((await pool.query("select count(*)::int as count from teloa_resources where owner_id=$1 and status='active'",[value.user.ownerId])).rows[0].count,1)
})

test('事务已提交但 RPC 回包丢失时，同一 requestId 恢复原知识版本和资源身份',async()=>{
 const value=await fixture(),input={requestId:randomUUID(),knowledgeId:value.saved.item.id,expectedKnowledgeVersion:1,resourceId:value.resource.id,expectedResourceVersion:1,markdown:'# 未知提交结果\n'}
 let lose=true
 const lossy={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){if(key==='query')return async(sql:unknown,...args:unknown[])=>{const result=await (target.query as (...values:unknown[])=>Promise<unknown>).call(target,sql,...args);if(lose&&typeof sql==='string'&&sql.toLowerCase()==='commit'){lose=false;throw Error('lost commit reply')}return result};const member=Reflect.get(target,key,target);return typeof member==='function'?member.bind(target):member}})}} as unknown as Pool
 const ids=identity(),knowledge=new MarkdownKnowledgeService(lossy,root,'default',ids),resources=new ResourceService(lossy,new MarkdownKnowledgeCatalog(knowledge),ids),revisions=new (backend.KnowledgeResourceService as RevisionConstructor)(lossy,knowledge,resources)
 await assert.rejects(revisions.revise(value.user,input),{code:'teloa/storage-unavailable'})
 const recovered=await revisions.revise(value.user,input)
 assert.equal(isKnowledgeResourceRevision(recovered),true)
 if(!isKnowledgeResourceRevision(recovered))return
 assert.equal(recovered.knowledge.item.currentVersion,2)
 assert.equal(recovered.resource.status,'active')
 assert.equal((await pool.query('select count(*)::int as count from teloa_knowledge_resource_revisions where owner_id=$1 and request_id=$2',[value.user.ownerId,input.requestId])).rows[0].count,1)
 assert.equal((await pool.query("select count(*)::int as count from teloa_resources where owner_id=$1 and status='active'",[value.user.ownerId])).rows[0].count,1)
})

test('Markdown 文件已暂存但资源创建失败时回滚数据库并清理孤立版本文件',async()=>{
 const tempId=randomUUID(),value=await fixture([randomUUID(),randomUUID(),randomUUID(),randomUUID(),tempId,randomUUID(),'invalid-resource-id']);if(!value.revisions)return
 const markdown='# 回滚版本\n',hash=createHash('sha256').update(markdown).digest('hex'),path=join(root,'workspaces','default','knowledge',value.saved.item.id,'versions',hash+'.md')
 await assert.rejects(value.revisions.revise(value.user,{requestId:randomUUID(),knowledgeId:value.saved.item.id,expectedKnowledgeVersion:1,resourceId:value.resource.id,expectedResourceVersion:1,markdown}),{code:'teloa/storage-corrupt'})
 await assert.rejects(readFile(path),{code:'ENOENT'})
 assert.equal((await value.knowledge.listVersions(value.user,{knowledgeId:value.saved.item.id})).length,1)
 assert.equal((await value.resources.getResource(value.user,{resourceId:value.resource.id})).status,'active')
})
