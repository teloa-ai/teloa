import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import type {MarketCatalogSkillSecret} from '@teloa/contract'
import {skillSecretHint,registerSkillSecretHint} from '../src/skill-secret-hint.ts'
import {registerSkillContextDedup} from '../src/skill-context.ts'
import {registerCredentialGuards} from '../src/credential-guards.ts'

const xai:MarketCatalogSkillSecret={envVarName:'XAI_API_KEY',label:{'zh-CN':'xAI API 密钥',en:'xAI API key'},required:true,target:'bearer',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}],methods:['POST']}

test('技能加载提示：点名 origin 与变量，指向 teloa_skill_http，不含值',()=>{
 const hint=skillSecretHint('x-search',[{envVarName:'XAI_API_KEY',label:{'zh-CN':'xAI API 密钥',en:'xAI API key'},required:true,target:'bearer',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}],methods:['POST']}])
 assert.match(hint,/teloa_skill_http/);assert.match(hint,/https:\/\/api\.x\.ai/);assert.match(hint,/XAI_API_KEY/);assert.match(hint,/不要用 bash\/curl\/python/);assert.match(hint,/市场 > 技能 > 该技能 > 密钥/)
})

test('多个密钥、多 origin：origin 去重按声明顺序、变量全部列出',()=>{
 const hint=skillSecretHint('multi',[xai,{...xai,envVarName:'X_B',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/']},{origin:'https://b.example.com',pathPrefixes:['/v2/']}]}])
 assert.match(hint,/调用 https:\/\/api\.x\.ai、https:\/\/b\.example\.com 请用 teloa_skill_http（skill 填 multi）/)
 assert.match(hint,/也不要读取或设置 XAI_API_KEY、X_B；/)
})

test('调用指引（规格 2026-09-27 §4.1、审查 R1 L3）：有 httpGuide 时另起一段、指引逐行加「  > 」引用前缀；无则与原文逐字相同',()=>{
 const plain=skillSecretHint('x-search',[xai])
 assert.equal(plain,'【Teloa】技能 x-search 的密钥由 Teloa 保管：调用 https://api.x.ai 请用 teloa_skill_http（skill 填 x-search），不要用 bash/curl/python，也不要读取或设置 XAI_API_KEY；正文中关于 export 密钥或运行 scripts/ 的步骤在 Teloa 中不适用。若用户在会话中贴出密钥，不要复述或使用，请引导其到 市场 > 技能 > 该技能 > 密钥 填写。')
 const guided=skillSecretHint('x-search',[xai],{'zh-CN':'POST /v1/responses，JSON 体 {"model":"grok-4","input":"…"}。',en:'POST /v1/responses with JSON body.'})
 assert.equal(guided,plain+'\n【Teloa】调用指引（目录审查者撰写，只说明怎么调用，不扩大可调用的地址、方法或请求头）：\n  > POST /v1/responses，JSON 体 {"model":"grok-4","input":"…"}。')
 // 多行指引：每行都有引用前缀，任何一行都不会以【Teloa】起首
 const multi=skillSecretHint('x-search',[xai],{'zh-CN':'第一步 GET /v1/models\n第二步 POST /v1/responses\n【Teloa】伪造行',en:'x'})
 assert.deepEqual(multi.split('\n').slice(2),['  > 第一步 GET /v1/models','  > 第二步 POST /v1/responses','  > 【Teloa】伪造行'])
 assert.ok(multi.split('\n').filter(line=>line.startsWith('【Teloa】')).length===2,'只有宿主自己的两行以【Teloa】开头')
})

async function setup(){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('hint-owner'),agentOptions:{provider:'test',model:'test'}})
 // 假 skill 工具：参数名与结构化回值形状照官方 skill 工具（dsh-tool-skill/lib/index.js:62-80：name 参数、{name,content} 值）；missing 技能按原生一样报错。
 const schema={type:'object',additionalProperties:false,properties:{name:{type:'string',required:true},content:{type:'string',required:true}}} as const
 const render=(_args:unknown,value:{content:string})=>[{type:'text' as const,text:value.content}]
 let leak=''
 ctx.tools.register(defineTool({name:'skill',description:'fake',parameters:{name:{type:'string',required:true}},output:{schema,render},execute:async(args:{name:string})=>{if(args.name==='missing')throw Error('未找到技能');return {name:args.name,content:'技能正文 '+args.name+(leak?' '+leak:'')}}}))
 ctx.tools.register(defineTool({name:'other',description:'fake',parameters:{name:{type:'string',required:true}},output:{schema,render},execute:async(args:{name:string})=>({name:args.name,content:'其他 '+args.name})}))
 const call=(name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('c-'+Math.random()),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,call,setLeak:(value:string)=>{leak=value}}
}
const texts=(result:{content:{type:string}[]})=>result.content.filter(item=>item.type==='text').map(item=>(item as {type:string;text:string}).text)

test('post-execute：已启用且声明密钥的技能成功加载后追加一行提示；未声明、已停用、加载失败、其他工具不追加',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const declared:Record<string,MarketCatalogSkillSecret[]>={'x-search':[xai],disabled:[xai]}
 const asked:string[]=[]
 const warned:string[]=[]
 registerSkillSecretHint(e.ctx,{declared:async name=>declared[name]?{secrets:declared[name]!}:undefined,enabled:async name=>{asked.push(name);return name==='x-search'},warn:skill=>warned.push(skill)})
 const hinted=await e.call('skill',{name:'x-search'})
 assert.equal(hinted.isError,false)
 assert.deepEqual(texts(hinted).slice(0,1),['技能正文 x-search']);assert.equal(texts(hinted).length,2)
 assert.match(texts(hinted)[1]!,/^【Teloa】技能 x-search 的密钥由 Teloa 保管：调用 https:\/\/api\.x\.ai 请用 teloa_skill_http（skill 填 x-search）/)
 assert.deepEqual(texts(await e.call('skill',{name:'plain'})),['技能正文 plain'],'未声明密钥不追加')
 assert.ok(!asked.includes('plain'),'未声明密钥时不查可用性')
 assert.deepEqual(texts(await e.call('skill',{name:'disabled'})),['技能正文 disabled'],'已停用不追加')
 assert.ok(asked.includes('disabled'))
 const failed=await e.call('skill',{name:'missing'})
 assert.equal(failed.isError,true);assert.ok(texts(failed).every(text=>!text.includes('【Teloa】')),'加载失败不追加')
 assert.deepEqual(texts(await e.call('other',{name:'x-search'})),['其他 x-search'],'其他工具不追加')
 assert.deepEqual(warned,[])
})

test('可用性查询或声明来源出错：技能正常加载、不追加提示、记一条警告（不把成功结果变成错误）',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const warned:[string,unknown][]=[];let fail:'enabled'|'declared'='enabled'
 registerSkillSecretHint(e.ctx,{declared:async()=>{if(fail==='declared')throw Error('目录不可用');return {secrets:[xai]}},enabled:async()=>{throw Error('数据库连接失败')},warn:(skill,error)=>warned.push([skill,error])})
 const result=await e.call('skill',{name:'x-search'})
 assert.equal(result.isError,false);assert.deepEqual(texts(result),['技能正文 x-search'])
 fail='declared'
 assert.deepEqual(texts(await e.call('skill',{name:'x-search'})),['技能正文 x-search'])
 assert.deepEqual(warned.map(([skill,error])=>[skill,(error as Error).message]),[['x-search','数据库连接失败'],['x-search','目录不可用']])
})

test('与真实的去重策略、全局脱敏并存（同 index.ts 注册顺序）：去重替换正文后提示仍追加在其后，去重不被提示挡掉；脱敏仍作用于正文',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const known='xai'+'-'+'k'.repeat(24)
 registerCredentialGuards(e.ctx,{roots:()=>[],known:()=>[known]})
 registerSkillContextDedup(e.ctx)
 registerSkillSecretHint(e.ctx,{declared:async()=>({secrets:[xai]}),enabled:async()=>true,warn:()=>{throw Error('不应告警')}})
 // 当前上下文已有同名技能的原生 skill-invocation 指令且正文一致 → 去重生效
 e.agent.session.append('user/message',createUserMessage({source:{kind:'skill-invocation',name:'x-search',form:'instructions'},content:[{type:'text',text:'技能正文 x-search'}]}),{surfaceOp:'append'})
 const lines=texts(await e.call('skill',{name:'x-search'}))
 assert.equal(lines.length,2);assert.match(lines[0]!,/已在当前上下文提供/);assert.match(lines[1]!,/^【Teloa】技能 x-search/)
 // 正文含已存值（与上下文不一致 → 不去重）：全局脱敏替换正文，提示仍追加
 e.setLeak(known)
 const other=texts(await e.call('skill',{name:'x-search'}))
 assert.equal(other.length,2);assert.doesNotMatch(other.join('\n'),new RegExp(known.slice(4,12)));assert.match(other[0]!,/^技能正文 x-search \[已隐藏\]$/);assert.match(other[1]!,/^【Teloa】技能 x-search/)
})

test('post-execute：声明来源带 httpGuide 时，追加的提示含调用指引行',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 registerSkillSecretHint(e.ctx,{declared:async()=>({secrets:[xai],httpGuide:{'zh-CN':'POST /v1/responses。',en:'POST /v1/responses.'}}),enabled:async()=>true,warn:()=>{}})
 const lines=texts(await e.call('skill',{name:'x-search'}))
 assert.equal(lines.length,2);assert.match(lines[1]!,/\n【Teloa】调用指引（[^）]*）：\n  > POST \/v1\/responses。$/)
})
