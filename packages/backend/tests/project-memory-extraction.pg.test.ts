import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {ProjectMemoryExtractionService,initializeProjectMemoryExtraction,type ProjectExtractionEvent,type ProjectExtractionPolicy,type ProjectExtractionProposal,type ProjectMemoryExtractionPorts} from '../src/work/project-memory-extraction.ts'

let pool:Pool,container:StartedPostgreSqlContainer
before(async()=>{
 container=await new PostgreSqlContainer('postgres:16-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri(),max:5,statement_timeout:5000})
 await initializeProjectMemoryExtraction(pool)
 await pool.query(`
  create table test_extraction_policies(owner_id text not null,session_id text not null,policy jsonb not null,context_version integer not null default 0,primary key(owner_id,session_id));
  create table test_extraction_entries(owner_id text not null,project_id uuid not null,id uuid primary key,kind text not null,topic text not null,markdown text not null,version integer not null,active boolean not null default true);
  create table test_extraction_sources(owner_id text not null,source_id text not null,available boolean not null,primary key(owner_id,source_id));
 `)
})
after(async()=>{await pool?.end();await stopTestContainer(container)})
async function fixture(){
 const owner=randomUUID(),projectId=randomUUID(),sessionId='session-'+randomUUID(),messageId=randomUUID(),sourceId=`message:${sessionId}:${messageId}`
 const event:ProjectExtractionEvent={eventId:randomUUID(),projectId,sessionId,messageId,sourceId,derivedSourceIds:[],bindingVersion:1,policyVersion:1,evidence:[{id:'decision',kind:'decision',text:'请记住：验收使用隔离目录。',assertion:'验收使用隔离目录。'}]}
 const policy:ProjectExtractionPolicy={projectId,bindingVersion:1,policyVersion:1,memoryEnabled:true,automatic:'decisions'}
 const proposal:ProjectExtractionProposal={kind:'memory',topic:'验收目录',markdown:'验收使用隔离目录。',evidence:[{evidenceId:'decision',quote:'验收使用隔离目录。'}]}
 await pool.query('insert into test_extraction_policies(owner_id,session_id,policy) values($1,$2,$3)',[owner,sessionId,policy])
 let clock=Date.now(),generate:ProjectMemoryExtractionPorts['generate']=async()=>[proposal]
 const identity={id:randomUUID,now:()=>new Date(clock).toISOString()}
 const ports:ProjectMemoryExtractionPorts={
  readPolicy:async(db,actor,input)=>{const row=(await db.query('select policy from test_extraction_policies where owner_id=$1 and session_id=$2 for update',[actor,input.sessionId])).rows[0];return row?.policy??null},
  sourceAvailable:async(db,actor,input)=>!(await db.query('select 1 from test_extraction_sources where owner_id=$1 and source_id=any($2::text[]) and not available',[actor,[input.sourceId,...input.derivedSourceIds]])).rowCount,
  generate:async(input,signal)=>generate(input,signal),
  readCurrent:async(db,actor,input)=>{
   const context=(await db.query("select context_version from test_extraction_policies where owner_id=$1 and policy->>'projectId'=$2",[actor,input.projectId])).rows[0]
   const row=(await db.query('select id,version,kind,topic,markdown from test_extraction_entries where owner_id=$1 and project_id=$2 and kind=$3 and lower(topic)=lower($4) and active',[actor,input.projectId,input.kind,input.topic])).rows[0]
   return {contextVersion:context.context_version,...(row?{entry:row}:{})}
  },
  save:async(db,actor,input)=>{
   const state=await ports.readCurrent(db,actor,input)
   if(state.contextVersion!==input.expectedContextVersion||input.entryId&&(state.entry?.id!==input.entryId||state.entry.version!==input.expectedEntryVersion))throw new WorkError('teloa/version-conflict','受控测试并发冲突')
   const id=input.entryId??randomUUID(),version=(state.entry?.version??0)+1
   if(state.entry&&!input.entryId)throw new WorkError('teloa/conflict','受控测试同主题冲突')
   await db.query('insert into test_extraction_entries(owner_id,project_id,id,kind,topic,markdown,version) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set markdown=excluded.markdown,version=excluded.version',[actor,input.projectId,id,input.kind,input.topic,input.markdown,version])
   await db.query("update test_extraction_policies set context_version=context_version+1 where owner_id=$1 and policy->>'projectId'=$2",[actor,input.projectId])
   return {entryId:id,entryVersion:version,contextVersion:state.contextVersion+1}
  },
  withdraw:async(db,actor,input)=>{await db.query('update test_extraction_entries set active=false where owner_id=$1 and project_id=$2 and id=$3 and version=$4',[actor,input.projectId,input.entryId,input.expectedEntryVersion])}
 }
 const options={maxEvents:2,maxAttempts:3,modelTimeoutMs:1000,leaseMs:2000,retryDelayMs:1}
 const service=new ProjectMemoryExtractionService(pool,identity,ports,options)
 const entries=async()=> (await pool.query('select * from test_extraction_entries where owner_id=$1 and active',[owner])).rows
 const changePolicy=async(change:Partial<ProjectExtractionPolicy>)=>{Object.assign(policy,change);await pool.query('update test_extraction_policies set policy=$3 where owner_id=$1 and session_id=$2',[owner,sessionId,policy])}
 const sourceUnavailable=async(id=sourceId)=>{await pool.query('insert into test_extraction_sources values($1,$2,false) on conflict(owner_id,source_id) do update set available=false',[owner,id])}
 return {owner,event,proposal,policy,ports,identity,options,service,entries,changePolicy,sourceUnavailable,setGenerate:(value:typeof generate)=>{generate=value},advance:()=>{clock+=10000}}
}

test('真实 PostgreSQL 恢复后仅提交一次同来源决定，不重复提炼同主题',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event)
 const recovered=new ProjectMemoryExtractionService(pool,f.identity,f.ports,f.options)
 const result=await recovered.drain(f.owner)
 assert.equal(result.completed,1)
 const first=await f.entries();assert.equal(first.length,1);assert.equal(first[0].markdown,'验收使用隔离目录。')
 assert.equal((await recovered.enqueue(f.owner,f.event)).status,'completed')
 await recovered.drain(f.owner)
 assert.equal((await f.entries())[0].version,1)
})
test('归档保留真实PG原事件并无尝试暂缓，继续其他项目；处理中归档后恢复只保存一次',async()=>{
 const f=await fixture();await f.changePolicy({blocked:'archived'})
 assert.equal((await f.service.enqueue(f.owner,f.event)).status,'queued')
 const other={...f.event,eventId:randomUUID(),projectId:randomUUID(),sessionId:'other-'+randomUUID(),messageId:randomUUID(),sourceId:'other:'+randomUUID()}
 await pool.query('insert into test_extraction_policies(owner_id,session_id,policy) values($1,$2,$3)',[f.owner,other.sessionId,{...f.policy,projectId:other.projectId,blocked:undefined}])
 await f.service.enqueue(f.owner,other);let calls=0
 f.setGenerate(async()=>{calls++;return [f.proposal]})
 assert.equal((await f.service.drain(f.owner)).completed,1);assert.equal(calls,1,'归档事件不调模型，另一项目继续')
 const stored=async()=>(await pool.query('select status,attempts,lease_token,next_attempt_at from teloa_project_extraction_events where owner_id=$1 and event_id=$2',[f.owner,f.event.eventId])).rows[0]
 assert.equal((await stored()).status,'queued');assert.equal((await stored()).attempts,0);assert.equal((await stored()).lease_token,null)
 assert.ok(Date.parse((await stored()).next_attempt_at)>Date.parse(f.identity.now()))
 delete f.policy.blocked;await f.changePolicy({});f.advance()
 f.setGenerate(async()=>{calls++;await f.changePolicy({blocked:'archived'});throw Error('fixed prepared admission invalidated by archive')})
 await f.service.drain(f.owner)
 assert.equal((await stored()).status,'queued');assert.equal((await stored()).attempts,0)
 assert.equal((await f.entries()).filter(entry=>entry.project_id===f.event.projectId).length,0)
 delete f.policy.blocked;await f.changePolicy({});f.advance();f.setGenerate(async()=>{calls++;return [f.proposal]})
 assert.equal((await f.service.drain(f.owner)).completed,1)
 assert.equal((await f.service.enqueue(f.owner,f.event)).status,'completed');await f.service.drain(f.owner)
 assert.equal((await f.entries()).filter(entry=>entry.project_id===f.event.projectId).length,1)
 assert.equal((await stored()).attempts,1);assert.equal(calls,3)
})
test('关闭会话记忆、暂停、归属不符或来源不可读时不入持久队列',async()=>{
 for(const change of [{memoryEnabled:false},{automatic:'paused' as const},{bindingVersion:2},{policyVersion:2},{projectId:randomUUID()}]){
  const f=await fixture();await f.changePolicy(change)
  assert.equal((await f.service.enqueue(f.owner,f.event)).status,'discarded')
  assert.equal((await pool.query('select count(*)::int n from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].n,0)
 }
 const f=await fixture();await f.sourceUnavailable();assert.equal((await f.service.enqueue(f.owner,f.event)).status,'discarded')
})
test('同一可信事件换正文或模型伪造来源不能借幂等入口写入',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event)
 await assert.rejects(f.service.enqueue(f.owner,{...f.event,evidence:[{...f.event.evidence[0]!,text:'不同原消息'}]}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.enqueue(f.owner,{...f.event,messageId:'different'}),{code:'teloa/conflict'})
 assert.equal((await f.service.enqueue(f.owner,{...f.event,eventId:randomUUID()})).eventId,f.event.eventId)
 await assert.rejects(f.service.enqueue('',f.event),{code:'teloa/forbidden'})
 await assert.rejects(f.service.enqueue(f.owner,{...f.event,ownerId:'fabricated'} as ProjectExtractionEvent),{code:'teloa/invalid-input'})
})
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
test('提炼进行中暂停或归属/策略换代后迟到模型结果不能提交',async()=>{
 for(const change of [{automatic:'paused' as const,policyVersion:2},{bindingVersion:2},{policyVersion:2},{memoryEnabled:false}]){
  const f=await fixture(),started=deferred(),release=deferred()
  f.setGenerate(async()=>{started.resolve();await release.promise;return [f.proposal]})
  await f.service.enqueue(f.owner,f.event);const running=f.service.drain(f.owner);await started.promise
  await f.changePolicy(change);release.resolve()
  assert.equal((await running).discarded,1);assert.equal((await f.entries()).length,0)
  assert.equal((await f.service.enqueue(f.owner,f.event)).status,'discarded')
 }
})
test('未获宿主确认的文本只保留候选，本人显式接受可在暂停状态保存并幂等回执',async()=>{
 const f=await fixture(),{assertion:_,...evidence}=f.event.evidence[0]!
 await f.service.enqueue(f.owner,{...f.event,evidence:[evidence]});await f.service.drain(f.owner)
 assert.equal((await f.entries()).length,0)
 const rows=await f.service.listCandidates(f.owner,{projectId:f.event.projectId});assert.equal(rows.length,1);assert.equal(rows[0]!.status,'candidate')
 assert.deepEqual(await f.service.listCandidates(randomUUID(),{projectId:f.event.projectId}),[])
 await f.changePolicy({automatic:'paused',policyVersion:2})
 const request={candidateId:rows[0]!.id,action:'accept' as const,expectedContextVersion:0,requestId:randomUUID()}
 const accepted=await f.service.resolveCandidate(f.owner,request)
 assert.equal(accepted.status,'applied');assert.equal((await f.entries()).length,1)
 assert.deepEqual(await f.service.resolveCandidate(f.owner,{requestId:request.requestId,action:request.action,candidateId:request.candidateId,expectedContextVersion:request.expectedContextVersion}),accepted)
 await assert.rejects(f.service.resolveCandidate(f.owner,{...request,action:'reject'}),{code:'teloa/conflict'})
})
test('同主题不同正文保留冲突，未明确纠正不覆盖，明确接受校验当前版本',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event);await f.service.drain(f.owner)
 const changed={...f.proposal,markdown:'验收使用另一份隔离目录。',evidence:[{evidenceId:'decision',quote:'验收使用另一份隔离目录。'}]}
 const event={...f.event,eventId:randomUUID(),messageId:'next',sourceId:'next:'+randomUUID(),evidence:[{id:'decision',kind:'decision' as const,text:'请记住：验收使用另一份隔离目录。',assertion:changed.markdown}]}
 f.setGenerate(async()=>[changed]);await f.service.enqueue(f.owner,event);await f.service.drain(f.owner)
 const row=(await f.service.listCandidates(f.owner,{projectId:f.event.projectId}))[0]
 assert.ok(row)
 assert.equal(row.status,'conflict');assert.equal((await f.entries())[0].markdown,'验收使用隔离目录。')
 await assert.rejects(f.service.resolveCandidate(f.owner,{candidateId:row.id,action:'accept',expectedContextVersion:0,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 await f.service.resolveCandidate(f.owner,{candidateId:row.id,action:'accept',expectedContextVersion:1,requestId:randomUUID()})
 assert.equal((await f.entries())[0].markdown,changed.markdown);assert.equal((await f.entries())[0].version,2)
})
test('本人明确纠正只修订匹配真实条目版本，不产生另一同主题条目',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event);await f.service.drain(f.owner)
 const old=(await f.entries())[0],markdown='验收仅处理本人授权的隔离目录。',proposal={...f.proposal,markdown,evidence:[{evidenceId:'correction',quote:markdown}]}
 const event={...f.event,eventId:randomUUID(),messageId:'correction',sourceId:'correction:'+randomUUID(),evidence:[{id:'correction',kind:'decision' as const,text:markdown,assertion:markdown,correction:{entryId:old.id,entryVersion:1}}]}
 f.setGenerate(async()=>[proposal]);await f.service.enqueue(f.owner,event);await f.service.drain(f.owner)
 const entries=await f.entries();assert.equal(entries.length,1);assert.equal(entries[0].version,2);assert.equal(entries[0].markdown,markdown)
})
test('同事件同主题互斥提议只留一份带双方依据的冲突，不能最后写入胜出',async()=>{
 const f=await fixture(),alternative={...f.proposal,markdown:'另一种目录策略。'}
 f.setGenerate(async()=>[f.proposal,alternative]);await f.service.enqueue(f.owner,f.event);await f.service.drain(f.owner)
 const rows=await f.service.listCandidates(f.owner,{projectId:f.event.projectId})
 assert.equal(rows.length,1);assert.equal(rows[0]!.status,'conflict');assert.equal(rows[0]!.alternatives[0]!.markdown,'另一种目录策略。');assert.equal((await f.entries()).length,0)
 await f.service.resolveCandidate(f.owner,{candidateId:rows[0]!.id,action:'reject',expectedContextVersion:0,requestId:randomUUID()})
 assert.deepEqual(await f.service.listCandidates(f.owner,{projectId:f.event.projectId}),[])
})
test('来源忘记撤回派生条目，重启及跨消息派生来源都不能再提炼',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event);await f.service.drain(f.owner)
 assert.equal((await f.service.forgetSource(f.owner,{sourceId:f.event.sourceId})).withdrawnEntries,1)
 assert.equal((await f.entries()).length,0)
 const derived={...f.event,eventId:randomUUID(),messageId:'derived',sourceId:'derived:'+randomUUID(),derivedSourceIds:[f.event.sourceId]}
 const service=new ProjectMemoryExtractionService(pool,f.identity,f.ports,f.options)
 assert.equal((await service.enqueue(f.owner,derived)).status,'discarded');assert.equal((await service.drain(f.owner)).processed,0)
})
test('提炼时来源被撤回或不可读后晚到结果不写入，也不暴露来源候选',async()=>{
 for(const forget of [false,true]){
  const f=await fixture(),started=deferred(),release=deferred()
  f.setGenerate(async()=>{started.resolve();await release.promise;return [f.proposal]})
  await f.service.enqueue(f.owner,f.event);const running=f.service.drain(f.owner);await started.promise
  if(forget)await f.service.forgetSource(f.owner,{sourceId:f.event.sourceId});else await f.sourceUnavailable()
  release.resolve();await running
  assert.equal((await f.entries()).length,0);assert.deepEqual(await f.service.listCandidates(f.owner,{projectId:f.event.projectId}),[])
 }
})
test('失败不抛回原工作，原持久事件可恢复重试，连续失败达到上限后停止',async()=>{
 const f=await fixture();f.setGenerate(async()=>{throw Error('controlled model unavailable')})
 await f.service.enqueue(f.owner,f.event);assert.equal((await f.service.drain(f.owner)).failed,1);assert.equal((await f.entries()).length,0)
 f.advance();f.setGenerate(async()=>[f.proposal]);const recovered=new ProjectMemoryExtractionService(pool,f.identity,f.ports,f.options)
 assert.equal((await recovered.drain(f.owner)).completed,1);assert.equal((await f.entries()).length,1)
 const exhausted=await fixture();exhausted.setGenerate(async()=>{throw Error('controlled model unavailable')});await exhausted.service.enqueue(exhausted.owner,exhausted.event)
 for(let i=0;i<3;i++){await exhausted.service.drain(exhausted.owner);exhausted.advance()}
 assert.equal((await exhausted.service.enqueue(exhausted.owner,exhausted.event)).status,'failed')
 exhausted.setGenerate(async()=>[exhausted.proposal]);assert.equal((await exhausted.service.drain(exhausted.owner)).processed,0)
})
test('进程失去租约可恢复，同本人并发 drain 不重复提交，单次处理数量有界',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event)
 await pool.query("update teloa_project_extraction_events set status='processing',attempts=1,lease_token=$3,lease_until=$4 where owner_id=$1 and event_id=$2",[f.owner,f.event.eventId,randomUUID(),'2000-01-01T00:00:00Z'])
 const results=await Promise.all([f.service.drain(f.owner),new ProjectMemoryExtractionService(pool,f.identity,f.ports,f.options).drain(f.owner)])
 assert.equal(results.reduce((n,r)=>n+r.completed,0),1);assert.equal((await f.entries())[0].version,1)
 const bounded=await fixture()
 for(let i=0;i<3;i++)await bounded.service.enqueue(bounded.owner,{...bounded.event,eventId:randomUUID(),messageId:'bounded-'+i,sourceId:'bounded-'+i+':'+randomUUID()})
 assert.equal((await bounded.service.drain(bounded.owner)).processed,2)
 assert.equal((await bounded.service.drain(bounded.owner)).processed,1)
 assert.equal((await bounded.entries()).length,1);assert.equal((await bounded.entries())[0].version,1)
})
test('忘记沿已登记事件的多级派生链传播，冷恢复不能只换一个来源身份绕过',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event);await f.service.drain(f.owner)
 const derived={...f.event,eventId:randomUUID(),messageId:'first-derived',sourceId:'first-derived:'+randomUUID(),derivedSourceIds:[f.event.sourceId]}
 await f.service.enqueue(f.owner,derived);await f.service.drain(f.owner)
 await f.service.forgetSource(f.owner,{sourceId:f.event.sourceId})
 const third={...f.event,eventId:randomUUID(),messageId:'second-derived',sourceId:'second-derived:'+randomUUID(),derivedSourceIds:[derived.sourceId]}
 assert.equal((await f.service.enqueue(f.owner,third)).status,'discarded')
 assert.equal((await f.entries()).length,0)
 const fourth={...third,eventId:randomUUID(),sourceId:'third-derived:'+randomUUID(),derivedSourceIds:[third.sourceId]}
 assert.equal((await f.service.enqueue(f.owner,fourth)).status,'discarded')
})
test('关闭记忆会话的原始来源即使以后经另一会话导入仍禁止自动提炼',async()=>{
 const f=await fixture();await f.changePolicy({memoryEnabled:false})
 await f.service.enqueue(f.owner,f.event)
 await f.changePolicy({memoryEnabled:true,policyVersion:2})
 const derived={...f.event,eventId:randomUUID(),sourceId:'new-session-source:'+randomUUID(),derivedSourceIds:[f.event.sourceId],policyVersion:2}
 assert.equal((await f.service.enqueue(f.owner,derived)).status,'discarded')
})
test('单独来源被忘记不撤回另一真实独立来源仍支持的相同条目',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event);await f.service.drain(f.owner)
 const independent={...f.event,eventId:randomUUID(),messageId:'independent',sourceId:'independent:'+randomUUID()}
 await f.service.enqueue(f.owner,independent);await f.service.drain(f.owner)
 assert.equal((await f.service.forgetSource(f.owner,{sourceId:f.event.sourceId})).withdrawnEntries,0)
 assert.equal((await f.entries()).length,1)
 assert.equal((await f.service.forgetSource(f.owner,{sourceId:independent.sourceId})).withdrawnEntries,1)
 assert.equal((await f.entries()).length,0)
})
test('模型适配只收到新增证据副本，修改传入事件不能篡改可信断言',async()=>{
 const f=await fixture(),{assertion:_,...evidence}=f.event.evidence[0]!
 f.setGenerate(async event=>{event.evidence[0]!.assertion=f.proposal.markdown;return [f.proposal]})
 await f.service.enqueue(f.owner,{...f.event,evidence:[evidence]});await f.service.drain(f.owner)
 assert.equal((await f.entries()).length,0)
 assert.equal((await f.service.listCandidates(f.owner,{projectId:f.event.projectId}))[0]!.status,'candidate')
})
test('不合作的模型调用也受超时约束，不占住原工作且保留可重试事件',async()=>{
 const f=await fixture();f.setGenerate(async()=>new Promise(()=>{}))
 const service=new ProjectMemoryExtractionService(pool,f.identity,f.ports,{...f.options,modelTimeoutMs:25})
 await service.enqueue(f.owner,f.event)
 assert.equal((await service.drain(f.owner)).failed,1)
 assert.equal((await f.entries()).length,0)
 f.advance();f.setGenerate(async()=>[f.proposal]);assert.equal((await service.drain(f.owner)).completed,1)
})
test('候选接受回执在来源失去访问后不能重放原正文',async()=>{
 const f=await fixture(),{assertion:_,...evidence}=f.event.evidence[0]!
 await f.service.enqueue(f.owner,{...f.event,evidence:[evidence]});await f.service.drain(f.owner)
 const row=(await f.service.listCandidates(f.owner,{projectId:f.event.projectId}))[0]!,request={candidateId:row.id,action:'accept' as const,expectedContextVersion:0,requestId:randomUUID()}
 await f.service.resolveCandidate(f.owner,request);await f.sourceUnavailable()
 await assert.rejects(f.service.resolveCandidate(f.owner,request),{code:'teloa/conflict'})
})
test('候选只在真实来源仍可读时展示原轮次和原证据，撤权后不返回证据正文',async()=>{
 const f=await fixture();delete f.event.evidence[0]!.assertion
 await f.service.enqueue(f.owner,f.event);await f.service.drain(f.owner)
 const row=(await f.service.listCandidates(f.owner,{projectId:f.event.projectId}))[0]!
 assert.deepEqual(row.source,{sessionId:f.event.sessionId,messageId:f.event.messageId})
 assert.deepEqual(row.evidence,[{kind:'decision',text:f.event.evidence[0]!.text}])
 await f.sourceUnavailable();assert.deepEqual(await f.service.listCandidates(f.owner,{projectId:f.event.projectId}),[])
})
test('上下文召回即时核自动修订真实来源，撤权未扫描也拒绝；本人新修订不继承旧许可',async()=>{
 const f=await fixture();await f.service.enqueue(f.owner,f.event);await f.service.drain(f.owner)
 const entry=(await f.entries())[0]!,db=await pool.connect()
 try{
  assert.equal(await f.service.entryAvailableInTransaction(db,f.owner,{entryId:entry.id,entryVersion:1}),true)
  await f.sourceUnavailable()
  assert.equal(await f.service.entryAvailableInTransaction(db,f.owner,{entryId:entry.id,entryVersion:1}),false)
  assert.equal(await f.service.entryAvailableInTransaction(db,f.owner,{entryId:entry.id,entryVersion:2}),true)
  assert.equal((await f.entries()).length,1,'只读核验不能改条目或重新拿本人事务锁')
 }finally{db.release()}
})
test('候选明确接受失回包后原请求恢复；错项目在首次与重放写前拒绝',async()=>{
 const f=await fixture(),{assertion:_,...evidence}=f.event.evidence[0]!
 await f.service.enqueue(f.owner,{...f.event,evidence:[evidence]});await f.service.drain(f.owner)
 const row=(await f.service.listCandidates(f.owner,{projectId:f.event.projectId}))[0]!,request={candidateId:row.id,action:'accept' as const,expectedContextVersion:0,requestId:randomUUID(),expectedProjectId:f.event.projectId}
 await assert.rejects(f.service.resolveCandidate(f.owner,{...request,expectedProjectId:randomUUID()}),{code:'teloa/conflict'})
 assert.equal((await f.entries()).length,0)
 const accepted=await f.service.resolveCandidate(f.owner,request)
 assert.deepEqual(await new ProjectMemoryExtractionService(pool,f.identity,f.ports,f.options).resolveCandidate(f.owner,request),accepted)
 assert.equal((await f.entries())[0].version,1)
 await assert.rejects(f.service.resolveCandidate(f.owner,{...request,expectedProjectId:randomUUID()}),{code:'teloa/conflict'})
 assert.equal((await f.entries())[0].version,1)
})
test('达到重试上限仅存安全错误码，本人同策略重试原事件可恢复且不重复续队',async()=>{
 const f=await fixture();f.setGenerate(async()=>{throw Error('secret-token: 不得持久化的提供方原异常')});await f.service.enqueue(f.owner,f.event)
 for(let i=0;i<3;i++){await f.service.drain(f.owner);f.advance()}
 const failures=await f.service.listFailures(f.owner,{projectId:f.event.projectId})
 assert.deepEqual(failures,[{eventId:f.event.eventId,projectId:f.event.projectId,status:'failed',attempts:3,errorCode:'teloa/dependency-unavailable',canRetry:true}])
 const stored=(await pool.query('select error_code from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].error_code
 assert.equal(stored,'teloa/dependency-unavailable')
 const request={eventId:f.event.eventId,requestId:randomUUID(),expectedProjectId:f.event.projectId}
 assert.equal((await f.service.retryEvent(f.owner,request)).status,'queued')
 f.setGenerate(async()=>[f.proposal]);await f.service.drain(f.owner)
 assert.equal((await f.service.retryEvent(f.owner,request)).status,'completed');assert.equal((await f.entries())[0].version,1)
})
test('失效策略或已撤回来源不能由本人重试复活，改绑候选不可列出',async()=>{
 const f=await fixture();f.setGenerate(async()=>{throw Error('controlled failure')});await f.service.enqueue(f.owner,f.event)
 for(let i=0;i<3;i++){await f.service.drain(f.owner);f.advance()}
 await f.changePolicy({automatic:'paused',policyVersion:2})
 assert.equal((await f.service.listFailures(f.owner,{projectId:f.event.projectId}))[0]?.canRetry,false)
 await assert.rejects(f.service.retryEvent(f.owner,{eventId:f.event.eventId,requestId:randomUUID(),expectedProjectId:f.event.projectId}),{code:'teloa/conflict'})
 const candidate=await fixture(),{assertion:_,...source}=candidate.event.evidence[0]!
 await candidate.service.enqueue(candidate.owner,{...candidate.event,evidence:[source]});await candidate.service.drain(candidate.owner)
 await candidate.changePolicy({bindingVersion:2})
 assert.deepEqual(await candidate.service.listCandidates(candidate.owner,{projectId:candidate.event.projectId}),[])
})
