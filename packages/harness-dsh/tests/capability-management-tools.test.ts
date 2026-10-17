import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError} from '@teloa/contract'
import {registerCapabilityManagementTools,capabilityManagementToolNames,type CapabilityManagementPorts} from '../src/capability-management-tools.ts'
import {groupMessageSecretGate} from '../src/prompt-secret-gate.ts'
import {createBundledExtensionHandler} from '../src/bundled-extensions.ts'
import {withProfileLock} from '../src/pending-plugins.ts'

const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64),owner='local:owner'
const availability={installationId:id,expectedVersion:1,expectedBundleHash:hash,expectedImpactDigest:hash,action:'disable'}
const text=(value:any)=>JSON.parse(value.content.filter((row:any)=>row.type==='text').map((row:any)=>row.text).join('\n'))
async function hostRoleToolsDescription(roles:unknown,read:()=>Promise<unknown>):Promise<CapabilityManagementPorts['describe']>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),file=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true)
 let adapter:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='stopCapabilityManagementTools'&&node.initializer&&ts.isCallExpression(node.initializer)){
  const ports=node.initializer.arguments[1]
  if(ports&&ts.isObjectLiteralExpression(ports)){const property=ports.properties.find(row=>ts.isPropertyAssignment(row)&&row.name.getText(file)==='describe');if(property&&ts.isPropertyAssignment(property))adapter=property.initializer}
 }ts.forEachChild(node,visit)}
 visit(file);assert.ok(adapter,'必须测试正式宿主当前装配的能力描述adapter')
 const code=ts.transpileModule('exports.describe='+adapter.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const exports:{describe?:CapabilityManagementPorts['describe']}={}
 const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
 const record=(value:unknown)=>{assert.ok(isRecord(value));return value}
 new Function('roleHandler','roleGrantHandler','capabilityRecord','isRecord','WorkError','owner','exports',code)(async()=>roles,async()=>read(),record,isRecord,WorkError,owner,exports)
 assert.ok(exports.describe);return exports.describe
}
async function setup(overrides:Partial<CapabilityManagementPorts>={},options:{origin?:'subagent';source?:any;instructions?:number;content?:any[]}={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('capability-management'),...(options.origin?{meta:{origin:options.origin,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 for(let i=0;i<(options.instructions??1);i++)agent.session.append('user/message',createUserMessage({source:options.source??{kind:'user',rpcId:'request'},content:options.content??[{type:'text',text:'停用这个技能，调整员工的明确授权'}]}),{surfaceOp:'append'})
 const calls:Array<{endpoint:string;payload:any}>=[],handler=async(endpoint:string,payload:unknown)=>{calls.push({endpoint,payload});return {endpoint,payload}}
 const rules=[{name:'read_reference',allowed:[{id:'ref-one',version:'v1'},{id:'ref-two',version:'v2'}]},{name:'web_search',anyArguments:true as const,allowed:[]}]
 const ports:CapabilityManagementPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,skillAvailability:handler,skillSelection:handler,extensions:handler,roleGrants:async(endpoint,payload)=>endpoint==='role-tools/candidates'?{roleVersion:1,rules}:handler(endpoint,payload),groupGrants:handler,dataSources:handler,executionTools:handler,probe:handler,describe:async()=>null,admitText:groupMessageSecretGate(()=>['stored-private-value']),...overrides}
 const dispose=registerCapabilityManagementTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={},callId='call',signal:AbortSignal=AbortSignal.timeout(5000))=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal})
 return {ctx,agent,ports,calls,rules,dispose,call}
}

test('固定能力配置入口复用真实端点，不注册任意RPC、密钥或命令入口',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.deepEqual(e.ctx.tools.schemas(e.agent).map(row=>row.name),[...capabilityManagementToolNames])
 const cases:[string,Record<string,unknown>,string][]=[
  ['teloa_skill_availability_preview',{installationId:id},'skill-availability/preview'],['teloa_skill_availability_change',availability,'skill-availability/change'],
  ['teloa_skill_selection_get',{nativeName:'research-brief'},'skill-selections/get'],['teloa_skill_selection_preview',{currentInstallationId:id,targetInstallationId:other},'skill-selections/preview'],
  ['teloa_skill_selection_change',{nativeName:'research-brief',currentInstallationId:id,targetInstallationId:other,expectedSelectionVersion:1,expectedCurrentBundleHash:hash,expectedTargetBundleHash:hash,expectedImpactDigest:hash,industryUsages:[]},'skill-selections/change'],
  ['teloa_extensions_list',{},'bundled-extensions/list'],['teloa_extensions_set',{extensionId:'local-embedding',enabled:true,expectedVersion:'0.2.0',expectedState:'available'},'bundled-extensions/set'],
  ['teloa_role_tools_get',{roleId:id},'role-tools/get'],['teloa_group_agent_grant_get',{groupId:id,roleId:other},'groups/agent-grants/get'],
  ['teloa_group_agent_grant_change',{groupId:id,roleId:other,expectedGroupVersion:1,expectedRoleVersion:1,action:'save',resources:[{kind:'group-resource',id:other,version:2}],canPost:true,canAutoRun:false},'groups/agent-grants/change'],
  ['teloa_connector_instances_list',{kind:'data-source'},'industry-data-sources/list'],['teloa_connector_instances_get',{kind:'execution-tool',instanceId:id},'industry-execution-tools/get'],
  ['teloa_connector_instances_authorize',{kind:'data-source',instanceId:id,expectedRevision:1},'industry-data-sources/authorize'],['teloa_connector_probe',{kind:'mcp',instanceId:id},'connectors/probe'],
 ]
 for(const [name,args,endpoint] of cases){const result=await e.call(name,args,name);assert.equal(result.isError,false,name+JSON.stringify(result));assert.equal(e.calls.at(-1)?.endpoint,endpoint)}
 assert.equal(e.calls.every(row=>!('ownerId'in row.payload)&&!('sessionId'in row.payload)),true)
 assert.deepEqual(e.calls.find(row=>row.endpoint==='bundled-extensions/set')?.payload,{extensionId:'local-embedding',enabled:true,expected:{version:'0.2.0',state:'available'}})
})

test('写请求固定到当前指令和工具调用，同调用可重试，不同调用及新轮次不同',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const call of ['one','one','two'])assert.equal((await e.call('teloa_skill_availability_change',availability,call)).isError,false)
 assert.equal(e.calls[0]!.payload.requestId,e.calls[1]!.payload.requestId);assert.notEqual(e.calls[0]!.payload.requestId,e.calls[2]!.payload.requestId)
 e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'next'},content:[{type:'text',text:'按新指令停用'}]}),{surfaceOp:'append'})
 assert.equal((await e.call('teloa_skill_availability_change',availability,'one')).isError,false);assert.notEqual(e.calls[0]!.payload.requestId,e.calls.at(-1)!.payload.requestId)
})

test('只有本人普通会话可配置；读取无须唯一当前指令，写入必须真实用户来源',async t=>{
 for(const item of [{overrides:{conversation:async(sessionId:string)=>({ownerId:'other',sessionId,status:'ready' as const})}},{overrides:{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'managed'})}},{options:{origin:'subagent' as const}},{options:{instructions:0}},{options:{instructions:2}},{options:{source:{kind:'tool',name:'untrusted'}}}]){
  const e=await setup(item.overrides,item.options);t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_skill_availability_change',availability)).isError,true);assert.equal(e.calls.length,0)
 }
 const e=await setup({}, {instructions:0});t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_extensions_list')).isError,false)
 const files=await setup({}, {content:[{type:'text',text:'停用技能'},{type:'image',attachment:{id:'untrusted-image'}},{type:'file',attachment:{id:'untrusted-file'}}]});t.after(()=>files.ctx.fiber.dispose());assert.equal((await files.call('teloa_skill_availability_change',availability)).isError,false)
})

test('严格拒绝未知字段、伪造身份、无版本、凭据、任意RPC和任意工具参数',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const args of [{...availability,ownerId:'other'},{...availability,requestId:id},{...availability,expectedVersion:0},{...availability,action:'delete'},{...availability,reason:'stored-private-value'}])assert.equal((await e.call('teloa_skill_availability_change',args)).isError,true)
 for(const [name,args] of [['teloa_extensions_set',{extensionId:'im-gateway',enabled:false,expectedVersion:'0.2.0',expectedState:'active'}],['teloa_connector_instances_authorize',{kind:'mcp',instanceId:id,expectedRevision:1}],['teloa_role_tools_change',{roleId:id,expectedRoleVersion:1,action:'save',expectedCandidatesDigest:hash,selections:[],rules:[{name:'bash',anyArguments:true,allowed:[]}]}]] as const)assert.equal((await e.call(name,args)).isError,true)
 assert.equal(e.calls.length,0)
})

test('员工授权只能选择本人实时目录的固定规则与参数子集，摘要变化拒绝',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());const candidates=text(await e.call('teloa_role_tools_candidates',{roleId:id})).value
 const input={roleId:id,expectedRoleVersion:1,action:'save',expectedCandidatesDigest:candidates.digest,selections:[{key:candidates.candidates[0].key,argumentIndices:[1]}]}
 assert.equal((await e.call('teloa_role_tools_change',input)).isError,false)
 assert.deepEqual(e.calls.at(-1)?.payload,{roleId:id,expectedRoleVersion:1,action:'save',rules:[{name:'read_reference',allowed:[{id:'ref-two',version:'v2'}]}]})
 assert.equal((await e.call('teloa_role_tools_change',{...input,selections:[{key:hash,argumentIndices:[]}]})).isError,true)
 assert.equal((await e.call('teloa_role_tools_change',{...input,expectedCandidatesDigest:hash})).isError,true)
 assert.equal((await e.call('teloa_role_tools_change',{...input,selections:[{key:candidates.candidates[0].key,argumentIndices:[9]}]})).isError,true)
})

test('原生审核等待前 pin 指令；等待中换轮次拒绝原参数，原生deny保持',async t=>{
 let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve}),finished=new Promise<void>(resolve=>{release=resolve})
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());e.ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.name==='teloa_skill_availability_change'){entered();await finished}return next()})
 const call=e.call('teloa_skill_availability_change',availability);await waiting;e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'next'},content:[{type:'text',text:'现在取消'}]}),{surfaceOp:'append'});release();assert.equal((await call).isError,true);assert.equal(e.calls.length,0)
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose());denied.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'原生规则拒绝'}));assert.equal((await denied.call('teloa_skill_availability_change',availability)).isError,true);assert.equal(denied.calls.length,0)
})

test('真实服务的版本冲突保留；服务意外密钥内容不进入模型回包',async t=>{
 const e=await setup({skillAvailability:async()=>{throw new WorkError('teloa/version-conflict','安装版本已变化')}});t.after(()=>e.ctx.fiber.dispose());const result=await e.call('teloa_skill_availability_change',availability);assert.equal(result.isError,true);assert.match(JSON.stringify(result),/安装版本已变化/)
 const bad=await setup({extensions:async()=>({secret:'stored-private-value'})});t.after(()=>bad.ctx.fiber.dispose());const output=await bad.call('teloa_extensions_list');assert.equal(output.isError,true);assert.equal(JSON.stringify(output).includes('stored-private-value'),false)
})

test('配置回执携带宿主真实对象摘要；跨本人、空版本和含密钥标题不进入卡片',async t=>{
 const resource={kind:'skill' as const,id:'research-brief',ownerId:owner,title:'研究摘要',version:'1.0.0',state:'saved',installationId:id,contentId:other,nativeName:'research-brief'}
 const e=await setup({describe:async()=>resource});t.after(()=>e.ctx.fiber.dispose());const receipt=text(await e.call('teloa_skill_availability_preview',{installationId:id}));assert.equal(receipt.schema,'teloa.capability-result/v1');assert.equal(receipt.sessionId,e.agent.id);assert.deepEqual(receipt.resource,resource)
 for(const extra of [{ownerId:'other'},{version:''},{title:'stored-private-value'}]){const denied=await setup({describe:async()=>({...resource,...extra})});t.after(()=>denied.ctx.fiber.dispose());const result=await denied.call('teloa_skill_availability_preview',{installationId:id});assert.equal(result.isError,true);assert.equal(JSON.stringify(result).includes('stored-private-value'),false)}
})

test('真实宿主adapter保留生命周期之前的有效工具授权，未来版本/撤销和本人边界仍准确',async t=>{
 const role={id,ownerId:owner,name:'原员工',version:4},grant={roleId:id,roleVersion:3,state:'active',rules:[{name:'get_goal',anyArguments:true,allowed:[]}],createdAt:new Date(0).toISOString()}
 for(const [label,value,state] of [
  ['恢复在岗后旧版active仍有效',{roleVersion:4,grant},'active'],
  ['同版active',{roleVersion:4,grant:{...grant,roleVersion:4}},'active'],
  ['最新撤销不能复活旧授权',{roleVersion:4,grant:{...grant,state:'revoked',rules:[]}},'revoked'],
  ['没有授权',{roleVersion:4,grant:null},'not-granted'],
  ['未来版本不误当有效',{roleVersion:4,grant:{...grant,roleVersion:5}},'invalidated'],
  ['坏版本不会经隐式数值转换成为有效',{roleVersion:4,grant:{...grant,roleVersion:'bad-version'}},'invalidated'],
 ] as const)await t.test(label,async t=>{
  const read=async()=>value,e=await setup({roleGrants:async()=>read(),describe:await hostRoleToolsDescription([role],read)});t.after(()=>e.ctx.fiber.dispose())
  const receipt=text(await e.call('teloa_role_tools_get',{roleId:id}))
  assert.deepEqual(receipt.value,value);assert.deepEqual(receipt.resource,{kind:'role-tools',id,roleId:id,ownerId:owner,title:role.name,version:4,state})
 })
 for(const [label,roles,read] of [
  ['其它本人目录不能冒用原员工',[{...role,ownerId:'other'}],async()=>({roleVersion:4,grant})],
  ['服务拒绝损坏未来授权不被adapter吞掉',[role],async()=>{throw new WorkError('teloa/storage-corrupt','授权版本高于员工版本。')}],
 ] as const)await t.test(label,async t=>{
  const e=await setup({roleGrants:async()=>read(),describe:await hostRoleToolsDescription(roles,read)});t.after(()=>e.ctx.fiber.dispose())
  assert.equal((await e.call('teloa_role_tools_get',{roleId:id})).isError,true)
 })
})

test('真实 DSH 与 profile 排队锁：取消或换轮次后不写配置、不热套用；最终原子替换前再核验',async t=>{
 for(const mode of ['abort','new-turn','before-commit'] as const)await t.test(mode,async t=>{
  const home=await mkdtemp(join(tmpdir(),'teloa-capability-profile-')),profileDir=join(home,'profile'),projectRoot=resolve(fileURLToPath(new URL('../../../',import.meta.url)))
  t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(profileDir)
  const manifest=JSON.stringify({dependencies:{'@teloa/local-embedding':'link:'+join(projectRoot,'packages/local-embedding')},dsh:{profile:{bundles:['@teloa/bundle']}}});await writeFile(join(profileDir,'package.json'),manifest)
  let applies=0,guards=0,entered!:()=>void;const queued=new Promise<void>(resolve=>{entered=resolve})
  const handler=createBundledExtensionHandler({profileDir,programRoot:projectRoot,runtimeRoot:join(home,'runtime'),bundlesAtStart:['@teloa/bundle'],loaded:()=>false,version:async()=>'0.2.0',apply:async()=>{applies++;return 'restart-required'}})
  const changeTurn=()=>{e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'next'},content:[{type:'text',text:'取消刚才的启用'}]}),{surfaceOp:'append'})}
  const e=await setup({extensions:(endpoint,payload,signal,guard)=>{const result=handler(endpoint,payload,signal,async()=>{guards++;if(mode==='before-commit'&&guards===2)changeTurn();await guard?.()});entered();return result}});t.after(()=>e.ctx.fiber.dispose())
  let release!:()=>void,held!:()=>void;const ready=new Promise<void>(resolve=>{held=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
  const blocker=mode==='before-commit'?Promise.resolve():withProfileLock(profileDir,async()=>{held();await wait});if(mode!=='before-commit')await ready
  const controller=new AbortController(),pending=e.call('teloa_extensions_set',{extensionId:'local-embedding',enabled:true,expectedVersion:'0.2.0',expectedState:'available'},'queued',controller.signal);await queued
  if(mode==='abort')controller.abort();if(mode==='new-turn')changeTurn();if(mode!=='before-commit')release()
  await blocker;assert.equal((await pending).isError,true);await withProfileLock(profileDir,async()=>{})
  assert.equal(await readFile(join(profileDir,'package.json'),'utf8'),manifest);assert.equal(applies,0);assert.deepEqual(await readdir(profileDir),['package.json'])
  if(mode==='before-commit')assert.equal(guards,2)
 })
})
