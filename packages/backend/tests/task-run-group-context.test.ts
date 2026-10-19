import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {MessageReference} from '@teloa/contract'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'
import {initializeGroupWorkInputs} from '../src/work/group-work-inputs.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {RoleToolGrantService,initializeRoleToolGrants} from '../src/work/role-tool-grants.ts'
import {RoleDelegationService} from '../src/work/role-delegations.ts'
import {TwinExecutionConsentService} from '../src/work/twin-execution-consents.ts'
import {HandoffService,initializeHandoffs} from '../src/work/handoffs.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeTaskRunSubagents} from '../src/work/task-run-subagents.ts'
import {initializeTaskRunRuntimeLinks} from '../src/work/task-run-runtime-links.ts'
import {initializeTaskRunFlows} from '../src/work/task-run-flows.ts'
import {GroupAttachmentService,initializeGroupAttachments,type GroupAttachmentBytePorts} from '../src/work/group-attachments.ts'
import {ArtifactSnapshotStore,initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {groupTaskSourceDigest} from '../src/work/group-task-source-digest.ts'
import {groupFileHandleLine,groupFileTextMaxBytes,groupModelNoVisionNotice,groupPartialAttachFailedNotice,readRunGroupArtifactImageBytes,readRunGroupContext,readStoredRunGroupContext,runGroupContextHash,type RunGroupContext,type RunGroupFile,type RunGroupFilePorts} from '../src/work/task-run-group-context.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-21T09:00:00.000Z').toISOString()}
const at=(files:RunGroupFile[],index:number):RunGroupFile=>{const file=files[index];assert.ok(file);return file}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')

/** 附件字节的内存仓：上传落进来，运行上下文的端口从这里取。 */
const stored=new Map<string,Buffer>()
let readFails=false
const bytePorts:GroupAttachmentBytePorts={
 saveImage:async(dataBase64,mime)=>{const buffer=Buffer.from(dataBase64,'base64'),id='img-'+hash(buffer);stored.set(id,buffer);return {attachmentId:id,bytes:buffer.length,width:800,height:600,mediaType:mime}},
 saveFile:async(dataBase64,name)=>{const buffer=Buffer.from(dataBase64,'base64'),id='file-'+hash(buffer);stored.set(id,buffer);return {attachmentId:id,bytes:buffer.length,name}},
 readBytes:async row=>stored.get(row.attachmentId)??Buffer.alloc(0)
}
/** 端口收到的字节上限：真端口按它读够即停，桩照做并记下来。 */
const requestedMaxBytes:(number|undefined)[]=[]
const runPorts:RunGroupFilePorts={readAttachmentBytes:async(file,maxBytes)=>{
 // 桩端口按 DSH 的 ATTACHMENT_CORRUPT 映射抛出（T1 的映射把它归到 teloa/source-unavailable）。
 if(readFails)throw Object.assign(Error('ATTACHMENT_CORRUPT'),{code:'ATTACHMENT_CORRUPT'})
 requestedMaxBytes.push(maxBytes)
 const all=stored.get(file.attachmentId)??Buffer.alloc(0)
 return maxBytes===undefined?all:all.subarray(0,maxBytes)
}}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool)
 await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializeHandoffs(pool);await initializeObjectConversations(pool)
 await initializeCollaboration(pool)
 await initializeGroupTasks(pool)
 await initializeGroupWorkInputs(pool)
 await initializeGroupAgentGrants(pool)
 await initializeGroupAttachments(pool)
 await initializeArtifactSnapshots(pool)
 await initializeArtifacts(pool)
 await initializeRoleToolGrants(pool);await initializeTaskRuns(pool);await initializeTaskRunSubagents(pool);await initializeTaskRunRuntimeLinks(pool);await initializeTaskRunFlows(pool)
})
after(async()=>{await pool?.end();await container?.stop()})

const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
const groupFields=(memberRoleIds:string[])=>({name:'SOC 调查协作',scope:'SOC',announcement:'围绕固定证据协作。',rules:openGroupRules,memberRoleIds})
const roleFields={name:'调查岗',kind:'employee' as const,scopes:['SOC'],duty:'调查',dataScope:'固定证据',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}

async function fixture(kind:'employee'|'twin'='employee'){
 const owner=randomUUID(),tasks=new TaskService(pool,identity)
 const roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity),groupTasks=new GroupTaskService(pool,identity,tasks)
 let role=await roles.create(owner,{requestId:randomUUID(),fields:{...roleFields,kind}})
 if(kind==='twin'){
  await new RoleToolGrantService(pool,identity.now,async()=>{}).change(owner,{roleId:role.id,expectedRoleVersion:role.version,action:'save',rules:[{name:'read_reference',allowed:[{id:'one',version:'v1'}]}]})
  role=(await roles.get(owner,role.id))!
 }
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:groupFields([role.id])})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请核验这些原件。'})
 const authority={authorize:async()=>({assertCurrent(){}})},consents=new TwinExecutionConsentService(pool,identity,authority)
 let consent:Awaited<ReturnType<TwinExecutionConsentService['confirm']>>|undefined
 if(kind==='twin'){
  const delegation=await new RoleDelegationService(pool,identity,authority).change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{scope:'SOC',allowedTools:['read_reference'],knowledgeIds:[],memoryViewId:null,groupIds:[group.id],safeRecovery:false}})
  consent=await consents.confirm(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,authorization:{kind:'delegation',delegationId:delegation.id,delegationVersion:delegation.version}})
  await new GroupAgentGrantService(pool,identity.now).change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 }
 const created=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'形成结论。',assignee:{roleId:role.id,expectedVersion:role.version}})
 return {owner,role,group,task:created.task,source:created.source,consent,consents,attachments:new GroupAttachmentService(pool,identity,bytePorts)}
}

type Fixture=Awaited<ReturnType<typeof fixture>>

test('原群增加协作成员后，精确重授予仍在岗原负责人的资料即可沿原Task准备，不要求重建Task',async()=>{
 const f=await fixture();await wire(f,[])
 const role=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{...roleFields,name:'后续调查岗'}})
 const {scope:_scope,...fields}=groupFields([f.role.id,role.id])
 const group=await new CollaborationService(pool,identity).change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,fields:{...fields,pinned:false,archived:false}})
 await new GroupAgentGrantService(pool,identity.now).change(f.owner,{requestId:randomUUID(),groupId:group.id,roleId:f.role.id,expectedGroupVersion:group.version,expectedRoleVersion:f.role.version,expectedGrantVersion:2,action:'save',resources:[],canPost:true,canAutoRun:true})
 const result=await context(f);assert.equal(result?.taskId,f.task.id);assert.equal(result?.groupVersion,group.version)
})

/**
 * 直接改写来源快照与授权行：T6 的 send／grants 三分流与本任务并行，本用例不依赖它们落地。
 * 摘要用现行 groupTaskSourceDigest 重算，因此 T6 改摘要算法后本夹具仍自洽。
 */
async function wire(f:Fixture,references:MessageReference[],granted=references){
 const source={...f.source,references}
 await pool.query('update teloa_group_task_sources set source_snapshot=$2,snapshot_digest=$3 where task_id=$1',[f.task.id,JSON.stringify(source),groupTaskSourceDigest(source)])
 await pool.query('delete from teloa_group_agent_grants where group_id=$1 and role_id=$2',[f.group.id,f.role.id])
 await pool.query("insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at) values($1,$2,$3,1,$4,$5,'active',$6,false,false,$7,'{}'::jsonb,$8)",[f.group.id,f.owner,f.role.id,f.group.version,f.role.version,JSON.stringify(granted),randomUUID(),identity.now()])
}

async function context(f:Fixture,ports:RunGroupFilePorts|null=runPorts,withPool=true,continuationReferences:readonly MessageReference[]=[]):Promise<RunGroupContext|undefined>{
 const db=await pool.connect()
 try{await db.query('begin');const value=await readRunGroupContext(db,f.owner,f.task,f.role,ports??undefined,withPool?pool:undefined,continuationReferences);await db.query('commit');return value}
 catch(error){await db.query('rollback');throw error}
 finally{db.release()}
}

test('续办明确引用的固定资料进入新上下文，授权本身不注入，未授权及版本漂移拒绝',async()=>{
 const f=await fixture(),groups=new CollaborationService(pool,identity)
 const resource=await groups.saveResource(f.owner,{requestId:randomUUID(),groupId:f.group.id,resourceId:randomUUID(),expectedVersion:0,title:'独立质检固定意见',markdown:'受审版本1：退回，须修订时间与证据边界。'})
 const reference:MessageReference={kind:'group-resource',id:resource.id,version:resource.version}
 await wire(f,[],[reference])
 const before=await context(f);assert.deepEqual(before!.materials,[])
 const after=await context(f,runPorts,true,[reference,reference])
 assert.deepEqual(after!.materials.map(item=>item.markdown),['受审版本1：退回，须修订时间与证据边界。'])
 assert.deepEqual(before!.materials,[])
 await assert.rejects(context(f,runPorts,true,[{...reference,version:2}]),{code:'teloa/forbidden'})
 await wire(f,[],[])
 await assert.rejects(context(f,runPorts,true,[reference]),{code:'teloa/forbidden'})
})

test('JSONB原引用与续办引用字段顺序不同也按精确身份去重，不把8份原件计为16份',async()=>{
 const f=await fixture(),groups=new CollaborationService(pool,identity),references:MessageReference[]=[]
 for(let i=0;i<8;i++){
  const resource=await groups.saveResource(f.owner,{requestId:randomUUID(),groupId:f.group.id,resourceId:randomUUID(),expectedVersion:0,title:'固定原件'+i,markdown:'证据'+i})
  references.push({kind:'group-resource',id:resource.id,version:resource.version})
 }
 await wire(f,references)
 const continuation=references.map(r=>({version:r.version,kind:r.kind,id:r.id}))
 const result=await context(f,runPorts,true,continuation)
 assert.equal(result!.materials.length,8)
 assert.equal(new Set(result!.materials.map(r=>r.resourceId)).size,8)
 await assert.rejects(context(f,runPorts,true,[{...references[0]!,version:2}]),{code:'teloa/forbidden'},'去重不合并不同版本或扩大授权')
})

const upload=async(f:Fixture,mime:string,name:string,content:Buffer)=>f.attachments.upload(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,mime,name,dataBase64:content.toString('base64')})

async function artifact(owner:string,files:{path:string;content:Buffer}[]){
 const store=new ArtifactSnapshotStore(pool),sessionId=randomUUID(),snapshotIds:string[]=[]
 for(const file of files)snapshotIds.push(await store.save(owner,{schema:'teloa.file-snapshot/v1',sessionId,id:hash(file.path+sessionId),path:file.path,sha256:hash(file.content),bytes:file.content.length,capturedAt:identity.now(),contentBase64:file.content.toString('base64')}))
 const id=randomUUID(),content={title:'调查成果',sections:[],snapshotIds,note:'固定说明。'}
 await pool.query('insert into teloa_artifacts values($1,$2,$3,$4,$5,1)',[id,owner,randomUUID(),JSON.stringify({}),'task:'+id])
 await pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,1,$3,$4,$5)',[owner,id,JSON.stringify({kind:'task',id:randomUUID(),scope:'SOC'}),JSON.stringify(content),identity.now()])
 for(const snapshotId of snapshotIds)await pool.query('insert into teloa_artifact_files values($1,$2,1,$3)',[owner,id,snapshotId])
 return id
}

const legacy={taskId:'11111111-1111-4111-8111-111111111111',groupId:'22222222-2222-4222-8222-222222222222',groupVersion:1,roleId:'33333333-3333-4333-8333-333333333333',roleVersion:2,grantVersion:3,source:{messageId:'44444444-4444-4444-8444-444444444444',rootId:'55555555-5555-4555-8555-555555555555',createdAt:'2026-09-18T00:00:00.000Z',text:'请核验这个告警。'},materials:[{resourceId:'66666666-6666-4666-8666-666666666666',resourceVersion:1,title:'告警证据',markdown:'# 证据\n\n固定内容。'}]}

test('空 files 的快照哈希与本次变更之前落库的值逐字相等，materials 结构一个字节不动',()=>{
 // 两条常量是在加 files 之前的代码路径上算出来的；对不上就说明在途 Run 的 group_context_hash 会整片失配。
 assert.equal(runGroupContextHash(legacy as unknown as RunGroupContext),'77f4a4acc2e0c8b9e1f2ee655defc14dabbd299e855a8f307b923ab330058540')
 assert.equal(runGroupContextHash({...legacy,materials:[]} as unknown as RunGroupContext),'5508479115cdfb23a4ce641cb4ecb8c9448018190fde44b8815fee6f6f19b8fb')
 const fixed=readStoredRunGroupContext(legacy)!
 assert.deepEqual(fixed.materials,legacy.materials)
 assert.deepEqual(fixed.files,[])
 // 显式给空 files 的新快照与老快照同哈希：空数组不进 JSON。
 assert.equal(runGroupContextHash({...legacy,files:[]} as unknown as RunGroupContext),runGroupContextHash(legacy as unknown as RunGroupContext))
})

test('缺 files 键的旧快照按空数组回落，不判 storage-corrupt',()=>{
 assert.deepEqual(readStoredRunGroupContext(legacy)?.files,[])
 assert.equal(readStoredRunGroupContext(undefined),undefined)
 assert.throws(()=>readStoredRunGroupContext({...legacy,extra:1}),{code:'teloa/storage-corrupt'})
})

test('Twin群运行上下文复用当前本人完整执行许可，无pool或撤回同意不能读取新上下文',async()=>{
 const f=await fixture('twin'),value=await context(f)
 assert.equal(value?.roleId,f.role.id);assert.equal(value?.roleVersion,f.role.version)
 assert.deepEqual(value?.materials,[]);assert.deepEqual(value?.files,[])
 assert.equal('memory' in value!,false)
 await assert.rejects(context(f,runPorts,false),{code:'teloa/forbidden'})
 assert.ok(f.consent)
 await f.consents.revoke(f.owner,{requestId:randomUUID(),consentId:f.consent.id,expectedVersion:f.consent.version})
 await assert.rejects(context(f),{code:'teloa/forbidden'})
 assert.deepEqual(readStoredRunGroupContext(value),value)
})

test('Twin群运行上下文拒绝关闭发言或自动Run的当前grant，不借用旧授权',async()=>{
 const f=await fixture('twin'),grants=new GroupAgentGrantService(pool,identity.now)
 const change=async(canPost:boolean,canAutoRun:boolean)=>grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'save',resources:[],canPost,canAutoRun})
 await change(false,true);await assert.rejects(context(f),{code:'teloa/forbidden'})
 await change(true,false);await assert.rejects(context(f),{code:'teloa/forbidden'})
 await change(true,true);assert.equal((await context(f))?.roleId,f.role.id)
})

test('非空 files 的哈希对同一输入稳定，改一位 sha256 即变',()=>{
 const file={kind:'attachment' as const,id:'file-'+'a'.repeat(64),version:1,sha256:'b'.repeat(64),mime:'text/markdown',bytes:12,name:'证据.md',text:'固定正文'}
 const value={...legacy,files:[file]} as unknown as RunGroupContext
 assert.equal(runGroupContextHash(value),runGroupContextHash(value))
 assert.notEqual(runGroupContextHash(value),runGroupContextHash(legacy as unknown as RunGroupContext))
 assert.notEqual(runGroupContextHash(value),runGroupContextHash({...legacy,files:[{...file,sha256:'c'+'b'.repeat(63)}]} as unknown as RunGroupContext))
 assert.notEqual(runGroupContextHash(value),runGroupContextHash({...legacy,files:[{...file,version:2}]} as unknown as RunGroupContext))
 assert.notEqual(runGroupContextHash(value),runGroupContextHash({...legacy,files:[{...file,kind:'artifact',id:randomUUID()}]} as unknown as RunGroupContext))
})

test('后端的两条提示常量与客户端词条中文逐字相同',()=>{
 const rows=readFileSync(join(import.meta.dirname,'../../client/ui-workbench/src/client/i18n/locales/group-attachment.ts'),'utf8')
 assert.ok(rows.includes("'collaboration.attachment.modelNoVision','"+groupModelNoVisionNotice+"'"))
 assert.ok(rows.includes("'collaboration.attachment.partialFailed','"+groupPartialAttachFailedNotice(0).replace('0','{count}')+"'"))
})

test('未获授权的原件引用一律 teloa/forbidden，不是静默跳过',async()=>{
 const f=await fixture(),saved=await upload(f,'text/markdown','证据.md',Buffer.from('# 固定正文','utf8'))
 await wire(f,[{kind:'attachment',id:saved.attachmentId,version:1}],[])
 await assert.rejects(context(f),{code:'teloa/forbidden',message:'群消息引用的原件未获当前员工授权。'})
})

test('已撤回的附件引用判 teloa/forbidden',async()=>{
 const f=await fixture(),saved=await upload(f,'text/markdown','撤回件.md',Buffer.from('# 待撤回','utf8'))
 const reference:MessageReference={kind:'attachment',id:saved.attachmentId,version:1}
 await wire(f,[reference])
 assert.equal((await context(f))?.files.length,1)
 await f.attachments.withdraw(f.owner,{requestId:randomUUID(),attachmentId:saved.attachmentId})
 await assert.rejects(context(f),{code:'teloa/forbidden'})
})

test('文本附件带正文，图片只给元数据与句柄行，GIF 按文件处理没有宽高',async()=>{
 const f=await fixture()
 const note=await upload(f,'text/markdown','研判.md',Buffer.from('# 结论\n\n固定正文。','utf8'))
 const png=await upload(f,'image/png','证据.png',Buffer.from('89504e470d0a1a0a0000000d49484452','hex'))
 const gif=await upload(f,'image/gif','动画.gif',Buffer.from('474946383961010001000000','hex'))
 await wire(f,[{kind:'attachment',id:note.attachmentId,version:1},{kind:'attachment',id:png.attachmentId,version:1},{kind:'attachment',id:gif.attachmentId,version:1}])
 const files=(await context(f))!.files
 assert.equal(at(files,0).text,'# 结论\n\n固定正文。')
 assert.equal(at(files,1).text,undefined)
 // 句柄行的分隔符全行一致都是 ' · '：图片那段两侧各一个，尺寸缺省时也不留下粘连的 '字节· 摘要'。
 assert.ok(groupFileHandleLine(at(files,1)).includes(' 字节 · 800×600 · 摘要 '))
 assert.ok(groupFileHandleLine(at(files,1)).startsWith('附件 证据.png · image/png · '))
 assert.ok(groupFileHandleLine(at(files,0)).includes(' 字节 · 摘要 '))
 assert.equal(at(files,2).text,undefined)
 assert.equal(at(files,2).width,undefined)
 assert.equal(at(files,2).height,undefined)
 assert.ok(!groupFileHandleLine(at(files,2)).includes('×'))
})

test('超长文本截断到 16000 字并在尾部逐字留下提示',async()=>{
 const f=await fixture(),saved=await upload(f,'text/markdown','长文.md',Buffer.from('甲'.repeat(17000),'utf8'))
 await wire(f,[{kind:'attachment',id:saved.attachmentId,version:1}])
 const file=at((await context(f))!.files,0)
 assert.equal(file.text?.length,16000)
 assert.ok(file.text?.endsWith('内容超过 16000 字，此处只给前段，完整内容请按句柄行读取'))
})

test('文本附件只读前 groupFileTextMaxBytes 字节；截断点落在多字节字符中间时退回完整字符，照常给前段正文',async()=>{
 assert.equal(groupFileTextMaxBytes,64000)
 // 64000 不是 3 的倍数：「甲」占 3 字节，前缀末尾必然卡在半个字符上。
 const f=await fixture(),saved=await upload(f,'text/markdown','大长文.md',Buffer.from('甲'.repeat(30000),'utf8'))
 await wire(f,[{kind:'attachment',id:saved.attachmentId,version:1}])
 requestedMaxBytes.length=0
 const file=at((await context(f))!.files,0)
 assert.deepEqual(requestedMaxBytes,[groupFileTextMaxBytes])
 assert.equal(file.text?.length,16000)
 assert.ok(file.text?.startsWith('甲甲甲'))
 assert.ok(file.text?.endsWith('内容超过 16000 字，此处只给前段，完整内容请按句柄行读取'))
})

test('行为变化：非法 UTF-8 只出现在读取前缀之后时，给前段正文并标截断（原先整份降为句柄行）',async()=>{
 const f=await fixture(),saved=await upload(f,'text/plain','尾部乱码.log',Buffer.concat([Buffer.from('a'.repeat(groupFileTextMaxBytes+10)),Buffer.from([0xff,0xfe])]))
 await wire(f,[{kind:'attachment',id:saved.attachmentId,version:1}])
 const file=at((await context(f))!.files,0)
 assert.equal(file.text?.length,16000)
 assert.ok(file.text?.endsWith('内容超过 16000 字，此处只给前段，完整内容请按句柄行读取'))
})

test('非 UTF-8 字节的文本附件降为句柄行而不抛错',async()=>{
 const f=await fixture(),saved=await upload(f,'text/plain','乱码.txt',Buffer.from([0xff,0xfe,0xfd,0xfc]))
 await wire(f,[{kind:'attachment',id:saved.attachmentId,version:1}])
 const file=at((await context(f))!.files,0)
 assert.equal(file.text,undefined)
 assert.equal(file.mime,'text/plain')
 assert.ok(groupFileHandleLine(file).includes('乱码.txt'))
})

test('读字节失败整次判 teloa/source-unavailable，不降级成句柄行',async()=>{
 const f=await fixture(),saved=await upload(f,'text/plain','日志.log',Buffer.from('固定日志','utf8'))
 await wire(f,[{kind:'attachment',id:saved.attachmentId,version:1}])
 readFails=true
 try{await assert.rejects(context(f),{code:'teloa/source-unavailable'})}finally{readFails=false}
 assert.equal(at((await context(f))!.files,0).text,'固定日志')
})

test('成果引用展开到固定版本的每个文件，超过上限判 teloa/conflict',async()=>{
 const f=await fixture()
 const eight=await artifact(f.owner,Array.from({length:8},(_,index)=>({path:`out/第${index}份.md`,content:Buffer.from('# 第'+index+'份','utf8')})))
 await wire(f,[{kind:'artifact',id:eight,version:1}])
 const files=(await context(f))!.files
 assert.equal(files.length,8)
 assert.equal(at(files,0).kind,'artifact')
 assert.equal(at(files,0).name,'第0份.md')
 assert.equal(at(files,0).text,'# 第0份')
 assert.ok(groupFileHandleLine(at(files,0)).startsWith('成果文件 第0份.md · text/markdown · '))
 const nine=await artifact(f.owner,Array.from({length:9},(_,index)=>({path:`大/第${index}份.md`,content:Buffer.from('# 大第'+index,'utf8')})))
 await wire(f,[{kind:'artifact',id:nine,version:1}])
 await assert.rejects(context(f),{code:'teloa/conflict'})
})

test('成果图片窄读口只按本人固定版本与快照事实读取，版本或摘要不符即拒绝',async()=>{
 const f=await fixture(),content=Buffer.from('89504e470d0a1a0a0000000d49484452','hex')
 const id=await artifact(f.owner,[{path:'out/成果图.png',content}])
 await wire(f,[{kind:'artifact',id,version:1}])
 const file=at((await context(f))!.files,0)
 assert.equal(file.kind,'artifact')
 assert.deepEqual(await readRunGroupArtifactImageBytes(pool,f.owner,file),content)
 await assert.rejects(readRunGroupArtifactImageBytes(pool,randomUUID(),file),{code:'teloa/forbidden'})
 await assert.rejects(readRunGroupArtifactImageBytes(pool,f.owner,{...file,version:2}),{code:'teloa/forbidden'})
 await assert.rejects(readRunGroupArtifactImageBytes(pool,f.owner,{...file,sha256:'0'.repeat(64)}),{code:'teloa/storage-corrupt'})
 await assert.rejects(readRunGroupArtifactImageBytes(pool,f.owner,{...file,name:'别的图.png'}),{code:'teloa/storage-corrupt'})
 await assert.rejects(readRunGroupArtifactImageBytes(pool,f.owner,{...file,mime:'image/jpeg'}),{code:'teloa/storage-corrupt'})
})

test('成果里的 .svg 只给句柄行，既没有正文也不落在图片白名单里',async()=>{
 const f=await fixture()
 const id=await artifact(f.owner,[{path:'out/图.svg',content:Buffer.from('<svg/>','utf8')},{path:'out/页.html',content:Buffer.from('<b/>','utf8')},{path:'out/说明.md',content:Buffer.from('# 说明','utf8')}])
 await wire(f,[{kind:'artifact',id,version:1}])
 const files=(await context(f))!.files
 assert.equal(at(files,0).name,'图.svg')
 assert.equal(at(files,0).text,undefined)
 assert.equal(at(files,0).mime,'application/octet-stream')
 assert.equal(at(files,1).text,undefined)
 assert.equal(at(files,1).mime,'application/octet-stream')
 assert.equal(at(files,2).text,'# 说明')
})

test('只引用群资料的运行其 materials 与 files 分开，哈希覆盖引用四元组',async()=>{
 const f=await fixture(),groups=new CollaborationService(pool,identity)
 const resource=await groups.saveResource(f.owner,{requestId:randomUUID(),groupId:f.group.id,resourceId:randomUUID(),expectedVersion:0,title:'生产告警证据',markdown:'# prod-03\n\n固定上下文。'})
 await wire(f,[{kind:'group-resource',id:resource.id,version:resource.version}])
 const onlyMaterials=(await context(f))!
 assert.deepEqual(onlyMaterials.materials,[{resourceId:resource.id,resourceVersion:1,title:'生产告警证据',markdown:'# prod-03\n\n固定上下文。'}])
 assert.deepEqual(onlyMaterials.files,[])
 const saved=await upload(f,'text/csv','明细.csv',Buffer.from('列一,列二\n1,2','utf8'))
 await wire(f,[{kind:'group-resource',id:resource.id,version:resource.version},{kind:'attachment',id:saved.attachmentId,version:1}])
 const withFile=(await context(f))!
 assert.deepEqual(withFile.materials,onlyMaterials.materials)
 assert.equal(at(withFile.files,0).text,'列一,列二\n1,2')
 assert.notEqual(runGroupContextHash(withFile),runGroupContextHash(onlyMaterials))
 assert.notEqual(runGroupContextHash(withFile),runGroupContextHash({...withFile,files:[{...at(withFile.files,0),sha256:'0'.repeat(64)}]}))
})

test('只填了一半宽高的附件行读回后整对缺省，不判 storage-corrupt',async()=>{
 // teloa_attachments 的 check 只约束「image ⟺ 宽高齐全」，file 类填一个 width 是能落库的；
 // 写入侧要是按两个键各自展开，半对就会写出孤零零一个 width，读回侧立刻判损坏。
 const f=await fixture(),saved=await upload(f,'application/pdf','半对.pdf',Buffer.from('%PDF-1.4','utf8'))
 await pool.query('update teloa_attachments set width=5 where owner_id=$1 and attachment_id=$2',[f.owner,saved.attachmentId])
 await wire(f,[{kind:'attachment',id:saved.attachmentId,version:1}])
 const file=at((await context(f))!.files,0)
 assert.equal(file.width,undefined)
 assert.equal(file.height,undefined)
 assert.ok(!groupFileHandleLine(file).includes('×'))
})

test('成果展开在超过上限的那一刻就停，不把整份成果读进内存',async()=>{
 const f=await fixture()
 const many=await artifact(f.owner,Array.from({length:10},(_,index)=>({path:`多/第${index}份.md`,content:Buffer.from('# 多第'+index,'utf8')})))
 await wire(f,[{kind:'artifact',id:many,version:1}])
 await assert.rejects(context(f),{code:'teloa/conflict'})
 // 已经有 8 件在先时，第二条引用一件都不该再读出来。
 const one=await artifact(f.owner,[{path:'再/一份.md',content:Buffer.from('# 再一份','utf8')}])
 const eight=await artifact(f.owner,Array.from({length:8},(_,index)=>({path:`满/第${index}份.md`,content:Buffer.from('# 满第'+index,'utf8')})))
 await wire(f,[{kind:'artifact',id:eight,version:1},{kind:'artifact',id:one,version:1}])
 await assert.rejects(context(f),{code:'teloa/conflict'})
})

test('无扩展名的成果文件落到句柄行，不因 slice 取巧命中白名单',async()=>{
 const f=await fixture()
 const id=await artifact(f.owner,[{path:'out/README',content:Buffer.from('固定说明','utf8')}])
 await wire(f,[{kind:'artifact',id,version:1}])
 const file=at((await context(f))!.files,0)
 assert.equal(file.name,'README')
 assert.equal(file.mime,'application/octet-stream')
 assert.equal(file.text,undefined)
})

test('端口未接入时文本附件整次失败，不静默给空正文',async()=>{
 const f=await fixture(),saved=await upload(f,'application/json','配置.json',Buffer.from('{"a":1}','utf8'))
 await wire(f,[{kind:'attachment',id:saved.attachmentId,version:1}])
 await assert.rejects(context(f,null),{code:'teloa/dependency-unavailable'})
})


test('群任务在正式重新交办后沿原来源接续，创建时负责人快照不改写',async()=>{
 const f=await fixture(),lifecycle=new RoleLifecycleService(pool,identity),roles=new RoleService(pool,identity)
 const original=(await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where task_id=$1',[f.task.id])).rows[0]
 await lifecycle.change(f.owner,{roleId:f.role.id,expectedVersion:1,action:'pause',reason:'暂停后继续'})
 const resumed=await lifecycle.change(f.owner,{roleId:f.role.id,expectedVersion:2,action:'resume',reason:'恢复原任务'})
 const nextRole=(await roles.get(f.owner,f.role.id))!
 await assert.rejects(context({...f,role:nextRole}),{code:'teloa/version-conflict'},'恢复员工本身不能替代重新交办')
 const changed=await new HandoffService(pool,identity).change(f.owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:f.task.version,target:{kind:'role',roleId:f.role.id,expectedRoleVersion:resumed.role.version},note:'本人确认继续同一群任务'})
 const value=await context({...f,task:changed.task,role:nextRole})
 assert.equal(value?.taskId,f.task.id);assert.equal(value?.source.messageId,f.source.messageId);assert.equal(value?.roleId,f.role.id);assert.equal(value?.roleVersion,3);assert.equal(value?.grantVersion,2)
 const edited=await new TaskService(pool,identity).edit(f.owner,{taskId:f.task.id,expectedVersion:changed.task.version,fields:{title:'保留原群任务',goal:f.task.goal}})
 assert.equal((await context({...f,task:edited,role:nextRole}))?.roleVersion,3,'合理的任务编辑版本不要求再改派一次')
 const prepare=async(task:typeof f.task,role:typeof f.role)=>{
  const sessionId=randomUUID(),inspect=async()=>({id:sessionId,sessionId,ownerId:f.owner,status:'ready'})
  await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],groupContext:(db,owner,current,currentRole)=>readRunGroupContext(db,owner,current,currentRole)})
  const run=await runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'default-agent')
  return {runs,run}
 }
 const old=await prepare(edited,nextRole)
 assert.equal(old.run.taskId,f.task.id);assert.equal(old.run.groupContext?.roleVersion,3)
 await old.runs.withdraw(f.owner,{runId:old.run.id})
 const oldRow=(await pool.query('select * from teloa_task_runs where id=$1',[old.run.id])).rows[0]
 await lifecycle.change(f.owner,{roleId:f.role.id,expectedVersion:3,action:'pause',reason:'再次暂停'})
 const secondResume=await lifecycle.change(f.owner,{roleId:f.role.id,expectedVersion:4,action:'resume',reason:'再次恢复'})
 const second=await new HandoffService(pool,identity).change(f.owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:edited.version,target:{kind:'role',roleId:f.role.id,expectedRoleVersion:secondResume.role.version},note:'确认当前版本接续'})
 const finalRole=(await roles.get(f.owner,f.role.id))!,next=await prepare(second.task,finalRole)
 assert.equal(next.run.taskId,f.task.id);assert.equal(next.run.roleVersion,5);assert.equal(next.run.groupContext?.source.messageId,f.source.messageId);assert.equal(next.run.groupContext?.grantVersion,3)
 assert.equal((await old.runs.claim(f.owner,{runId:old.run.id})).dispatch,false,'旧准备记录仍是撤回终态，不能恢复发送')
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[old.run.id])).rows[0],oldRow)
 assert.deepEqual((await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where task_id=$1',[f.task.id])).rows[0],original)
})

test('群任务换代仅认真实当前任务与完整交办链，坏回执、伪任务、未来员工和过期授权均拒绝',async()=>{
 const f=await fixture(),lifecycle=new RoleLifecycleService(pool,identity),roles=new RoleService(pool,identity)
 await lifecycle.change(f.owner,{roleId:f.role.id,expectedVersion:1,action:'pause',reason:'调整当前版本'})
 await lifecycle.change(f.owner,{roleId:f.role.id,expectedVersion:2,action:'resume',reason:'本人恢复'})
 const role=(await roles.get(f.owner,f.role.id))!,request={requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,target:{kind:'role' as const,roleId:role.id,expectedRoleVersion:3},note:'本人明确接续'}
 await assert.rejects(context({...f,role,task:{...f.task,assigneeRoleVersion:3}}),{code:'teloa/version-conflict'},'没有实际交办回执，不能靠调用者拼任务放行')
 const result=await new HandoffService(pool,identity).change(f.owner,request),current={...f,role,task:result.task}
 assert.ok(await context(current))
 await assert.rejects(context({...current,task:{...current.task,version:current.task.version+1}}),{code:'teloa/version-conflict'},'伪任务版本')
 await assert.rejects(context({...current,task:{...current.task,goal:'换掉原目标'}}),{code:'teloa/version-conflict'},'伪任务正文')
 await assert.rejects(context({...current,role:{...role,version:4},task:{...current.task,assigneeRoleVersion:4}}),{code:'teloa/version-conflict'},'未来员工版本')
 const original=(await pool.query('select * from teloa_task_handoff_changes where owner_id=$1 and request_id=$2',[f.owner,request.requestId])).rows[0]
 const write=async(spec:unknown,from:unknown,to:unknown,base:number,applied:number)=>pool.query('update teloa_task_handoff_changes set request_spec=$3,from_party=$4,to_party=$5,base_version=$6,applied_version=$7 where owner_id=$1 and request_id=$2',[f.owner,request.requestId,JSON.stringify(spec),JSON.stringify(from),JSON.stringify(to),base,applied])
 const changes=[
  {spec:{...original.request_spec,taskId:randomUUID()},from:original.from_party,to:original.to_party,base:1,applied:2,code:'teloa/storage-corrupt'},
  {spec:original.request_spec,from:{kind:'role',roleId:randomUUID(),roleVersion:1},to:original.to_party,base:1,applied:2,code:'teloa/version-conflict'},
  {spec:original.request_spec,from:{...original.from_party,roleVersion:2},to:original.to_party,base:1,applied:2,code:'teloa/version-conflict'},
  {spec:{...original.request_spec,target:{...request.target,expectedRoleVersion:4}},from:original.from_party,to:{...original.to_party,roleVersion:4},base:1,applied:2,code:'teloa/version-conflict'},
  {spec:{...original.request_spec,expectedTaskVersion:8},from:original.from_party,to:original.to_party,base:8,applied:9,code:'teloa/version-conflict'},
 ]
 for(const change of changes){try{await write(change.spec,change.from,change.to,change.base,change.applied);await assert.rejects(context(current),{code:change.code})}finally{await write(original.request_spec,original.from_party,original.to_party,original.base_version,original.applied_version)}}
 await pool.query('update teloa_group_agent_grants set role_version=1 where owner_id=$1 and group_id=$2 and role_id=$3 and grant_version=2',[f.owner,f.group.id,role.id])
 await assert.rejects(context(current),{code:'teloa/version-conflict'},'本人交办不借用旧员工版本授权')
 await pool.query('update teloa_group_agent_grants set role_version=3 where owner_id=$1 and group_id=$2 and role_id=$3 and grant_version=2',[f.owner,f.group.id,role.id])
 await new GroupAgentGrantService(pool,identity.now).change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:role.id,expectedGroupVersion:1,expectedRoleVersion:3,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await assert.rejects(context(current),{code:'teloa/version-conflict'},'已撤销授权不复活')
 await pool.query('delete from teloa_group_members where owner_id=$1 and group_id=$2 and role_id=$3',[f.owner,f.group.id,role.id])
 await assert.rejects(context(current),{code:'teloa/forbidden'},'不再是当前群成员')
})
