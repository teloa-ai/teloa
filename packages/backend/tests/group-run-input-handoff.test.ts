import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtemp,rm,statfs} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {ArtifactFile,GroupMessage,GroupRoutingDecision,MessageReference,DigitalRole} from '@teloa/contract'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {RoleService} from '../src/work/roles.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupAttachmentService} from '../src/work/group-attachments.ts'
import {GroupRoutingDecisionService} from '../src/work/group-routing-decisions.ts'
import {GroupRoutingOutboxService} from '../src/work/group-routing-outbox.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskService} from '../src/work/tasks.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {readRunGroupContext,type RunGroupFilePorts} from '../src/work/task-run-group-context.ts'
import {ArtifactService} from '../src/work/artifacts.ts'
import {ArtifactSnapshotStore} from '../src/work/artifact-snapshots.ts'
import {taskArtifactSource,taskArtifactSessions} from '../src/work/artifact-task-source.ts'

let container:StartedPostgreSqlContainer|undefined,pool:Pool,root:string|undefined
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:15000}).trim()
const previous={host:process.env.DOCKER_HOST,socket:process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE,ryuk:process.env.TESTCONTAINERS_RYUK_DISABLED}
async function space(){const value=await statfs(tmpdir());assert.ok(Number(value.bavail)*Number(value.bsize)>=20*1024**3+256*1024**2,'保持20GiB及本轮PG预算')}
before(async()=>{
 await space()
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 process.env.TESTCONTAINERS_RYUK_DISABLED='true'
 const image=docker('image','inspect','postgres:17-alpine','--format','{{.Id}}')
 container=await new PostgreSqlContainer('postgres:17-alpine').withTmpFs({'/var/lib/postgresql/data':'rw,size=128m'}).withResourcesQuota({memory:0.25}).start()
 assert.equal(docker('inspect',container.getId(),'--format','{{.Image}}'),image)
 assert.equal(Number(docker('inspect',container.getId(),'--format','{{.HostConfig.Memory}}')),256*1024**2)
 assert.equal(JSON.parse(docker('inspect',container.getId(),'--format','{{json .HostConfig.Tmpfs}}'))['/var/lib/postgresql/data'],'rw,size=128m')
 root=await mkdtemp(join(tmpdir(),'teloa-group-input-handoff-'))
 pool=new Pool({connectionString:container.getConnectionUri(),max:4})
 await initializeTeloaDatabase(pool,{businessSqlSecretPath:join(root,'reader.json')})
})
after(async()=>{
 await pool?.end();await stopTestContainer(container)
 if(container)assert.equal(docker('ps','-aq','--no-trunc','--filter','id='+container.getId()),'')
 if(root)await rm(root,{recursive:true,force:false})
 for(const [key,value] of [['DOCKER_HOST',previous.host],['TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE',previous.socket],['TESTCONTAINERS_RYUK_DISABLED',previous.ryuk]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value}
 await space()
})

/** 真实正式服务及PG；路由decision与native终态仅服务层夹具，不调用模型/SDK。 */
async function fixture(kind:'attachment'|'artifact'='attachment',groupResources=0,artifactFiles=2){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 const fields={kind:'employee' as const,scopes:['general'],duty:'核对明确提供的合成资料。',dataScope:'本轮资料。',executionScope:'群内分析。',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}
 const a=await roles.create(owner,{requestId:randomUUID(),fields:{...fields,name:'编制A'}}),b=await roles.create(owner,{requestId:randomUUID(),fields:{...fields,name:'复核B'}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'输入原件交接',scope:'general',announcement:'新合成资料。',memberRoleIds:[a.id,b.id],rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:false,mentionAllAllowed:false}}})
 const body='新合成物资：南场18份，北场27份。\n',stored=new Map<string,Buffer>()
 const ports:RunGroupFilePorts={readAttachmentBytes:async(file,maxBytes)=>{const bytes=stored.get(file.attachmentId);assert.ok(bytes);if('sha256:'+sha(bytes)!==file.attachmentId)throw Object.assign(Error('ATTACHMENT_CORRUPT'),{code:'ATTACHMENT_CORRUPT'});return bytes.subarray(0,maxBytes??bytes.length)}}
 let fileReference:MessageReference
 if(kind==='attachment'){
  const attachments=new GroupAttachmentService(pool,identity,{saveFile:async(dataBase64,name)=>{const bytes=Buffer.from(dataBase64,'base64'),attachmentId='sha256:'+sha(bytes);stored.set(attachmentId,bytes);return {attachmentId,bytes:bytes.length,name}},saveImage:async()=>{throw Error('本测试不上传图片')},readBytes:async row=>{const bytes=stored.get(row.attachmentId);assert.ok(bytes);return bytes}})
  const file=await attachments.upload(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,name:'新原件.txt',mime:'text/plain',dataBase64:Buffer.from(body).toString('base64')})
  fileReference={kind:'attachment',id:file.attachmentId,version:file.version}
 }else{
  const task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'固定文件来源',goal:'保留新合成文件。',scope:'general'}}),sessionId=randomUUID()
  const inspect=async()=>({id:sessionId,ownerId:owner,sessionId,status:'ready'})
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
  const store=new ArtifactSnapshotStore(pool),snapshotIds:string[]=[]
  for(let i=0;i<artifactFiles;i++){const text=body+'文件'+i,path='固定'+i+'.txt';snapshotIds.push(await store.save(owner,{schema:'teloa.file-snapshot/v1',sessionId,id:sha(sessionId+path),path,sha256:sha(text),bytes:Buffer.byteLength(text),capturedAt:identity.now(),contentBase64:Buffer.from(text).toString('base64')}))}
  const source=await taskArtifactSource(pool,owner,task.id,false)
  const saved=await new ArtifactService(pool,identity,async(actor,expected,db)=>({source:await taskArtifactSource(db,actor,expected.id,true),sessionIds:await taskArtifactSessions(db,actor,expected.id,true)})).create(owner,{requestId:randomUUID(),source,content:{title:'新固定成果',sections:[],snapshotIds,note:'仅本测试合成。'}})
  fileReference={kind:'artifact',id:saved.artifactId,version:saved.number}
 }
 const references:MessageReference[]=[]
 for(let i=0;i<groupResources;i++){const r=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'固定资料'+i,markdown:'新合成资料'+i});references.push({kind:'group-resource',id:r.id,version:r.version})}
 references.push(fileReference)
 const grant=async(role:DigitalRole,resources:MessageReference[])=>grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources,canPost:true,canAutoRun:true})
 await grant(a,references);await grant(b,references)
 const initial=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'@编制A 先按原件写初稿，然后请复核B独立核对同一原件。',mentions:[{roleId:a.id,expectedVersion:a.version}],references})
 const outbox=new GroupRoutingOutboxService(pool,identity),decisions=new GroupRoutingDecisionService(pool,identity)
 async function prepare(message:GroupMessage,role:DigitalRole){
  const decision:GroupRoutingDecision={kind:'routed',intent:'work',respond:[role.id],reactions:[],hops:message.authorId==='self'?0:1,candidateIds:[a.id,b.id],truncatedCandidates:false,stopMessageId:null,at:identity.now(),assignments:[{roleId:role.id,instructionRange:{start:0,end:message.text.length}}],workTarget:null}
  const items=await decisions.withTopicLock(owner,group.id,message.rootId??message.id,async db=>{await decisions.record(db,owner,{groupId:group.id,messageId:message.id,decision});return outbox.recordRecipients(db,owner,{groupId:group.id,messageId:message.id,decision,decisionVersion:1})})
  const item=items[0];assert.ok(item)
  const claimed=await outbox.claim(owner,{itemId:item.id,expectedLeaseGeneration:0}),created=await new GroupTaskService(pool,identity,tasks).create(owner,await outbox.taskInput(owner,{itemId:item.id}))
  assert.ok(claimed)
  const sessionId=randomUUID(),inspect=async()=>({id:sessionId,ownerId:owner,sessionId,status:'ready'})
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,currentRole,refs,selection)=>readRunGroupContext(db,actor,task,currentRole,ports,pool,refs,selection)})
  const run=await runs.prepare(owner,{requestId:item.requestId,taskId:created.task.id,expectedTaskVersion:created.task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})
  assert.equal(run.agentPresetId,'standard')
  await outbox.reserveSubmission(owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration,taskId:created.task.id,runId:run.id})
  return {runs,run,item,claimed}
 }
 const parent=await prepare(initial,a);assert.equal(parent.run.groupContext?.files.length,kind==='attachment'?1:artifactFiles)
 await parent.runs.claim(owner,{runId:parent.run.id})
 await parent.runs.record(owner,{runId:parent.run.id,sessionId:parent.run.sessionId,nativeRequestId:parent.run.nativeRequestId,evidence:{state:'accepted'}})
 await parent.runs.record(owner,{runId:parent.run.id,sessionId:parent.run.sessionId,nativeRequestId:parent.run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 await outbox.settle(owner,{itemId:parent.item.id,leaseGeneration:parent.claimed.leaseGeneration,taskId:parent.run.taskId,runId:parent.run.id,state:'settled',reason:null})
 const publisher=new GroupRunMessageService(pool,identity,undefined,ports,outbox),input={requestId:parent.run.nativeRequestId,runId:parent.run.id,text:'已按原件整理。@复核B 请独立核对原附件并给复核。'}
 return {owner,a,b,group,body,stored,ports,references,fileReference,grant,grants,groups,parent,publisher,input,prepare}
}

test('J06-ATTACH001：A正常回帖保留固定原附件，B同版本授权后正式prepare收到完整正文',async()=>{
 const f=await fixture(),posted=await f.publisher.post(f.owner,f.input)
 assert.deepEqual(posted.references,f.references)
 assert.deepEqual(await f.publisher.post(f.owner,f.input),posted,'同nonce只读原回执，不新增引用/消息')
 const child=await f.prepare(posted,f.b),file=child.run.groupContext?.files[0];assert.ok(file)
 assert.equal(file.text,f.body);assert.equal(file.sha256,sha(f.body));assert.equal(file.version,f.fileReference.version)
 assert.equal(child.run.lineage?.parentRunId,f.parent.run.id)
 assert.deepEqual(child.run.groupContext?.ownerRequest,f.parent.run.groupContext?.ownerRequest)
})

test('J06-ATTACH001：保留引用不替B授予权限，B缺少对应原件授权仍拒绝',async()=>{
 const f=await fixture();await f.grant(f.b,[])
 const posted=await f.publisher.post(f.owner,f.input);assert.deepEqual(posted.references,f.references)
 await assert.rejects(f.prepare(posted,f.b),{code:'teloa/forbidden'})
 const current=await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.b.id});assert.ok(current)
 assert.ok(current.grant)
 assert.deepEqual(current.grant.resources,[])
})

test('同一固定成果展开多个文件只回传一条artifact引用，B仍收到各文件',async()=>{
 const f=await fixture('artifact'),posted=await f.publisher.post(f.owner,f.input)
 assert.deepEqual(posted.references,[f.fileReference])
 const child=await f.prepare(posted,f.b);assert.equal(child.run.groupContext?.files.length,2)
 assert.deepEqual(child.run.groupContext?.files.map(file=>file.text),[f.body+'文件0',f.body+'文件1'])
})

test('八条混合输入引用保持完整，输出声明沿原满额降级且不留孤儿成果',async()=>{
 const f=await fixture('attachment',7),reported:string[]=[]
 const publisher=new GroupRunMessageService(pool,identity,{readClaimedFile:async()=>{throw Error('满额不得现读输出')},report:code=>reported.push(code)},f.ports)
 const before=(await pool.query('select count(*)::int as n from teloa_artifacts where owner_id=$1',[f.owner])).rows[0].n
 const posted=await publisher.post(f.owner,{...f.input,files:[{path:'额外.txt',sha256:sha('额外')}]})
 assert.deepEqual(posted.references,f.references);assert.equal(posted.references.length,8)
 assert.match(posted.text,/有 1 件文件未能贴出/);assert.deepEqual(reported,['teloa/conflict'])
 assert.equal((await pool.query('select count(*)::int as n from teloa_artifacts where owner_id=$1',[f.owner])).rows[0].n,before)
})

test('固定输入成果已展开八文件时，输出在capture前跳过且B仍能读取原八文件',async()=>{
 const f=await fixture('artifact',0,8),reported:string[]=[]
 const publisher=new GroupRunMessageService(pool,identity,{readClaimedFile:async()=>{throw Error('展开文件满额不得capture')},report:code=>reported.push(code)},f.ports,f.publisher.routing)
 const before=(await pool.query('select count(*)::int as n from teloa_artifacts where owner_id=$1',[f.owner])).rows[0].n
 const posted=await publisher.post(f.owner,{...f.input,files:[{path:'额外.txt',sha256:sha('额外')}]})
 assert.deepEqual(posted.references,[f.fileReference]);assert.match(posted.text,/有 1 件文件未能贴出/)
 assert.deepEqual(reported,['teloa/conflict'])
 assert.equal((await pool.query('select count(*)::int as n from teloa_artifacts where owner_id=$1',[f.owner])).rows[0].n,before)
 assert.equal((await f.prepare(posted,f.b)).run.groupContext?.files.length,8)
})

test('输出只使用剩余展开文件额度，原完整claims请求身份及输入成果保持',async()=>{
 const f=await fixture('artifact',0,7),reported:string[]=[],captured:string[]=[]
 const content='额外新合成文件',publisher=new GroupRunMessageService(pool,identity,{readClaimedFile:async(sessionId,claim):Promise<ArtifactFile>=>{
  captured.push(claim.path);return {schema:'teloa.file-snapshot/v1',sessionId,id:sha(sessionId+claim.path),path:claim.path,sha256:sha(content),bytes:Buffer.byteLength(content),capturedAt:identity.now(),contentBase64:Buffer.from(content).toString('base64')}
 },report:code=>reported.push(code)},f.ports)
 const files=[{path:'甲.txt',sha256:sha(content)},{path:'乙.txt',sha256:sha(content)}],posted=await publisher.post(f.owner,{...f.input,files})
 assert.equal(captured.length,1);assert.deepEqual(posted.references[0],f.fileReference);assert.equal(posted.references.length,2)
 assert.match(posted.text,/有 1 件文件未能贴出/);assert.deepEqual(reported,['teloa/conflict'])
 const output=posted.references[1];assert.ok(output)
 const saved=(await pool.query('select a.request_id,v.content from teloa_artifacts a join teloa_artifact_versions v on v.owner_id=a.owner_id and v.artifact_id=a.id where a.owner_id=$1 and a.id=$2',[f.owner,output.id])).rows[0]
 assert.equal(saved.content.snapshotIds.length,1)
 const digest=sha(['teloa/group-run-artifact/v1',f.owner,f.parent.run.id,...files.map(file=>`${file.path}\0${file.sha256}`).sort()].join('\0'))
 const variant=((parseInt(digest.slice(16,17),16)&3)|8).toString(16)
 assert.equal(saved.request_id,`${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-${variant}${digest.slice(17,20)}-${digest.slice(20,32)}`)
})

test('历史同nonce回执按原引用返回，不把旧空references回填为新输入引用',async()=>{
 const f=await fixture(),posted=await f.publisher.post(f.owner,f.input)
 // 仅本自有PG的旧版持久形状夹具；不改原实际失败证据或任何运行现场。
 await pool.query("update teloa_group_messages set reference_snapshot='[]'::jsonb where owner_id=$1 and id=$2",[f.owner,posted.id])
 const replay=await f.publisher.post(f.owner,f.input)
 assert.equal(replay.id,posted.id);assert.deepEqual(replay.references,[])
 assert.deepEqual((await pool.query('select reference_snapshot from teloa_group_messages where owner_id=$1 and id=$2',[f.owner,posted.id])).rows[0].reference_snapshot,[])
})

test('A当前授权撤回或原件字节损坏时不能借旧固定输入新发回帖',async()=>{
 for(const change of ['grant','bytes'] as const){
  const f=await fixture()
  if(change==='grant')await f.grant(f.a,[])
  else f.stored.set(f.fileReference.id,Buffer.from('内容已变化'))
  await assert.rejects(f.publisher.post(f.owner,f.input),{code:change==='grant'?'teloa/forbidden':'teloa/source-unavailable'})
  assert.equal((await pool.query('select count(*)::int as n from teloa_group_messages where owner_id=$1 and run_id=$2',[f.owner,f.parent.run.id])).rows[0].n,0)
 }
})
