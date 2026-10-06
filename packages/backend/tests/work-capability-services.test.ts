import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,rm} from 'node:fs/promises'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {PlanService,initializePlans} from '../src/work/plans.ts'
import {ConversationService,FileConversationRepository} from '../src/work/conversations.ts'
import {ConversationWorkService,initializeConversationWork} from '../src/work/conversation-work.ts'
import {workAccess,type WorkAccessRequest} from '../src/work/work-access.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()},blocked={value:false},seen:Readonly<WorkAccessRequest>[]=[]
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializePlans(pool);await initializeConversationWork(pool)
 workAccess.installPolicy(async request=>{seen.push(request);return {assertCurrent(){if(blocked.value&&request.kind==='capability'&&request.capability!=='general-agent')throw Error('advanced locked')}}})
})

test('岗位会话无people权益不建预约或宿主；基础可建，旧回执可读，等待宿主跨到期保留同一预约',async t=>{
 blocked.value=false
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{...roleFields,runtimeConfig:{agentPresetId:'fixed-reviewer'}}})
 const root=await mkdtemp(join(tmpdir(),'teloa-capability-conversation-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const repository=new FileConversationRepository(join(root,'conversations.json')),created:string[]=[],known=new Set<string>()
 let revokeAfterCreate=false
 const host={async create(id:string,_workspace?:string,preset?:string){created.push(id);known.add(id);if(preset!==undefined)assert.equal(preset,'fixed-reviewer');if(revokeAfterCreate)blocked.value=true;return id},async inspect(id:string){assert.ok(known.has(id))}}
 const service=new ConversationService(repository,host,identity,async(actor,id)=>actor===owner&&id===role.id?role:undefined)
 const input={requestId:randomUUID(),title:'员工会话',roleId:role.id}
 blocked.value=true
 await assert.rejects(service.create(owner,input),forbidden)
 assert.deepEqual(await repository.read(),[]);assert.deepEqual(created,[])
 const basic=await service.create(owner,{requestId:randomUUID(),title:'通用会话'})
 assert.equal(basic.status,'ready');assert.equal(created.length,1)
 blocked.value=false
 const ready=await service.create(owner,input),calls=created.length
 blocked.value=true
 assert.deepEqual(await service.create(owner,input),ready);assert.equal(created.length,calls)
 blocked.value=false;revokeAfterCreate=true
 const pendingInput={...input,requestId:randomUUID(),title:'到期保留预约'}
 await assert.rejects(service.create(owner,pendingInput),forbidden)
 const pending=(await repository.read()).find(row=>row.requestId===pendingInput.requestId)!
 assert.equal(pending.status,'pending')
 blocked.value=false;revokeAfterCreate=false
 const recovered=await service.create(owner,pendingInput)
 assert.equal(recovered.id,pending.id);assert.equal(recovered.sessionId,pending.requestedSessionId)
 assert.deepEqual(created.slice(-2),[pending.requestedSessionId,pending.requestedSessionId])
})

test('真实PG非空负责人需people准入，null基础与旧回执可用；最后写入跨到期整笔回滚',async()=>{
 blocked.value=false
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:roleFields}),sessionId='config-'+randomUUID()
 const inspect=async(actor:string,id:string)=>({ownerId:actor,sessionId:id,status:'ready',submitted:false})
 const service=new ConversationWorkService(pool,identity.now,inspect)
 const initial=await service.setContext(owner,{requestId:randomUUID(),sessionId,scopeId:'general',roleId:null,expectedVersion:0})
 blocked.value=true
 const input={requestId:randomUUID(),sessionId,scopeId:'general',roleId:role.id,expectedVersion:initial.version}
 await assert.rejects(service.setContext(owner,input),forbidden)
 assert.deepEqual(await service.context(owner,{sessionId}),initial)
 blocked.value=false
 const selected=await service.setContext(owner,input)
 blocked.value=true
 assert.deepEqual(await service.setContext(owner,input),selected)
 const cleared=await service.setContext(owner,{requestId:randomUUID(),sessionId,scopeId:'general',roleId:null,expectedVersion:selected.version})
 assert.equal(cleared.roleId,null)
 blocked.value=false
 const delayed=new Proxy(pool,{get(target,key){
  if(key==='connect')return async()=>{
   const client=await target.connect()
   return new Proxy(client,{get(db,name){
    if(name==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(db.query,db,args);if(String(args[0]).startsWith('insert into teloa_conversation_work_contexts('))blocked.value=true;return result}
    const value=Reflect.get(db,name);return typeof value==='function'?value.bind(db):value
   }})
  }
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
 }})
 await assert.rejects(new ConversationWorkService(delayed,identity.now,inspect).setContext(owner,{...input,requestId:randomUUID(),expectedVersion:cleared.version}),forbidden)
 assert.deepEqual(await service.context(owner,{sessionId}),cleared)
})
after(async()=>{await pool?.end();await container?.stop()})
const roleFields={name:'资料员',kind:'employee',scopes:['general'],duty:'整理资料',dataScope:'本人资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}
const groupFields=(id:string)=>({name:'工作群',scope:'general',announcement:'资料核对',memberRoleIds:[id],rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}})
const forbidden={code:'teloa/forbidden'}

test('真实PG高级创建/编辑/启用/群发消息拒绝并回滚，读记录、暂停与精确默认分身初始化仍可用',async()=>{
 blocked.value=false
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity),plans=new PlanService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields}),group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:groupFields(role.id)})
 const plan=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日核对',goal:'核对资料',scope:'general',dataScope:'本人资料',delivery:'核对结果',roleId:role.id,expectedRoleVersion:role.version,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'},source:{kind:'manual'}})
 const active=await plans.change(owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'enable'})
 blocked.value=true
 await assert.rejects(roles.create(owner,{requestId:randomUUID(),fields:{...roleFields,name:'新员工'}}),forbidden)
 await assert.rejects(groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:groupFields(role.id)}),forbidden)
 await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'继续协作'}),forbidden)
 const paused=await plans.change(owner,{requestId:randomUUID(),planId:active.id,expectedVersion:active.version,action:'pause'})
 await assert.rejects(plans.change(owner,{requestId:randomUUID(),planId:paused.id,expectedVersion:paused.version,action:'enable'}),forbidden)
 await pool.query("update teloa_roles set state='paused' where owner_id=$1 and id=$2",[owner,role.id])
 await assert.rejects(roles.edit(owner,{roleId:role.id,expectedVersion:role.version,fields:{...roleFields,name:'修改员工'}}),forbidden)
 assert.equal((await roles.list(owner,{})).length,1);assert.equal((await groups.messages(owner,{groupId:group.id})).length,0)
 assert.equal((await plans.get(owner,{planId:plan.id})).state,'paused')
 assert.equal((await roles.ensurePersonalTwin(owner)).kind,'twin')
 assert.ok(seen.some(request=>request.kind==='capability'&&request.capability==='people'&&request.ownerId===owner))
 assert.ok(seen.some(request=>request.kind==='capability'&&request.capability==='groups'&&request.objectId===group.id))
 assert.ok(seen.some(request=>request.kind==='capability'&&request.capability==='automation'&&request.objectId===plan.id))
})
