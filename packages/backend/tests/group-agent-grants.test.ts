import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {type MessageReference} from '@teloa/contract'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {GroupAttachmentService,initializeGroupAttachments} from '../src/work/group-attachments.ts'
import {artifactVersion as artifactVersionRow,attachmentPorts,uploadFile} from './group-attachment-test-fixture.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-21T09:00:00.000Z').toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeGroupAttachments(pool)
})
after(async()=>{await pool?.end();await container?.stop()})

const roleFields={name:'调查岗',kind:'employee' as const,scopes:['SOC'],duty:'调查',dataScope:'固定证据',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}

/** 建一个已在岗数字员工并加入群，供本人授权用例复用。 */
async function memberGroup(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'授权测试群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 return {owner,role,group,groups,grants:new GroupAgentGrantService(pool,identity.now)}
}
/** 本文件里 `artifactVersion` 固定用同一个测试时钟；夹具本体在 `group-attachment-test-fixture.ts`。 */
const artifactVersion=(owner:string)=>artifactVersionRow(pool,owner,identity.now())

test('canAutoRun 随群授权保存与读取往返，撤销时必须为假',async()=>{
 const {owner,role,group,grants}=await memberGroup()
 const input={requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save' as const,resources:[],canPost:false,canAutoRun:true}
 const saved=await grants.change(owner,input)
 assert.equal(saved.canAutoRun,true)
 assert.deepEqual(await grants.get(owner,{groupId:group.id,roleId:role.id}),{groupVersion:group.version,roleVersion:role.version,grant:saved,status:'active'})
 await assert.rejects(grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'revoke',resources:[],canPost:false,canAutoRun:true}),{code:'teloa/invalid-input'})
 const revoked=await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 assert.equal(revoked.canAutoRun,false)
 assert.equal(revoked.state,'revoked')
})

test('老授权行（本字段上线前，列缺省）读出 canAutoRun:false',async()=>{
 const {owner,role,group,grants}=await memberGroup()
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,request_id,request_spec,created_at)
  values($1,$2,$3,(select coalesce(max(grant_version),0)+1 from teloa_group_agent_grants where group_id=$1 and role_id=$3),$4,$5,'active','[]'::jsonb,false,$6,'{}'::jsonb,$7)`,[group.id,owner,role.id,group.version,role.version,randomUUID(),identity.now()])
 const read=await grants.get(owner,{groupId:group.id,roleId:role.id})
 assert.equal(read.grant?.canAutoRun,false)
})

test('撤销行的表级判据也盖住 can_auto_run：绕过服务层直接写库同样被拒',async()=>{
 const {owner,role,group}=await memberGroup()
 await assert.rejects(pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,(select coalesce(max(grant_version),0)+1 from teloa_group_agent_grants where group_id=$1 and role_id=$3),$4,$5,'revoked','[]'::jsonb,false,true,$6,'{}'::jsonb,$7)`,[group.id,owner,role.id,group.version,role.version,randomUUID(),identity.now()]),/teloa_group_agent_grants_revoked_empty/)
 // 幂等：重复初始化不因约束已存在而失败。
 await initializeGroupAgentGrants(pool)
})

test('数字员工授权三类原件各一条往返；不可见原件、超 32 条与撤销带资源都被拒',async()=>{
 const {owner,role,group,groups,grants}=await memberGroup()
 const attachments=new GroupAttachmentService(pool,identity,attachmentPorts())
 const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'授权资料',markdown:'# 资料\n\n固定线索。'})
 const attachment=await uploadFile(attachments,owner,group.id,group.version,'授权原件。')
 const artifactId=await artifactVersion(owner)
 const resources:MessageReference[]=[
  {kind:'group-resource',id:resource.id,version:resource.version},
  {kind:'attachment',id:attachment.attachmentId,version:1},
  {kind:'artifact',id:artifactId,version:1}
 ]
 const base={groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,canPost:false,canAutoRun:false}
 const saved=await grants.change(owner,{...base,requestId:randomUUID(),action:'save',resources})
 assert.deepEqual(saved.resources,resources)
 assert.deepEqual((await grants.get(owner,{groupId:group.id,roleId:role.id})).grant?.resources,resources)
 // 撤回后的附件不可见，与「不存在」「不属本人」同一个错误码。
 await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:attachment.attachmentId})
 await assert.rejects(grants.change(owner,{...base,requestId:randomUUID(),action:'save',resources:[resources[1]]}),{code:'teloa/forbidden'})
 await assert.rejects(grants.change(owner,{...base,requestId:randomUUID(),action:'save',resources:[{kind:'artifact',id:await artifactVersion(randomUUID()),version:1}]}),{code:'teloa/forbidden'})
 // 他人上传的附件：原件真实存在且在用，只是不属本人；杜撰的 attachmentId 则根本不存在。两者同码。
 const outsider=randomUUID(),outsiderGroups=new CollaborationService(pool,identity)
 const outsiderGroup=await outsiderGroups.create(outsider,{requestId:randomUUID(),expectedVersion:0,fields:{name:'别人的群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[]}})
 const outsiderAttachment=await uploadFile(new GroupAttachmentService(pool,identity,attachmentPorts()),outsider,outsiderGroup.id,outsiderGroup.version,'别人上传的原件。')
 await assert.rejects(grants.change(owner,{...base,requestId:randomUUID(),action:'save',resources:[{kind:'attachment',id:outsiderAttachment.attachmentId,version:1}]}),{code:'teloa/forbidden'})
 await assert.rejects(grants.change(owner,{...base,requestId:randomUUID(),action:'save',resources:[{kind:'attachment',id:'sha256:'+'0'.repeat(64),version:1}]}),{code:'teloa/forbidden'})
 const tooMany=Array.from({length:33},(_item,index)=>({kind:'attachment' as const,id:'sha256:batch-'+index,version:1}))
 await assert.rejects(grants.change(owner,{...base,requestId:randomUUID(),action:'save',resources:tooMany}),{code:'teloa/invalid-input'})
 await assert.rejects(grants.change(owner,{...base,requestId:randomUUID(),action:'revoke',resources:[resources[0]]}),{code:'teloa/invalid-input'})
})

test('范围不支持的群成员：读口返回未授权而不是记录损坏，写口拒绝保存',async()=>{
 const {owner,group,groups,grants}=await memberGroup()
 const outsider=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{...roleFields,name:'应用安全岗',scopes:['AppSec']}})
 const joined=await groups.change(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,fields:{name:group.name,announcement:group.announcement,rules:openGroupRules,memberRoleIds:[outsider.id],pinned:false,archived:false}})
 // 成员可以来自任何业务范围（用户裁定 B），所以这不是损坏数据：本人看到的是可读的「未授权」，不是恢复横幅。
 assert.deepEqual(await grants.get(owner,{groupId:group.id,roleId:outsider.id}),{groupVersion:joined.version,roleVersion:outsider.version,grant:null,status:'not-granted'})
 const base={groupId:group.id,roleId:outsider.id,expectedGroupVersion:joined.version,expectedRoleVersion:outsider.version,resources:[]}
 await assert.rejects(grants.change(owner,{...base,requestId:randomUUID(),action:'save',canPost:true,canAutoRun:true}),{code:'teloa/forbidden'})
 // 一行都没有时撤销没有落点：不给它凭空落一行 revoked。
 await assert.rejects(grants.change(owner,{...base,requestId:randomUUID(),action:'revoke',canPost:false,canAutoRun:false}),{code:'teloa/forbidden'})
 assert.equal((await pool.query('select count(*)::int c from teloa_group_agent_grants where group_id=$1 and role_id=$2',[group.id,outsider.id])).rows[0].c,0)
 // 历史遗留的那一行：读口照常回读并标「有行但不作数」（invalidated），本人看得到也关得掉；
 // 契约钉死「not-granted 必须配 grant:null」（`contract/src/collaboration.ts:295`），所以有行时不能再报 not-granted。
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,1,$4,$5,'active','[]'::jsonb,true,true,$6,'{}'::jsonb,$7)`,[group.id,owner,outsider.id,joined.version,outsider.version,randomUUID(),identity.now()])
 const legacy=await grants.get(owner,{groupId:group.id,roleId:outsider.id})
 assert.equal(legacy.status,'invalidated')
 assert.equal(legacy.grant?.grantVersion,1)
 assert.equal(legacy.grant?.state,'active')
 const revoked=await grants.change(owner,{...base,requestId:randomUUID(),action:'revoke',canPost:false,canAutoRun:false})
 assert.equal(revoked.state,'revoked')
 assert.equal(revoked.grantVersion,2)
})

test('老授权行的旧二元组资源读回按群资料归一化，不判损坏',async()=>{
 const {owner,role,group,groups,grants}=await memberGroup()
 const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'历史授权资料',markdown:'# 历史\n\n固定线索。'})
 const normalized:MessageReference[]=[{kind:'group-resource',id:resource.id,version:resource.version}]
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:normalized,canPost:false,canAutoRun:false})
 await pool.query('update teloa_group_agent_grants set resources=$3::jsonb where group_id=$1 and role_id=$2',[group.id,role.id,JSON.stringify([{resourceId:resource.id,resourceVersion:resource.version}])])
 const read=await grants.get(owner,{groupId:group.id,roleId:role.id})
 assert.deepEqual(read.grant?.resources,normalized)
 assert.equal(read.status,'active')
})
