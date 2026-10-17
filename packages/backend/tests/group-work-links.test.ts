import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {GroupWorkLinkService,initializeGroupWorkLinks} from '../src/work/group-work-links.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {ProjectService} from '../src/work/projects.ts'
import {TaskService} from '../src/work/tasks.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {readGroupWorkLinks,readGroupWorkLinkItem} from '@teloa/contract'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool);await initializeGroupWorkLinks(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),service=new GroupWorkLinkService(pool,identity),groups=new CollaborationService(pool,identity)
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'跨业务协作',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
 const project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'Quarterly delivery',goal:'Coordinate original work',dueDate:null,state:'planning',links:[],references:[]}})
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'Original task',goal:'Prepare results',scope:'general'}})
 const incident={scope:'SOC',type:'incident',id:'INC-207',version:1,title:'Credential investigation',source:'test-fixture',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'Investigate a synthetic case',fields:[{label:'status',value:'investigating'}]}
 await pool.query('insert into teloa_business_object_snapshots values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[owner,incident.scope,incident.type,incident.id,incident.version,businessObjectSnapshotHash(incident),JSON.stringify(incident),incident.source,incident.receivedAt])
 const links=[{kind:'project',scope:project.scope,id:project.id},{kind:'task',scope:task.scope,id:task.id},{kind:'business',scope:incident.scope,type:incident.type,id:incident.id}]
 const request={requestId:randomUUID(),groupId:group.id,expectedGroupVersion:group.version,expectedVersion:0,links}
 return {owner,service,groups,group,project,task,incident,links,request}
}
test('一个原群持久关联项目、任务与案件；重放不改对象、不复制会话、不扩大授权',async()=>{
 const f=await fixture(),[a,b]=await Promise.all([f.service.change(f.owner,f.request),f.service.change(f.owner,f.request)])
 assert.deepEqual(a,b);assert.equal(a.version,1);assert.equal(a.items.length,3)
 assert.equal((await new GroupWorkLinkService(pool,identity).get(f.owner,{groupId:f.group.id})).items.length,3)
 assert.equal((await f.groups.get(f.owner,{groupId:f.group.id})).group.version,1)
 assert.equal((await new TaskService(pool,identity).list(f.owner,{})).find(task=>task.id===f.task.id)!.version,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_object_conversations where owner_id=$1',[f.owner])).rows[0].n,0)
 assert.equal((await pool.query('select count(*)::int n from teloa_group_agent_grants where group_id=$1',[f.group.id])).rows[0].n,0)
 await f.service.change(f.owner,{...f.request,requestId:randomUUID(),expectedVersion:1,links:[]})
 assert.deepEqual(await f.service.change(f.owner,f.request),a,'迟到原请求仍返回原保存回执，而不是当前状态')
 await assert.rejects(f.service.change(f.owner,{...f.request,links:[]}),{code:'teloa/conflict'})
})
test('跨本人、范围伪装、不可用对象和过期群版本不能保存',async()=>{
 const f=await fixture(),other=await fixture()
 await assert.rejects(f.service.get(other.owner,{groupId:f.group.id}),{code:'teloa/not-found'})
 for(const link of [{kind:'project',scope:'general',id:other.project.id},{kind:'task',scope:'SOC',id:f.task.id},{kind:'business',scope:'SOC',type:'incident',id:'missing'}])await assert.rejects(f.service.change(f.owner,{...f.request,requestId:randomUUID(),links:[link]}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.change(f.owner,{...f.request,expectedGroupVersion:2}),{code:'teloa/version-conflict'})
 assert.equal((await f.service.get(f.owner,{groupId:f.group.id})).version,0)
 assert.equal((await f.service.candidates(f.owner,{groupId:f.group.id,scope:'general',kind:'project',query:'Quarterly'})).some(item=>item.id===other.project.id),false)
})
test('并发编辑只接受一个版本；取消关联不删除原件',async()=>{
 const f=await fixture(),saved=await f.service.change(f.owner,f.request)
 const results=await Promise.allSettled([[],[f.links[0]]].map(links=>f.service.change(f.owner,{...f.request,requestId:randomUUID(),expectedVersion:saved.version,links})))
 assert.equal(results.filter(row=>row.status==='fulfilled').length,1)
 assert.equal((await new ProjectService(pool,identity).get(f.owner,{projectId:f.project.id})).project.id,f.project.id)
})
test('归档原对象显示不可用占位，不漏出私有标题；可以移除失效关联',async()=>{
 const f=await fixture();await f.service.change(f.owner,f.request)
 await new ProjectService(pool,identity).edit(f.owner,{projectId:f.project.id,expectedVersion:1,fields:{scope:'general',title:f.project.title,goal:f.project.goal,dueDate:null,state:'archived',links:[],references:[]}})
 const detail=await f.service.get(f.owner,{groupId:f.group.id}),project=detail.items.find(row=>row.kind==='project')!
 assert.deepEqual(project,{kind:'project',scope:'general',id:f.project.id,available:false,title:null,state:null,objectVersion:null})
 assert.equal((await f.service.change(f.owner,{...f.request,requestId:randomUUID(),expectedVersion:1,links:f.links.filter(link=>link.kind!=='project')})).items.length,2)
})
test('原业务对象更新后关联读当前版本；删除和摘要损坏不得回落旧快照',async()=>{
 const f=await fixture();await f.service.change(f.owner,f.request)
 const next={...f.incident,version:2,title:'Confirmed case',fields:[{label:'status',value:'resolved'}]}
 await pool.query('insert into teloa_business_object_snapshots values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[f.owner,next.scope,next.type,next.id,next.version,businessObjectSnapshotHash(next),JSON.stringify(next),next.source,next.receivedAt])
 assert.equal((await f.service.get(f.owner,{groupId:f.group.id})).items.find(item=>item.kind==='business')!.objectVersion,2)
 await pool.query("update teloa_business_object_snapshots set snapshot_hash=$1 where owner_id=$2 and object_version=2",['a'.repeat(64),f.owner])
 await assert.rejects(f.service.get(f.owner,{groupId:f.group.id}),{code:'teloa/storage-corrupt'})
})
test('提交前取消或原指令变化整笔回滚，不产生保存回执',async()=>{
 for(const mode of ['cancel','changed'] as const){
  const f=await fixture(),controller=new AbortController();let checks=0
  await assert.rejects(f.service.change(f.owner,f.request,controller.signal,async()=>{
   if(++checks===3){if(mode==='cancel')controller.abort();else throw Object.assign(Error('changed'),{code:'teloa/version-conflict'})}
  }))
  assert.equal((await f.service.get(f.owner,{groupId:f.group.id})).version,0)
  assert.equal((await pool.query('select count(*)::int n from teloa_group_work_link_requests where owner_id=$1',[f.owner])).rows[0].n,0)
 }
})
test('候选搜索将百分号、下划线和反斜杠视作原名称的文字',async()=>{
 const f=await fixture(),tasks=new TaskService(pool,identity)
 for(const title of ['release_2026','releaseA2026','margin%done','marginXdone','path\\report','pathreport'])await tasks.create(f.owner,{requestId:randomUUID(),fields:{scope:'general',title,goal:'Prepare original work'}})
 for(const query of ['release_2026','margin%done','path\\report'])assert.deepEqual((await f.service.candidates(f.owner,{groupId:f.group.id,scope:'general',kind:'task',query})).map(row=>row.title),[query])
})
test('合法业务原件的多行标题与长状态只压缩显示摘要，不损坏原件或保存回执',async()=>{
 const f=await fixture(),title='合成案件\n待核对',state='分析中\n'+ '待核实证据'.repeat(40)
 const snapshot={...f.incident,title,fields:[{label:'status',value:state}]}
 await pool.query('update teloa_business_object_snapshots set snapshot=$1,snapshot_hash=$2 where owner_id=$3',[JSON.stringify(snapshot),businessObjectSnapshotHash(snapshot),f.owner])
 const saved=readGroupWorkLinks(await f.service.change(f.owner,f.request)),item=saved.items.find(row=>row.kind==='business')!
 assert.equal(item.title,'合成案件 待核对');assert.equal(item.state!.length,120);assert.ok(item.state!.endsWith('…'))
 assert.equal((readGroupWorkLinks(await f.service.get(f.owner,{groupId:f.group.id}))).items.find(row=>row.kind==='business')!.state,item.state)
 assert.equal(readGroupWorkLinkItem((await f.service.candidates(f.owner,{groupId:f.group.id,scope:'SOC',kind:'business',query:'合成案件'}))[0]).state,item.state)
 assert.equal((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1',[f.owner])).rows[0].snapshot.fields[0].value,state)
 assert.deepEqual(await f.service.change(f.owner,f.request),saved)
})


test('项目当前详情反向读取同一原群关联，跨业务保留原范围；解除不写项目或员工授权',async()=>{
 const f=await fixture(),projects=new ProjectService(pool,identity)
 const initial=await projects.get(f.owner,{projectId:f.project.id})
 assert.deepEqual(initial.linkedGroups,[])
 await f.service.change(f.owner,f.request)
 let detail=await projects.get(f.owner,{projectId:f.project.id})
 assert.deepEqual(detail.linkedGroups,[{kind:'group',scope:'general',id:f.group.id,title:f.group.name,state:'active',version:1,available:true}])
 const cross=await f.groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'Security support',scope:'SOC',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
 await f.service.change(f.owner,{requestId:randomUUID(),groupId:cross.id,expectedGroupVersion:cross.version,expectedVersion:0,links:[f.links[0]]})
 detail=await projects.get(f.owner,{projectId:f.project.id})
 assert.equal(detail.linkedGroups?.length,2)
 assert.ok(detail.linkedGroups?.some(row=>row.id===cross.id&&row.scope==='SOC'&&row.title==='Security support'))
 assert.deepEqual(detail.project,initial.project,'反向展示不改项目定义、版本或关联列表')
 const other=await fixture();assert.deepEqual((await projects.get(other.owner,{projectId:other.project.id})).linkedGroups,[])
 await assert.rejects(projects.get(other.owner,{projectId:f.project.id}),{code:'teloa/not-found'})
 await f.service.change(f.owner,{...f.request,requestId:randomUUID(),expectedVersion:1,links:f.links.filter(link=>link.kind!=='project')})
 await f.service.change(f.owner,{requestId:randomUUID(),groupId:cross.id,expectedGroupVersion:cross.version,expectedVersion:1,links:[]})
 assert.deepEqual((await projects.get(f.owner,{projectId:f.project.id})).linkedGroups,[],'解除群侧原关联后项目立即反映，不留下第二份关系')
 assert.equal((await pool.query('select count(*)::int n from teloa_group_agent_grants where group_id=any($1::uuid[])',[[f.group.id,cross.id]])).rows[0].n,0)
})

test('项目侧关联在原群读取反向显示，同业务和跨业务引用均不写第二份关系',async()=>{
 const f=await fixture(),projects=new ProjectService(pool,identity)
 const linked=await projects.edit(f.owner,{projectId:f.project.id,expectedVersion:1,fields:{scope:f.project.scope,title:f.project.title,goal:f.project.goal,dueDate:null,state:'planning',links:[{kind:'group',id:f.group.id}],references:[]}})
 const crossBase=await projects.create(f.owner,{requestId:randomUUID(),fields:{scope:'SOC',title:'跨业务支持',goal:'Coordinate synthetic work',dueDate:null,state:'planning',links:[],references:[]}})
 const cross=await projects.edit(f.owner,{projectId:crossBase.id,expectedVersion:crossBase.version,fields:{scope:'SOC',title:crossBase.title,goal:crossBase.goal,dueDate:null,state:'running',links:[],references:[{kind:'group',scope:'general',id:f.group.id}]}})
 const before=await f.groups.get(f.owner,{groupId:f.group.id})
 const detail=readGroupWorkLinks(await f.service.get(f.owner,{groupId:f.group.id}))
 assert.deepEqual(detail.items,[]);assert.equal(detail.version,0)
 assert.deepEqual(detail.projectLinks?.map(row=>[row.id,row.scope,row.title,row.objectVersion]).sort(),[[f.project.id,'general',f.project.title,2],[cross.id,'SOC','跨业务支持',2]].sort())
 assert.deepEqual((await f.groups.get(f.owner,{groupId:f.group.id})).group,before.group)
 assert.equal((await pool.query('select count(*)::int n from teloa_group_work_links where owner_id=$1',[f.owner])).rows[0].n,0)
 assert.equal((await pool.query('select count(*)::int n from teloa_group_agent_grants where group_id=$1',[f.group.id])).rows[0].n,0)
 await projects.edit(f.owner,{projectId:linked.id,expectedVersion:linked.version,fields:{scope:linked.scope,title:linked.title,goal:linked.goal,dueDate:linked.dueDate,state:linked.state,links:[],references:[]}})
 assert.deepEqual((await f.service.get(f.owner,{groupId:f.group.id})).projectLinks?.map(row=>row.id),[cross.id])
 const archived=await projects.edit(f.owner,{projectId:cross.id,expectedVersion:cross.version,fields:{scope:cross.scope,title:cross.title,goal:cross.goal,dueDate:cross.dueDate,state:'archived',links:[],references:cross.references}})
 assert.deepEqual((await f.service.get(f.owner,{groupId:f.group.id})).projectLinks,[{kind:'project',scope:'SOC',id:archived.id,available:false,title:null,state:null,objectVersion:null}])
})

test('项目侧反向关联只读取本人和注册业务；损坏原定义不能被当作可信关系',async()=>{
 const f=await fixture(),other=await fixture()
 // 造非法存量关系，验证读取边界；正规写服务已经禁止跨本人关联。
 await pool.query('update teloa_projects set definition=jsonb_set(definition,\'{links}\',$1::jsonb) where id=$2',[JSON.stringify([{kind:'group',id:f.group.id}]),other.project.id])
 assert.deepEqual((await f.service.get(f.owner,{groupId:f.group.id})).projectLinks,[])
 await pool.query('update teloa_projects set definition=jsonb_set(jsonb_set(definition,\'{scope}\',\'"unregistered"\'::jsonb),\'{references}\',$1::jsonb) where id=$2',[JSON.stringify([{kind:'group',scope:'general',id:f.group.id}]),f.project.id])
 assert.deepEqual((await f.service.get(f.owner,{groupId:f.group.id})).projectLinks,[])
 await pool.query('update teloa_projects set definition=jsonb_set(jsonb_set(definition,\'{scope}\',\'"SOC"\'::jsonb),\'{state}\',\'"invalid"\'::jsonb) where id=$1',[f.project.id])
 await assert.rejects(f.service.get(f.owner,{groupId:f.group.id}),{code:'teloa/storage-corrupt'})
})
