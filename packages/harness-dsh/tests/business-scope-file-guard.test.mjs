import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,symlink,link,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRuntime,official,defineTool,ToolCallId,createUserMessage} from '../../../tests/native-auto-review-fixture.mjs'
import {registerBusinessScopeFileGuard} from '../src/business-scope-file-guard.ts'

async function fixture(t){
 const {ctx}=await createRuntime(t),cwd=await mkdtemp(join(tmpdir(),'teloa-business-file-'))
 t.after(()=>rm(cwd,{recursive:true,force:true}));await mkdir(join(cwd,'other'))
 for(const [name,text]of [['SOC.md','SOC-PRIVATE'],['AppSec.md','APP-PRIVATE'],['general.md','GENERAL-PRIVATE'],['ordinary.txt','ordinary'],['SOC.md-extra','ordinary-prefix']])await writeFile(join(cwd,name),text)
 ctx.provide('agentPresets',{serviceFor:()=>undefined});await ctx.plugin(await official('dsh-tool-fs'),{})
 await ctx.plugin((await official('dsh-subprocess-local')).default)
 await ctx.plugin(await official('dsh-tool-fs-search'),{sampleOverCapGlobResults:false})
 const read=ctx.tools.get('read');assert(read);ctx.tools.register({...read,name:'read_file'})
 let scope='AppSec',version=1,managed=false,io=0,spawns=0,sequence=0
 const fs=ctx.fs
 for(const name of ['readText','streamText','readBytes','readByteRange']){const original=fs[name].bind(fs);fs[name]=(...args)=>{io++;return original(...args)}}
 const subprocess=ctx.subprocess,spawn=subprocess.spawn.bind(subprocess);subprocess.spawn=(...args)=>{spawns++;return spawn(...args)}
 const agent=(await ctx.agents.create({sessionId:'business-files',meta:{cwd},agentOptions:{provider:'native-auto-review-test',model:'scripted'}})).agent
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:'business-file-request'}}),{surfaceOp:'append'})
 const boundaries=[{path:join(cwd,'SOC.md'),scopeIds:['SOC']},{path:join(cwd,'AppSec.md'),scopeIds:['AppSec']},{path:join(cwd,'general.md'),scopeIds:['general']}]
 const authorization={owner:'owner',conversation:async id=>({ownerId:'owner',sessionId:id,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async id=>({sessionId:id,scopeId:scope,roleId:null,version,locked:false}),scopes:async()=>[{scope:'SOC',title:'SOC'},{scope:'AppSec',title:'AppSec'}]}
 const off=registerBusinessScopeFileGuard(ctx,{authorization,applies:async()=>!managed,boundaries:async()=>boundaries});t.after(off)
 const call=(name,args)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('business-file-'+ ++sequence),signal:AbortSignal.timeout(10000)})
 return{ctx,cwd,agent,boundaries,call,get io(){return io},get spawns(){return spawns},scope(value){scope=value;version++},managed(value){managed=value},changeVersion(){version++}}
}
test('真实官方ToolRuntime read及read_file拒绝跨业务原件，当前业务与未登记普通文件照常读取',async t=>{
 const f=await fixture(t)
 for(const name of ['read','read_file']){const before=f.io,result=await f.call(name,{file_path:'SOC.md'});assert.equal(result.isError,true);assert.equal(f.io,before,'越界正文没有进入FS读取');assert(!JSON.stringify(result).includes('SOC-PRIVATE'))}
 for(const [name,args]of [['write',{file_path:'SOC.md',content:'denied'}],['edit',{file_path:'SOC.md',old_string:'SOC-PRIVATE',new_string:'denied'}]])assert.equal((await f.call(name,args)).isError,true)
 for(const path of ['AppSec.md','ordinary.txt','SOC.md-extra'])assert.equal((await f.call('read',{file_path:path})).isError,false,path)
 assert.equal((await f.call('write',{file_path:'ordinary-new.txt',content:'first'})).isError,false)
 assert.equal((await f.call('edit',{file_path:'ordinary-new.txt',old_string:'first',new_string:'updated'})).isError,false)
 assert(f.io>0)
 f.scope('SOC');assert.equal((await f.call('read',{file_path:'SOC.md'})).isError,false);assert.equal((await f.call('read',{file_path:'AppSec.md'})).isError,true)
})
test('绝对/规范化/软链接与硬链接别名不能绕过真实登记；general不是全业务',async t=>{
 const f=await fixture(t);await symlink(join(f.cwd,'SOC.md'),join(f.cwd,'alias.md'));await link(join(f.cwd,'SOC.md'),join(f.cwd,'hard.md'))
 for(const path of [join(f.cwd,'SOC.md'),'./SOC.md','other/../SOC.md','alias.md','hard.md'])assert.equal((await f.call('read',{file_path:path})).isError,true,path)
 assert.equal((await f.call('read',{file_path:'general.md'})).isError,true,'通用业务原件不自动共享给AppSec')
 f.scope('general');assert.equal((await f.call('read',{file_path:'general.md'})).isError,false);assert.equal((await f.call('read',{file_path:'SOC.md'})).isError,false,'未选具体业务维持既有本人workspace授权，非resource共享scope扩大');assert.equal((await f.call('read',{file_path:'ordinary.txt'})).isError,false)
})
test('官方glob/grep在真实subprocess前阻断混合业务扫描，明确普通子目录仍可搜索',async t=>{
 const f=await fixture(t);await writeFile(join(f.cwd,'other/code.txt'),'safe')
 for(const [name,args]of [['glob',{pattern:'**/*'}],['grep',{pattern:'PRIVATE'}]]){const before=f.spawns;assert.equal((await f.call(name,args)).isError,true);assert.equal(f.spawns,before,'未启动读取其他业务文件的ripgrep')}
 const result=await f.call('glob',{pattern:'*',path:'other'});assert.equal(result.isError,false,JSON.stringify(result));assert(f.spawns>0)
 for(const path of ['ordinary.txt','AppSec.md'])assert.equal((await f.call('grep',{pattern:'.',path})).isError,false,'grep合法单文件不能被opendir误拦')
 assert.equal((await f.call('grep',{pattern:'.',path:'SOC.md'})).isError,true)
 await symlink(join(f.cwd,'SOC.md'),join(f.cwd,'other/alias.md'));const beforeLink=f.spawns;assert.equal((await f.call('grep',{pattern:'.',path:'other'})).isError,true);assert.equal(f.spawns,beforeLink)
 await link(join(f.cwd,'SOC.md'),join(f.cwd,'other/hard.md'))
 for(const name of ['glob','grep']){const before=f.spawns;assert.equal((await f.call(name,{pattern:'*',path:'other'})).isError,true);assert.equal(f.spawns,before,'其他目录内硬链接同样不能由rg读取')}
})
test('目录alias和不透明代码执行同样走真实ToolRuntime拒绝，Task明确授权不被普通业务guard取代',async t=>{
 const f=await fixture(t);let listings=0,commands=0
 f.ctx.tools.register(defineTool({name:'list_directory',description:'real directory listing',parameters:{path:{type:'string',required:true}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async({path},exec)=>{listings++;const target=await f.ctx.fs.resolve(path,{cwd:f.cwd,signal:exec.signal});return JSON.stringify(await f.ctx.fs.listDir(target,exec.signal))}}))
 f.ctx.tools.register(defineTool({name:'execute_code',description:'would execute code',parameters:{code:{type:'string'}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{commands++;return 'executed'}}))
 assert.equal((await f.call('list_directory',{path:'.'})).isError,true);assert.equal(listings,0)
 assert.equal((await f.call('list_directory',{path:'other'})).isError,false);assert.equal(listings,1)
 assert.equal((await f.call('execute_code',{code:'opaque code'})).isError,true);assert.equal(commands,0,'没有通过分析命令字符串放行')
 f.scope('general');assert.equal((await f.call('execute_code',{code:'ordinary work'})).isError,false);assert.equal(commands,1,'原通用工作不会因为工作区有SOC登记而被封原生执行')
 f.scope('AppSec')
 f.managed(true);assert.equal((await f.call('read',{file_path:'SOC.md'})).isError,false,'正常Task仍交原TaskToolGuard，不借普通scope假授权')
})
test('原生审批等待后业务版本或登记范围改变，实际读取前fresh recheck拒绝',async t=>{
 for(const change of ['version','registration']){
  const f=await fixture(t);let asks=0
  f.ctx.on('tools/pre-execute',async(_exec,_next)=>({kind:'ask',reason:'验证审批期间当前业务变化'}))
  f.ctx.on('approval/request',async()=>{asks++;if(change==='version')f.changeVersion();else f.boundaries.find(row=>row.path===join(f.cwd,'AppSec.md')).scopeIds=['SOC'];return 'allowed-once'})
  const before=f.io,result=await f.call('read',{file_path:'AppSec.md'});assert.equal(result.isError,true);assert.equal(asks,1,JSON.stringify(result));assert.equal(f.io,before)
 }
})
