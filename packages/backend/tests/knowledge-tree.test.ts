import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeResources} from '../src/capabilities/schema.ts'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import type {ResourceActor} from '../src/capabilities/resources.ts'

let container:StartedPostgreSqlContainer,pool:Pool,contentRoot:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool)
 contentRoot=await mkdtemp(join(tmpdir(),'teloa-tree-test-'))
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(contentRoot)await rm(contentRoot,{recursive:true,force:true})})

const now='2026-09-12T10:00:00.000Z'
const actor=():ResourceActor=>({ownerId:randomUUID(),kind:'human',scopeIds:['general']})
const identities=()=>({id:randomUUID,now:()=>now})

test('旧知识初始化后平滑落入默认知识空间根目录',async()=>{
 const user=actor(),knowledgeId=randomUUID(),sourceId=randomUUID(),requestId=randomUUID(),contentHash='a'.repeat(64),markdownPath=`workspaces/default/knowledge/${knowledgeId}/versions/${contentHash}.md`
 await pool.query("insert into teloa_knowledge_sources values($1,$2,'paste',$3)",[sourceId,user.ownerId,now])
 await pool.query("insert into teloa_knowledge_items(id,owner_id,request_id,request_spec,source_id,workspace_id,title,category,topics,scope_ids,current_version,status,created_at,updated_at) values($1,$2,$3,'{}',$4,'default','旧手册','sop','[]','[\"general\"]',1,'active',$5,$5)",[knowledgeId,user.ownerId,requestId,sourceId,now])
 await pool.query('insert into teloa_knowledge_versions(owner_id,knowledge_id,source_id,number,content_hash,bytes,markdown_path,created_at) values($1,$2,$3,1,$4,8,$5,$6)',[user.ownerId,knowledgeId,sourceId,contentHash,markdownPath,now])
 const module=await import('../src/capabilities/knowledge-tree.ts').catch(()=>({})) as Record<string,unknown>
 assert.equal(typeof module.initializeKnowledgeTree,'function','必须提供知识目录初始化器')
 assert.equal(typeof module.KnowledgeTreeService,'function','必须提供知识目录服务')
 if(typeof module.initializeKnowledgeTree!=='function'||typeof module.KnowledgeTreeService!=='function')return
 await (module.initializeKnowledgeTree as (pool:Pool)=>Promise<void>)(pool)
 const Tree=module.KnowledgeTreeService as new(pool:Pool,workspaceId:string,identity:{id:()=>string;now:()=>string})=>{list(actor:ResourceActor,input:unknown):Promise<any>}
 const tree=await new Tree(pool,'default',identities()).list(user,{})
 assert.equal(tree.space.workspaceId,'default')
 assert.equal(tree.nodes[0].type,'space')
 assert.deepEqual(tree.nodes.slice(1).map((node:any)=>[node.type,node.title,node.knowledgeId,node.parentId]),[['page','旧手册',knowledgeId,tree.space.rootNodeId]])
 const versions=(await pool.query('select number,content_hash,markdown_path from teloa_knowledge_versions where owner_id=$1 and knowledge_id=$2',[user.ownerId,knowledgeId])).rows
 assert.deepEqual(versions,[{number:1,content_hash:contentHash,markdown_path:markdownPath}])
})

test('文件夹创建、页面落位、重命名与移动只修改目录修订',async()=>{
 const module=await import('../src/capabilities/knowledge-tree.ts').catch(()=>({})) as Record<string,unknown>
 const Tree=module.KnowledgeTreeService as new(pool:Pool,workspaceId:string,identity:{id:()=>string;now:()=>string})=>any
 assert.equal(typeof Tree,'function','必须提供知识目录服务')
 if(typeof Tree!=='function')return
 const user=actor(),identity=identities(),treeService=new Tree(pool,'default',identity),initial=await treeService.list(user,{})
 const folder=await treeService.createFolder(user,{requestId:randomUUID(),parentId:initial.space.rootNodeId,title:'运行手册',expectedDirectoryRevision:initial.space.directoryRevision})
 const knowledge=new MarkdownKnowledgeService(pool,contentRoot,'default',identity)
 const saved=await knowledge.createPaste(user,{requestId:randomUUID(),title:'发布流程',category:'sop',topics:[],scopeIds:['general'],markdown:'# 发布流程\n',parentId:folder.node.id,expectedDirectoryRevision:folder.space.directoryRevision})
 const placed=await treeService.list(user,{})
 const page=placed.nodes.find((node:any)=>node.knowledgeId===saved.item.id)
 assert.deepEqual(page.path,[placed.space.rootNodeId,folder.node.id,page.id])
 const renamed=await treeService.renameNode(user,{requestId:randomUUID(),nodeId:page.id,title:'生产发布流程',expectedDirectoryRevision:placed.space.directoryRevision})
 const moved=await treeService.moveNode(user,{requestId:randomUUID(),nodeId:page.id,parentId:placed.space.rootNodeId,position:0,expectedDirectoryRevision:renamed.space.directoryRevision})
 assert.equal(moved.node.title,'生产发布流程')
 assert.deepEqual(moved.node.path,[placed.space.rootNodeId,page.id])
 assert.equal((await knowledge.listVersions(user,{knowledgeId:saved.item.id})).length,1)
})

test('目录写入执行 CAS、拒绝环和跨边界未知字段',async()=>{
 const module=await import('../src/capabilities/knowledge-tree.ts').catch(()=>({})) as Record<string,unknown>
 const Tree=module.KnowledgeTreeService as new(pool:Pool,workspaceId:string,identity:{id:()=>string;now:()=>string})=>any
 if(typeof Tree!=='function')return
 const user=actor(),treeService=new Tree(pool,'default',identities()),initial=await treeService.list(user,{})
 const parent=await treeService.createFolder(user,{requestId:randomUUID(),parentId:initial.space.rootNodeId,title:'父目录',expectedDirectoryRevision:initial.space.directoryRevision})
 const child=await treeService.createFolder(user,{requestId:randomUUID(),parentId:parent.node.id,title:'子目录',expectedDirectoryRevision:parent.space.directoryRevision})
 await assert.rejects(treeService.renameNode(user,{requestId:randomUUID(),nodeId:parent.node.id,title:'过期修改',expectedDirectoryRevision:initial.space.directoryRevision}),{code:'teloa/version-conflict'})
 await assert.rejects(treeService.moveNode(user,{requestId:randomUUID(),nodeId:parent.node.id,parentId:child.node.id,expectedDirectoryRevision:child.space.directoryRevision}),{code:'teloa/conflict'})
 await assert.rejects(treeService.createFolder(user,{requestId:randomUUID(),parentId:initial.space.rootNodeId,title:'越界',expectedDirectoryRevision:child.space.directoryRevision,ownerId:user.ownerId}),{code:'teloa/invalid-input'})
})

test('目录请求并发幂等、指定位置持久化且 Markdown 页面保持叶子',async()=>{
 const {KnowledgeTreeService}=await import('../src/capabilities/knowledge-tree.ts')
 const user=actor(),identity=identities(),firstService=new KnowledgeTreeService(pool,'default',identity),initial=await firstService.list(user,{}),requestId=randomUUID()
 const input={requestId,parentId:initial.space.rootNodeId,title:'后建目录',expectedDirectoryRevision:initial.space.directoryRevision}
 const [first,retry]=await Promise.all([firstService.createFolder(user,input),firstService.createFolder(user,input)])
 assert.deepEqual(retry,first)
 await assert.rejects(firstService.createFolder(user,{...input,title:'另一意图'}),{code:'teloa/conflict'})
 const before=await firstService.list(user,{}),front=await firstService.createFolder(user,{requestId:randomUUID(),parentId:before.space.rootNodeId,title:'置顶目录',position:0,expectedDirectoryRevision:before.space.directoryRevision})
 const knowledge=new MarkdownKnowledgeService(pool,contentRoot,'default',identity),page=await knowledge.createPaste(user,{requestId:randomUUID(),title:'父页面',category:'sop',topics:[],scopeIds:['general'],markdown:'# 父页面\n',parentId:front.node.id,expectedDirectoryRevision:front.space.directoryRevision})
 const withPage=await firstService.list(user,{}),pageNode=withPage.nodes.find(node=>node.type==='page'&&node.knowledgeId===page.item.id)!
 await assert.rejects(firstService.createFolder(user,{requestId:randomUUID(),parentId:pageNode.id,title:'页面下目录',expectedDirectoryRevision:withPage.space.directoryRevision}),{code:'teloa/conflict'})
 await assert.rejects(knowledge.createPaste(user,{requestId:randomUUID(),title:'页面下文档',category:'sop',topics:[],scopeIds:['general'],markdown:'# 页面下文档\n',parentId:pageNode.id,expectedDirectoryRevision:withPage.space.directoryRevision}),{code:'teloa/conflict'})
 await assert.rejects(firstService.moveNode(user,{requestId:randomUUID(),nodeId:first.node.id,parentId:pageNode.id,expectedDirectoryRevision:withPage.space.directoryRevision}),{code:'teloa/conflict'})
 const rebuilt=await new KnowledgeTreeService(pool,'default',identities()).list(user,{})
 assert.deepEqual(rebuilt.nodes.filter(node=>node.parentId===rebuilt.space.rootNodeId).map(node=>node.title),['置顶目录','后建目录'])
 assert.equal(rebuilt.nodes.some(node=>node.parentId===pageNode.id),false)
})

test('合法类型但断裂的持久路径显式报告存储损坏',async()=>{
 const {KnowledgeTreeService}=await import('../src/capabilities/knowledge-tree.ts')
 const user=actor(),treeService=new KnowledgeTreeService(pool,'default',identities()),initial=await treeService.list(user,{}),folder=await treeService.createFolder(user,{requestId:randomUUID(),parentId:initial.space.rootNodeId,title:'待破坏目录',expectedDirectoryRevision:initial.space.directoryRevision}),healthy=await treeService.createFolder(user,{requestId:randomUUID(),parentId:initial.space.rootNodeId,title:'另一目录',expectedDirectoryRevision:folder.space.directoryRevision})
 await pool.query('update teloa_knowledge_nodes set path=$3 where owner_id=$1 and id=$2',[user.ownerId,folder.node.id,JSON.stringify([folder.node.id])])
 await assert.rejects(treeService.list(user,{}),{code:'teloa/storage-corrupt'})
 await assert.rejects(treeService.renameNode(user,{requestId:randomUUID(),nodeId:healthy.node.id,title:'不能掩盖其他节点损坏',expectedDirectoryRevision:healthy.space.directoryRevision}),{code:'teloa/storage-corrupt'})
})
