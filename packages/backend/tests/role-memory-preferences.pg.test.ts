import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {setupRoleWork,insertRoleRun,ownerAuthority} from './role-work-test-fixture.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {RoleMemoryService,readRunRoleMemories} from '../src/work/role-memory.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {readPreference} from '../src/work/role-memory-preferences.ts'
import {RoleDailyLogService} from '../src/work/role-daily-logs.ts'
import {AutoDreamHabitService} from '../src/work/auto-dream-habits.ts'
import {AUTO_DREAM_DEFAULT_TRIGGER} from '../src/work/auto-dream-plans.ts'
import {BusinessDataService} from '../src/work/business-data.ts'
import {BusinessTaskService} from '../src/work/business-tasks.ts'
import {SecurityRequestJournal} from '../src/security/request-journal.ts'
import {SecurityActionService} from '../src/security/actions.ts'
import {SecurityApprovalService} from '../src/security/approvals.ts'
import {createSecurityEndpointIsolateDefinition} from '../src/security/action-authorization.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {ArtifactAvailabilityService} from '../src/work/artifact-availability.ts'
import type {DigitalRole} from '@teloa/contract'

let f:Awaited<ReturnType<typeof setupRoleWork>>
before(async()=>{f=await setupRoleWork();await initializeTeloaDatabase(f.pool)},{timeout:120000})
after(async()=>{await f?.close()})
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const goal='For future review notes, start with the decision and cite evidence. For this task only, use a compact table.'

async function world(scope='general',existing?:{owner:string;role:DigitalRole}){
 const owner=existing?.owner??randomUUID(),roles=new RoleService(f.pool,identity),role=existing?.role??(scope==='general'?await roles.ensurePersonalTwin(owner):await roles.create(owner,{requestId:randomUUID(),fields:{name:'双业务本人分身',kind:'twin',scopes:['SOC','AppSec'],duty:'代拟与核对',dataScope:'本人已授权来源',executionScope:'只产候选',skills:[],knowledge:[],responsibility:testRoleResponsibility}})),service=new RoleMemoryService(f.pool,identity)
 const tasks=new TaskService(f.pool,identity,ownerAuthority),task=await tasks.createConfirmed(owner,{requestId:randomUUID(),fields:{title:'本人偏好来源',goal,scope},assignee:{roleId:role.id,expectedVersion:role.version}})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
 await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(f.pool,identity,inspect,{allowedTools:[],roleMemory:(db,who,target,current,ids)=>service.confirmedForRun(db,who,{scope:target.scope,taskId:target.taskId,groupId:target.groupId??null,memoryViewId:target.memoryViewId??null},current,undefined,ids)})
 const prepare=async()=>{const current=(await tasks.list(owner,{})).find(t=>t.id===task.id)!;return runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:current.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1},async()=>role.skills.map(name=>({name,provider:'test-contract',source:'fixture',description:name,content:name,sha256:createHash('sha256').update(name).digest('hex')})),undefined,undefined,async()=> 'default-agent')}
 const run=await prepare()
 await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'active',turn:0,messageSeq:1}})
 const runId=run.id
 return {owner,role,task,runId,run,runs,prepare,service,human:{ownerId:owner,kind:'human' as const},agent:{ownerId:owner,kind:'agent' as const,roleId:role.id}}
}
type World=Awaited<ReturnType<typeof world>>
function proposal(x:World,kind='preference',extra:Record<string,unknown>={}){
 return {schema:'teloa.preference-candidate/v1',kind,scope:x.task.scope,...(kind==='one-off'||kind==='counterexample'?{taskId:x.task.id}:{}),basis:{kind:'owner-input',quote:kind==='one-off'||kind==='counterexample'?'For this task only, use a compact table.':'For future review notes, start with the decision and cite evidence.'},...Object.fromEntries(Object.entries(extra).filter(([key])=>key!=='markdown'))}
}
async function create(x:World,kind='preference',extra:Record<string,unknown>={},title='合成评审结构'){
 return x.service.create(x.agent,{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,title,markdown:extra.markdown??'先给结论并引用依据。',preference:proposal(x,kind,extra),source:{kind:'run',id:x.runId,version:1},visibility:{kind:'private',scopeIds:[]}})
}
async function confirm(x:World,m:Awaited<ReturnType<typeof create>>){return x.service.confirm(x.human,{requestId:randomUUID(),memoryId:m.id,expectedStateVersion:m.stateVersion})}
const against=(m:Awaited<ReturnType<typeof create>>)=>({memoryId:m.id,version:m.content.version,contentHash:m.content.contentHash})
const current=(x:World,taskId?:string,selectedIds?:string[])=>x.service.confirmedForRun(f.pool,x.owner,{scope:x.task.scope,groupId:null,memoryViewId:null,...(taskId?{taskId}:{})},x.role,undefined,selectedIds)

test('分身 Run 可提出有固定本人依据的偏好；仍为候选，长期与一次性按实际 Task 消费',async()=>{
 const x=await world(),p=await create(x),once=await create(x,'one-off',{},'本次表格例外')
 assert.equal((await create(x)).id,p.id,'JSONB 字段顺序不应破坏同源同参语义候选的去重')
 assert.equal(p.state,'candidate');assert.equal(p.content.markdown.includes('"schema"'),false)
 assert.deepEqual(await current(x,x.task.id),[])
 await confirm(x,p);await confirm(x,once)
 assert.deepEqual((await current(x)).map(m=>m.id),[p.id])
 const inside=await current(x,x.task.id);assert.deepEqual(new Set(inside.map(m=>m.id)),new Set([p.id,once.id]))
 assert.equal(inside.find(m=>m.id===once.id)?.preference?.kind,'one-off')
 assert.equal(inside.find(m=>m.id===p.id)?.preference?.kind,'preference')
 assert.deepEqual(readRunRoleMemories(inside),inside)
})

test('已确认反例只覆盖本次 Task；撤回反例不恢复该 Task 已被明确排除的旧默认',async()=>{
 const x=await world(),p=await confirm(x,await create(x)),exception=await confirm(x,await create(x,'counterexample',{against:against(p),markdown:'本任务只用紧凑表格；其它任务仍用原默认。'}))
 assert.deepEqual((await current(x,x.task.id)).map(m=>m.id),[exception.id])
 assert.deepEqual((await current(x)).map(m=>m.id),[p.id])
 await x.service.withdraw(x.human,{requestId:randomUUID(),memoryId:exception.id,expectedStateVersion:exception.stateVersion})
 assert.deepEqual(await current(x,x.task.id),[])
 assert.deepEqual((await current(x)).map(m=>m.id),[p.id])
 assert.equal((await x.service.readVersion(x.human,{roleId:x.role.id,memoryId:p.id,version:1})).content.markdown,p.content.markdown)
})

test('明确更正在同一消费链替代固定旧版，撤回更正不复活旧版；冻结选项不偷偷追加新记忆',async()=>{
 const x=await world(),p=await confirm(x,await create(x)),correction=await confirm(x,await create(x,'correction',{against:against(p),markdown:'后续默认先列证据，再给结论。'}))
 assert.deepEqual((await current(x)).map(m=>m.id),[correction.id])
 assert.deepEqual(await current(x,undefined,[p.id]),[])
 await assert.rejects(create(x,'correction',{against:against(p)}),{code:'teloa/version-conflict'})
 await x.service.withdraw(x.human,{requestId:randomUUID(),memoryId:correction.id,expectedStateVersion:correction.stateVersion})
 assert.deepEqual(await current(x),[])
 const historic=await x.service.readVersion(x.human,{roleId:x.role.id,memoryId:p.id,version:1});assert.equal(historic.content.contentHash,p.content.contentHash)
})

test('本人编辑保留一次性范围及可追溯旧版，不因正文包含长期措辞自动升级；重放返回固定回执',async()=>{
 const x=await world(),once=await confirm(x,await create(x,'one-off',{},'本次格式'))
 const input={requestId:randomUUID(),roleId:x.role.id,memoryId:once.id,expectedContentVersion:once.content.version,expectedContentHash:once.content.contentHash,expectedStateVersion:once.stateVersion,title:once.title,markdown:'Always use the revised layout in this test.'}
 const edited=await x.service.edit(x.human,input);assert.deepEqual(await x.service.edit(x.human,input),edited)
 assert.equal((await current(x,x.task.id))[0]?.preference?.kind,'one-off');assert.deepEqual(await current(x),[])
 assert.equal((await readPreference(f.pool,x.owner,edited.id,edited.content.version,edited.content.contentHash))?.ownerEdit?.requestId,input.requestId)
 assert.equal((await x.service.readVersion(x.human,{roleId:x.role.id,memoryId:once.id,version:1})).content.contentHash,once.content.contentHash)
})

test('更正确认前原偏好已被编辑时拒绝旧版本关系，不能凭不同标题绕过版本核验',async()=>{
 const x=await world(),p=await confirm(x,await create(x)),candidate=await create(x,'correction',{against:against(p)},'另一个标题')
 await x.service.edit(x.human,{requestId:randomUUID(),roleId:x.role.id,memoryId:p.id,expectedContentVersion:p.content.version,expectedContentHash:p.content.contentHash,expectedStateVersion:p.stateVersion,title:p.title,markdown:'本人已另行更正当前版本。'})
 await assert.rejects(confirm(x,candidate),{code:'teloa/version-conflict'})
 const withdrawn=await world(),old=await confirm(withdrawn,await create(withdrawn)),pending=await create(withdrawn,'correction',{against:against(old)},'原版本已撤回')
 await withdrawn.service.withdraw(withdrawn.human,{requestId:randomUUID(),memoryId:old.id,expectedStateVersion:old.stateVersion})
 await assert.rejects(confirm(withdrawn,pending),{code:'teloa/version-conflict'})
})

test('他人、另一 Task、工具返回及员工接力不能成为本人偏好依据',async()=>{
 const x=await world(),foreign=await world()
 await assert.rejects(create(x,'preference',{basis:{kind:'owner-input',quote:'UNSEEN_TOOL_OUTPUT'}}),{code:'teloa/forbidden'})
 await assert.rejects(create(x,'one-off',{taskId:foreign.task.id}),{code:'teloa/forbidden'})
 await assert.rejects(create(x,'preference',{basis:{kind:'owner-confirmation'}}),{code:'teloa/forbidden'})
 await assert.rejects(create(x,'preference',{scope:'SOC'}),{code:'teloa/forbidden'})
 const other=await confirm(foreign,await create(foreign));await assert.rejects(create(x,'correction',{against:against(other)}),{code:'teloa/forbidden'})
 await assert.rejects(x.service.create(x.agent,{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,title:'跨本人来源',markdown:'原文',preference:proposal(x),source:{kind:'run',id:foreign.runId,version:1},visibility:{kind:'private',scopeIds:[]}}),{code:'teloa/forbidden'})
 await assert.rejects(x.service.confirmedForRun(f.pool,x.owner,{scope:'general',groupId:null,memoryViewId:null,taskId:foreign.task.id},x.role),{code:'teloa/forbidden'})
 // 缺少本人交办谱系的受控反例，不修改或关闭正式不可变谱系触发器。
 const orphan=randomUUID(),at=identity.now()
 await f.pool.query("insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,assignee_role_id,assignee_role_version,created_at,updated_at) values($1,$2,$3,'{}',$4,1,'ready',$5,$6,$7,$7)",[orphan,x.owner,randomUUID(),JSON.stringify({title:'未核实来源',goal,scope:'general',groupId:null,skills:[]}),x.role.id,x.role.version,at])
 const orphanRun=await insertRoleRun(f.pool,x.owner,x.role.id,orphan,'active')
 await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[orphanRun,JSON.stringify({task:{id:orphan,version:1,title:'未核实来源',goal,scope:'general'}})])
 await assert.rejects(create({...x,runId:orphanRun,task:{...x.task,id:orphan}}),{code:'teloa/forbidden'})
})

test('语义候选不能借 C1 自动保存跳过明确确认，旧普通 Markdown 仍可按原流程保存',async()=>{
 const x=await world()
 await assert.rejects(x.service.remember(x.human,{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,title:'试图自动确认偏好',markdown:'原文',preference:proposal(x),source:{kind:'habit-digest',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}}),{code:'teloa/forbidden'})
 const old=await x.service.create(x.human,{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,title:'原有本人笔记',markdown:'只保留事实，不自动归类。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}})
 assert.equal(old.state,'candidate');assert.equal(old.content.markdown,'只保留事实，不自动归类。')
})

test('群源只接受该 Run 已绑定的本人消息，不接受员工回帖作为本人偏好',async()=>{
 const x=await world(),groups=new CollaborationService(f.pool,identity),group=await groups.create(x.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'受控来源核对',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
 const self=await groups.send(x.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:goal})
 const input=(messageId:string)=>JSON.stringify({task:{id:x.task.id,version:1,title:x.task.title,goal,scope:'general'},groupContext:{groupId:group.id,source:{messageId,text:goal}}})
 await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[x.runId,input(self.id)])
 assert.equal((await create(x)).state,'candidate')
 const employeeMessage=randomUUID()
 await f.pool.query("insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id) values($1,$2,$3,$4,'{}',$5,$6,$7,'[]',now(),$8,$9)",[employeeMessage,x.owner,group.id,randomUUID(),self.id,x.role.id,goal,x.task.id,x.runId])
 await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[x.runId,input(employeeMessage)])
 await assert.rejects(create(x),{code:'teloa/forbidden'})
})

async function habit(x:World,reason:string){
 const scope='SOC',sourceId='security-alert-http',principal={ownerId:x.owner,approverId:'local-self',scopeIds:[scope]},at=identity.now()
 const alert={scope,type:'alert',id:'evt-'+randomUUID().slice(0,8),version:1,title:'合成审批来源',source:'test',observedAt:at,receivedAt:at,quality:'complete' as const,summary:'隔离来源验证',fields:[{label:'资产',value:'test-host'}]}
 const data=new BusinessDataService(f.pool,{id:sourceId,scopes:[scope],query:async()=>({schema:'teloa.data-source-page/v1',sourceId,scope,capturedAt:at,items:[alert]})})
 const snapshot=(await data.query(principal,{scope,limit:10})).items[0]!
 const {task}=await new BusinessTaskService(f.pool,identity,new TaskService(f.pool,identity)).create(principal,{requestId:randomUUID(),reference:{scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'核对合成来源'})
 const definition=createSecurityEndpointIsolateDefinition(),catalog={require:()=>definition},journal=new SecurityRequestJournal(f.pool),actions=new SecurityActionService(f.pool,identity,catalog,journal,{existsForAction:async()=>false})
 const p=await actions.propose(principal,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,title:'合成隔离审批',goal:'验证来源',tool:definition.tool,targetSet:['test-host'],params:{reason:'已核对合成资产'}})
 const pending=await actions.submit(principal,{requestId:randomUUID(),actionId:p.id,expectedActionVersion:p.version})
 const approval=await new SecurityApprovalService(f.pool,identity,catalog,journal).decide(principal,{requestId:randomUUID(),actionId:pending.id,expectedActionVersion:pending.version,decision:'approved',reason,impactConfirmed:true})
 const logs=new RoleDailyLogService(f.pool,identity,x.service),habits=new AutoDreamHabitService(f.pool,identity,logs,async()=>({enabled:true,trigger:{...AUTO_DREAM_DEFAULT_TRIGGER,time:'00:00',timezone:'UTC'}}))
 const log=await habits.ensureForDay(x.owner,x.role,identity.now());assert.ok(log)
 const sample=(await x.service.list(x.human,{roleId:x.role.id})).find(m=>m.source.kind==='habit-digest')!;assert.ok(sample);assert.equal(sample.content.markdown,log.markdown)
 return {logs,log,sample,approval,task,basis:{kind:'habit-observation',quote:reason,memoryId:sample.id,version:sample.content.version,contentHash:sample.content.contentHash,evidenceId:approval.id}}
}

test('C1 事实经正常 prepare 冻结后才可提议：统计、未选观察、改版与撤回均不能冒充有效语义依据',async()=>{
 const x=await world('SOC'),h=await habit(x,'以后评审请先给结论，随后列出证据。')
 await assert.rejects(create(x,'preference',{basis:h.basis}),{code:'teloa/forbidden'},'本 Run 尚未选入后生成的观察')
 await x.runs.record(x.owner,{runId:x.runId,sessionId:x.run.sessionId,nativeRequestId:x.run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'aborted'}})
 const run=await x.prepare();assert.ok(run.memory.some(m=>m.id===h.sample.id));assert.deepEqual(JSON.parse(run.inputText).memory.contents,run.memory)
 await x.runs.claim(x.owner,{runId:run.id});await x.runs.record(x.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'active',turn:0,messageSeq:1}})
 const selected={...x,runId:run.id}
 await assert.rejects(create(selected,'preference',{basis:{...h.basis,quote:'当天新建任务 1 条。'}}),{code:'teloa/forbidden'})
 await assert.rejects(create(selected,'preference',{basis:{...h.basis,evidenceId:randomUUID()}}),{code:'teloa/version-conflict'})
 const p=await confirm(x,await create(selected,'preference',{basis:h.basis},'有本人理由的偏好'))
 const pending=await create(selected,'preference',{basis:h.basis,markdown:'待确认的另一项提议。'},'另一个待确认项')
 assert.ok((await current(x)).some(m=>m.id===p.id))
 const edited=await x.service.edit(x.human,{requestId:randomUUID(),roleId:x.role.id,memoryId:h.sample.id,expectedContentVersion:1,expectedContentHash:h.sample.content.contentHash,expectedStateVersion:h.sample.stateVersion,title:h.sample.title,markdown:'本人修改后的观察，不再等于原日志。'})
 await assert.rejects(confirm(x,pending),{code:'teloa/version-conflict'})
 assert.equal((await current(x)).some(m=>m.id===p.id),false)
 await assert.rejects(create(selected,'preference',{basis:h.basis}),{code:'teloa/version-conflict'})
 await x.service.withdraw(x.human,{requestId:randomUUID(),memoryId:edited.id,expectedStateVersion:edited.stateVersion})
 const own=await x.service.edit(x.human,{requestId:randomUUID(),roleId:x.role.id,memoryId:p.id,expectedContentVersion:1,expectedContentHash:p.content.contentHash,expectedStateVersion:p.stateVersion,title:p.title,markdown:'这是本人重新明确写下的长期默认。'})
 assert.ok((await current(x)).some(m=>m.id===own.id),'本人明确的新版本以此次编辑为依据，保留原版本来源而不复活旧观察')
 assert.equal((await readPreference(f.pool,x.owner,p.id,1,p.content.contentHash))?.basis.kind,'habit-observation')
 assert.equal((await readPreference(f.pool,x.owner,own.id,own.content.version,own.content.contentHash))?.basis.kind,'owner-confirmation')
})

test('本人修订只使用已冻结并展示的成果版本；未展示、原员工正文、改版和撤回均不升级为偏好',async()=>{
 const x=await world(),artifactId=randomUUID(),employee=await new RoleService(f.pool,identity).create(x.owner,{requestId:randomUUID(),fields:{name:'来源员工',kind:'employee',scopes:['general'],duty:'核对来源',dataScope:'已授权资料',executionScope:'分析',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const task=await new TaskService(f.pool,identity).create(x.owner,{requestId:randomUUID(),fields:{title:'原员工成果来源',goal:'分析固定材料',scope:'general'}}),origin=await insertRoleRun(f.pool,x.owner,employee.id,task.id,'ended')
 const quote='后续评审请逐条列明证据。',body=(text:string)=>({title:'合成成果',sections:[{id:'s1',title:'结论',text}],snapshotIds:[],note:'来源闸测试'})
 // 受控历史与 Run 固定快照只验证来源闸，不冒充模型生成、宿主文件渲染或实际采用。
 await f.pool.query("insert into teloa_artifacts values($1,$2,$3,'{}',$4,2)",[artifactId,x.owner,randomUUID(),artifactId])
 for(const [number,source,text] of [[1,{kind:'run',id:origin,scope:'general',version:'1',title:'初版'},'员工原始结论。'],[2,{kind:'session',id:'owner-editor',scope:'general',version:'2',title:'本人修订'},quote]] as const)await f.pool.query('insert into teloa_artifact_versions values($1,$2,$3,$4,$5,$6)',[x.owner,artifactId,number,JSON.stringify(source),JSON.stringify(body(text)),identity.now()])
 const basis={kind:'owner-revision',artifactId,version:2,quote}
 await assert.rejects(create(x,'preference',{basis}),{code:'teloa/forbidden'})
 const original=JSON.parse(x.run.inputText),file={kind:'artifact',id:artifactId,version:2,sha256:createHash('sha256').update(quote).digest('hex'),mime:'text/markdown',bytes:Buffer.byteLength(quote),name:'review.md',text:quote}
 await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[x.runId,JSON.stringify({...original,groupContext:{files:[file]}})])
 const p=await confirm(x,await create(x,'preference',{basis},'本人修订产生的候选'))
 const metadata=(await current(x))[0]?.preference;assert.ok(metadata&&metadata.kind!=='observation');assert.equal(metadata.basis.kind,'owner-revision')
 await assert.rejects(create(x,'preference',{basis:{...basis,quote:'未展示的新内容'}}),{code:'teloa/forbidden'})
 await assert.rejects(create(x,'preference',{basis:{...basis,version:1}}),{code:'teloa/invalid-input'})
 const pending=await create(x,'preference',{basis,markdown:'同版本的另一条候选。'},'待确认来源')
 await f.pool.query('insert into teloa_artifact_versions values($1,$2,3,$3,$4,$5)',[x.owner,artifactId,JSON.stringify({kind:'session',id:'owner-editor',scope:'general',version:'3',title:'新修订'}),JSON.stringify(body('新的本人修订。')),identity.now()])
 await f.pool.query('update teloa_artifacts set current_version=3 where owner_id=$1 and id=$2',[x.owner,artifactId])
 assert.equal((await current(x)).some(m=>m.id===p.id),false)
 await assert.rejects(confirm(x,pending),{code:'teloa/version-conflict'})
 const nextText='新的本人修订。',source={kind:'session' as const,id:'owner-editor',scope:'general',version:'3',title:'新修订'}
 await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[x.runId,JSON.stringify({...original,groupContext:{files:[{...file,version:3,text:nextText,sha256:createHash('sha256').update(nextText).digest('hex'),bytes:Buffer.byteLength(nextText)}]}})])
 const next=await confirm(x,await create(x,'preference',{basis:{...basis,version:3,quote:nextText}},'新版修订候选'))
 assert.ok((await current(x)).some(m=>m.id===next.id))
 await new ArtifactAvailabilityService(f.pool,identity.now).withdraw(x.owner,{requestId:randomUUID(),artifactId,expectedVersion:3,source})
 assert.equal((await current(x)).some(m=>m.id===next.id),false)
})

test('双业务分身的合法 C1 注入保持源业务：SOC 正例、AppSec 长期和一次性反例、本人新声明正例',async()=>{
 const x=await world('SOC'),h=await habit(x,'以后 SOC 审批先核对生产影响。')
 const finish=(env:World)=>env.runs.record(env.owner,{runId:env.runId,sessionId:env.run.sessionId,nativeRequestId:env.run.nativeRequestId,evidence:{state:'ended' as const,turn:0,messageSeq:1,endSeq:2,reason:'aborted' as const}})
 await finish(x)
 const run=await x.prepare();await x.runs.claim(x.owner,{runId:run.id});await x.runs.record(x.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'active',turn:0,messageSeq:1}})
 const soc={...x,runId:run.id,run};assert.ok(run.memory.some(m=>m.id===h.sample.id));assert.deepEqual(JSON.parse(run.inputText).memory.contents,run.memory)
 const p=await confirm(soc,await create(soc,'preference',{basis:h.basis},'SOC 审批偏好'))
 const once=await create(soc,'one-off',{basis:h.basis,taskId:undefined},'原 SOC 审批一次性例外'),metadata=await readPreference(f.pool,soc.owner,once.id,1,once.content.contentHash)
 assert.equal(metadata?.scope,'SOC');assert.equal(metadata?.basis.originScope,'SOC');assert.equal(metadata?.taskId,h.task.id)
 await finish(soc)
 const app=await world('AppSec',{owner:x.owner,role:x.role})
 assert.ok(app.run.memory.some(m=>m.id===h.sample.id),'跨业务反例也必须是合法已注入的同一本人私有观察')
 assert.deepEqual(JSON.parse(app.run.inputText).memory.contents,app.run.memory)
 for(const kind of ['preference','one-off'])await assert.rejects(create(app,kind,{basis:h.basis,taskId:undefined},'不得迁移 SOC 审批依据'),{code:'teloa/forbidden'})
 const declared=await app.service.create(app.human,{requestId:randomUUID(),roleId:app.role.id,expectedRoleVersion:app.role.version,title:'AppSec 本人新声明',markdown:'AppSec 按本人现在明确的要求执行。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]},preference:{schema:'teloa.preference-candidate/v1',kind:'preference',scope:'AppSec',basis:{kind:'owner-confirmation'}}})
 await confirm(app,declared)
 const consumed=await current(app);assert.ok(consumed.some(m=>m.id===declared.id));assert.equal(consumed.some(m=>m.id===p.id),false)
 assert.equal((await readPreference(f.pool,app.owner,declared.id,1,declared.content.contentHash))?.basis.kind,'owner-confirmation')
 assert.equal((await h.logs.get(x.human,{roleId:x.role.id,logId:h.log.id})).log.markdown,h.log.markdown)
})

test('满额时连续三十次明确更正不耗尽私有位置；撤回不复活，普通第31条仍拒绝，C1及历史保留',{timeout:120000},async()=>{
 const x=await world(),h=await habit(x,'这是一条仅用于配额回归的事实观察。'),original=await confirm(x,await create(x)),history=[original]
 const ordinary=(index:number)=>x.service.create(x.human,{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,title:'独立记忆 '+index,markdown:'本人独立保存的内容 '+index,source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}})
 for(let i=0;i<29;i++)await confirm(x,await ordinary(i))
 let latest=original
 for(let i=1;i<=30;i++){
  const candidate=await x.service.create(x.human,{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,title:'明确更正 '+i,markdown:'本人现在明确的评审规则 '+i,source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]},preference:{schema:'teloa.preference-candidate/v1',kind:'correction',scope:'general',basis:{kind:'owner-confirmation'},against:against(latest)}})
  latest=await confirm(x,candidate);history.push(latest)
 }
 const active=await current(x);assert.ok(active.some(m=>m.id===latest.id));assert.equal(active.filter(m=>m.preference?.kind==='preference'||m.preference?.kind==='correction').length,1)
 await x.service.withdraw(x.human,{requestId:randomUUID(),memoryId:latest.id,expectedStateVersion:latest.stateVersion})
 const after=await current(x);assert.equal(after.some(m=>history.some(old=>old.id===m.id)),false)
 const reopened=await confirm(x,await ordinary(29));assert.equal(reopened.state,'confirmed')
 const over=await ordinary(30);await assert.rejects(confirm(x,over),{code:'teloa/conflict',message:'分身私有记忆最多确认 30 条；请先撤回不再适用的记忆。'})
 const audit=await x.service.list(x.human,{roleId:x.role.id});assert.ok(history.every(old=>audit.some(m=>m.id===old.id)));assert.equal(audit.find(m=>m.id===h.sample.id)?.state,'confirmed')
 assert.equal((await x.service.readVersion(x.human,{roleId:x.role.id,memoryId:original.id,version:1})).content.contentHash,original.content.contentHash)
 assert.equal((await h.logs.get(x.human,{roleId:x.role.id,logId:h.log.id})).log.markdown,h.log.markdown)
})
