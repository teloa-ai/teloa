import test from 'node:test'
import assert from 'node:assert/strict'
import type {SkillDefinition} from '@deepseek-ai/dsh-skill'
import {createHash} from 'node:crypto'
import {resolveRoleSkills} from '../src/role-skills.ts'
const skill:SkillDefinition={name:'evidence-review',provider:'filesystem',source:'project-dsh',description:'核对证据',content:'保留来源，区分事实与推测',invocation:{modelInvocable:true,userInvocable:true},resourceBase:{kind:'directory',path:'/workspace/skills/evidence-review'}}
test('岗位技能保留原生提供方和正文摘要，不把名称当作权限',async()=>{
 const signal=new AbortController().signal
 const [first]=await resolveRoleSkills([skill.name],async name=>{assert.equal(name,skill.name);return skill},signal)
 assert.equal(first!.content,skill.content);assert.equal(first!.provider,'filesystem');assert.equal(first!.sha256.length,64)
 const [changed]=await resolveRoleSkills([skill.name],async()=>({...skill,content:'更新的方法'}),signal)
 assert.notEqual(first!.sha256,changed!.sha256)
 assert.deepEqual(await resolveRoleSkills([],async()=>{throw Error('不应读取')},signal),[])
 assert.ok(!('allowedTools' in first!))
})
test('缺失、重名、不可调用、超限技能均明确拒绝，取消不泄漏提供方错误',async()=>{
 const signal=new AbortController().signal
 for(const value of [undefined,{...skill,name:'other'},{...skill,invocation:{modelInvocable:false,userInvocable:true}},{...skill,content:'x'.repeat(256*1024+1)}]){
  await assert.rejects(resolveRoleSkills([skill.name],async()=>value,signal))
 }
 await assert.rejects(resolveRoleSkills([skill.name,skill.name],async()=>skill,signal))
 await assert.rejects(resolveRoleSkills(['技能中文名称'],async()=>skill,signal))
 await assert.rejects(resolveRoleSkills([skill.name],async()=>{throw Error('secret')},signal),e=>e instanceof Error&&!e.message.includes('secret'))
 const controller=new AbortController()
 await assert.rejects(resolveRoleSkills([skill.name],async()=>{controller.abort();return skill},controller.signal))
})

test('DSH技能读取使用目标会话预设及工作目录，跨本人会话拒绝',async()=>{
 const {resolveDshRoleSkills}=await import('../src/role-skills-dsh.ts')
 const agent={session:{header:{cwd:'/target'}}},signal=new AbortController().signal
 let reads=0
 const ctx={sessionController:{resolveAgent:async()=>({agent})},agentPresets:{serviceFor:(value:unknown,name:string)=>{assert.equal(value,agent);assert.equal(name,'skills');return {get:async(name:string,options:unknown)=>{reads++;assert.equal(name,skill.name);assert.deepEqual(options,{cwd:'/target',scope:agent,signal});return skill}}}},skills:{get:()=>{throw Error('不能读全局目录')}}} as unknown as import('@deepseek-ai/cordis').Context
 const inspect=async()=>({ownerId:'owner',sessionId:'session',status:'ready'})
 await assert.rejects(resolveDshRoleSkills(ctx,'other','session',[skill.name],inspect,signal),{code:'teloa/forbidden'})
 assert.equal(reads,0)
 const result=await resolveDshRoleSkills(ctx,'owner','session',[skill.name],inspect,signal)
 assert.equal(result[0]!.name,skill.name);assert.equal(reads,1)
})

test('岗位按受管原生名称先查可用状态，停用时不读取同名次选来源',async()=>{
 const {resolveDshRoleSkills}=await import('../src/role-skills-dsh.ts')
 const agent={session:{header:{cwd:'/target'}}},signal=new AbortController().signal,database={} as import('@teloa/backend').TaskRunSkillDatabase
 let reads=0,availabilityReads=0
 const ctx={sessionController:{resolveAgent:async()=>({agent})},agentPresets:{serviceFor:()=>({get:async()=>{reads++;return skill}})},skills:{}} as unknown as import('@deepseek-ai/cordis').Context
 const inspect=async()=>({ownerId:'owner',sessionId:'session',status:'ready'})
 await assert.rejects(resolveDshRoleSkills(ctx,'owner','session',[skill.name],inspect,signal,undefined,database,async(name,currentDatabase)=>{
  availabilityReads++;assert.equal(name,skill.name);assert.equal(currentDatabase,database);return 'disabled'
 }),{code:'teloa/skill-unavailable'})
 assert.equal(availabilityReads,1);assert.equal(reads,0)
 const result=await resolveDshRoleSkills(ctx,'owner','session',[skill.name],inspect,signal,undefined,database,async()=>undefined)
 assert.equal(result[0]?.name,skill.name);assert.equal(reads,1)
})

test('Teloa 内置技能（技能创建器）不能被写进岗位技能',async()=>{
 const signal=new AbortController().signal
 await assert.rejects(resolveRoleSkills(['teloa-skill-creator'],async()=>({...skill,name:'teloa-skill-creator',provider:'teloa-builtin'}),signal),(error:any)=>error?.code==='teloa/forbidden'&&/内置技能/.test(error.message))
})

test('岗位技能正文超限时报出合计、上限与最大的一条，读完全部技能再算合计',async()=>{
 const signal=new AbortController().signal,kib=(name:string,size:number):SkillDefinition=>({...skill,name,content:'x'.repeat(size*1024)})
 const skills=new Map([['first',kib('first',200)],['second',kib('second',100)],['third',kib('third',50)]])
 await assert.rejects(resolveRoleSkills([...skills.keys()],async name=>skills.get(name),signal),(error:any)=>error?.code==='teloa/invalid-input'&&error.message==='员工技能正文合计 350 KiB，超过 256 KiB 上限（最大：first 200 KiB）。请减少本员工绑定的技能。')
 const odd=new Map([['small',{...skill,name:'small',content:'y'.repeat(100*1024)}],['large',{...skill,name:'large',content:'z'.repeat(156*1024+1)}]])
 await assert.rejects(resolveRoleSkills([...odd.keys()],async name=>odd.get(name),signal),(error:any)=>error?.message==='员工技能正文合计 257 KiB，超过 256 KiB 上限（最大：large 157 KiB）。请减少本员工绑定的技能。')
})

test('技能正文整段进任务提示词（B8）：岗位解析与运行快照的合计上限同为 256 KiB',async()=>{
 const {readRunSkills}=await import('@teloa/backend')
 const signal=new AbortController().signal,build=(content:string)=>({...skill,content})
 for(const [bytes,accepted] of [[256*1024,true],[256*1024+1,false]] as const){
  const content='x'.repeat(bytes),role=resolveRoleSkills([skill.name],async()=>build(content),signal)
  if(accepted){
   const resolved=await role
   assert.deepEqual(readRunSkills(resolved),resolved)
  }else{
   await assert.rejects(role,{code:'teloa/invalid-input'})
   const sha256=createHash('sha256').update(content).digest('hex')
   assert.throws(()=>readRunSkills([{name:skill.name,provider:skill.provider,source:skill.source,description:skill.description,content,sha256}]),{code:'teloa/storage-corrupt'})
  }
 }
})
