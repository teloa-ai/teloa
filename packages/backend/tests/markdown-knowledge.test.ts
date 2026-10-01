import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,symlink,unlink,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {MarkdownKnowledgeService,initializeMarkdownKnowledge} from '../src/capabilities/markdown-knowledge.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import type {ResourceActor} from '../src/capabilities/resources.ts'

let container:StartedPostgreSqlContainer,pool:Pool,root:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool)
 root=await mkdtemp(join(tmpdir(),'teloa-knowledge-test-'))
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})

const actor=():ResourceActor=>({ownerId:randomUUID(),kind:'human',scopeIds:['general','design']})
const service=(workspaceId='default')=>new MarkdownKnowledgeService(pool,root,workspaceId,{id:randomUUID,now:()=>new Date('2026-09-12T10:00:00.000Z').toISOString()})
const fixedService=(ids:string[],workspaceId='default')=>new MarkdownKnowledgeService(pool,root,workspaceId,{id:()=>ids.shift()!,now:()=>new Date('2026-09-12T10:00:00.000Z').toISOString()})
const paste=(value:{requestId:string;title:string;scopeIds:string[];markdown:string})=>({...value,category:'sop' as const,topics:['排障']})

test('同一 requestId 并发创建只产生一份 paste 知识和不可变首版本',async()=>{
 const user=actor(),store=service(),requestId=randomUUID()
 const input=paste({requestId,title:'排障手册',scopeIds:['general'],markdown:'\ufeff# 排障手册\r\n\r\n先看日志。\r\n'})
 const [first,retry]=await Promise.all([store.createPaste(user,input),store.createPaste(user,input)])
 assert.deepEqual(retry,first)
 assert.equal(first.item.currentVersion,1)
 assert.equal(first.item.sourceType,'paste')
 assert.equal(first.item.category,'sop')
 assert.deepEqual(first.item.topics,['排障'])
 assert.equal(first.version.version,1)
 assert.equal(first.version.markdown,'# 排障手册\n\n先看日志。\n')
 assert.equal(first.version.contentHash,createHash('sha256').update('# 排障手册\n\n先看日志。\n','utf8').digest('hex'))
 const itemRow=(await pool.query('select category,topics,request_spec from teloa_knowledge_items where owner_id=$1',[user.ownerId])).rows[0]
 assert.equal(itemRow.category,'sop');assert.deepEqual(itemRow.topics,['排障']);assert.equal(itemRow.request_spec.category,'sop');assert.deepEqual(itemRow.request_spec.topics,['排障'])
 assert.equal((await pool.query('select count(*)::integer as count from teloa_knowledge_versions where owner_id=$1',[user.ownerId])).rows[0].count,1)
 const path=join(root,'workspaces','default','knowledge',first.item.id,'versions',first.version.contentHash+'.md')
 assert.equal(await readFile(path,'utf8'),first.version.markdown)
 await assert.rejects(store.createPaste(user,{...input,title:'另一份知识'}),{code:'teloa/conflict'})
 await assert.rejects(store.createPaste(user,{...input,category:'policy'}),{code:'teloa/conflict'})
 assert.equal(await readFile(path,'utf8'),first.version.markdown)
})

test('分类使用稳定代码，主题限制为零至二十个非空去重文本',async()=>{
 const user=actor(),store=service(),base=paste({requestId:randomUUID(),title:'分类边界',scopeIds:['general'],markdown:'# 分类边界\n'})
 await assert.rejects(store.createPaste(user,{...base,category:'scope'}),{code:'teloa/invalid-input'})
 await assert.rejects(store.createPaste(user,{...base,topics:['重复','重复']}),{code:'teloa/invalid-input'})
 await assert.rejects(store.createPaste(user,{...base,topics:Array.from({length:21},(_,index)=>String(index))}),{code:'teloa/invalid-input'})
 const saved=await store.createPaste(user,{...base,topics:[]})
 assert.equal(saved.item.category,'sop');assert.deepEqual(saved.item.topics,[])
})

test('旧知识表升级时回填分类与主题并安装默认值和约束',async()=>{
 const schema='legacy_'+randomUUID().replaceAll('-',''),legacy=new Pool({connectionString:container.getConnectionUri(),options:`-c search_path=${schema}`}),ownerId=randomUUID(),knowledgeId=randomUUID(),sourceId=randomUUID(),requestId=randomUUID(),now='2026-09-12T10:00:00.000Z'
 await pool.query(`create schema ${schema}`)
 try{
  await legacy.query(`
   create table teloa_knowledge_sources(id uuid not null,owner_id text not null,source_type text not null,created_at timestamptz not null,primary key(owner_id,id));
   create table teloa_knowledge_items(id uuid not null,owner_id text not null,request_id uuid not null,request_spec jsonb not null,source_id uuid not null,workspace_id text not null,title text not null,scope_ids jsonb not null,current_version integer not null,status text not null,created_at timestamptz not null,updated_at timestamptz not null,primary key(owner_id,id),unique(owner_id,request_id));
   create table teloa_knowledge_versions(owner_id text not null,knowledge_id uuid not null,source_id uuid not null,number integer not null,content_hash text not null,bytes integer not null,markdown_path text not null,created_at timestamptz not null,primary key(owner_id,knowledge_id,number));
  `)
  await legacy.query("insert into teloa_knowledge_sources values($1,$2,'paste',$3)",[sourceId,ownerId,now])
  await legacy.query("insert into teloa_knowledge_items values($1,$2,$3,'{}',$4,'default','旧知识','[\"general\"]',1,'active',$5,$5)",[knowledgeId,ownerId,requestId,sourceId,now])
  await initializeMarkdownKnowledge(legacy)
  const migrated=(await legacy.query('select category,topics from teloa_knowledge_items where owner_id=$1 and id=$2',[ownerId,knowledgeId])).rows[0]
  assert.equal(migrated.category,'reference');assert.deepEqual(migrated.topics,[])
  const defaulted=(await legacy.query("insert into teloa_knowledge_items(id,owner_id,request_id,request_spec,source_id,workspace_id,title,scope_ids,current_version,status,created_at,updated_at) values($1,$2,$3,'{}',$4,'default','默认分类','[]',1,'active',$5,$5) returning category,topics",[randomUUID(),ownerId,randomUUID(),sourceId,now])).rows[0]
  assert.equal(defaulted.category,'reference');assert.deepEqual(defaulted.topics,[])
  await assert.rejects(legacy.query("update teloa_knowledge_items set category='scope' where owner_id=$1 and id=$2",[ownerId,knowledgeId]),/check constraint/)
  await assert.rejects(legacy.query("update teloa_knowledge_items set topics='{}' where owner_id=$1 and id=$2",[ownerId,knowledgeId]),/check constraint/)
 }finally{await legacy.end();await pool.query(`drop schema ${schema} cascade`)}
})

test('旧记录的分类与主题请求快照升级后可用同一 requestId 恢复真实首版本',async()=>{
 const schema='legacy_retry_'+randomUUID().replaceAll('-',''),legacy=new Pool({connectionString:container.getConnectionUri(),options:`-c search_path=${schema}`}),ownerId=randomUUID(),knowledgeId=randomUUID(),sourceId=randomUUID(),requestId=randomUUID(),workspaceId='legacy-retry',title='旧值班手册',markdown='# 旧值班手册\n\n先核对告警来源。\n',contentHash=createHash('sha256').update(markdown).digest('hex'),relative=['workspaces',workspaceId,'knowledge',knowledgeId,'versions',contentHash+'.md'].join('/'),now='2026-09-12T10:00:00.000Z'
 await pool.query(`create schema ${schema}`)
 try{
  await legacy.query(`
   create table teloa_knowledge_sources(id uuid not null,owner_id text not null,source_type text not null,created_at timestamptz not null,primary key(owner_id,id));
   create table teloa_knowledge_items(id uuid not null,owner_id text not null,request_id uuid not null,request_spec jsonb not null,source_id uuid not null,workspace_id text not null,title text not null,scope_ids jsonb not null,current_version integer not null,status text not null,created_at timestamptz not null,updated_at timestamptz not null,primary key(owner_id,id),unique(owner_id,request_id));
   create table teloa_knowledge_versions(owner_id text not null,knowledge_id uuid not null,source_id uuid not null,number integer not null,content_hash text not null,bytes integer not null,markdown_path text not null,created_at timestamptz not null,primary key(owner_id,knowledge_id,number));
  `)
  const oldRequestSpec={workspaceId,title,scopeIds:['general'],contentHash}
  await legacy.query("insert into teloa_knowledge_sources values($1,$2,'paste',$3)",[sourceId,ownerId,now])
  await legacy.query("insert into teloa_knowledge_items values($1,$2,$3,$4,$5,$6,$7,'[\"general\"]',1,'active',$8,$8)",[knowledgeId,ownerId,requestId,JSON.stringify(oldRequestSpec),sourceId,workspaceId,title,now])
  await legacy.query('insert into teloa_knowledge_versions values($1,$2,$3,1,$4,$5,$6,$7)',[ownerId,knowledgeId,sourceId,contentHash,Buffer.byteLength(markdown),relative,now])
  await mkdir(join(root,...relative.split('/').slice(0,-1)),{recursive:true});await writeFile(join(root,relative),markdown)

  await initializeMarkdownKnowledge(legacy)
  const store=new MarkdownKnowledgeService(legacy,root,workspaceId,{id:randomUUID,now:()=>now}),user:ResourceActor={ownerId,kind:'human',scopeIds:['general']}
  const recovered=await store.createPaste(user,{requestId,title,category:'reference',topics:[],scopeIds:['general'],markdown})

  assert.equal(recovered.item.id,knowledgeId);assert.equal(recovered.version.markdown,markdown)
  const migrated=(await legacy.query('select request_spec from teloa_knowledge_items where owner_id=$1 and id=$2',[ownerId,knowledgeId])).rows[0].request_spec
  assert.deepEqual(migrated,{...oldRequestSpec,category:'reference',topics:[]})
 }finally{await legacy.end();await pool.query(`drop schema ${schema} cascade`)}
})

test('粘贴知识单份正文上限 2 MiB：恰好 2 MiB 保存并可读回，多一字节拒绝',async()=>{
 const user=actor(),store=service(),markdown='# 大'+'a'.repeat(2*1024*1024-Buffer.byteLength('# 大'))
 const saved=await store.createPaste(user,paste({requestId:randomUUID(),title:'大份资料',scopeIds:['general'],markdown}))
 assert.equal(saved.version.bytes,2*1024*1024)
 assert.equal((await store.readVersion(user,{knowledgeId:saved.item.id,version:1})).markdown,markdown)
 await assert.rejects(store.createPaste(user,paste({requestId:randomUUID(),title:'超限资料',scopeIds:['general'],markdown:markdown+'a'})),{code:'teloa/invalid-input'})
 await assert.rejects(store.revise(user,{requestId:randomUUID(),knowledgeId:saved.item.id,expectedVersion:1,markdown:markdown+'a'}),{code:'teloa/invalid-input'})
 const revised=await store.revise(user,{requestId:randomUUID(),knowledgeId:saved.item.id,expectedVersion:1,markdown:'# 改'+'b'.repeat(2*1024*1024-Buffer.byteLength('# 改'))})
 assert.equal(revised.version.version,2);assert.equal(revised.version.bytes,2*1024*1024)
})

test('旧库正文字节约束（128 KiB）启动时替换为 2 MiB，重复启动不再改动，已有数据不变',async()=>{
 const schema='legacy_bytes_'+randomUUID().replaceAll('-',''),legacy=new Pool({connectionString:container.getConnectionUri(),options:`-c search_path=${schema}`}),ownerId=randomUUID(),knowledgeId=randomUUID(),sourceId=randomUUID(),now='2026-09-12T10:00:00.000Z'
 const constraint=async()=>(await legacy.query("select oid,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='teloa_knowledge_versions'::regclass and conname='teloa_knowledge_versions_bytes_check'")).rows
 const version=(number:number,bytes:number)=>legacy.query('insert into teloa_knowledge_versions(owner_id,knowledge_id,source_id,number,content_hash,bytes,markdown_path,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[ownerId,knowledgeId,sourceId,number,createHash('sha256').update(String(number)).digest('hex'),bytes,'workspaces/default/knowledge/'+knowledgeId+'/versions/'+number+'.md',now])
 await pool.query(`create schema ${schema}`)
 try{
  await legacy.query(`
   create table teloa_knowledge_sources(id uuid not null,owner_id text not null,source_type text not null check(source_type='paste'),created_at timestamptz not null,primary key(owner_id,id));
   create table teloa_knowledge_items(id uuid not null,owner_id text not null,request_id uuid not null,request_spec jsonb not null,source_id uuid not null,workspace_id text not null,title text not null,scope_ids jsonb not null,current_version integer not null,status text not null,created_at timestamptz not null,updated_at timestamptz not null,primary key(owner_id,id),unique(owner_id,request_id),foreign key(owner_id,source_id) references teloa_knowledge_sources(owner_id,id));
   create table teloa_knowledge_versions(owner_id text not null,knowledge_id uuid not null,source_id uuid not null,number integer not null check(number>0),content_hash text not null,bytes integer not null check(bytes>0 and bytes<=131072),markdown_path text not null,created_at timestamptz not null,primary key(owner_id,knowledge_id,number),foreign key(owner_id,knowledge_id) references teloa_knowledge_items(owner_id,id));
  `)
  await legacy.query("insert into teloa_knowledge_sources values($1,$2,'paste',$3)",[sourceId,ownerId,now])
  await legacy.query("insert into teloa_knowledge_items values($1,$2,$3,'{}',$4,'default','旧知识','[\"general\"]',1,'active',$5,$5)",[knowledgeId,ownerId,randomUUID(),sourceId,now])
  await version(1,131072)
  await assert.rejects(version(2,131073),/check constraint/)
  const before=(await legacy.query('select * from teloa_knowledge_versions order by number')).rows
  await initializeMarkdownKnowledge(legacy)
  const [migrated]=await constraint()
  assert.match(migrated.definition,/bytes <= 2097152/)
  assert.deepEqual((await legacy.query('select * from teloa_knowledge_versions order by number')).rows,before)
  await initializeMarkdownKnowledge(legacy)
  assert.deepEqual(await constraint(),[migrated])
  await version(2,2*1024*1024)
  await assert.rejects(version(3,2*1024*1024+1),/check constraint/)
  await assert.rejects(version(3,0),/check constraint/)
  // 按上下限数值比对，不按字面：同义写法（条件顺序不同）视为已是目标，不再重建。
  await legacy.query('alter table teloa_knowledge_versions drop constraint teloa_knowledge_versions_bytes_check')
  await legacy.query('alter table teloa_knowledge_versions add constraint teloa_knowledge_versions_bytes_check check(bytes<=2097152 and bytes>0)')
  const [equivalent]=await constraint()
  assert.notEqual(equivalent.definition,migrated.definition)
  await initializeMarkdownKnowledge(legacy)
  assert.deepEqual(await constraint(),[equivalent])
 }finally{await legacy.end();await pool.query(`drop schema ${schema} cascade`)}
})

test('目录列出知识与固定版本元数据，读取必须指定版本号',async()=>{
 const user=actor(),store=service()
 const saved=await store.createPaste(user,paste({requestId:randomUUID(),title:'值班依据',scopeIds:['general'],markdown:'# 值班依据\n\n固定正文。\n'}))
 assert.deepEqual(await store.list(user,{}),[saved.item])
 const {markdown:_,...summary}=saved.version
 assert.deepEqual(await store.listVersions(user,{knowledgeId:saved.item.id}),[summary])
 assert.deepEqual(await store.readVersion(user,{knowledgeId:saved.item.id,version:1}),saved.version)
})

test('已提交的 Markdown 版本在数据库层拒绝原地更新和删除',async()=>{
 const user=actor(),store=service()
 const saved=await store.createPaste(user,paste({requestId:randomUUID(),title:'不可变依据',scopeIds:['general'],markdown:'# 不可变依据\n'}))
 await assert.rejects(pool.query('update teloa_knowledge_versions set content_hash=$3 where owner_id=$1 and knowledge_id=$2',[user.ownerId,saved.item.id,'0'.repeat(64)]),/knowledge versions are immutable/)
 await assert.rejects(pool.query('delete from teloa_knowledge_versions where owner_id=$1 and knowledge_id=$2',[user.ownerId,saved.item.id]),/knowledge versions are immutable/)
 assert.deepEqual(await store.readVersion(user,{knowledgeId:saved.item.id,version:1}),saved.version)
})

test('owner 与 scope 授权同时约束创建、目录和固定版本读取',async()=>{
 const user=actor(),store=service()
 const saved=await store.createPaste(user,paste({requestId:randomUUID(),title:'设计依据',scopeIds:['design'],markdown:'# 设计依据\n'}))
 const missingScope:ResourceActor={ownerId:user.ownerId,kind:'human',scopeIds:['general']}
 const otherOwner:ResourceActor={ownerId:randomUUID(),kind:'human',scopeIds:['general','design']}
 const agent:ResourceActor={ownerId:user.ownerId,kind:'agent',scopeIds:['general','design']}
 assert.deepEqual(await store.list(missingScope,{}),[])
 await assert.rejects(store.listVersions(missingScope,{knowledgeId:saved.item.id}),{code:'teloa/forbidden'})
 await assert.rejects(store.readVersion(otherOwner,{knowledgeId:saved.item.id,version:1}),{code:'teloa/forbidden'})
 await assert.rejects(store.createPaste(agent,paste({requestId:randomUUID(),title:'越权写入',scopeIds:['general'],markdown:'# 越权\n'})),{code:'teloa/forbidden'})
})

test('固定版本目录拒绝版本号断层，不用行数冒充连续历史',async()=>{
 const user=actor(),store=service()
 const saved=await store.createPaste(user,paste({requestId:randomUUID(),title:'断层测试',scopeIds:['general'],markdown:'# 第一版\n'}))
 const row=(await pool.query('select * from teloa_knowledge_versions where owner_id=$1 and knowledge_id=$2',[user.ownerId,saved.item.id])).rows[0]
 await pool.query('insert into teloa_knowledge_versions(owner_id,knowledge_id,source_id,number,content_hash,bytes,markdown_path,created_at) values($1,$2,$3,3,$4,$5,$6,$7)',[user.ownerId,saved.item.id,row.source_id,'b'.repeat(64),row.bytes,row.markdown_path,'2026-09-12T10:01:00.000Z'])
 await pool.query('update teloa_knowledge_items set current_version=2 where owner_id=$1 and id=$2',[user.ownerId,saved.item.id])
 await assert.rejects(store.listVersions(user,{knowledgeId:saved.item.id}),{code:'teloa/storage-corrupt'})
})

test('损坏的幂等请求规格按存储损坏报告，不伪装成用户输入错误',async()=>{
 const user=actor(),store=service(),input=paste({requestId:randomUUID(),title:'请求回执',scopeIds:['general'],markdown:'# 请求回执\n'})
 const saved=await store.createPaste(user,input)
 await pool.query("update teloa_knowledge_items set request_spec='{\"unexpected\":true}'::jsonb where owner_id=$1 and id=$2",[user.ownerId,saved.item.id])
 await assert.rejects(store.createPaste(user,input),{code:'teloa/storage-corrupt'})
})

test('幂等回执缺少不可变首版本时按存储损坏报告',async()=>{
 const user=actor(),store=service(),requestId=randomUUID(),knowledgeId=randomUUID(),sourceId=randomUUID(),markdown='# 缺失首版本\n',contentHash=createHash('sha256').update(markdown).digest('hex'),now='2026-09-12T10:00:00.000Z'
 const input=paste({requestId,title:'缺失首版本',scopeIds:['general'],markdown}),requestSpec={workspaceId:'default',title:'缺失首版本',category:'sop',topics:['排障'],scopeIds:['general'],contentHash}
 await pool.query("insert into teloa_knowledge_sources values($1,$2,'paste',$3)",[sourceId,user.ownerId,now])
 await pool.query("insert into teloa_knowledge_items(id,owner_id,request_id,request_spec,source_id,workspace_id,title,category,topics,scope_ids,current_version,status,created_at,updated_at) values($1,$2,$3,$4,$5,'default','缺失首版本','sop','[\"排障\"]','[\"general\"]',1,'active',$6,$6)",[knowledgeId,user.ownerId,requestId,JSON.stringify(requestSpec),sourceId,now])
 await assert.rejects(store.createPaste(user,input),{code:'teloa/storage-corrupt'})
})

test('知识目录拒绝指向不存在当前版本的目录头',async()=>{
 const user=actor(),store=service()
 const saved=await store.createPaste(user,paste({requestId:randomUUID(),title:'坏目录头',scopeIds:['general'],markdown:'# 第一版\n'}))
 await pool.query('update teloa_knowledge_items set current_version=2 where owner_id=$1 and id=$2',[user.ownerId,saved.item.id])
 await assert.rejects(store.list(user,{}),{code:'teloa/storage-corrupt'})
})

test('工作空间由服务绑定，客户端不能在创建或目录请求中选择',async()=>{
 const user=actor(),defaultStore=service(),otherStore=service('other')
 const current=await defaultStore.createPaste(user,paste({requestId:randomUUID(),title:'默认空间',scopeIds:['general'],markdown:'# 默认\n'}))
 const other=await otherStore.createPaste(user,paste({requestId:randomUUID(),title:'其他空间',scopeIds:['general'],markdown:'# 其他\n'}))
 assert.deepEqual(await defaultStore.list(user,{}),[current.item])
 assert.deepEqual(await otherStore.list(user,{}),[other.item])
 await assert.rejects(defaultStore.createPaste(user,{...paste({requestId:randomUUID(),title:'越界',scopeIds:['general'],markdown:'# 越界\n'}),workspaceId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(defaultStore.list(user,{workspaceId:'other'}),{code:'teloa/invalid-input'})
})

test('跨 owner 存在相同知识 UUID 时只读取 actor 自己的记录',async()=>{
 const first=actor(),second=actor(),knowledgeId=randomUUID(),sourceId=randomUUID(),input=paste({requestId:randomUUID(),title:'相同身份',scopeIds:['general'],markdown:'# 相同正文\n'})
 await fixedService([knowledgeId,sourceId,randomUUID()]).createPaste(first,input)
 const saved=await fixedService([knowledgeId,sourceId,randomUUID()]).createPaste(second,{...input,requestId:randomUUID()})
 assert.equal(saved.item.ownerId,second.ownerId)
 assert.equal((await service().readVersion(second,{knowledgeId,version:1})).ownerId,second.ownerId)
})

test('幂等重试先拒绝非规范 markdown_path，不用该路径驱动文件读取',async()=>{
 const user=actor(),store=service(),requestId=randomUUID(),knowledgeId=randomUUID(),sourceId=randomUUID(),markdown='# 固定路径\n',contentHash=createHash('sha256').update(markdown).digest('hex'),now='2026-09-12T10:00:00.000Z'
 const requestSpec={workspaceId:'default',title:'固定路径',category:'sop',topics:['排障'],scopeIds:['general'],contentHash}
 await pool.query("insert into teloa_knowledge_sources values($1,$2,'paste',$3)",[sourceId,user.ownerId,now])
 await pool.query("insert into teloa_knowledge_items(id,owner_id,request_id,request_spec,source_id,workspace_id,title,category,topics,scope_ids,current_version,status,created_at,updated_at) values($1,$2,$3,$4,$5,'default','固定路径','sop','[\"排障\"]','[\"general\"]',1,'active',$6,$6)",[knowledgeId,user.ownerId,requestId,JSON.stringify(requestSpec),sourceId,now])
 const wrong=['workspaces','default','knowledge',knowledgeId,'versions'].join('/')
 await mkdir(join(root,...wrong.split('/')),{recursive:true})
 await pool.query('insert into teloa_knowledge_versions values($1,$2,$3,1,$4,$5,$6,$7)',[user.ownerId,knowledgeId,sourceId,contentHash,Buffer.byteLength(markdown),wrong,now])
 await assert.rejects(store.createPaste(user,paste({requestId,title:'固定路径',scopeIds:['general'],markdown})),{code:'teloa/storage-corrupt'})
})

test('固定版本读取拒绝符号链接，即使链接目标正文和摘要相同',async()=>{
 const user=actor(),store=service(),saved=await store.createPaste(user,paste({requestId:randomUUID(),title:'链接测试',scopeIds:['general'],markdown:'# 链接测试\n'}))
 const path=join(root,'workspaces','default','knowledge',saved.item.id,'versions',saved.version.contentHash+'.md'),outside=join(root,'outside.md')
 await writeFile(outside,saved.version.markdown)
 await unlink(path);await symlink(outside,path)
 await assert.rejects(store.readVersion(user,{knowledgeId:saved.item.id,version:1}),{code:'teloa/storage-corrupt'})
})

test('目录和版本查询的数据库基础设施错误统一报告 storage-unavailable',async()=>{
 const failure=Error('database offline'),client={query:async(sql:unknown)=>{if(sql==='rollback')return {rows:[]};throw failure},release(){}},broken={query:async()=>{throw failure},connect:async()=>client} as unknown as Pool
 const store=new MarkdownKnowledgeService(broken,root,'default',{id:randomUUID,now:()=>new Date().toISOString()}),user=actor(),id=randomUUID()
 await assert.rejects(store.list(user,{}),{code:'teloa/storage-unavailable'})
 await assert.rejects(store.listVersions(user,{knowledgeId:id}),{code:'teloa/storage-unavailable'})
 await assert.rejects(store.readVersion(user,{knowledgeId:id,version:1}),{code:'teloa/storage-unavailable'})
})

test('内容目录无法创建时报告 storage-unavailable 且数据库不留目录记录',async()=>{
 const user=actor(),blocked=join(root,'blocked-'+randomUUID())
 await writeFile(blocked,'不是目录')
 const store=new MarkdownKnowledgeService(pool,blocked,'default',{id:randomUUID,now:()=>new Date().toISOString()}),requestId=randomUUID()
 await assert.rejects(store.createPaste(user,paste({requestId,title:'无法落盘',scopeIds:['general'],markdown:'# 无法落盘\n'})),{code:'teloa/storage-unavailable'})
 assert.equal((await pool.query('select count(*)::integer as count from teloa_knowledge_items where owner_id=$1 and request_id=$2',[user.ownerId,requestId])).rows[0].count,0)
})

test('文件发布后数据库在 commit 前明确失败会清理本次文件和事务记录',async()=>{
 const user=actor(),knowledgeId=randomUUID(),sourceId=randomUUID(),markdown='# 提交前失败\n',contentHash=createHash('sha256').update(markdown).digest('hex'),path=join(root,'workspaces','default','knowledge',knowledgeId,'versions',contentHash+'.md')
 const store=fixedService([knowledgeId,sourceId,randomUUID()]),input=paste({requestId:randomUUID(),title:'提交前失败',scopeIds:['general'],markdown})
 await pool.query(`create function reject_knowledge_version_${knowledgeId.replaceAll('-','_')}() returns trigger language plpgsql as $$ begin if new.owner_id='${user.ownerId}' then raise exception 'known precommit failure';end if;return new;end $$;create trigger reject_knowledge_version_${knowledgeId.replaceAll('-','_')} before insert on teloa_knowledge_versions for each row execute function reject_knowledge_version_${knowledgeId.replaceAll('-','_')}()`)
 try{
  await assert.rejects(store.createPaste(user,input),{code:'teloa/storage-unavailable'})
  await assert.rejects(readFile(path),{code:'ENOENT'})
  assert.equal((await pool.query('select count(*)::integer as count from teloa_knowledge_items where owner_id=$1',[user.ownerId])).rows[0].count,0)
 }finally{await pool.query(`drop trigger reject_knowledge_version_${knowledgeId.replaceAll('-','_')} on teloa_knowledge_versions;drop function reject_knowledge_version_${knowledgeId.replaceAll('-','_')}()`)}
})

test('commit 已执行但回包丢失时保留文件，由同 requestId 恢复既有版本',async()=>{
 const user=actor(),knowledgeId=randomUUID(),sourceId=randomUUID(),markdown='# 未知提交\n',contentHash=createHash('sha256').update(markdown).digest('hex'),path=join(root,'workspaces','default','knowledge',knowledgeId,'versions',contentHash+'.md'),input=paste({requestId:randomUUID(),title:'未知提交',scopeIds:['general'],markdown})
 let lose=true
 const lossy={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();return new Proxy(db,{get(target,key){if(key==='query')return async(sql:unknown,...args:unknown[])=>{const result=await (target.query as (...values:unknown[])=>Promise<unknown>).call(target,sql,...args);if(lose&&typeof sql==='string'&&sql.toLowerCase()==='commit'){lose=false;throw Error('lost commit reply')}return result};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}} as unknown as Pool
 const ids=[knowledgeId,sourceId,randomUUID()],uncertain=new MarkdownKnowledgeService(lossy,root,'default',{id:()=>ids.shift()!,now:()=>new Date('2026-09-12T10:00:00.000Z').toISOString()})
 await assert.rejects(uncertain.createPaste(user,input),{code:'teloa/storage-unavailable'})
 assert.equal(await readFile(path,'utf8'),markdown)
 assert.equal((await pool.query('select count(*)::integer as count from teloa_knowledge_items where owner_id=$1 and request_id=$2',[user.ownerId,input.requestId])).rows[0].count,1)
 const recovered=await service().createPaste(user,input)
 assert.equal(recovered.item.id,knowledgeId)
 assert.equal(recovered.version.contentHash,contentHash)
})

test('首次发布拒绝占据规范路径的符号链接，不提交指向仓外的版本',async()=>{
 const user=actor(),knowledgeId=randomUUID(),sourceId=randomUUID(),markdown='# 预占链接\n',contentHash=createHash('sha256').update(markdown).digest('hex'),path=join(root,'workspaces','default','knowledge',knowledgeId,'versions',contentHash+'.md'),outside=join(root,'outside-publish-'+randomUUID()+'.md')
 await mkdir(join(root,'workspaces','default','knowledge',knowledgeId,'versions'),{recursive:true});await writeFile(outside,markdown);await symlink(outside,path)
 const store=fixedService([knowledgeId,sourceId,randomUUID()])
 await assert.rejects(store.createPaste(user,paste({requestId:randomUUID(),title:'预占链接',scopeIds:['general'],markdown})),{code:'teloa/storage-corrupt'})
 assert.equal((await pool.query('select count(*)::integer as count from teloa_knowledge_items where owner_id=$1',[user.ownerId])).rows[0].count,0)
})

test('逐级拒绝 workspace、knowledge 与 versions 祖先符号链接，不向仓外发布',async()=>{
 for(const layer of ['workspace','knowledge','versions'] as const){
  const user=actor(),knowledgeId=randomUUID(),sourceId=randomUUID(),markdown=`# ${layer}\n`,contentHash=createHash('sha256').update(markdown).digest('hex'),caseRoot=await mkdtemp(join(tmpdir(),`teloa-${layer}-`)),outside=await mkdtemp(join(tmpdir(),`teloa-outside-${layer}-`)),target=join(outside,contentHash+'.md')
  try{
   if(layer==='workspace'){await mkdir(join(caseRoot,'workspaces'),{recursive:true});await symlink(outside,join(caseRoot,'workspaces','default'))}
   if(layer==='knowledge'){await mkdir(join(caseRoot,'workspaces','default'),{recursive:true});await symlink(outside,join(caseRoot,'workspaces','default','knowledge'))}
   if(layer==='versions'){await mkdir(join(caseRoot,'workspaces','default','knowledge',knowledgeId),{recursive:true});await symlink(outside,join(caseRoot,'workspaces','default','knowledge',knowledgeId,'versions'))}
   const ids=[knowledgeId,sourceId,randomUUID()],store=new MarkdownKnowledgeService(pool,caseRoot,'default',{id:()=>ids.shift()!,now:()=>new Date('2026-09-12T10:00:00.000Z').toISOString()})
   await assert.rejects(store.createPaste(user,paste({requestId:randomUUID(),title:'祖先链接',scopeIds:['general'],markdown})),{code:'teloa/storage-corrupt'})
   await assert.rejects(readFile(target),{code:'ENOENT'})
  }finally{await rm(caseRoot,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
 }
})

test('临时文件后缀必须是可信 UUID',async()=>{
 const user=actor(),knowledgeId=randomUUID(),sourceId=randomUUID(),ids=[knowledgeId,sourceId,'../escape'],store=new MarkdownKnowledgeService(pool,root,'default',{id:()=>ids.shift()!,now:()=>new Date('2026-09-12T10:00:00.000Z').toISOString()})
 await assert.rejects(store.createPaste(user,paste({requestId:randomUUID(),title:'坏临时后缀',scopeIds:['general'],markdown:'# 后缀\n'})),{code:'teloa/storage-corrupt'})
 assert.equal((await pool.query('select count(*)::integer as count from teloa_knowledge_items where owner_id=$1',[user.ownerId])).rows[0].count,0)
})

test('revise 以 CAS 追加不可变版本，并发同一请求只生成一个版本',async()=>{
 const user=actor(),store=service(),created=await store.createPaste(user,paste({requestId:randomUUID(),title:'编辑手册',scopeIds:['general'],markdown:'# 第一版\n'}))
 const revise=Reflect.get(store,'revise')
 assert.equal(typeof revise,'function','MarkdownKnowledgeService 必须提供 revise')
 if(typeof revise!=='function')return
 const requestId=randomUUID(),input={requestId,knowledgeId:created.item.id,expectedVersion:1,markdown:'# 第二版\n'}
 const [first,retry]=await Promise.all([revise.call(store,user,input),revise.call(store,user,input)])
 assert.deepEqual(retry,first)
 assert.equal(first.item.currentVersion,2);assert.equal(first.version.version,2);assert.equal(first.version.markdown,'# 第二版\n')
 assert.equal((await store.readVersion(user,{knowledgeId:created.item.id,version:1})).markdown,'# 第一版\n')
 assert.equal((await store.readVersion(user,{knowledgeId:created.item.id,version:2})).markdown,'# 第二版\n')
 await assert.rejects(revise.call(store,user,{...input,markdown:'# 伪造重试\n'}),{code:'teloa/conflict'})
 await assert.rejects(revise.call(store,user,{...input,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 assert.equal((await store.listVersions(user,{knowledgeId:created.item.id})).length,2)
})

test('revise 的 commit 已执行但回包丢失时，同一 requestId 恢复已提交新版本',async()=>{
 const user=actor(),created=await service().createPaste(user,paste({requestId:randomUUID(),title:'编辑回包恢复',scopeIds:['general'],markdown:'# 第一版\n'})),input={requestId:randomUUID(),knowledgeId:created.item.id,expectedVersion:1,markdown:'# 第二版\n'}
 let lose=true
 const lossy={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();return new Proxy(db,{get(target,key){if(key==='query')return async(sql:unknown,...args:unknown[])=>{const result=await (target.query as (...values:unknown[])=>Promise<unknown>).call(target,sql,...args);if(lose&&typeof sql==='string'&&sql.toLowerCase()==='commit'){lose=false;throw Error('lost commit reply')}return result};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}} as unknown as Pool
 const uncertain=new MarkdownKnowledgeService(lossy,root,'default',{id:randomUUID,now:()=>new Date('2026-09-12T10:00:00.000Z').toISOString()})
 await assert.rejects(uncertain.revise(user,input),{code:'teloa/storage-unavailable'})
 const recovered=await service().revise(user,input)
 assert.equal(recovered.item.currentVersion,2);assert.equal(recovered.version.markdown,'# 第二版\n')
 assert.equal((await service().listVersions(user,{knowledgeId:created.item.id})).length,2)
})

test('损坏的版本追加操作回执按存储损坏失败',async()=>{
 const user=actor(),store=service(),created=await store.createPaste(user,paste({requestId:randomUUID(),title:'损坏编辑回执',scopeIds:['general'],markdown:'# 第一版\n'})),input={requestId:randomUUID(),knowledgeId:created.item.id,expectedVersion:1,markdown:'# 第二版\n'}
 await store.revise(user,input)
 await pool.query('alter table teloa_knowledge_revision_requests disable trigger teloa_knowledge_revision_requests_immutable')
 try{
  await pool.query(`update teloa_knowledge_revision_requests set result=result||'{"extra":true}'::jsonb where owner_id=$1 and request_id=$2`,[user.ownerId,input.requestId])
 }finally{await pool.query('alter table teloa_knowledge_revision_requests enable trigger teloa_knowledge_revision_requests_immutable')}
 await assert.rejects(store.revise(user,input),{code:'teloa/storage-corrupt'})
})

test('restore 复制指定历史正文为新版本，不回拨或覆盖历史版本',async()=>{
 const user=actor(),store=service(),created=await store.createPaste(user,paste({requestId:randomUUID(),title:'恢复手册',scopeIds:['general'],markdown:'# 第一版\n'})),revise=Reflect.get(store,'revise'),restore=Reflect.get(store,'restore')
 assert.equal(typeof revise,'function');assert.equal(typeof restore,'function','MarkdownKnowledgeService 必须提供 restore')
 if(typeof revise!=='function'||typeof restore!=='function')return
 await revise.call(store,user,{requestId:randomUUID(),knowledgeId:created.item.id,expectedVersion:1,markdown:'# 第二版\n'})
 const requestId=randomUUID(),restored=await restore.call(store,user,{requestId,knowledgeId:created.item.id,version:1,expectedVersion:2}),retry=await restore.call(store,user,{requestId,knowledgeId:created.item.id,version:1,expectedVersion:2})
 assert.deepEqual(retry,restored)
 assert.equal(restored.item.currentVersion,3);assert.equal(restored.version.version,3);assert.equal(restored.version.markdown,'# 第一版\n')
 assert.deepEqual((await store.listVersions(user,{knowledgeId:created.item.id})).map(row=>[row.version,row.contentHash]),[[1,created.version.contentHash],[2,createHash('sha256').update('# 第二版\n').digest('hex')],[3,created.version.contentHash]])
 assert.equal((await store.readVersion(user,{knowledgeId:created.item.id,version:2})).markdown,'# 第二版\n')
 await assert.rejects(restore.call(store,user,{requestId:randomUUID(),knowledgeId:created.item.id,version:99,expectedVersion:3}),{code:'teloa/not-found'})
})

test('版本追加固定 owner、workspace、scope 和 human 写权限，拒绝未知字段',async()=>{
 const user=actor(),store=service(),created=await store.createPaste(user,paste({requestId:randomUUID(),title:'授权手册',scopeIds:['design'],markdown:'# 第一版\n'})),revise=Reflect.get(store,'revise'),restore=Reflect.get(store,'restore')
 assert.equal(typeof revise,'function');assert.equal(typeof restore,'function')
 if(typeof revise!=='function'||typeof restore!=='function')return
 const missingScope:ResourceActor={ownerId:user.ownerId,kind:'human',scopeIds:['general']},agent:ResourceActor={ownerId:user.ownerId,kind:'agent',scopeIds:['general','design']},input={requestId:randomUUID(),knowledgeId:created.item.id,expectedVersion:1,markdown:'# 第二版\n'}
 await assert.rejects(revise.call(store,missingScope,input),{code:'teloa/forbidden'})
 await assert.rejects(revise.call(store,agent,input),{code:'teloa/forbidden'})
 await assert.rejects(revise.call(store,user,{...input,ownerId:user.ownerId}),{code:'teloa/invalid-input'})
 await assert.rejects(restore.call(store,user,{requestId:randomUUID(),knowledgeId:created.item.id,version:1,expectedVersion:1,workspaceId:'other'}),{code:'teloa/invalid-input'})
 assert.equal((await store.listVersions(user,{knowledgeId:created.item.id})).length,1)
})
