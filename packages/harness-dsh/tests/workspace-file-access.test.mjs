import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRuntime,official,createUserMessage,ToolCallId} from '../../../tests/native-auto-review-fixture.mjs'
import {createScopedWorkspaceFileSystem,createTaskRunWorkspaceFileAccess,workspaceFileToolRules} from '../src/workspace-file-access.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

async function fixture(t){
 const {ctx}=await createRuntime(t),home=await mkdtemp(join(tmpdir(),'teloa-workspace-files-')),cwd=join(home,'work'),outside=join(home,'work-extra')
 t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(cwd);await mkdir(outside)
 let authorized=true
 const scoped=await createScopedWorkspaceFileSystem(ctx.fs,{cwd,authorize:async()=>{if(!authorized)throw Error('授权已撤销')},protectedPath:path=>path.endsWith('/credentials.txt')})
 return {ctx,cwd,outside,scoped,revoke:()=>{authorized=false}}
}
test('官方受限 FS 在实际读写和编辑处再次核对当前工作目录，支持未创建的子目录',async t=>{
 const f=await fixture(t),signal=AbortSignal.timeout(5000),target=await f.scoped.resolve('outputs/result.txt',{cwd:f.cwd,signal})
 await f.scoped.writeText(target,'first',undefined,signal,{mode:'danger-full-access',workspaceRoot:f.outside})
 assert.equal(await readFile(join(f.cwd,'outputs/result.txt'),'utf8'),'first')
 assert.equal(await f.scoped.readText(target,signal),'first')
 await f.scoped.editText(target,{oldString:'first',newString:'edited',replaceAll:false},undefined,signal)
 assert.equal(await f.scoped.readText(target,signal),'edited')
 f.revoke();await assert.rejects(f.scoped.readText(target,signal),/撤销/)
 await assert.rejects(f.scoped.writeText(target,'denied',undefined,signal),/撤销/)
 assert.equal(await readFile(join(f.cwd,'outputs/result.txt'),'utf8'),'edited')
})
test('工作目录外链、相同前缀兄弟目录、嵌套敏感目录与凭据别名均不能读取或写入',async t=>{
 const f=await fixture(t),signal=AbortSignal.timeout(5000)
 await writeFile(join(f.outside,'secret.txt'),'outside');await symlink(f.outside,join(f.cwd,'external'))
 await mkdir(join(f.cwd,'nested/.runtime'),{recursive:true});await writeFile(join(f.cwd,'nested/.runtime/private.txt'),'runtime')
 await symlink(join(f.cwd,'nested/.runtime'),join(f.cwd,'runtime-alias'));await writeFile(join(f.cwd,'credentials.txt'),'private')
 await symlink(join(f.cwd,'credentials.txt'),join(f.cwd,'renamed.txt'))
 for(const path of ['external/secret.txt','external/new-dir/file.txt',join(f.outside,'new.txt'),'runtime-alias/private.txt','nested/.runtime/private.txt','renamed.txt','../work-extra/secret.txt','.git/config'])await assert.rejects(f.scoped.resolve(path,{cwd:f.cwd,signal}),/范围|目录|凭据/)
 assert.equal(await readFile(join(f.outside,'secret.txt'),'utf8'),'outside')
})
test('resolve 后链接改指在实际 I/O 前被拒绝，不能用已核验旧目标写入新位置',async t=>{
 const f=await fixture(t),signal=AbortSignal.timeout(5000)
 await mkdir(join(f.cwd,'inside'));await writeFile(join(f.cwd,'inside/result.txt'),'inside');await writeFile(join(f.outside,'result.txt'),'outside')
 await symlink(join(f.cwd,'inside'),join(f.cwd,'alias'))
 const target=await f.scoped.resolve('alias/result.txt',{cwd:f.cwd,signal})
 await rm(join(f.cwd,'alias'));await symlink(f.outside,join(f.cwd,'alias'))
 await assert.rejects(f.scoped.readText(target,signal),/范围|变化/)
 await assert.rejects(f.scoped.writeText(target,'denied',undefined,signal),/范围|变化/)
 assert.equal(await readFile(join(f.outside,'result.txt'),'utf8'),'outside')
})
test('文件授权候选只来自官方工具与受限 FS 的当前可见交集，不包含 Bash 或脚本',async t=>{
 const f=await fixture(t)
 assert.deepEqual(await workspaceFileToolRules(f.ctx),[])
 await f.ctx.plugin(await official('dsh-tool-fs'),{})
 assert.deepEqual(await workspaceFileToolRules(f.ctx),['read','write','edit'].map(name=>({name,allowed:[],workspaceFiles:'default-workspace'})))
})
test('没有 Agent 时从默认预设只读 lease 发现文件候选，不创建运行会话',async t=>{
 const f=await fixture(t),{createScope}=await official('dsh-scope'),key={},scope=createScope(f.ctx,key)
 t.after(()=>scope.dispose());await scope.ctx.plugin(await official('dsh-tool-fs'),{})
 let released=0
 f.ctx.provide('agentPresets',{acquireScope:async()=>({key,async [Symbol.asyncDispose](){released++}})})
 assert.equal(f.ctx.tools.get('read'),undefined)
 assert.deepEqual(await workspaceFileToolRules(f.ctx),['read','write','edit'].map(name=>({name,allowed:[],workspaceFiles:'default-workspace'})))
 assert.equal(released,1);assert.equal(f.ctx.agents.list().length,0)
})
test('仅授读取时 scoped 官方套件不会把写入或其他文件工具重新露给模型',async t=>{
 const f=await fixture(t);await f.ctx.plugin(await official('dsh-tool-fs'),{})
 f.ctx.provide('agentPresets',{serviceFor:()=>undefined})
 await writeFile(join(f.cwd,'input.txt'),'bounded')
 const agent=(await f.ctx.agents.create({sessionId:'workspace-readonly',meta:{cwd:f.cwd},agentOptions:{provider:'native-auto-review-test',model:'scripted'}})).agent
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:'readonly-request'}}),{surfaceOp:'append'})
 const read=async()=>({nativeRequestId:'readonly-request',allowedTools:['read'],argumentRules:[{name:'read',allowed:[],workspaceFiles:'default-workspace'}]})
 registerTaskToolGuard(f.ctx,read,[],undefined,undefined,undefined,undefined,undefined,undefined,createTaskRunWorkspaceFileAccess(f.ctx,f.cwd,read,()=>false))
 agent.ctx.tools.restrict({allow:['read']})
 const result=await f.ctx.tools.execute({agent,name:'read',arguments:{file_path:'input.txt'},callId:ToolCallId('readonly-call'),signal:AbortSignal.timeout(5000)})
 assert.equal(result.isError,false,JSON.stringify(result))
 assert.deepEqual(f.ctx.tools.schemas(agent).map(tool=>tool.name),['read'])
})
test('真实官方工具运行器保留 scoped 文件授权与审批，确认期间撤权不能写文件，子会话不能换目录',async t=>{
 const f=await fixture(t);await f.ctx.plugin(await official('dsh-tool-fs'),{})
 f.ctx.provide('agentPresets',{serviceFor:()=>undefined})
 const agent=(await f.ctx.agents.create({sessionId:'workspace-run',meta:{cwd:f.cwd},agentOptions:{provider:'native-auto-review-test',model:'scripted'}})).agent
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:'workspace-request'}}),{surfaceOp:'append'})
 let active=true,revokeOnApproval=false,asks=0,seq=0
 const rules=['read','write','edit'].map(name=>({name,allowed:[],workspaceFiles:'default-workspace'}))
 const read=async()=>({nativeRequestId:'workspace-request',allowedTools:active?['read','write','edit']:[],argumentRules:active?rules:[]})
 const access=createTaskRunWorkspaceFileAccess(f.ctx,f.cwd,read,()=>false)
 registerTaskToolGuard(f.ctx,read,[],undefined,undefined,undefined,undefined,undefined,undefined,access)
 f.ctx.on('tools/pre-execute',async(exec,next)=>revokeOnApproval&&exec.name==='write'?{kind:'ask',reason:'定向验证等待期间撤权'}:next())
 f.ctx.on('approval/request',async()=>{asks++;if(revokeOnApproval)active=false;return 'allowed-once'})
 const call=(name,args,actor=agent)=>f.ctx.tools.execute({agent:actor,name,arguments:args,callId:ToolCallId('workspace-'+ ++seq),signal:AbortSignal.timeout(5000)})
 const written=await call('write',{file_path:join(f.cwd,'outputs/result.txt'),content:'created'})
 assert.equal(written.isError,false,JSON.stringify(written));assert.equal(await readFile(join(f.cwd,'outputs/result.txt'),'utf8'),'created')
 assert.equal((await call('read',{file_path:'outputs/result.txt'})).isError,false)
 assert.equal((await call('edit',{file_path:'outputs/result.txt',old_string:'created',new_string:'edited'})).isError,false)
 assert.equal((await call('write',{file_path:join(f.outside,'outside.txt'),content:'denied'})).isError,true)
 const child=(await f.ctx.agents.create({sessionId:'workspace-child',meta:{cwd:f.outside,origin:'subagent',parentSession:agent.session.id,delegationDepth:1},agentOptions:{provider:'native-auto-review-test',model:'scripted'}})).agent
 assert.equal((await call('write',{file_path:'child.txt',content:'denied'},child)).isError,true)
 revokeOnApproval=true
 assert.equal((await call('write',{file_path:'outputs/denied.txt',content:'denied'})).isError,true)
 assert.ok(asks>0,'保留官方文件工具的审批链')
 await assert.rejects(readFile(join(f.cwd,'outputs/denied.txt')))
 assert.equal((await call('bash',{command:'echo denied'})).isError,true)
})

async function readonlyRun(t){
 const f=await fixture(t);await f.ctx.plugin(await official('dsh-tool-fs'),{})
 f.ctx.provide('agentPresets',{serviceFor:()=>undefined})
 const agent=(await f.ctx.agents.create({sessionId:'workspace-escalation',meta:{cwd:f.cwd},agentOptions:{provider:'native-auto-review-test',model:'scripted'}})).agent
 const {setSandboxMode}=await official('dsh-sandbox-policy');setSandboxMode(agent.session,'read-only')
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:'escalation-request'}}),{surfaceOp:'append'})
 let current=true,seq=0
 const rules=['read','write','edit'].map(name=>({name,allowed:[],workspaceFiles:'default-workspace'}))
 const policy=async()=>{if(!current)throw Error('员工版本或授权已变化');return {nativeRequestId:'escalation-request',allowedTools:['read','write','edit'],argumentRules:rules}}
 registerTaskToolGuard(f.ctx,policy,[],undefined,undefined,undefined,undefined,undefined,undefined,createTaskRunWorkspaceFileAccess(f.ctx,f.cwd,policy,path=>path.endsWith('/credentials.txt')))
 const call=(name,args)=>f.ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('escalation-'+ ++seq),signal:AbortSignal.timeout(5000)})
 return {...f,agent,call,revoke:()=>{current=false}}
}

for(const name of ['write','edit'])for(const decision of ['allowed-once','rejected'])test(`只读任务的官方 ${name} 升级先审批，${decision} 不改变常驻权限`,async t=>{
 const f=await readonlyRun(t),path=join(f.cwd,'result.txt');let asks=0
 await writeFile(path,'original')
 assert.equal((await f.call('read',{file_path:'result.txt'})).isError,false)
 const args=name==='write'?{file_path:'result.txt',content:'updated'}:{file_path:'result.txt',old_string:'original',new_string:'updated'}
 f.ctx.on('approval/request',async()=>{asks++;assert.equal(await readFile(path,'utf8'),'original');return decision})
 assert.equal((await f.call(name,args)).isError,true);assert.equal(asks,0)
 const result=await f.call(name,{...args,sandbox_permissions:'workspace-write',justification:'请批准本次合成文件变更。'})
 assert.equal(asks,1,JSON.stringify(result));assert.equal(result.isError,decision==='rejected',JSON.stringify(result))
 assert.equal(await readFile(path,'utf8'),decision==='allowed-once'?'updated':'original')
 assert.equal(f.ctx.sandboxPolicy.resolve({session:f.agent.session}).mode,'read-only')
 assert.equal((await f.call('write',{file_path:'another.txt',content:'not approved'})).isError,true)
 await assert.rejects(readFile(join(f.cwd,'another.txt')))
 assert.equal(asks,1)
})

test('文件升级仍拒绝目录外、链接越界、凭据路径、未授权工具与审批期间失效的角色版本',async t=>{
 const f=await readonlyRun(t);let asks=0
 await writeFile(join(f.outside,'original.txt'),'outside');await symlink(f.outside,join(f.cwd,'external'));await writeFile(join(f.cwd,'credentials.txt'),'private')
 f.ctx.on('approval/request',async()=>{asks++;f.revoke();return 'allowed-once'})
 const retry={content:'denied',sandbox_permissions:'danger-full-access',justification:'仅测试本次文件批准仍保留范围。'}
 for(const file_path of [join(f.outside,'new.txt'),'../work-extra/new.txt','external/new.txt','credentials.txt'])assert.equal((await f.call('write',{...retry,file_path})).isError,true)
 assert.equal((await f.call('bash',{command:'echo denied',sandbox_permissions:'danger-full-access',justification:'越权工具'})).isError,true)
 assert.equal(asks,0)
 const result=await f.call('write',{...retry,file_path:'inside.txt'})
 assert.equal(asks,1,JSON.stringify(result));assert.equal(result.isError,true,JSON.stringify(result))
 await assert.rejects(readFile(join(f.cwd,'inside.txt')));await assert.rejects(readFile(join(f.outside,'new.txt')))
 assert.equal(await readFile(join(f.outside,'original.txt'),'utf8'),'outside')
 assert.equal(await readFile(join(f.cwd,'credentials.txt'),'utf8'),'private')
})

test('审批期间将已核对的文件别名改指目录外，批准也不能写入外部原件',async t=>{
 const f=await readonlyRun(t),inside=join(f.cwd,'inside.txt'),outside=join(f.outside,'original.txt'),alias=join(f.cwd,'alias.txt')
 await writeFile(inside,'inside');await writeFile(outside,'outside');await symlink(inside,alias)
 assert.equal((await f.call('read',{file_path:'alias.txt'})).isError,false)
 let asks=0
 f.ctx.on('approval/request',async()=>{asks++;await rm(alias);await symlink(outside,alias);return 'allowed-once'})
 const result=await f.call('write',{file_path:'alias.txt',content:'denied',sandbox_permissions:'danger-full-access',justification:'仅批准本工作区文件。'})
 assert.equal(asks,1);assert.equal(result.isError,true,JSON.stringify(result))
 assert.equal(await readFile(outside,'utf8'),'outside');assert.equal(await readFile(inside,'utf8'),'inside')
})

test('本人普通会话不受任务文件授权管理，官方一次性升级审批保持可用',async t=>{
 const f=await fixture(t);await f.ctx.plugin(await official('dsh-tool-fs'),{})
 const agent=(await f.ctx.agents.create({sessionId:'ordinary-file-escalation',meta:{cwd:f.cwd},agentOptions:{provider:'native-auto-review-test',model:'scripted'}})).agent
 const {setSandboxMode}=await official('dsh-sandbox-policy');setSandboxMode(agent.session,'read-only')
 agent.session.append('turn/start',{turn:0})
 const policy=async()=>null
 registerTaskToolGuard(f.ctx,policy,[],undefined,undefined,undefined,undefined,undefined,undefined,createTaskRunWorkspaceFileAccess(f.ctx,f.cwd,policy,()=>false))
 let asks=0
 f.ctx.on('approval/request',async()=>{asks++;await assert.rejects(readFile(join(f.cwd,'ordinary.txt')));return 'allowed-once'})
 const result=await f.ctx.tools.execute({agent,name:'write',arguments:{file_path:'ordinary.txt',content:'owner approved',sandbox_permissions:'workspace-write',justification:'本人批准本次文件写入。'},callId:ToolCallId('ordinary-escalation'),signal:AbortSignal.timeout(5000)})
 assert.equal(asks,1);assert.equal(result.isError,false,JSON.stringify(result))
 assert.equal(await readFile(join(f.cwd,'ordinary.txt'),'utf8'),'owner approved')
})

test('上层竞速答复器在下游不可用后撤权并批准，文件变更仍须复核最终授权',async t=>{
 const f=await readonlyRun(t);let downstream
 f.ctx.on('approval/request',async(_request,next)=>{downstream=await next();f.revoke();return 'allowed-once'},{prepend:true})
 const result=await f.call('write',{file_path:'result.txt',content:'denied',sandbox_permissions:'workspace-write',justification:'合成审批竞速核对。'})
 assert.equal(downstream,'unavailable');assert.equal(result.isError,true,JSON.stringify(result))
 await assert.rejects(readFile(join(f.cwd,'result.txt')))
})

test('同一员工同 callId 的并发文件调用不能复用另一调用的目录核验',async t=>{
 const f=await readonlyRun(t),inside=join(f.cwd,'inside.txt'),outside=join(f.outside,'original.txt'),alias=join(f.cwd,'alias.txt')
 await writeFile(inside,'inside');await writeFile(outside,'outside');await symlink(inside,alias)
 let asks=0,releaseFirst,signalFirst
 const firstReady=new Promise(resolve=>{signalFirst=resolve}),firstDecision=new Promise(resolve=>{releaseFirst=resolve})
 f.ctx.on('approval/request',async()=>{if(++asks===1){signalFirst();return firstDecision}await rm(alias);await symlink(outside,alias);return 'allowed-once'})
 const call=(file_path,content)=>f.ctx.tools.execute({agent:f.agent,name:'write',arguments:{file_path,content,sandbox_permissions:'danger-full-access',justification:'合成并发范围核对。'},callId:ToolCallId('duplicate-call'),signal:AbortSignal.timeout(5000)})
 const first=call('first.txt','first');await firstReady
 let second
 try{second=await call('alias.txt','denied')}finally{releaseFirst('rejected');await first}
 assert.equal(asks,2);assert.equal(second.isError,true,JSON.stringify(second))
 assert.equal(await readFile(outside,'utf8'),'outside');await assert.rejects(readFile(join(f.cwd,'first.txt')))
})

async function presentationRun(t,transformFS=fs=>fs,transformWorkingDirectory=service=>service){
 const f=await fixture(t),source=transformFS(f.ctx.fs),workingDirectory=transformWorkingDirectory(f.ctx.workingDirectory)
 await f.ctx.extend({fs:source,workingDirectory}).plugin(await official('dsh-tool-present'),{maxFiles:8})
 let fsProvider=source,workingDirectoryProvider=workingDirectory
 f.ctx.provide('agentPresets',{serviceFor:(_agent,name)=>name==='fs'?fsProvider:name==='workingDirectory'?workingDirectoryProvider:undefined})
 const agent=(await f.ctx.agents.create({sessionId:'workspace-present',meta:{cwd:f.cwd},agentOptions:{provider:'native-auto-review-test',model:'scripted'}})).agent
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:'present-request'}}),{surfaceOp:'append'})
 const {setSandboxMode}=await official('dsh-sandbox-policy');setSandboxMode(agent.session,'read-only')
 let policy={nativeRequestId:'present-request',allowedTools:['read'],argumentRules:[{name:'read',allowed:[],workspaceFiles:'default-workspace'}]},seq=0,pending,asks=0
 const read=async()=>{if(policy instanceof Error)throw policy;return policy}
 registerTaskToolGuard(f.ctx,read,[],undefined,undefined,undefined,undefined,undefined,undefined,createTaskRunWorkspaceFileAccess(f.ctx,f.cwd,read,path=>path.endsWith('/credentials.txt')))
 const presented=[]
 f.ctx.on('session/event',(session,event)=>{if(session===agent.session&&event.type==='deliverables/presented')presented.push(event)})
 const call=(files=[{path:'note.md'}],actor=agent)=>f.ctx.tools.execute({agent:actor,name:'present',arguments:{files},callId:ToolCallId('present-'+ ++seq),signal:AbortSignal.timeout(5000)})
 const beforeApproval=mutate=>{
  f.ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.name!=='present')return next();pending=exec;return {kind:'ask',reason:'核对交付等待期间的授权和文件范围'}})
  f.ctx.on('approval/request',async()=>{asks++;await mutate(pending);return 'allowed-once'})
 }
 await writeFile(join(f.cwd,'note.md'),'# 合成成果\n只在当前工作目录交付。')
 return {...f,agent,call,presented,beforeApproval,setPolicy:value=>{policy=value},setFsProvider:value=>{fsProvider=value},setWorkingDirectoryProvider:value=>{workingDirectoryProvider=value},policy:()=>policy,asks:()=>asks}
}

test('J13：当前 Run 的工作目录 read 授权可调用真正官方 present，保留原生交付事件与文件字节',async t=>{
 const f=await presentationRun(t),definition=f.ctx.tools.get('present',f.agent),original=await readFile(join(f.cwd,'note.md'))
 const result=await f.call()
 assert.equal(result.isError,false,JSON.stringify(result))
 assert.notEqual(f.ctx.tools.get('present',f.agent),definition,'原官方实现在 Agent 专属受限 FS 中登记调用变体')
 assert.equal(f.ctx.tools.get('present'),definition,'本人普通会话的原官方定义保持不变')
 assert.equal(f.presented.length,1)
 assert.equal(f.presented[0].data.turn,1)
 assert.equal(f.presented[0].data.files[0].path,await realpath(join(f.cwd,'note.md')))
 assert.deepEqual(await readFile(join(f.cwd,'note.md')),original)
 assert.equal(f.ctx.sandboxPolicy.resolve({session:f.agent.session}).mode,'read-only')
})

test('J13：present 不能借仅写入授权、无工作目录规则或普通工具名授权扩大读取范围',async t=>{
 const f=await presentationRun(t)
 for(const policy of [
  {nativeRequestId:'present-request',allowedTools:['write'],argumentRules:[{name:'write',allowed:[],workspaceFiles:'default-workspace'}]},
  {nativeRequestId:'present-request',allowedTools:['read'],argumentRules:[]},
  {nativeRequestId:'present-request',allowedTools:['present'],argumentRules:[{name:'present',anyArguments:true,allowed:[]}]},
  {...f.policy(),textOnly:true},
 ]){
  f.setPolicy(policy);assert.equal((await f.call()).isError,true)
 }
 assert.equal(f.presented.length,0)
})

test('J13：官方 present 拒绝目录外、父目录、凭据、链接逃逸、目录和不存在的文件',async t=>{
 const f=await presentationRun(t)
 await writeFile(join(f.outside,'secret.txt'),'outside');await symlink(f.outside,join(f.cwd,'external'))
 await writeFile(join(f.cwd,'credentials.txt'),'private');await symlink(join(f.cwd,'credentials.txt'),join(f.cwd,'renamed.txt'))
 for(const path of ['../work-extra/secret.txt',join(f.outside,'secret.txt'),'external/secret.txt','credentials.txt','renamed.txt','missing.md','.','note.md\0']){
  const result=await f.call([{path}]);assert.equal(result.isError,true,path+': '+JSON.stringify(result))
 }
 assert.equal(f.presented.length,0)
 assert.equal(await readFile(join(f.outside,'secret.txt'),'utf8'),'outside')
})

for(const change of ['revoke','request','stop','unavailable','definition','cwd'])test('J13：present 等待审批后 '+change+'，执行前拒绝且不写原生交付事件',async t=>{
 const f=await presentationRun(t);let changed=false
 f.beforeApproval(async()=>{
  if(change==='revoke')f.setPolicy({...f.policy(),allowedTools:[],argumentRules:[]})
  if(change==='request')f.setPolicy({...f.policy(),nativeRequestId:'another-request'})
  if(change==='stop')f.setPolicy({...f.policy(),stopRequested:true})
  if(change==='unavailable')f.setPolicy(Error('当前员工版本已变化'))
  if(change==='definition'){
   const previous=f.ctx.tools.get('present',f.agent),runtime=[...f.ctx.registry.values()].find(runtime=>runtime.name==='teloa-run-present')
   assert.ok(runtime);await Promise.all([...runtime.fibers].map(fiber=>fiber.dispose()));f.ctx.registry.delete(runtime.callback)
   await f.agent.ctx.plugin({name:'replace-present-for-test',apply:scope=>scope.tools.register({...previous,execute:async()=>{throw Error('替换工具不能运行')}})})
   assert.notEqual(f.ctx.tools.get('present',f.agent),previous)
  }
  if(change==='cwd')await f.ctx.workingDirectory.set(f.agent,f.outside)
  changed=true
 })
 const result=await f.call();assert.equal(f.asks(),1);assert.equal(changed,true);assert.equal(result.isError,true,JSON.stringify(result));assert.equal(f.presented.length,0)
})

test('J13：present 等待期间将目录链接改指外部，批准也不能交付',async t=>{
 const f=await presentationRun(t);let changed=false
 await mkdir(join(f.cwd,'inside'));await writeFile(join(f.cwd,'inside/note.md'),'inside');await writeFile(join(f.outside,'note.md'),'outside')
 await symlink(join(f.cwd,'inside'),join(f.cwd,'alias'))
 f.beforeApproval(async()=>{await rm(join(f.cwd,'alias'));await symlink(f.outside,join(f.cwd,'alias'));changed=true})
 const result=await f.call([{path:'alias/note.md'}])
 assert.equal(f.asks(),1);assert.equal(changed,true);assert.equal(result.isError,true,JSON.stringify(result));assert.equal(f.presented.length,0)
})

test('J13：官方 present 的审批参数不可改写，原操作批准后仍按原文件交付',async t=>{
 const f=await presentationRun(t);let checked=false
 f.beforeApproval(exec=>{
  assert.ok(Object.isFrozen(exec.arguments.files[0]))
  assert.throws(()=>{exec.arguments.files[0].path='../outside.txt'},TypeError)
  checked=true
 })
 const result=await f.call()
 assert.equal(f.asks(),1);assert.equal(checked,true);assert.equal(result.isError,false,JSON.stringify(result))
 assert.equal(f.presented.length,1);assert.equal(f.presented[0].data.files[0].path,await realpath(join(f.cwd,'note.md')))
})

test('J13：本人普通会话保留官方 present，不需要任务 read 授权',async t=>{
 const f=await presentationRun(t);f.setPolicy(null)
 const result=await f.call()
 assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.presented.length,1)
})

test('J13：present 用当前 FS 复核真实目标，不把等价 Context 服务代理误判为换源',async t=>{
 const f=await presentationRun(t)
 f.beforeApproval(()=>f.setFsProvider(new Proxy(f.ctx.fs,{})))
 const result=await f.call()
 assert.equal(f.asks(),1);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.presented.length,1)
})

test('J13：present 混合文件批次整体拒绝，不能先交付合法项再带出越界项',async t=>{
 const f=await presentationRun(t);await writeFile(join(f.outside,'secret.txt'),'outside')
 const result=await f.call([{path:'note.md'},{path:join(f.outside,'secret.txt')}])
 assert.equal(result.isError,true,JSON.stringify(result));assert.equal(f.presented.length,0)
})

test('J13：present 不能进入 blanket 自授权集',async t=>{
 const f=await presentationRun(t)
 assert.throws(()=>registerTaskToolGuard(f.ctx,async()=>f.policy(),['present']),/工作目录读取授权/)
})

const barrier=()=>{
 let enter,release
 const entered=new Promise(resolve=>{enter=resolve}),released=new Promise(resolve=>{release=resolve})
 return {wait:async()=>{let timer;try{await Promise.race([entered,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('未进入指定原生等待点')),5000)})])}finally{clearTimeout(timer)}},release,pause:async()=>{enter();await released}}
}
const changePresentationPolicy=(f,change)=>f.setPolicy(change==='revoke'?{...f.policy(),allowedTools:[],argumentRules:[]}:change==='stop'?{...f.policy(),stopRequested:true}:{...f.policy(),nativeRequestId:'replacement-request'})

for(const change of ['revoke','stop','request'])test('J13 revision：最后 ensure 等待期间 '+change+'，不得交付',async t=>{
 const f=await presentationRun(t),gate=barrier(),service=f.ctx.workingDirectory;let ensures=0
 f.setWorkingDirectoryProvider(new Proxy(service,{get(target,key){if(key==='ensure')return async(...args)=>{const cwd=await target.ensure(...args);if(++ensures===2)await gate.pause();return cwd};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}}))
 const pending=f.call()
 try{await gate.wait();changePresentationPolicy(f,change)}finally{gate.release()}
 const result=await pending
 assert.equal(result.isError,true,JSON.stringify(result));assert.equal(f.presented.length,0)
})

for(const change of ['revoke','stop'])test('J13 revision：真正官方 present 的内部 stat 等待期间 '+change+'，不得交付',async t=>{
 const gate=barrier();let bodyIO=0,ensures=0,inBody=false
 const f=await presentationRun(t,fs=>new Proxy(fs,{get(target,key){
  if(key==='stat')return async(...args)=>{
   const info=await target.stat(...args)
   if(inBody&&args[0].displayPath.endsWith('/note.md')){bodyIO++;await gate.pause()}
   return info
  }
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
 }}),service=>new Proxy(service,{get(target,key){
  if(key==='ensure')return async(...args)=>{const cwd=await target.ensure(...args);if(++ensures===3)inBody=true;return cwd}
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
 }}))
 const pending=f.call()
 try{await gate.wait();changePresentationPolicy(f,change)}finally{gate.release()}
 const result=await pending
 assert.ok(bodyIO>0,'必须命中官方工具体的真实 FS I/O');assert.equal(result.isError,true,JSON.stringify(result));assert.equal(f.presented.length,0)
})

for(const change of ['revoke','stop'])test('J13 revision：官方工具返回后的 post-execute 等待期间 '+change+'，不得追加交付事件',async t=>{
 const f=await presentationRun(t),gate=barrier()
 f.ctx.on('tools/post-execute',async(exec,_result,next)=>{if(exec.name==='present')await gate.pause();return next()})
 const pending=f.call()
 try{await gate.wait();changePresentationPolicy(f,change)}finally{gate.release()}
 const result=await pending
 assert.equal(result.isError,true,JSON.stringify(result));assert.equal(f.presented.length,0)
})

test('J13 revision：官方工具体开始后目录别名改指外部，真正受限 FS 不对外部文件执行 stat',async t=>{
 const gate=barrier();let ensures=0,outsideStats=0
 const f=await presentationRun(t,fs=>new Proxy(fs,{get(target,key){
  if(key==='stat')return async(...args)=>{if(target.processPath(args[0]).includes('/work-extra/'))outsideStats++;return target.stat(...args)}
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
 }}),service=>new Proxy(service,{get(target,key){
  if(key==='ensure')return async(...args)=>{const cwd=await target.ensure(...args);if(++ensures===3)await gate.pause();return cwd}
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
 }}))
 await mkdir(join(f.cwd,'inside'));await writeFile(join(f.cwd,'inside/note.md'),'inside');await writeFile(join(f.outside,'note.md'),'outside')
 await symlink(join(f.cwd,'inside'),join(f.cwd,'alias'))
 const pending=f.call([{path:'alias/note.md'}])
 try{await gate.wait();await rm(join(f.cwd,'alias'));await symlink(f.outside,join(f.cwd,'alias'))}finally{gate.release()}
 const result=await pending
 assert.equal(outsideStats,0,'不只在工具返回后阻止事件，官方 body 的实际 FS 也必须受限')
 assert.equal(result.isError,true,JSON.stringify(result));assert.equal(f.presented.length,0)
})
