import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {IndustryLoadService,initializeIndustryLoads,type IndustryLoadSource} from '../src/work/industry-loads.ts'
import {IndustryDataSourceService,initializeIndustryDataSources} from '../src/work/industry-data-sources.ts'
import {initializeIndustryRoles} from '../src/work/industry-roles.ts'
import {initializeRoles} from '../src/work/roles.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeIndustryLoads(pool)})
after(async()=>{await pool?.end();await container?.stop()})
const contentId=randomUUID(),contentHash='a'.repeat(64),snapshot={templateId:'security',templateVersion:'1.2.0',title:'安全工作',domain:'security',description:'安全行业工作模板',resources:[{localId:'role-soc',kind:'role' as const,title:'SOC 岗',version:'1.0.0',required:true,available:true},{localId:'optional-skill',kind:'skill' as const,title:'可选技能',version:'1.0.0',required:false,available:false},{localId:'work',kind:'work-template' as const,title:'告警核对',version:'1.0.0',required:true,available:true},{localId:'notes',kind:'knowledge' as const,title:'独立知识',version:'1.0.0',required:false,available:true}],relations:[{kind:'role-work',from:'role-soc',to:'work'},{kind:'role-skill',from:'role-soc',to:'optional-skill'}],entrypoints:['work','optional-skill']}
const source:IndustryLoadSource={read:async(owner,id,hash)=>{assert.ok(owner);assert.equal(id,contentId);assert.equal(hash,contentHash);return structuredClone(snapshot)}}
const command=(requestId=randomUUID(),spaceId=randomUUID())=>({requestId,contentId,contentHash,target:{kind:'new' as const,spaceId,name:'安全空间'}})

test('同请求并发、服务重建和不同请求只登记一份空间及稳定映射',async()=>{
 const owner=randomUUID(),requestId=randomUUID(),input=command(requestId),service=new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},source)
 const [a,b]=await Promise.all([service.create(owner,input),service.create(owner,input)])
 assert.deepEqual(a,b);assert.equal(a.space.scope,snapshot.domain);assert.equal(a.space.version,1);assert.equal(a.targetVersion,1)
 assert.deepEqual(Object.fromEntries(a.items.map(item=>[item.localId,item.status])),{notes:'pending-adapter','optional-skill':'skipped','role-soc':'pending-adapter',work:'pending-adapter'})
 const byId=new Map(a.items.map(item=>[item.localId,item]));assert.deepEqual(a.relations,[{kind:'role-work',from:byId.get('role-soc')!.instanceId,to:byId.get('work')!.instanceId},{kind:'role-skill',from:byId.get('role-soc')!.instanceId,to:byId.get('optional-skill')!.instanceId}]);assert.deepEqual(a.entrypoints,[byId.get('work')!.instanceId,byId.get('optional-skill')!.instanceId])
 assert.deepEqual(await new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},source).create(owner,input),a)
 const dedupRequest=randomUUID();assert.deepEqual(await service.create(owner,{...input,requestId:dedupRequest}),a)
 await assert.rejects(service.create(owner,{...input,requestId:dedupRequest,target:{...input.target,name:'改名'}}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_loads where owner_id=$1',[owner])).rows[0].count,1)
 await assert.rejects(service.create(owner,{...input,contentHash:'b'.repeat(64)}),{code:'teloa/conflict'})
 await assert.rejects(service.create(owner,{...input,requestId:randomUUID(),target:{...input.target,name:'另一个名字'}}),{code:'teloa/conflict'})
})

test('不同空间生成隔离映射，已有空间按版本加载并恢复目录',async()=>{
 const owner=randomUUID(),service=new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},source),firstInput=command(),a=await service.create(owner,firstInput),b=await service.create(owner,command())
 assert.notEqual(a.id,b.id);assert.equal(new Set([...a.items,...b.items].map(item=>item.instanceId)).size,8)
 const otherHash='c'.repeat(64),otherSource:IndustryLoadSource={read:async()=>({...snapshot,templateVersion:'1.3.0'})},existing=await new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},otherSource).create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:otherHash,target:{kind:'existing',spaceId:a.space.id,expectedVersion:1}})
 assert.equal(existing.space.version,2);assert.equal(existing.targetVersion,2);const old=await service.get(owner,{loadId:a.id});assert.equal(old.id,a.id);assert.equal(old.targetVersion,1);assert.equal(old.space.version,2);const retried=await service.create(owner,firstInput);assert.equal(retried.id,a.id);assert.equal(retried.targetVersion,1);assert.equal(retried.space.version,2);assert.equal((await service.list(owner,{})).items.length,3)
 await assert.rejects(service.create(owner,{requestId:randomUUID(),contentId,contentHash,target:{kind:'existing',spaceId:a.space.id,expectedVersion:1}}),{code:'teloa/version-conflict'})
 await assert.rejects(new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},otherSource).create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'d'.repeat(64),target:{kind:'existing',spaceId:a.space.id,expectedVersion:1}}),{code:'teloa/version-conflict'})
})

test('必需来源缺失不落库，坏映射和跨本人读取显式失败',async()=>{
 const owner=randomUUID(),badSource:IndustryLoadSource={read:async()=>({...snapshot,resources:snapshot.resources.map((item,index)=>index===0?{...item,available:false}:item)})},service=new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},badSource),input=command()
 await assert.rejects(service.create(owner,input),{code:'teloa/source-unavailable'});assert.equal((await pool.query('select count(*)::int count from teloa_industry_loads where owner_id=$1',[owner])).rows[0].count,0)
 const saved=await new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},source).create(owner,input)
 await assert.rejects(service.get('other',{loadId:saved.id}),{code:'teloa/forbidden'})
 const notes=saved.items.find(item=>item.localId==='notes')!;await pool.query("update teloa_industry_load_items set instance_id=$2 where load_id=$1 and local_id='notes'",[saved.id,randomUUID()]);await assert.rejects(service.get(owner,{loadId:saved.id}),{code:'teloa/storage-corrupt'});await pool.query("update teloa_industry_load_items set instance_id=$2 where load_id=$1 and local_id='notes'",[saved.id,notes.instanceId])
 await pool.query("update teloa_industry_load_items set status='skipped' where load_id=$1 and local_id='role-soc'",[saved.id])
 await assert.rejects(service.get(owner,{loadId:saved.id}),{code:'teloa/storage-corrupt'})
})

test('不同请求并发去重，空间已存在时 new 不能绕过版本闸',async()=>{
 const owner=randomUUID(),spaceId=randomUUID(),service=new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},source)
 const [a,b]=await Promise.all([service.create(owner,command(randomUUID(),spaceId)),service.create(owner,command(randomUUID(),spaceId))])
 assert.equal(a.id,b.id);assert.equal((await pool.query('select count(*)::int count from teloa_industry_load_requests where owner_id=$1',[owner])).rows[0].count,2)
 const otherSource:IndustryLoadSource={read:async()=>({...snapshot,templateVersion:'2.0.0'})}
 await assert.rejects(new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},otherSource).create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'e'.repeat(64),target:{kind:'new',spaceId,name:'安全空间'}}),{code:'teloa/conflict'})
})

test('丢失提交回包后按请求恢复，孤立映射删除和错误回执显式失败',async()=>{
 const owner=randomUUID(),input=command(),normal=new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},source);let dropped=false
 const lossy={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{if(args[0]==='commit'&&!dropped){dropped=true;await target.query('commit');throw new Error('response lost')}return (target.query as (...queryArgs:unknown[])=>unknown)(...args)};const value=(target as unknown as Record<PropertyKey,unknown>)[key];return typeof value==='function'?value.bind(target):value}})},query:pool.query.bind(pool)} as unknown as Pool
 await assert.rejects(new IndustryLoadService(lossy,{id:randomUUID,now:()=>new Date().toISOString()},source).create(owner,input),/response lost/)
 const recovered=await normal.create(owner,input);assert.equal(recovered.space.id,input.target.spaceId)
 await pool.query("delete from teloa_industry_load_items where load_id=$1 and local_id='notes'",[recovered.id]);await assert.rejects(normal.get(owner,{loadId:recovered.id}),{code:'teloa/storage-corrupt'})
 const other=await normal.create(owner,command());await pool.query('update teloa_industry_load_requests set load_id=$1 where owner_id=$2 and request_id=$3',[other.id,owner,input.requestId]);await assert.rejects(normal.create(owner,input),{code:'teloa/storage-corrupt'})
})

test('单连接池中需要数据库连接的来源读取不会被加载事务占满',async()=>{
 const single=new Pool({connectionString:container.getConnectionUri(),max:1}),owner=randomUUID(),input=command()
 try{
  const persistedSource:IndustryLoadSource={read:async()=>{await single.query('select 1');return structuredClone(snapshot)}}
  const saved=await new IndustryLoadService(single,{id:randomUUID,now:()=>new Date().toISOString()},persistedSource).create(owner,input)
  assert.equal(saved.contentHash,contentHash)
 }finally{await single.end()}
})

const projectionSnapshot={templateId:'security',templateVersion:'1.2.0',title:'安全工作',domain:'security',scope:'SOC',description:'安全行业工作模板',resources:[{localId:'alert-source',kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,available:true}],relations:[],entrypoints:[]}
const projectionSource:IndustryLoadSource={read:async()=>structuredClone(projectionSnapshot)}
const projectionReader=(loads:IndustryLoadService)=>({read:async(db:Parameters<IndustryLoadService['getInTransaction']>[0],owner:string,input:{loadId:string;itemInstanceId:string})=>{const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(row=>row.instanceId===input.itemInstanceId);assert.ok(item);return {loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition:{format:'teloa.data-source/v1' as const,sourceId:'security-alert-http',scopes:['SOC']}}}})

test('加载项状态按各实例表投影而不改写存储列',async()=>{
 await initializeIndustryDataSources(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,projectionSource)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'1'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'投影空间'}}),item=load.items[0]!
 assert.equal(load.domain,'security')
 assert.equal(load.scope,'SOC')
 assert.equal(load.space.scope,'SOC')
 assert.equal(item.status,'pending-adapter')
 const service=new IndustryDataSourceService(pool,identity,loads,projectionReader(loads),{ready:async()=>({ready:true as const,probedAt:'2026-09-14T00:00:00.000Z'})})
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item.instanceId})
 assert.equal((await loads.get(owner,{loadId:load.id})).items[0]!.status,'instantiated')
 await service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 assert.equal((await loads.get(owner,{loadId:load.id})).items[0]!.status,'active')
 assert.equal((await loads.list(owner,{})).items.find(row=>row.id===load.id)!.items[0]!.status,'active')
 assert.equal((await pool.query('select status from teloa_industry_load_items where instance_id=$1',[item.instanceId])).rows[0].status,'pending-adapter')
 assert.equal(await loads.storedItemStatus(pool,owner,item.instanceId),'pending-adapter')
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),await service.get(owner,{instanceId:created.id}))
})

test('已解除的岗位实例投影为 detached 且跳过项保持存储列',async()=>{
 await initializeRoles(pool);await initializeIndustryRoles(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const load=await loads.create(owner,command()),role=load.items.find(row=>row.kind==='role')!,skipped=load.items.find(row=>row.status==='skipped')!
 const roleId=randomUUID(),now=new Date().toISOString()
 await pool.query("insert into teloa_roles(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,'{}','{}',1,'retired',$4,$4)",[roleId,owner,randomUUID(),now])
 await pool.query(`insert into teloa_industry_role_instances(id,owner_id,load_id,item_instance_id,item_local_id,scope,definition,definition_hash,knowledge,omitted_knowledge,declarations,downstream_request_id,mapping_digest,role_id,phase,revision,failure_code,failure_message,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'{}',$7,'[]','[]','[]',$8,$7,$9,'prepared',1,null,null,$10,$10)`,[randomUUID(),owner,load.id,role.instanceId,role.localId,load.space.scope,'a'.repeat(64),randomUUID(),roleId,now])
 const projected=await loads.get(owner,{loadId:load.id})
 assert.equal(projected.items.find(row=>row.instanceId===role.instanceId)!.status,'detached')
 assert.equal(projected.items.find(row=>row.instanceId===skipped.instanceId)!.status,'skipped')
 assert.equal((await pool.query('select status from teloa_industry_load_items where instance_id=$1',[role.instanceId])).rows[0].status,'pending-adapter')
 await pool.query("update teloa_roles set state='paused' where id=$1",[roleId])
 assert.equal((await loads.get(owner,{loadId:load.id})).items.find(row=>row.instanceId===role.instanceId)!.status,'active')
 assert.equal(await loads.storedItemStatus(pool,owner,skipped.instanceId),'skipped')
})

test('业务定制声明资源类型作为待接入项加载，不携带沿用血缘',async()=>{
 const owner=randomUUID(),viewSource:IndustryLoadSource={read:async()=>({...snapshot,resources:[...snapshot.resources,{localId:'view-alerts',kind:'business-view' as const,title:'告警视图',version:'1.0.0',required:true,available:true}]})}
 const service=new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},viewSource)
 const load=await service.create(owner,command())
 const item=load.items.find(row=>row.localId==='view-alerts')!
 assert.equal(item.status,'pending-adapter')
 assert.equal(item.required,true)
 assert.equal(item.carriedFrom,undefined)
})

test('市场创建在空间锁之前等待整体配置锁，登记受管后拒绝写入',async()=>{
 const {lockBusinessConfiguration}=await import('../src/work/business-configuration-lock.ts')
 const {BusinessScopeService}=await import('../src/work/business-scopes.ts')
 const owner=randomUUID(),service=new IndustryLoadService(pool,{id:randomUUID,now:()=>new Date().toISOString()},source),input=command(),db=await pool.connect()
 await db.query('begin');await lockBusinessConfiguration(db,owner,snapshot.domain)
 const existingSpace=randomUUID()
 await db.query("insert into teloa_business_spaces(id,owner_id,name,description,version,created_at,updated_at) values($1,$2,'原空间','',1,now(),now())",[existingSpace,owner])
 await BusinessScopeService.ensure(db,owner,{scope:snapshot.domain,title:'本地业务',kind:'domain',spaceId:existingSpace})
 await db.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1',[owner])
 const pid=Number((await db.query('select pg_backend_pid() pid')).rows[0].pid)
 const pending=service.create(owner,input).then(value=>({value}),error=>({error}))
 try{
  let blocked=false;const deadline=Date.now()+5000
  while(Date.now()<deadline){
   if((await pool.query("select 1 from pg_stat_activity where wait_event='advisory' and $1=any(pg_blocking_pids(pid))",[pid])).rowCount){blocked=true;break}
   await new Promise<void>(resolve=>setImmediate(resolve))
  }
  assert.equal(blocked,true,'创建须在配置锁上等待，不能先取空间/范围行锁')
  await db.query('commit')
  const result=await pending
  assert.ok('error' in result);assert.equal(result.error.code,'teloa/conflict')
  assert.equal((await pool.query('select 1 from teloa_industry_loads where owner_id=$1',[owner])).rowCount,0)
  assert.equal((await pool.query('select 1 from teloa_business_spaces where owner_id=$1 and id=$2',[owner,input.target.spaceId])).rowCount,0)
 }finally{await db.query('rollback');db.release();await pending}
})
