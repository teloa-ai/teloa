import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,type DigitalRole,type Group,type GroupResource} from '@teloa/contract'
import {registerGroupTools,groupToolNames,type GroupToolsPorts} from '../src/group-tools.ts'
import {groupMessageSecretGate} from '../src/prompt-secret-gate.ts'
import {createGroupHandler} from '../src/groups.ts'

const owner='local:owner',id='11111111-1111-4111-8111-111111111111',roleId='22222222-2222-4222-8222-222222222222',now='2026-10-11T00:00:00.000Z'
const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
const fields={name:'事件协作',scope:'SOC',announcement:'核对真实证据',rules,memberRoleIds:[roleId]}
const members=[{roleId,expectedVersion:3}]
const group:Group={id,ownerId:owner,version:1,name:fields.name,scope:fields.scope,announcement:fields.announcement,rules,pinned:false,archived:false,createdAt:now,updatedAt:now}
const role:DigitalRole={id:roleId,ownerId:owner,version:3,state:'active',kind:'employee',name:'调查员',scopes:['OtherBusiness'],duty:'调查',dataScope:'已授权',executionScope:'已授权',skills:[],knowledge:[],createdAt:now,updatedAt:now}
const changeFields={name:fields.name,announcement:fields.announcement,rules,memberRoleIds:[roleId],pinned:true,archived:false}

async function setup(overrides:Partial<GroupToolsPorts>={},options:{subagent?:boolean;instructions?:number;content?:any[];source?:any}={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('group-tools-session'),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 for(let i=0;i<(options.instructions??1);i++)agent.session.append('user/message',createUserMessage({source:options.source??{kind:'user',rpcId:'group-request'},content:options.content??[{type:'text',text:'建立事件协作群并保存处置资料'}]}),{surfaceOp:'append'})
 const writes:Array<{endpoint:string;payload:any}>=[],all:Array<{endpoint:string;payload:any}>=[],receipts=new Map<string,unknown>(),resources=new Map<string,GroupResource>()
 let current={...group}
 const route:GroupToolsPorts['route']=async(endpoint,payload)=>{
  const row=payload as any;all.push({endpoint,payload})
  if(endpoint==='groups/list')return [current]
  if(endpoint==='groups/get')return {group:current,members:[{groupId:id,roleId:null,createdAt:now},{groupId:id,roleId,createdAt:now}]}
  if(endpoint==='groups/resources/list')return [...resources.values()]
  writes.push({endpoint,payload})
  if(receipts.has(row.requestId))return receipts.get(row.requestId)
  let result:unknown
  if(endpoint==='groups/create')result={...group,...row.fields}
  else if(endpoint==='groups/change'){
   if(current.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','群已变化')
   current={...current,...row.fields,version:current.version+1};delete (current as any).memberRoleIds;result=current
  }else if(endpoint==='groups/resources/save'){
   const resource={id:row.resourceId,groupId:id,ownerId:owner,version:row.expectedVersion+1,title:row.title,withdrawnAt:null,createdAt:now,updatedAt:now};resources.set(resource.id,resource);result=resource
  }else if(endpoint==='groups/resources/withdraw'){
   const resource={...resources.get(row.resourceId)!,withdrawnAt:now};resources.set(resource.id,resource);result=resource
  }else throw Error(endpoint)
  if(endpoint==='groups/create')delete (result as any).memberRoleIds
  receipts.set(row.requestId,result);return result
 }
 const ports:GroupToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,scopes:async()=>['general','SOC'],roles:async()=>[role],admitText:groupMessageSecretGate(()=>[]),route,...overrides}
 registerGroupTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={},callId='call')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,ports,call,writes,all,resources}
}
const json=(result:any)=>JSON.parse(result.content.filter((item:any)=>item.type==='text').map((item:any)=>item.text).join('\n'))

test('自然语言群工具可创建、修改和清空群说明，回读沿用同一群身份',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const created=await e.call('teloa_groups_create',{fields:{...fields,purpose:'  持续核查采购资料  '},members},'purpose-create')
 assert.equal(created.isError,false);assert.equal(json(created).group.id,id);assert.equal(json(created).group.purpose,'持续核查采购资料')
 assert.equal(e.writes[0]!.payload.fields.purpose,'持续核查采购资料')
 const edited=await e.call('teloa_groups_change',{groupId:id,expectedVersion:1,fields:{...changeFields,purpose:'共同核查付款证据'},members},'purpose-change')
 assert.equal(edited.isError,false);assert.equal(json(edited).group.id,id);assert.equal(json(edited).group.purpose,'共同核查付款证据')
 const cleared=await e.call('teloa_groups_change',{groupId:id,expectedVersion:2,fields:{...changeFields,purpose:''},members},'purpose-clear')
 assert.equal(cleared.isError,false);assert.equal(json(cleared).group.purpose,'')
 const read=await e.call('teloa_groups_get',{groupId:id});assert.equal(json(read).group.purpose,'')
})

test('群说明也是重放核对的一部分，不能把另一份说明当成原写入成功',async t=>{
 let writes=0
 const e=await setup({route:async endpoint=>{if(endpoint==='groups/get')return {group:{...group,pinned:true,version:2,purpose:'另一项工作'},members:[{groupId:id,roleId:null,createdAt:now},{groupId:id,roleId,createdAt:now}]};writes++;throw Error('Must reject before write')}});t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call('teloa_groups_change',{groupId:id,expectedVersion:1,fields:{...changeFields,purpose:'核查采购资料'},members})
 assert.equal(result.isError,true);assert.match(JSON.stringify(result),/群版本已变化，请先核对原群/);assert.equal(writes,0)
})

test('注册群与资料工具，目录返回真实成员版本和群身份，不提供冒本人发言、删除或扩权入口',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.deepEqual(e.ctx.tools.schemas(e.agent).filter(item=>item.name.startsWith('teloa_group')).map(item=>item.name),[...groupToolNames])
 const directory=await e.call('teloa_groups_list');assert.equal(directory.isError,false)
 assert.equal(json(directory).groups[0].id,id);assert.equal(json(directory).roles[0].version,3)
 const detail=await e.call('teloa_groups_get',{groupId:id});assert.equal(detail.isError,false)
 assert.equal(json(detail).groupId,id);assert.equal(json(detail).groupVersion,1);assert.equal(json(detail).groupName,fields.name)
 for(const name of ['teloa_groups_send','teloa_groups_delete','teloa_groups_agent_grant'])assert.equal((await e.call(name)).isError,true)
 assert.equal(e.writes.length,0)
})

test('本人当前指令建群复用服务；请求固定到 callId，同轮不同调用各有请求',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const callId of ['one','one','two'])assert.equal((await e.call('teloa_groups_create',{fields,members},callId)).isError,false)
 assert.deepEqual(e.writes.map(row=>row.endpoint),['groups/create','groups/create','groups/create'])
 assert.equal(e.writes[0]!.payload.requestId,e.writes[1]!.payload.requestId)
 assert.notEqual(e.writes[0]!.payload.requestId,e.writes[2]!.payload.requestId)
 assert.equal(e.writes[0]!.payload.expectedVersion,0)
 assert.deepEqual(e.writes[0]!.payload.expectedMembers,members)
 assert.equal('ownerId' in e.writes[0]!.payload,false)
})

test('严格参数：模型不能指定本人、会话、请求、授权；完整定义和成员版本必须对应',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const args of [{fields,members,ownerId:'other'},{fields,members,requestId:id},{fields,members,sessionId:'other'},{fields:{...fields,canAutoRun:true},members},{fields,members:[{roleId,expectedVersion:2}]},{fields,members:[]},{fields:{...fields,rules:undefined},members},{fields,members:[{roleId,expectedVersion:3,canPost:true}]}])assert.equal((await e.call('teloa_groups_create',args)).isError,true)
 assert.equal(e.writes.length,0)
})

test('非本人、待归属、子代理、任务/搭建会话拒绝；写入还必须有唯一真实当前指令',async t=>{
 const cases:Array<{overrides?:Partial<GroupToolsPorts>;options?:Parameters<typeof setup>[1]}>=
  [{options:{subagent:true}},{options:{instructions:0}},{options:{instructions:2}},{overrides:{conversation:async sessionId=>({ownerId:'other',sessionId,status:'ready'})}},{overrides:{conversation:async sessionId=>({ownerId:owner,sessionId,status:'pending'})}},{overrides:{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'managed'})}},{overrides:{isTaskConversation:async()=>true}},{overrides:{isBuilder:async()=>true}},{overrides:{isPendingDaily:async()=>true}}]
 for(const item of cases){const e=await setup(item.overrides,item.options);t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_groups_create',{fields,members})).isError,true);assert.equal((await e.call('teloa_groups_list')).isError,item.options?.instructions===0||item.options?.instructions===2?false:true);assert.equal(e.writes.length,0)}
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.ctx.tools.execute({name:'teloa_groups_create',arguments:{fields,members},callId:ToolCallId('no-agent'),signal:AbortSignal.timeout(5000)})).isError,true)
})

test('本人员工原单聊可管理群；图片、文件与引用不阻断真实指令，也不能冒充用户来源',async t=>{
 const content=[{type:'text',text:'将附件相关工作放入这个群'}, {type:'image',attachment:{id:'image-untrusted'}}, {type:'file',attachment:{id:'file-untrusted'}}]
 const e=await setup({isRoleConversation:async()=>true},{content});t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.call('teloa_groups_create',{fields,members})).isError,false)
 assert.equal((await e.call('teloa_group_resources_save',{groupId:id,expectedVersion:0,title:'工作关联',markdown:'来自本人明确指令的关联说明'},'attachment-resource')).isError,false)
 const untrusted=await setup({},{content,source:{kind:'plugin:fake',form:'notice'}});t.after(()=>untrusted.ctx.fiber.dispose())
 assert.equal((await untrusted.call('teloa_groups_create',{fields,members})).isError,true);assert.equal(untrusted.writes.length,0)
})

for(const phase of ['review','approval'])test(`真实原生 Auto ${phase} 等待期间进入新轮次，旧工具参数不能重新绑定新指令`,async t=>{
 const fixture=await import('../../../tests/native-auto-review-fixture.mjs') as any
 const {ctx,adapter,create}=await fixture.createRuntime(t),agent=await create('group-auto-'+phase+'-turn-race')
 await ctx.plugin(fixture.autoReview);ctx.permissionPresets.set(agent.session,'auto')
 let writes=0,entered!:()=>void,release!:()=>void
 const waiting=new Promise<void>(resolve=>{entered=resolve}),released=new Promise<void>(resolve=>{release=resolve})
 registerGroupTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,scopes:async()=>['SOC'],roles:async()=>[role],admitText:groupMessageSecretGate(()=>[]),route:async()=>{writes++;return group}})
 const call=fixture.toolResponse('teloa_groups_create','old-call'),body=JSON.stringify({fields,members});call[1].argumentsDelta=body;call[2].block.arguments=body
 if(phase==='approval')ctx.on('approval/request',async()=>{entered();await released;return 'allowed-once'})
 const review=phase==='review'?(async function*(){entered();await released;yield* fixture.textResponse(JSON.stringify({risk:'low',decision:'allow'}))})():fixture.textResponse(JSON.stringify({risk:'medium',decision:'deny'}))
 adapter.script.push(call,review,fixture.textResponse('done'))
 agent.followup(fixture.createUserMessage({source:{kind:'user',rpcId:'old-turn'},content:[{type:'text',text:'创建这个协作群'}]}))
 const idle=agent.whenIdle();await waiting
 agent.session.append('turn/start',{turn:2});agent.session.append('user/message',fixture.createUserMessage({source:{kind:'user',rpcId:'new-turn'},content:[{type:'text',text:'改为先回答另一个问题'}]}),{surfaceOp:'append'})
 release();await idle
 assert.equal(writes,0)
 const result=agent.session.snapshotEvents().find((event:any)=>event.type==='tool/result');assert.equal(result?.data.message.isError,true)
})

test('真实 scope、在岗和本人目录限制：跨业务成员可加入，不能扩大岗位 scope 或换岗位版本',async t=>{
 for(const overrides of [{scopes:async()=>['general']},{roles:async()=>[{...role,ownerId:'other'}]},{roles:async()=>[{...role,state:'paused' as const}]},{roles:async()=>[]}]){
  const e=await setup(overrides);t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_groups_create',{fields,members})).isError,true);assert.equal(e.writes.length,0)
 }
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_groups_create',{fields,members})).isError,false)
 assert.deepEqual(e.writes[0]!.payload.fields.memberRoleIds,[roleId])
})

test('群编辑支持归档和恢复，旧版本拒绝；成功调用重放只用原请求',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const args={groupId:id,expectedVersion:1,fields:changeFields,members}
 for(let i=0;i<2;i++)assert.equal((await e.call('teloa_groups_change',args,'edit')).isError,false)
 assert.equal(e.writes[0]!.payload.requestId,e.writes[1]!.payload.requestId)
 assert.equal((await e.call('teloa_groups_change',{...args,fields:{...changeFields,name:'旧版本覆盖'}},'stale')).isError,true)
 assert.equal((await e.call('teloa_groups_change',{...args,expectedVersion:2,fields:{...changeFields,archived:true}},'archive')).isError,false)
 assert.equal(json(await e.call('teloa_groups_get',{groupId:id})).group.archived,true)
 assert.equal((await e.call('teloa_groups_change',{...args,expectedVersion:3},'restore')).isError,false)
})

test('资料创建、修订、撤回沿真实资源口，固定新资源身份，撤回保留原版本，不提供员工资源授权',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const args={groupId:id,expectedVersion:0,title:'处置资料',markdown:'# 经核对的步骤'}
 const first=await e.call('teloa_group_resources_save',args,'save');assert.equal(first.isError,false)
 const resourceId=json(first).resource.id
 assert.equal((await e.call('teloa_group_resources_save',args,'save')).isError,false)
 assert.equal(e.writes[0]!.payload.resourceId,e.writes[1]!.payload.resourceId)
 assert.equal((await e.call('teloa_group_resources_save',{...args,resourceId,expectedVersion:1,markdown:'修订'},'revise')).isError,false)
 assert.equal((await e.call('teloa_group_resources_withdraw',{groupId:id,resourceId,expectedVersion:2},'withdraw')).isError,false)
 const listing=await e.call('teloa_group_resources_list',{groupId:id});assert.equal(json(listing).resources[0].withdrawnAt,now)
 assert.equal((await e.call('teloa_group_resources_save',{...args,resourceId,expectedVersion:2},'revise-withdrawn')).isError,true)
 for(const row of e.writes)assert.equal('resources' in row.payload,false)
})

test('原生自动审查 allow 不被 blanket ask 替换，deny 保留；批准等待期间成员变更拒绝',async t=>{
 const allowed=await setup();t.after(()=>allowed.ctx.fiber.dispose())
 assert.equal((await allowed.call('teloa_groups_create',{fields,members})).isError,false)
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose());denied.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'原生拒绝'}))
 assert.equal((await denied.call('teloa_groups_create',{fields,members})).isError,true);assert.equal(denied.writes.length,0)
 let version=3
 const waiting=await setup({roles:async()=>[{...role,version}]});t.after(()=>waiting.ctx.fiber.dispose())
 waiting.ctx.on('tools/pre-execute',async(_exec,next)=>{const decision=await next();return decision.kind==='deny'?decision:{kind:'ask',reason:'需要本人确认'}})
 waiting.ctx.provide('approval',{request:async()=>{version=4;return 'allowed-once'}})
 assert.equal((await waiting.call('teloa_groups_create',{fields,members})).isError,true);assert.equal(waiting.writes.length,0)
})

test('服务回执必须保留本人、群版本和原字段，错误宿主回执不可作为成功',async t=>{
 for(const receipt of [{...group,ownerId:'other'},{...group,name:'偷换名字'},{...group,version:2}]){
  const e=await setup({route:async()=>receipt});t.after(()=>e.ctx.fiber.dispose())
  assert.equal((await e.call('teloa_groups_create',{fields,members})).isError,true)
 }
})

test('模型群定义与资料正文复用密钥闸，命中或密钥来源失效均不写入、不回显值',async t=>{
 const secret='owned-secret-value-not-a-pattern'
 for(const admitText of [groupMessageSecretGate(()=>[secret]),groupMessageSecretGate(()=>{throw Error('locked')})]){
  const e=await setup({admitText});t.after(()=>e.ctx.fiber.dispose())
  for(const [name,args] of [['teloa_groups_create',{fields:{...fields,announcement:secret},members}],['teloa_groups_create',{fields:{...fields,purpose:secret},members}],['teloa_group_resources_save',{groupId:id,expectedVersion:0,title:'步骤',markdown:secret}]] as const){
   const result=await e.call(name,args);assert.equal(result.isError,true);assert.equal(JSON.stringify(result).includes(secret),false)
  }
  assert.equal(e.writes.length,0)
 }
})

test('隔离 PostgreSQL：真实群处理器与持久服务完成建群、成员编辑和资料修订撤回，保持版本授权边界',{skip:process.env.TELOA_GROUP_TOOLS_POSTGRES_TEST!=='1'},async t=>{
 const {PostgreSqlContainer}=await import('@testcontainers/postgresql')
 const {Pool}=await import('../../backend/tests/postgres-test-lifecycle.ts')
 const {randomUUID}=await import('node:crypto')
 const {CollaborationService,RoleService,GroupAgentGrantService,initializeRoles,initializeRoleDelegations,initializeTasks,initializeCollaboration,initializeGroupAgentGrants}=await import('@teloa/backend')
 const container=await new PostgreSqlContainer('postgres:17-alpine').start()
 const pool=new Pool({connectionString:container.getConnectionUri()});t.after(async()=>{await pool.end();await container.stop()})
 await initializeRoles(pool);await initializeRoleDelegations(pool);await initializeTasks(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
 const realOwner='group-tools-test:'+randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},groups=new CollaborationService(pool,identity),roles=new RoleService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 const roleFields={name:'真实调查员',kind:'employee' as const,scopes:['SOC'],duty:'调查',dataScope:'已授权资料',executionScope:'已授权工具',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
 const firstRole=await roles.create(realOwner,{requestId:randomUUID(),fields:roleFields}),secondRole=await roles.create(realOwner,{requestId:randomUUID(),fields:{...roleFields,name:'跨业务核对员',scopes:['AppSec']}})
 const route=createGroupHandler(realOwner,async()=>({...groups,list:groups.list.bind(groups),get:groups.get.bind(groups),create:groups.create.bind(groups),change:groups.change.bind(groups),messages:groups.messages.bind(groups),messageBody:groups.messageBody.bind(groups),send:groups.send.bind(groups),resources:groups.resources.bind(groups),resource:groups.resource.bind(groups),saveResource:groups.saveResource.bind(groups),withdrawResource:groups.withdrawResource.bind(groups),reactions:async()=>{throw Error('未使用')},toggleReaction:async()=>{throw Error('未使用')},routing:async()=>{throw Error('未使用')},routingStatus:async()=>{throw Error('未使用')},retryRouting:async()=>{throw Error('未使用')}}),groupMessageSecretGate(()=>[]))
 const e=await setup({owner:realOwner,conversation:async sessionId=>({ownerId:realOwner,sessionId,status:'ready'}),roles:async()=>[firstRole,secondRole],route});t.after(()=>e.ctx.fiber.dispose())
 const create={fields:{...fields,memberRoleIds:[firstRole.id]},members:[{roleId:firstRole.id,expectedVersion:firstRole.version}]}
 const created=await e.call('teloa_groups_create',create,'real-create');assert.equal(created.isError,false,JSON.stringify(created))
 const persisted=json(created).group as Group
 assert.equal((await groups.get(realOwner,{groupId:persisted.id})).members.length,2)
 const initialGrant=await grants.get(realOwner,{groupId:persisted.id,roleId:firstRole.id})
 assert.equal(initialGrant.status,'active');assert.deepEqual(initialGrant.grant?.resources,[]);assert.equal(initialGrant.grant?.roleVersion,firstRole.version)
 const edited=await e.call('teloa_groups_change',{groupId:persisted.id,expectedVersion:1,fields:{...changeFields,memberRoleIds:[secondRole.id]},members:[{roleId:secondRole.id,expectedVersion:secondRole.version}]},'real-edit')
 assert.equal(edited.isError,false,JSON.stringify(edited));assert.equal(json(edited).group.version,2)
 const snapshot=await groups.get(realOwner,{groupId:persisted.id});assert.deepEqual(snapshot.members.map(member=>member.roleId).sort(),[null,secondRole.id].sort())
 assert.equal((await grants.get(realOwner,{groupId:persisted.id,roleId:secondRole.id})).status,'not-granted','跨业务成员不会扩大原岗位范围或获群执行授权')
 assert.equal((await e.call('teloa_groups_change',{groupId:persisted.id,expectedVersion:1,fields:{...changeFields,name:'覆盖旧版本',memberRoleIds:[secondRole.id]},members:[{roleId:secondRole.id,expectedVersion:secondRole.version}]},'real-stale')).isError,true)
 const saved=await e.call('teloa_group_resources_save',{groupId:persisted.id,expectedVersion:0,title:'处置步骤',markdown:'# 已核对'},'real-save');assert.equal(saved.isError,false,JSON.stringify(saved))
 const resourceId=json(saved).resource.id
 assert.equal((await e.call('teloa_group_resources_save',{groupId:persisted.id,expectedVersion:0,title:'处置步骤',markdown:'# 已核对'},'real-save')).isError,false)
 assert.equal((await groups.resources(realOwner,{groupId:persisted.id})).length,1)
 assert.equal((await e.call('teloa_group_resources_save',{groupId:persisted.id,resourceId,expectedVersion:1,title:'处置步骤',markdown:'# 修订内容'},'real-revise')).isError,false)
 assert.equal((await e.call('teloa_group_resources_withdraw',{groupId:persisted.id,resourceId,expectedVersion:2},'real-withdraw')).isError,false)
 const directory=await groups.resources(realOwner,{groupId:persisted.id});assert.equal(directory[0]?.version,2);assert.ok(directory[0]?.withdrawnAt)
 assert.equal((await groups.resource(realOwner,{groupId:persisted.id,resourceId,resourceVersion:1})).markdown,'# 已核对')
 assert.equal((await groups.resource(realOwner,{groupId:persisted.id,resourceId,resourceVersion:2})).markdown,'# 修订内容')
 const requests=await pool.query('select count(*)::int as n from teloa_group_resource_requests where owner_id=$1',[realOwner]);assert.equal(requests.rows[0].n,3)
 const expanded=await pool.query('select count(*)::int as n from teloa_group_agent_grants where owner_id=$1 and jsonb_array_length(resources)>0',[realOwner]);assert.equal(expanded.rows[0].n,0,'保存或撤回资料不会把版本引用加入员工授权')
 let racedRequestId=''
 e.ports.route=async(endpoint,args)=>{
  if(endpoint==='groups/create'){
   racedRequestId=(args as any).requestId
   await pool.query('update teloa_roles set version=version+1 where id=$1',[firstRole.id])
  }
  return route(endpoint,args)
 }
 const racedCreate=await e.call('teloa_groups_create',create,'race-create');assert.equal(racedCreate.isError,true,'工具最后一次目录核对后到事务前发生岗位版本变化，必须拒绝')
 assert.equal((await pool.query('select count(*)::int as n from teloa_groups where owner_id=$1 and request_id=$2',[realOwner,racedRequestId])).rows[0].n,0)
 const empty=await groups.create(realOwner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields,memberRoleIds:[]}})
 e.ports.roles=async()=>[{...firstRole,version:2},secondRole]
 e.ports.route=async(endpoint,args)=>{
  if(endpoint==='groups/change')await pool.query('update teloa_roles set version=version+1 where id=$1',[firstRole.id])
  return route(endpoint,args)
 }
 const racedChange=await e.call('teloa_groups_change',{groupId:empty.id,expectedVersion:1,fields:{...changeFields,memberRoleIds:[firstRole.id]},members:[{roleId:firstRole.id,expectedVersion:2}]},'race-change')
 assert.equal(racedChange.isError,true)
 const unchanged=await groups.get(realOwner,{groupId:empty.id});assert.equal(unchanged.group.version,1);assert.deepEqual(unchanged.members.map(member=>member.roleId),[null])
 assert.equal((await pool.query('select count(*)::int as n from teloa_group_agent_grants where owner_id=$1 and group_id=$2',[realOwner,empty.id])).rows[0].n,0)
 const fixed={requestId:randomUUID(),expectedVersion:0 as const,fields:{...fields,memberRoleIds:[firstRole.id]},expectedMembers:[{roleId:firstRole.id,expectedVersion:3}]}
 const committed=await groups.create(realOwner,fixed)
 await pool.query('update teloa_roles set version=version+1 where id=$1',[firstRole.id])
 assert.deepEqual(await groups.create(realOwner,fixed),committed,'持久请求已成功后按原成员版本重放，仍返回原群，不续签新版本授权')
 await assert.rejects(groups.create(realOwner,{...fixed,expectedMembers:[{roleId:firstRole.id,expectedVersion:4}]}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select role_version from teloa_group_agent_grants where owner_id=$1 and group_id=$2',[realOwner,committed.id])).rows[0].role_version,3)
 const fixedChange={requestId:randomUUID(),groupId:empty.id,expectedVersion:1,fields:{...changeFields,memberRoleIds:[firstRole.id]},expectedMembers:[{roleId:firstRole.id,expectedVersion:4}]}
 const committedChange=await groups.change(realOwner,fixedChange)
 await pool.query('update teloa_roles set version=version+1 where id=$1',[firstRole.id])
 assert.deepEqual(await groups.change(realOwner,fixedChange),committedChange)
 await assert.rejects(groups.change(realOwner,{...fixedChange,expectedMembers:[{roleId:firstRole.id,expectedVersion:5}]}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select role_version from teloa_group_agent_grants where owner_id=$1 and group_id=$2',[realOwner,empty.id])).rows[0].role_version,4)
})
