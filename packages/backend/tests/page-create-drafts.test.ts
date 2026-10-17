import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {pageCreateLimits} from '@teloa/contract'
import {initializePageCreateDrafts,PageCreateDraftService,type PageCreateActor} from '../src/work/page-create-drafts.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializePageCreateDrafts(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const actor=():PageCreateActor=>({ownerId:'local:'+randomUUID(),scopeIds:['SOC']})
const role=(name='对账同事')=>({name,kind:'employee',scopes:['SOC'],duty:'核对账单',dataScope:'本人授权资料',executionScope:'只提出建议',skills:[],knowledge:[],responsibility:{triggers:['每天'],autonomousActions:['整理账单'],confirmationPoints:['发出前'],escalationRules:['资料不足'],deliveryChecks:['逐项核对']}})
const staticTemplate=()=>{
 const id=randomUUID(),version='1.0.0',title='静态写作员工',description='使用本人提供的资料写作。'
 const manifest={format:'teloa.business-package/v2',id,version,title,description,domain:'general',scope:'general',resources:[{id:'writer',kind:'role',title,version,required:true,source:{kind:'local',path:'role.json'}}],relations:[],entrypoints:[]}
 return {package:{format:'teloa.template-share/v1',id,version,title,description,requirements:[],compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:['people']},files:[{path:'teloa.json',text:JSON.stringify(manifest)},{path:'role.json',text:JSON.stringify({format:'teloa.role/v1',kind:'employee',name:title,duty:description,dataScope:'本人提供的资料。',executionScope:'只草拟，不外发。'})}]}}
}

test('旧草案约束升级后保留原稿，静态模板原稿可持久保存且本人隔离',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),saved=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 await pool.query("alter table teloa_page_create_drafts drop constraint teloa_page_create_drafts_entity_check, add constraint teloa_page_create_drafts_entity_check check(entity in ('business-definition','business-domain','role','skill','connector','extension'))")
 const input={entity:'share' as const,body:staticTemplate(),requestId:randomUUID()}
 await assert.rejects(()=>service.draft(owner,input),(error:unknown)=>(error as {code?:string}).code==='23514')
 await initializePageCreateDrafts(pool)
 assert.deepEqual(await service.read(owner,{draftId:saved.id}),saved)
 const share=await service.draft(owner,input)
 assert.equal(share.title,'静态写作员工');assert.equal(share.status,'draft');assert.equal(share.appliedRef,undefined)
 assert.equal((await service.directory(actor(),{entity:'share'})).drafts.length,0)
 assert.equal((await service.directory(owner,{entity:'share'})).drafts[0]?.id,share.id)
 const retried=await service.draft(owner,input)
 assert.equal(retried.id,share.id);assert.equal(retried.createdAt,share.createdAt);assert.equal(retried.bodyHash,share.bodyHash);assert.equal(retried.body,share.body);assert.equal(retried.status,'draft')
 assert.ok(retried.updatedAt>=share.updatedAt)
 assert.equal((await pool.query('select count(*)::int total from teloa_page_create_drafts where owner_id=$1 and request_id=$2',[owner.ownerId,input.requestId])).rows[0].total,1)
})
const view=(title='风险分布')=>({format:'teloa.business-view/v1',id:'risk-distribution',version:'1.0.0',domain:'SOC',title,kind:'distribution',chart:'bar',objectType:'alert-ticket',dimension:{field:'severity',limit:3},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3})
const businessDomainBody=(scope:string)=>({
 manifest:{format:'teloa.business-package/v2',id:'recruiting-template',title:'招聘行业模板',version:'1.0.0',domain:'recruiting',scope,description:'用于验证新业务范围目录读取。',resources:[{id:'recruiting-template-work',kind:'work-template',title:'招聘工作模板',version:'1.0.0',required:true,source:{kind:'local',path:'work-template.json'}}],relations:[],entrypoints:[]},
 definitions:[view()],
})

test('草案同 requestId 只替换同一条待确认记录，落定后不再允许改写',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),requestId=randomUUID()
 const first=await service.draft(owner,{entity:'role',body:role(),requestId})
 const again=await service.draft(owner,{entity:'role',body:role('对账同事（二次修改）'),requestId})
 assert.equal(again.id,first.id);assert.equal(again.status,'draft');assert.equal(again.appliedRef,undefined);assert.notEqual(again.bodyHash,first.bodyHash)
 await assert.rejects(()=>service.settle(owner,{requestId:randomUUID(),draftId:again.id,expectedBodyHash:again.bodyHash,outcome:'applied'}),{code:'teloa/invalid-input'})
 await service.settle(owner,{requestId:randomUUID(),draftId:again.id,expectedBodyHash:again.bodyHash,outcome:'applied',appliedRef:'role-created-1'})
 await assert.rejects(()=>service.draft(owner,{entity:'role',body:role('不应覆盖'),requestId}),{code:'teloa/conflict'})
 const directory=await service.directory(owner,{entity:'role'})
 assert.equal(directory.drafts[0]?.status,'applied');assert.equal(directory.drafts[0]?.appliedRef,'role-created-1')
})

test('草案上限按实体和范围硬性拒绝，不截断也不删除旧草案',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 for(let index=0;index<pageCreateLimits.draftsPerEntity;index++)await service.draft(owner,{entity:'role',body:role('同事 '+index),requestId:randomUUID()})
 await assert.rejects(()=>service.draft(owner,{entity:'role',body:role('超出上限'),requestId:randomUUID()}),{code:'teloa/conflict'})
 assert.equal((await service.directory(owner,{entity:'role'})).drafts.length,pageCreateLimits.draftsPerEntity)
})

test('范围只允许本人已登记的业务；通用范围和多余范围一律拒绝',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 const saved=await service.draft(owner,{entity:'business-definition',scope:'SOC',body:view(),requestId:randomUUID()})
 assert.equal(saved.scope,'SOC')
 await assert.rejects(()=>service.draft(owner,{entity:'business-definition',scope:'general',body:view(),requestId:randomUUID()}),{code:'teloa/invalid-input'})
 await assert.rejects(()=>service.draft(owner,{entity:'business-definition',scope:'AppSec',body:{...view(),domain:'AppSec'},requestId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(()=>service.draft(owner,{entity:'role',scope:'SOC',body:role(),requestId:randomUUID()}),{code:'teloa/invalid-input'})
})

test('落定按正文摘要乐观核对，丢弃不能带落地记录',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 await assert.rejects(()=>service.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:'a'.repeat(64),outcome:'discarded'}),{code:'teloa/version-conflict'})
 await assert.rejects(()=>service.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'discarded',appliedRef:'role-1'}),{code:'teloa/invalid-input'})
 const directory=await service.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'discarded'})
 assert.equal(directory.drafts.find(item=>item.id===draft.id)?.status,'discarded')
 await assert.rejects(()=>service.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'discarded'}),{code:'teloa/version-conflict'})
})

test('需要你只读来源：仅本人待确认草案，无权范围与已落定草案不出现，读取不改状态',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 const pending=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 const scoped=await service.draft(owner,{entity:'business-definition',scope:'SOC',body:view(),requestId:randomUUID()})
 const done=await service.draft(owner,{entity:'role',body:role('已丢弃'),requestId:randomUUID()})
 await service.settle(owner,{requestId:randomUUID(),draftId:done.id,expectedBodyHash:done.bodyHash,outcome:'discarded'})
 await service.draft(actor(),{entity:'role',body:role('别人的'),requestId:randomUUID()})
 const before=(await pool.query('select id,status,updated_at from teloa_page_create_drafts where owner_id=$1 order by id',[owner.ownerId])).rows
 const result=await service.pendingForAttention(owner)
 assert.deepEqual(result.drafts.map(item=>item.id).sort(),[pending.id,scoped.id].sort())
 assert.equal(result.truncated,false)
 assert.deepEqual(result.drafts.find(item=>item.id===scoped.id)?.bodyHash,scoped.bodyHash)
 assert.deepEqual((await service.pendingForAttention({...owner,scopeIds:[]})).drafts.map(item=>item.id),[pending.id])
 assert.deepEqual((await pool.query('select id,status,updated_at from teloa_page_create_drafts where owner_id=$1 order by id',[owner.ownerId])).rows,before)
})

test('对话应用先检查归属与摘要，真实写回后重复应用不再次创建',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 let writes=0
 const write=async()=>{writes++;return 'role-created-once'}
 await assert.rejects(()=>service.read(actor(),{draftId:draft.id}),{code:'teloa/forbidden'})
 await assert.rejects(()=>service.apply(actor(),{draftId:draft.id,expectedBodyHash:draft.bodyHash},write),{code:'teloa/forbidden'})
 await assert.rejects(()=>service.apply(owner,{draftId:draft.id,expectedBodyHash:'a'.repeat(64)},write),{code:'teloa/version-conflict'})
 assert.equal(writes,0)
 const applied=await service.apply(owner,{draftId:draft.id,expectedBodyHash:draft.bodyHash},write)
 assert.equal(applied.status,'applied');assert.equal(applied.appliedRef,'role-created-once')
 const again=await service.apply(owner,{draftId:draft.id,expectedBodyHash:draft.bodyHash},write)
 assert.deepEqual(again,applied);assert.equal(writes,1)
 assert.deepEqual(await service.read(owner,{draftId:draft.id}),applied)
 await assert.rejects(()=>service.apply(owner,{draftId:draft.id,expectedBodyHash:'b'.repeat(64)},write),{code:'teloa/version-conflict'})
 assert.equal(writes,1)
})

test('写入失败保留草案；同一草案并发应用由行锁串行，只创建一次',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 await assert.rejects(()=>service.apply(owner,{draftId:draft.id,expectedBodyHash:draft.bodyHash},async()=>{throw Error('failed')}),/failed/)
 assert.equal((await service.read(owner,{draftId:draft.id})).status,'draft')
 let writes=0
 const apply=()=>service.apply(owner,{draftId:draft.id,expectedBodyHash:draft.bodyHash},async()=>{writes++;await new Promise(resolve=>setTimeout(resolve,20));return 'created-concurrently'})
 const results=await Promise.all([apply(),apply()])
 assert.equal(writes,1);assert.deepEqual(results[0],results[1])
})

test('新业务范围键未登记也能读取目录；键格式不合规一律拒绝',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 const saved=await service.draft(owner,{entity:'business-domain',scope:'recruiting',body:businessDomainBody('recruiting'),requestId:randomUUID()})
 assert.equal(saved.scope,'recruiting')
 const directory=await service.directory(owner,{entity:'business-domain',scope:'recruiting'})
 assert.equal(directory.drafts[0]?.id,saved.id)
 await assert.rejects(()=>service.draft(owner,{entity:'business-domain',scope:'招聘',body:businessDomainBody('招聘'),requestId:randomUUID()}),{code:'teloa/invalid-input'})
 await assert.rejects(()=>service.directory(owner,{entity:'business-domain',scope:'招聘'}),{code:'teloa/invalid-input'})
})

test('业务登记后仍能只读定位本人原草案；读取不会重建或返回别人的原稿',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 const saved=await service.draft(owner,{entity:'business-domain',scope:'SOC',body:businessDomainBody('SOC'),requestId:randomUUID()})
 const applied=await service.apply(owner,{draftId:saved.id,expectedBodyHash:saved.bodyHash},async()=> 'existing-business')
 const directory=await service.directory(owner,{entity:'business-domain',scope:'SOC'})
 assert.deepEqual(directory.drafts,[applied])
 assert.equal((await service.directory(actor(),{entity:'business-domain',scope:'SOC'})).drafts.length,0)
 assert.deepEqual(await service.read(owner,{draftId:saved.id}),applied)
})

test('事务读取仍核对库中正文，篡改后的草案不能静默返回',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 const db=await pool.connect()
 try{
  await db.query("update teloa_page_create_drafts set body='{}' where owner_id=$1 and id=$2",[owner.ownerId,draft.id])
  await assert.rejects(()=>service.draftInTransaction(db,owner.ownerId,draft.id),{code:'teloa/storage-corrupt'})
  await assert.rejects(()=>service.draftInTransaction(db,'local:'+randomUUID(),draft.id),{code:'teloa/forbidden'})
 }finally{db.release()}
})

const draftOrigin=()=>({sessionId:'draft-origin-'+randomUUID(),messageId:'message-'+randomUUID(),messageSeq:2,requestId:randomUUID()})
const revisionGuard=()=>({assertCurrent:async()=>{},method:async()=>{}})
test('本人新消息续改原草稿保留身份、原正文和确认边界，旧预览失效且重放不重复写',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),origin=draftOrigin(),first=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID(),origin}),acceptedSource={...origin,messageId:'latest-message',messageSeq:5,requestId:randomUUID()},requestId=randomUUID()
 const next=await service.revise(owner,{draftId:first.id,expectedBodyHash:first.bodyHash,entity:'role',body:role('修订后的同事'),requestId,acceptedSource},revisionGuard())
 assert.equal(next.id,first.id);assert.equal(next.requestId,first.requestId);assert.equal(next.entity,first.entity);assert.equal(next.scope,first.scope);assert.equal(next.createdAt,first.createdAt);assert.equal(next.status,'draft');assert.equal(next.appliedRef,undefined);assert.notEqual(next.bodyHash,first.bodyHash)
 const history=(await pool.query('select * from teloa_page_create_draft_revisions where owner_id=$1 and draft_id=$2',[owner.ownerId,first.id])).rows;assert.equal(history.length,1);assert.equal(history[0].previous_body,first.body);assert.equal(history[0].previous_body_hash,first.bodyHash);assert.equal(history[0].body,next.body);assert.deepEqual(history[0].accepted_source,acceptedSource)
 await assert.rejects(service.revise(owner,{draftId:first.id,expectedBodyHash:next.bodyHash,entity:'role',body:role('不得重放'),requestId,acceptedSource},revisionGuard()),{code:'teloa/conflict'})
 await assert.rejects(service.settle(owner,{draftId:first.id,expectedBodyHash:first.bodyHash,requestId:randomUUID(),outcome:'discarded'}),{code:'teloa/version-conflict'})
 await assert.rejects(service.draft(owner,{entity:'role',body:role(),requestId:first.requestId,origin}),{code:'teloa/conflict'})
 assert.equal((await service.read(owner,{draftId:first.id})).bodyHash,next.bodyHash,'原创建工具的旧调用不能覆盖后续本人修改')
 assert.deepEqual(await service.origin(owner,{draftId:first.id,expectedBodyHash:next.bodyHash}),{draftId:first.id,bodyHash:next.bodyHash,sessionId:origin.sessionId})
})
test('同次修改丢失回执后只读恢复成功，变更重放或后续正文不能冒原回执',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),origin=draftOrigin(),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID(),origin}),input={draftId:draft.id,expectedBodyHash:draft.bodyHash,entity:'role' as const,body:role('已保存修订'),requestId:randomUUID(),acceptedSource:{...origin,messageId:'next-message',messageSeq:4}}
 const saved=await service.revise(owner,input,revisionGuard()),before=(await pool.query('select xmin::text as transaction,* from teloa_page_create_drafts where owner_id=$1',[owner.ownerId])).rows
 let restoring=false
 assert.deepEqual(await service.revise(owner,input,{assertCurrent:async()=>{},method:async(_db,_draft,_body,_hash,isRestore)=>{restoring=isRestore}}),saved);assert.equal(restoring,true)
 assert.deepEqual((await pool.query('select xmin::text as transaction,* from teloa_page_create_drafts where owner_id=$1',[owner.ownerId])).rows,before)
 assert.equal((await pool.query('select count(*)::int n from teloa_page_create_draft_revisions where owner_id=$1',[owner.ownerId])).rows[0].n,1)
 for(const changed of [{body:role('另一正文')},{acceptedSource:{...input.acceptedSource,messageId:'different-source'}},{expectedBodyHash:'b'.repeat(64)}])await assert.rejects(service.revise(owner,{...input,...changed},revisionGuard()),{code:'teloa/conflict'})
 await assert.rejects(service.revise(owner,input,{assertCurrent:async()=>{throw Object.assign(Error(),{code:'teloa/forbidden'})},method:async()=>{}}),{code:'teloa/forbidden'})
 await service.revise(owner,{...input,expectedBodyHash:saved.bodyHash,requestId:randomUUID(),body:role('更晚的修订')},revisionGuard())
 await assert.rejects(service.revise(owner,input,revisionGuard()),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_page_create_draft_revisions where owner_id=$1',[owner.ownerId])).rows[0].n,2)
})
test('两个并发修改只接受同一原稿摘要的一次，另一项必须重新核对',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),origin=draftOrigin(),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID(),origin})
 const results=await Promise.allSettled(['甲','乙'].map(name=>service.revise(owner,{draftId:draft.id,expectedBodyHash:draft.bodyHash,entity:'role',body:role(name),requestId:randomUUID(),acceptedSource:{...origin,messageSeq:3}},revisionGuard())))
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.code,'teloa/version-conflict')
 assert.equal((await pool.query('select count(*)::int n from teloa_page_create_draft_revisions where owner_id=$1',[owner.ownerId])).rows[0].n,1)
})
test('旧创建调用在续改行锁前开始等待，也不能用旧语句快照覆盖刚提交的修改',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),origin=draftOrigin(),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID(),origin}),application='draft-create-race-'+randomUUID(),otherPool=new Pool({connectionString:container.getConnectionUri(),application_name:application}),oldService=new PageCreateDraftService(otherPool,identity)
 let release!:()=>void,ready!:()=>void,checks=0;const gate=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>ready=resolve)
 const revision=service.revise(owner,{draftId:draft.id,expectedBodyHash:draft.bodyHash,entity:'role',body:role('必须保留的后续修改'),requestId:randomUUID(),acceptedSource:origin},{method:async()=>{},assertCurrent:async()=>{if(++checks===2){ready();await gate}}})
 await entered
 const old=oldService.draft(owner,{entity:'role',body:role('过时创建调用'),requestId:draft.requestId,origin}),observed=old.then(value=>({value}),error=>({error}))
 try{
  let waiting=false
  for(let attempt=0;attempt<100;attempt++){
   const rows=(await pool.query("select wait_event_type,query from pg_stat_activity where application_name=$1",[application])).rows
   if(rows.some(row=>row.wait_event_type==='Lock'&&row.query.includes('for update'))){waiting=true;break}
   await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.equal(waiting,true,'旧创建调用必须实际等待续改持有的原行锁，不能凭时间推断并发')
  release();const next=await revision,result=await observed;assert.ok('error'in result);assert.equal(result.error.code,'teloa/conflict')
  assert.equal((await service.read(owner,{draftId:draft.id})).bodyHash,next.bodyHash)
  assert.equal((await pool.query('select count(*)::int n from teloa_page_create_draft_revisions where owner_id=$1',[owner.ownerId])).rows[0].n,1)
 }finally{release();await Promise.allSettled([revision,observed]);await otherPool.end()}
})
test('跨本人、跨原会话、更换实体或归属、已落定与无来源的草稿均不能借续改重建',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),origin=draftOrigin(),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID(),origin}),input={draftId:draft.id,expectedBodyHash:draft.bodyHash,entity:'role' as const,body:role('变更'),requestId:randomUUID(),acceptedSource:origin}
 await assert.rejects(service.revise(actor(),input,revisionGuard()),{code:'teloa/forbidden'})
 await assert.rejects(service.revise(owner,{...input,acceptedSource:{...origin,sessionId:'other'}},revisionGuard()),{code:'teloa/forbidden'})
 await assert.rejects(service.revise(owner,{...input,entity:'skill'},revisionGuard()),{code:'teloa/forbidden'})
 await assert.rejects(service.revise(owner,{...input,scope:'other'},revisionGuard()),{code:'teloa/forbidden'})
 await assert.rejects(service.revise(owner,{...input,body:{...role('变更'),scopes:['other']}},revisionGuard()),{code:'teloa/forbidden'})
 await service.settle(owner,{draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'discarded',requestId:randomUUID()})
 await assert.rejects(service.revise(owner,input,revisionGuard()),{code:'teloa/version-conflict'})
 const legacy=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 await assert.rejects(service.origin(owner,{draftId:legacy.id,expectedBodyHash:legacy.bodyHash}),{code:'teloa/source-unavailable'})
 const applied=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID(),origin});await service.apply(owner,{draftId:applied.id,expectedBodyHash:applied.bodyHash},async()=> 'existing-role')
 await assert.rejects(service.revise(owner,{...input,draftId:applied.id,expectedBodyHash:applied.bodyHash},revisionGuard()),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_page_create_draft_revisions where owner_id=$1',[owner.ownerId])).rows[0].n,0)
})
test('提交前本人指令撤回会回滚正文和旧稿回执，不留下半份修改',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),origin=draftOrigin(),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID(),origin});let checks=0
 await assert.rejects(service.revise(owner,{draftId:draft.id,expectedBodyHash:draft.bodyHash,entity:'role',body:role('不得保留'),requestId:randomUUID(),acceptedSource:origin},{assertCurrent:async()=>{if(++checks===2)throw Object.assign(Error('指令撤回'),{code:'teloa/version-conflict'})},method:async()=>{}}),{code:'teloa/version-conflict'})
 assert.deepEqual(await service.read(owner,{draftId:draft.id}),draft);assert.equal((await pool.query('select count(*)::int n from teloa_page_create_draft_revisions where owner_id=$1',[owner.ownerId])).rows[0].n,0)
})
test('计划续改可调整原暂停草稿，但不能借修改启用或换计划与业务',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),origin=draftOrigin(),schedule={kind:'schedule',cadence:'daily',weekday:1,time:'11:00',timezone:'Asia/Singapore'},work={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:4,maxTokens:10000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:1,stagnationRounds:2,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 const original={definition:{executor:{kind:'owner'},roleId:null,title:'客户摘要',goal:'整理提供的反馈',scope:'general',dataScope:'本人提供资料',delivery:'摘要与待办',trigger:schedule,notificationPolicy:'attention'},work,intent:'save-paused',source:{artifactId:randomUUID(),version:1,basisHash:'a'.repeat(64)}},draft=await service.draft(owner,{entity:'plan',body:original,requestId:randomUUID(),origin}),input={draftId:draft.id,expectedBodyHash:draft.bodyHash,entity:'plan' as const,requestId:randomUUID(),acceptedSource:origin}
 for(const body of [{...original,intent:'create-and-enable'},{...original,definition:{...original.definition,scope:'SOC'}},{kind:'configure-work',planId:randomUUID(),expectedVersion:1,expectedConfigVersion:1,work,intent:'save-paused'}])await assert.rejects(service.revise(owner,{...input,body},revisionGuard()),{code:'teloa/forbidden'})
 const changed=await service.revise(owner,{...input,body:{...original,definition:{...original.definition,title:'修订客户摘要'}}},revisionGuard())
 assert.equal(JSON.parse(changed.body).intent,'save-paused');assert.equal(changed.id,draft.id);assert.equal(changed.status,'draft')
})
