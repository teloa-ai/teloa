import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRuntime,official,createUserMessage,ToolCallId} from '../../../tests/native-auto-review-fixture.mjs'
import {createScopedWorkspaceFileSystem,createTaskRunWorkspaceFileAccess,workspaceFileToolRules} from '../src/workspace-file-access.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

async function fixture(t){
 const {ctx}=await createRuntime(t),home=await mkdtemp(join(tmpdir(),'teloa-workspace-files-')),cwd=join(home,'work'),outside=join(home,'work-extra')
 t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(cwd);await mkdir(outside)
 await ctx.plugin((await official('dsh-fs-sandbox')).default,{cwd})
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
