import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeMarketContents,MarketContentStore} from '../src/market/content-store.ts'
import {initializePlans,PlanService,type PlanFields} from '../src/work/plans.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const now='2026-09-11T12:00:00.000Z',identity={id:randomUUID,now:()=>now}
const schedule={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const}
const fields=(roleId:string,extra:Partial<PlanFields&{expectedRoleVersion:number}>={}):PlanFields&{expectedRoleVersion:number}=>({title:'每日资料核对',goal:'核对新增资料并形成明确结论。',scope:'general',dataScope:'本人已授权的通用资料。',delivery:'变化、来源和待核对项。',roleId,expectedRoleVersion:1,trigger:schedule,notificationPolicy:'attention',...extra})

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeMarketContents(pool);await initializePlans(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})
/** 服务端自建入口：系统计划不经人类 `create`，调用方自己开事务。 */
const inTransaction=async<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>=>{
 const client=await pool.connect()
 try{await client.query('begin');const value=await run(client);await client.query('commit');return value}
 catch(error){await client.query('rollback');throw error}
 finally{client.release()}
}

async function role(owner:string,options:{kind?:'employee'|'twin';scopes?:string[];active?:boolean}={}){
 const created=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'资料核对岗',kind:options.kind??'employee',scopes:options.scopes??['general'],duty:'核对资料',dataScope:'已授权资料',executionScope:'只读整理',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 // 创建后直接在岗；要「暂停岗位」的用例显式摆回暂停，不动版本。
 if(options.active===false)await pool.query("update teloa_roles set state='paused' where id=$1",[created.id])
 return created
}

test('本人计划并发幂等创建、默认暂停并可在服务重建后读取',async()=>{
 const owner=randomUUID(),assignee=await role(owner),service=new PlanService(pool,identity),input={requestId:randomUUID(),fields:fields(assignee.id),source:{kind:'manual' as const}}
 const [a,b]=await Promise.all([service.create(owner,input),service.create(owner,input)])
 assert.deepEqual(a,b);assert.equal(a.state,'paused');assert.equal(a.version,1);assert.equal(a.configVersion,1)
 assert.equal(a.roleId,assignee.id);assert.equal(a.roleVersion,1);assert.deepEqual(a.trigger,schedule);assert.equal(a.notificationPolicy,'attention')
 assert.deepEqual(await new PlanService(pool,identity).list(owner,{}),[a])
 assert.deepEqual(await new PlanService(pool,identity).get(owner,{planId:a.id}),a)
 await pool.query("update teloa_roles set state='paused' where id=$1",[assignee.id])
 assert.deepEqual(await service.create(owner,input),a)
 await assert.rejects(service.create(owner,{...input,fields:{...input.fields,title:'另一计划'}}),{code:'teloa/conflict'})
 await assert.rejects(service.create(owner,{...input,fields:{...input.fields,notificationPolicy:'failure'}}),{code:'teloa/conflict'})
 assert.deepEqual(await service.list('other',{}),[])
})

test('新计划必须本人显式核对通知策略，旧计划缺字段保持可读和可启用且不静默写回',async()=>{
 const owner=randomUUID(),assignee=await role(owner),service=new PlanService(pool,identity)
 const base={requestId:randomUUID(),fields:fields(assignee.id),source:{kind:'manual' as const}}
 for(const notificationPolicy of [undefined,'all','quiet',null,{}]){
  const {notificationPolicy:_removed,...withoutPolicy}=base.fields
  await assert.rejects(service.create(owner,{...base,requestId:randomUUID(),fields:notificationPolicy===undefined?withoutPolicy:{...withoutPolicy,notificationPolicy}}),{code:'teloa/invalid-input'})
 }
 const created=await service.create(owner,base)
 await pool.query("update teloa_plans set notification_policy=null,definition=definition-'notificationPolicy',request_spec=jsonb_set(request_spec,'{fields}',(request_spec->'fields')-'notificationPolicy') where id=$1",[created.id])
 const legacy=await service.get(owner,{planId:created.id})
 assert.equal(Object.hasOwn(legacy,'notificationPolicy'),false)
 const enabled=await service.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:legacy.version,action:'enable'})
 assert.equal(enabled.state,'active');assert.equal(Object.hasOwn(enabled,'notificationPolicy'),false)
 const stored=(await pool.query('select notification_policy,definition,request_spec from teloa_plans where id=$1',[created.id])).rows[0]
 assert.equal(stored.notification_policy,null);assert.equal(Object.hasOwn(stored.definition,'notificationPolicy'),false);assert.equal(Object.hasOwn(stored.request_spec.fields,'notificationPolicy'),false)
})

test('创建只接受同本人、同版本、同业务的在岗数字员工与合法日程',async()=>{
 const owner=randomUUID(),service=new PlanService(pool,identity),paused=await role(owner,{active:false}),twin=await role(owner,{kind:'twin'}),otherScope=await role(owner,{scopes:['SOC']}),foreign=await role(randomUUID())
 const attempts=[
  {requestId:randomUUID(),fields:fields(paused.id),source:{kind:'manual'}},
  {requestId:randomUUID(),fields:fields(twin.id),source:{kind:'manual'}},
  {requestId:randomUUID(),fields:fields(foreign.id),source:{kind:'manual'}},
  {requestId:randomUUID(),fields:fields(paused.id,{expectedRoleVersion:9}),source:{kind:'manual'}},
  {requestId:randomUUID(),fields:{...fields(paused.id),trigger:{kind:'event',source:'任意文字',event:'发生'}},source:{kind:'manual'}},
  {requestId:randomUUID(),fields:fields(paused.id),source:{kind:'manual'},ownerId:'forged'},
 ]
 for(const input of attempts)await assert.rejects(service.create(owner,input))
 // 通用工作（general）对任何岗位都开放（2026-09-21 用户裁定），范围判据只在业务范围上成立：SOC 岗位派不了 AppSec 计划。
 await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:fields(otherScope.id,{scope:'AppSec'}),source:{kind:'manual'}}),{code:'teloa/forbidden'})
 assert.deepEqual(await service.list(owner,{}),[])
})

test('启用、暂停与归档使用固定请求回执和版本，归档不可复活',async()=>{
 const owner=randomUUID(),assignee=await role(owner),service=new PlanService(pool,identity)
 const plan=await service.create(owner,{requestId:randomUUID(),fields:fields(assignee.id),source:{kind:'manual'}})
 const enable={planId:plan.id,requestId:randomUUID(),expectedVersion:1,action:'enable' as const}
 const [activeA,activeB]=await Promise.all([service.change(owner,enable),service.change(owner,enable)])
 assert.deepEqual(activeA,activeB);assert.equal(activeA.state,'active');assert.equal(activeA.version,2);assert.equal(activeA.configVersion,1)
 const pause=await service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:2,action:'pause'})
 assert.equal(pause.state,'paused');assert.equal(pause.version,3)
 assert.deepEqual(await service.change(owner,enable),activeA)
 await assert.rejects(service.change(owner,{...enable,action:'pause'}),{code:'teloa/conflict'})
 const archived=await service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:3,action:'archive',note:'这项周期工作已经结束。'})
 assert.equal(archived.state,'archived');assert.equal(archived.version,4);assert.equal(archived.archivedReason,'这项周期工作已经结束。');assert.equal(archived.archivedAt,now)
 await assert.rejects(service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:4,action:'enable'}),{code:'teloa/conflict'})
})

test('不同请求并发修改同一版本只有一个生效，岗位变化阻止重新启用但不阻止暂停',async()=>{
 const owner=randomUUID(),assignee=await role(owner),service=new PlanService(pool,identity),plan=await service.create(owner,{requestId:randomUUID(),fields:fields(assignee.id),source:{kind:'manual'}})
 const changes=await Promise.allSettled([
  service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:1,action:'enable'}),
  service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:1,action:'archive',note:'停止'}),
 ])
 assert.equal(changes.filter(result=>result.status==='fulfilled').length,1)
 const linked=await service.create(owner,{requestId:randomUUID(),fields:fields(assignee.id,{title:'岗位变化核对'}),source:{kind:'manual'}})
 const current=await service.change(owner,{planId:linked.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 await pool.query("update teloa_roles set state='paused',version=2 where id=$1",[assignee.id])
 const paused=await service.change(owner,{planId:linked.id,requestId:randomUUID(),expectedVersion:current.version,action:'pause'})
 assert.equal(paused.state,'paused')
 await assert.rejects(service.change(owner,{planId:linked.id,requestId:randomUUID(),expectedVersion:paused.version,action:'enable'}),{code:'teloa/version-conflict'})
})

test('市场来源按本人内容、摘要、资源身份和版本固定，不接受同名或跨本人替代',async()=>{
 const owner=randomUUID(),assignee=await role(owner),market=new MarketContentStore(pool,identity)
 const manifest={format:'teloa.business-package/v2',id:'research',title:'研究模板',version:'1.0.0',domain:'general',description:'研究',resources:[{id:'daily-review',kind:'work-template',title:'每日核对',version:'1.0.0',required:true,source:{kind:'local',path:'work/daily.json'}}],relations:[],entrypoints:['daily-review']}
 const encode=(path:string,text:string)=>({path,bytes:new TextEncoder().encode(text)})
 const content=(await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'研究模板'},manifestPath:'teloa.json',files:[encode('teloa.json',JSON.stringify(manifest)),encode('work/daily.json','{}')],references:[]})).content
 const source={kind:'market-content' as const,contentId:content.id,contentHash:content.hash,resourceId:'daily-review',resourceVersion:'1.0.0'}
 const service=new PlanService(pool,identity,market),base={requestId:randomUUID(),fields:fields(assignee.id),source}
 const plan=await service.create(owner,base);assert.deepEqual(plan.source,source)
 const original=Buffer.from(content.files.find(file=>file.path==='work/daily.json')!.bytes)
 await pool.query("update teloa_market_files set bytes='tampered' where content_id=$1 and path='work/daily.json'",[content.id])
 await assert.rejects(service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:1,action:'enable'}),{code:'teloa/storage-corrupt'})
 await pool.query("update teloa_market_files set bytes=$2 where content_id=$1 and path='work/daily.json'",[content.id,original])
 const active=await service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 await pool.query("update teloa_market_files set bytes='tampered-again' where content_id=$1 and path='work/daily.json'",[content.id])
 const paused=await service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:active.version,action:'pause'})
 assert.equal(paused.state,'paused')
 const archived=await service.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:paused.version,action:'archive',note:'来源已失效'})
 assert.equal(archived.state,'archived')
 await pool.query("update teloa_market_files set bytes=$2 where content_id=$1 and path='work/daily.json'",[content.id,original])
 await assert.rejects(service.create(owner,{...base,requestId:randomUUID(),source:{...source,contentHash:'0'.repeat(64)}}),{code:'teloa/source-unavailable'})
 await assert.rejects(service.create(owner,{...base,requestId:randomUUID(),source:{...source,resourceId:'same-title-other-id'}}),{code:'teloa/source-unavailable'})
 const foreignRole=await role('another-owner')
 await assert.rejects(new PlanService(pool,identity,market).create('another-owner',{requestId:randomUUID(),fields:fields(foreignRole.id),source}),{code:'teloa/source-unavailable'})
})

test('损坏计划或状态回执显式失败，数据库拒绝跨本人岗位引用',async()=>{
 const owner=randomUUID(),assignee=await role(owner),service=new PlanService(pool,identity),createFields=fields(assignee.id),source={kind:'manual' as const},plan=await service.create(owner,{requestId:randomUUID(),fields:createFields,source})
 const change={planId:plan.id,requestId:randomUUID(),expectedVersion:1,action:'enable' as const}
 const active=await service.change(owner,change)
 await pool.query("update teloa_plan_changes set result=jsonb_set(result,'{title}','\"伪造标题\"') where owner_id=$1 and request_id=$2",[owner,change.requestId])
 await assert.rejects(service.change(owner,change),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_plan_changes set result=$3 where owner_id=$1 and request_id=$2',[owner,change.requestId,JSON.stringify(active)])
 await pool.query("update teloa_plan_changes set result=jsonb_set(result,'{updatedAt}',$3::jsonb) where owner_id=$1 and request_id=$2",[owner,change.requestId,JSON.stringify(Date.parse(now))])
 await assert.rejects(service.change(owner,change),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_plan_changes set result=$3 where owner_id=$1 and request_id=$2',[owner,change.requestId,JSON.stringify(active)])
 await pool.query("update teloa_plan_changes set result=jsonb_set(result,'{ownerId}','\"other\"') where owner_id=$1 and request_id=$2",[owner,change.requestId])
 await assert.rejects(service.change(owner,change),{code:'teloa/storage-corrupt'})
 await pool.query("update teloa_plans set request_spec=jsonb_set(request_spec,'{fields,title}','\"另一创建目标\"') where id=$1",[plan.id])
 await assert.rejects(service.get(owner,{planId:plan.id}),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_plans set request_spec=$2 where id=$1',[plan.id,JSON.stringify({fields:createFields,source})])
 await pool.query("update teloa_plans set definition=jsonb_set(definition,'{title}','null') where id=$1",[plan.id])
 await assert.rejects(service.get(owner,{planId:plan.id}),{code:'teloa/storage-corrupt'})
 const foreign=await role(randomUUID())
 await assert.rejects(pool.query('update teloa_plans set role_id=$2 where id=$1',[plan.id,foreign.id]),{code:'23503'})
})

test('调度专用计划目录逐行隔离坏暂停计划，空页仍推进且客户端list仍显式失败',async()=>{
 const owner=randomUUID(),assignee=await role(owner),service=new PlanService(pool,identity)
 const plans=await Promise.all(Array.from({length:3},()=>service.create(owner,{requestId:randomUUID(),fields:fields(assignee.id),source:{kind:'manual'}})))
 plans.sort((a,b)=>a.id.localeCompare(b.id))
 await pool.query("update teloa_plans set definition=jsonb_set(definition,'{title}','null') where id=$1",[plans[0]!.id])
 await assert.rejects(service.list(owner,{}),{code:'teloa/storage-corrupt'})
 const first=await service.schedulerPlans(owner,{limit:1})
 assert.deepEqual(first.items,[]);assert.deepEqual(first.errors,[{planId:plans[0]!.id,code:'teloa/storage-corrupt'}]);assert.deepEqual(first.cursor,{id:plans[0]!.id})
 const second=await service.schedulerPlans(owner,{limit:1,cursor:first.cursor})
 assert.deepEqual(second.items,[plans[1]]);assert.equal(second.errors,undefined);assert.deepEqual(second.cursor,{id:plans[1]!.id})
 const last=await service.schedulerPlans(owner,{limit:1,cursor:second.cursor})
 assert.deepEqual(last.items,[plans[2]]);assert.equal(last.cursor,undefined)
 for(const input of [{limit:0},{limit:101},{limit:1.5},{limit:1,cursor:{id:'bad'}},{limit:1,extra:true}])await assert.rejects(service.schedulerPlans(owner,input),{code:'teloa/invalid-input'})
 assert.deepEqual(await service.schedulerPlans('other',{limit:1}),{items:[]})
 await assert.rejects(service.schedulerPlans('other',{limit:1,cursor:first.cursor}),{code:'teloa/forbidden'})
})

test('更新固定计划定义保留岗位、业务与来源，递增配置版本且拒绝旧版本与越界字段',async()=>{
 const owner=randomUUID(),assignee=await role(owner),service=new PlanService(pool,identity)
 const created=await service.create(owner,{requestId:randomUUID(),fields:fields(assignee.id),source:{kind:'manual'}})
 const update={planId:created.id,requestId:randomUUID(),expectedVersion:created.version,expectedConfigVersion:created.configVersion,action:'update' as const,fields:{title:'每周资料核对',goal:'核对本周新增资料并输出结论。',dataScope:'本人已授权的本周资料。',delivery:'本周变化、来源和待核对项。',trigger:{kind:'schedule' as const,cadence:'weekly' as const,weekday:5,time:'10:30',timezone:'Asia/Singapore' as const},notificationPolicy:'failure' as const}}
 const [a,b]=await Promise.all([service.change(owner,update),service.change(owner,update)])
 assert.deepEqual(a,b);assert.equal(a.version,2);assert.equal(a.configVersion,2);assert.equal(a.state,'paused');assert.equal(a.roleId,created.roleId);assert.equal(a.scope,created.scope);assert.deepEqual(a.source,created.source);assert.equal(a.title,update.fields.title);assert.deepEqual(a.trigger,update.fields.trigger)
 assert.deepEqual(await service.get(owner,{planId:created.id}),a)
 await assert.rejects(service.change(owner,{...update,requestId:randomUUID(),expectedVersion:created.version,expectedConfigVersion:created.configVersion,fields:{...update.fields,title:'旧版本写入'}}),{code:'teloa/version-conflict'})
 for(const bad of [
  {...update,requestId:randomUUID(),fields:{...update.fields,scope:'SOC'}},
  {...update,requestId:randomUUID(),expectedConfigVersion:undefined},
  {...update,requestId:randomUUID(),note:'不应接受'},
 ])await assert.rejects(service.change(owner,bad),{code:'teloa/invalid-input'})
})

test('系统计划来源能存能读，不能归档，且只放行时刻与时区',async()=>{
 const owner=randomUUID(),assignee=await role(owner),service=new PlanService(pool,identity)
 const source={kind:'system-digest' as const,roleId:assignee.id}
 // 系统计划只由服务端随同事在岗自建；人类入口一律拒绝，否则本人能建出一条不能归档、删不掉的计划。
 await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:fields(assignee.id),source}),{code:'teloa/forbidden'})
 const selfBuild=(input:unknown)=>inTransaction(client=>service.createInTransaction(client,owner,input))
 const created=await selfBuild({requestId:randomUUID(),fields:fields(assignee.id),source})
 assert.deepEqual(created.source,source);assert.deepEqual((await service.get(owner,{planId:created.id})).source,source)
 for(const bad of [{kind:'system-digest'},{kind:'system-digest',roleId:'bad'},{kind:'system-digest',roleId:assignee.id,extra:1},{kind:'system-digest',roleId:randomUUID()}])
  await assert.rejects(selfBuild({requestId:randomUUID(),fields:fields(assignee.id),source:bad}),{code:'teloa/invalid-input'})
 // 一位同事至多一条系统计划。
 await assert.rejects(selfBuild({requestId:randomUUID(),fields:fields(assignee.id),source}),{code:'teloa/conflict'})
 const enabled=await service.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:created.version,action:'enable'})
 assert.equal(enabled.state,'active')
 await assert.rejects(service.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:enabled.version,action:'archive',note:'不该归档'}),{code:'teloa/forbidden'})
 const base={title:enabled.title,goal:enabled.goal,dataScope:enabled.dataScope,delivery:enabled.delivery,trigger:enabled.trigger,notificationPolicy:enabled.notificationPolicy!}
 const update={planId:created.id,requestId:randomUUID(),expectedVersion:enabled.version,expectedConfigVersion:enabled.configVersion,action:'update' as const}
 const moved=await service.change(owner,{...update,fields:{...base,trigger:{...schedule,time:'23:30',timezone:'Asia/Shanghai' as const}}})
 assert.equal(moved.trigger.time,'23:30');assert.equal(moved.trigger.timezone,'Asia/Shanghai')
 for(const bad of [{...base,title:'换个名字'},{...base,goal:'换个目标说明。'},{...base,notificationPolicy:'silent' as const},{...base,dataScope:'换个资料面。'},{...base,delivery:'换个交付面。'},{...base,trigger:{...schedule,cadence:'weekly' as const}}])
  await assert.rejects(service.change(owner,{...update,requestId:randomUUID(),expectedVersion:moved.version,expectedConfigVersion:moved.configVersion,fields:bad}),{code:'teloa/forbidden'})
})
