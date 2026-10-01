import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import {officialCatalogBuiltin} from '@teloa/backend'
import {assertSkillCreatorLoaded,builtinSkillCreatorName,prepareBuiltinSkillCreator,registerBuiltinSkillCreator,type BuiltinSkillCreatorPorts} from '../src/builtin-skill-creator.ts'

const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem}
const skillRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh-skill'))
const {createScope}=await import(pathToFileURL(skillRequire.resolve('@deepseek-ai/dsh-scope')).href) as {createScope:(ctx:Context,key:object)=>{ctx:Context;dispose:()=>Promise<void>}}

async function setup(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-builtin-creator-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:root})
 await ctx.plugin(ToolSkill)
 const builtin=officialCatalogBuiltin(builtinSkillCreatorName),creator=await prepareBuiltinSkillCreator(ctx,{runtimeRoot:root,treeHash:builtin.treeHash,files:builtin.files})
 const agent=(id:string)=>{const target={} as Agent,scope=createScope(ctx,target);Object.assign(target,{ctx:scope.ctx,session:{id,header:{cwd:root},surface:{nodes:[]},events:[]}});return target}
 return {ctx,root,builtin,creator,agent}
}
const ports=(policy:(id:string)=>unknown=()=>null,status:'ready'|'pending'='ready'):BuiltinSkillCreatorPorts=>({owner:'owner',conversation:async id=>({ownerId:'owner',sessionId:id,status}),readTaskPolicy:async id=>policy(id) as never})
const step=(ctx:Context,agent:Agent,text:string)=>{const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})];return ctx.waterfall('agent/pre-step',{agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages}))}
const injected=(decision:Awaited<ReturnType<typeof step>>)=>decision.kind==='enter'?decision.messages.filter(message=>message.source.kind==='skill-invocation'):[]
const catalogText=(decision:Awaited<ReturnType<typeof step>>)=>decision.kind==='enter'?JSON.stringify(decision.messages.filter(message=>message.source.kind==='skill-catalog')):''

test('物化后由官方解析器读出，二次准备复用目录，磁盘被改后整体重写',async t=>{
 const {ctx,root,builtin,creator}=await setup(t)
 assert.equal(creator.definition.name,'teloa-skill-creator');assert.equal(creator.definition.provider,'teloa-builtin')
 assert.equal(creator.definition.resourceBase?.kind,'directory')
 assert.match(creator.rendered,/Teloa skill creation flow/)
 const skillPath=creator.definition.path!
 assert.ok(skillPath.startsWith(join(root,'builtin-skills',builtin.treeHash.slice(0,16))))
 const again=await prepareBuiltinSkillCreator(ctx,{runtimeRoot:root,treeHash:builtin.treeHash,files:builtin.files})
 assert.equal(again.rendered,creator.rendered)
 await writeFile(skillPath,'---\nname: teloa-skill-creator\ndescription: tampered\n---\nx\n')
 await writeFile(join(skillPath,'..','extra.md'),'x')
 const repaired=await prepareBuiltinSkillCreator(ctx,{runtimeRoot:root,treeHash:builtin.treeHash,files:builtin.files})
 assert.equal(repaired.rendered,creator.rendered)
 assert.equal(await readFile(skillPath,'utf8'),new TextDecoder().decode(builtin.files.find(file=>file.path==='SKILL.md')!.bytes))
 await assert.rejects(readFile(join(skillPath,'..','extra.md')))
})

test('本人普通会话：目录可见，/teloa-skill-creator 注入正文与固定渲染一致；global 视图看不到',async t=>{
 const {ctx,creator,agent}=await setup(t)
 registerBuiltinSkillCreator(ctx,creator,ports())
 const ordinary=agent('ordinary-session'),decision=await step(ctx,ordinary,'/teloa-skill-creator 帮我做一个周报技能')
 assert.match(catalogText(decision),/teloa-skill-creator/)
 const injections=injected(decision)
 assert.equal(injections.length,1)
 const block=injections[0]!.content[0]
 assert.ok(block?.type==='text'&&block.text===creator.rendered)
 assert.ok(!(await ctx.skills.list()).some(skill=>skill.name===builtinSkillCreatorName))
})

test('任务执行会话、子 Agent、未就绪或非本人会话都不登记创建器',async t=>{
 const {ctx,creator,agent}=await setup(t)
 const cases:[string,BuiltinSkillCreatorPorts,(value:Agent)=>void][]=[
  ['任务执行',ports(()=>({allowedTools:[]})),()=>{}],
  ['未就绪',ports(()=>null,'pending'),()=>{}],
  ['非本人',{...ports(),conversation:async id=>({ownerId:'someone-else',sessionId:id,status:'ready'})},()=>{}],
  ['读取失败',{...ports(),readTaskPolicy:async()=>{throw Error('down')}},()=>{}],
  ['子 Agent',ports(),value=>{(value.session.header as {origin?:string}).origin='subagent'}],
 ]
 for(const [label,value,mutate] of cases){
  const scoped=agent('session-'+label);mutate(scoped)
  const off=registerBuiltinSkillCreator(ctx,creator,value)
  const decision=await step(ctx,scoped,'/teloa-skill-creator 帮我做技能')
  assert.equal(injected(decision).length,0,label)
  assert.doesNotMatch(catalogText(decision),/teloa-skill-creator/,label)
  off()
 }
})

type Event={seq:number;type:string;data:Record<string,unknown>}
const session=(events:Event[],options:{visible?:number[];inherited?:number}={})=>({inheritedEventCount:options.inherited??0,surface:{nodes:options.visible??events.map(event=>event.seq)},snapshotEvents:()=>events as never})
const userText=(seq:number,text:string,source:Record<string,unknown>={kind:'user'})=>({seq,type:'user/message',data:{id:'m'+seq,role:'user',source,content:[{type:'text',text}]}})
const call=(seq:number,callId:string,name='skill',args={name:builtinSkillCreatorName})=>({seq,type:'tool/call',data:{turn:1,step:1,callId,name,arguments:JSON.stringify(args)}})
const result=(seq:number,callId:string,text:string,isError=false)=>({seq,type:'tool/result',data:{turn:1,step:1,message:{id:'r'+seq,role:'tool',source:{kind:'tool'},toolCallId:callId,isError,content:[{type:'text',text}]}}})
const invocation={kind:'skill-invocation',name:builtinSkillCreatorName,form:'instructions'}

test('加载证据：注入或工具结果可用；改字、不可见、继承、失败调用、用户自贴都不算',async t=>{
 const {creator}=await setup(t)
 const ok=(value:ReturnType<typeof session>)=>assert.doesNotThrow(()=>assertSkillCreatorLoaded(value,creator))
 const no=(value:ReturnType<typeof session>)=>assert.throws(()=>assertSkillCreatorLoaded(value,creator),{code:'teloa/forbidden'})
 ok(session([userText(0,'/teloa-skill-creator 做技能'),userText(1,creator.rendered,invocation)]))
 ok(session([call(0,'c1'),result(1,'c1',creator.rendered)]))
 no(session([userText(0,creator.rendered.slice(0,-1)+'X',invocation)]))
 no(session([userText(0,creator.rendered,invocation)],{visible:[]}))
 no(session([userText(0,creator.rendered,invocation),userText(1,'继续')],{inherited:1}))
 no(session([call(0,'c1')]))
 no(session([call(0,'c1'),result(1,'c1',creator.rendered,true)]))
 no(session([call(0,'c1','skill',{name:'other'}),result(1,'c1',creator.rendered)]))
 no(session([call(0,'c1','read_file'),result(1,'c1',creator.rendered)]))
 no(session([userText(0,creator.rendered)]))
 no(session([]))
})

test('任务执行会话判定一次后不再逐步读库；未就绪会话下一步重判并补登记',async t=>{
 const {ctx,creator,agent}=await setup(t)
 let policyReads=0,status:'pending'|'ready'='pending'
 const taskAgent=agent('task-session'),pendingAgent=agent('pending-session')
 registerBuiltinSkillCreator(ctx,creator,{owner:'owner',conversation:async id=>({ownerId:'owner',sessionId:id,status:id==='pending-session'?status:'ready'}),readTaskPolicy:async id=>{if(id==='task-session'){policyReads++;return {allowedTools:[]} as never}return null}})
 await step(ctx,taskAgent,'第一步');await step(ctx,taskAgent,'第二步')
 assert.equal(policyReads,1)
 assert.equal(injected(await step(ctx,pendingAgent,'/teloa-skill-creator 做技能')).length,0)
 status='ready'
 assert.equal(injected(await step(ctx,pendingAgent,'/teloa-skill-creator 做技能')).length,1)
})
