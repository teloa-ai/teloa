import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type MarketCatalogSkillSecret} from '@teloa/contract'
import type {Context} from '@deepseek-ai/cordis'
import type {PreToolDecision,ToolExecution} from '@deepseek-ai/dsh-tools'
import type {TaskExecutionScope,TaskRun} from '@teloa/backend'
import {createSkillHttpAuthorizer,registerSkillHttpTool,runSkillHttp,skillHttpToolName,type SkillHttpAuthorizePorts,type SkillHttpRunSnapshot} from '../src/skill-http-tool.ts'
import {dshTaskRunPorts,runDateLine,skillHttpRunHint} from '../src/task-run-dsh.ts'
import {createHash} from 'node:crypto'
import {skillSecretHint} from '../src/skill-secret-hint.ts'
import type {ResolvedSkillSecrets} from '../src/skill-secrets.ts'

// 规格 2026-09-27 §5（C2）：技能代发按岗位授权给任务执行会话。运行策略与运行快照一律桩出，不连库。
const secret:MarketCatalogSkillSecret={envVarName:'XAI_API_KEY',label:{'zh-CN':'xAI API 密钥',en:'xAI API key'},required:true,target:'bearer',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}],methods:['GET','POST']}
const installationId='a1234567-1234-4123-8123-123456789abc'
const managedSkill={name:'x-search',provider:'teloa-market',managed:{installationId}}
type Session={id:string;header:{origin?:string;parentSession?:string}}
const own:Session={id:'s-own',header:{}},task:Session={id:'s-task',header:{}},child:Session={id:'s-child',header:{origin:'subagent',parentSession:'s-task'}},routing:Session={id:'s-routing',header:{}}
const sessions=new Map([own,task,child,routing].map(session=>[session.id,{session}]))
type Over={allowedTools?:string[];granted?:string[];skills?:SkillHttpRunSnapshot['skills'];selected?:string|undefined;run?:SkillHttpRunSnapshot|null}
/** 本人在授权页逐项勾选的技能（审查修复 R1 M-1）：授权记录即 `{name:'teloa_skill_http',allowed:[{skill}]}`。 */
const grantRule=(skills:string[])=>({name:skillHttpToolName,allowed:skills.map(skill=>({skill}))})
function authorizer(over:Over={}){
 const calls={ordinary:0,policy:0},audit:Record<string,unknown>[]=[]
 const run:SkillHttpRunSnapshot|null=over.run===undefined?{id:'run-1',roleId:'role-1',sessionId:'s-task',skills:over.skills??[managedSkill]}:over.run
 const ports:SkillHttpAuthorizePorts={
  agents:{get:id=>sessions.get(id)},
  isRouting:id=>id==='s-routing',
  policy:async id=>{calls.policy++;return id==='s-task'?{allowedTools:over.allowedTools??[skillHttpToolName],argumentRules:[grantRule(over.granted??['x-search'])]}:null},
  run:async id=>id==='s-task'?run:null,
  selectedInstallation:async()=>'selected' in over?over.selected:installationId,
  ordinary:async exec=>{calls.ordinary++;return exec.agent!.session.id},
  audit:event=>audit.push(event as Record<string,unknown>),
 }
 const authorize=createSkillHttpAuthorizer(ports)
 const as=(session:Session,args:unknown={skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})=>authorize({agent:{session},signal:AbortSignal.timeout(5000)} as unknown as ToolExecution,args)
 return {as,authorize,calls,audit}
}
// 发送路径会按安装身份复核完整技能快照（task-run-dsh reloadSkills），这里给一份形状完整的受管快照与精确版本读口。
const files=[{path:'SKILL.md',hash:'a'.repeat(64),size:100}]
const runSkill={name:'x-search',provider:'teloa-market',source:'custom',description:'搜索',content:'正文',sha256:createHash('sha256').update('正文').digest('hex'),resourceBase:{kind:'directory' as const,path:'/managed/'+installationId},managed:{installationId,bundleHash:createHash('sha256').update(JSON.stringify(files.map(file=>[file.path,file.hash]))).digest('hex'),files}}
const loadExact=async()=>[runSkill]
const forbidden=(message?:RegExp)=>(error:unknown)=>error instanceof WorkError&&error.code==='teloa/forbidden'&&(message===undefined||message.test(error.message))

test('任务会话 + 已授予 + 技能在运行快照 + 受管 + 安装一致 → 放行，回 sessionId/runId/roleId',async()=>{
 const {as,calls}=authorizer()
 assert.deepEqual(await as(task),{sessionId:'s-task',runId:'run-1',roleId:'role-1'})
 assert.equal(calls.ordinary,0,'任务会话不走本人普通会话路径')
})

test('本人普通会话路径不变：运行策略为 null 时交给原有授权，不带 runId/roleId',async()=>{
 const {as,calls}=authorizer()
 assert.deepEqual(await as(own),{sessionId:'s-own'})
 assert.equal(calls.ordinary,1)
})

test('任务会话各拒绝分支：未授予、技能不在快照、非受管、安装已变、无运行 → teloa/forbidden，且不落到普通会话路径',async()=>{
 await assert.rejects(authorizer({allowedTools:['web_fetch']}).as(task),forbidden(/未获授权/))
 await assert.rejects(authorizer({allowedTools:[]}).as(task),forbidden(/未获授权/),'撤销（策略清单变空）立即生效')
 await assert.rejects(authorizer({granted:['x-search','other-skill']}).as(task,{skill:'other-skill',method:'GET',url:'https://api.x.ai/v1/x'}),forbidden(/不在本次运行/),'已勾选但不在本次运行快照')
 await assert.rejects(authorizer().as(task,{method:'GET',url:'https://api.x.ai/v1/x'}),forbidden(/未勾选/))
 await assert.rejects(authorizer({skills:[{name:'x-search',provider:'github'}]}).as(task),forbidden(/受管安装/))
 await assert.rejects(authorizer({skills:[{name:'x-search',provider:'teloa-market'}]}).as(task),forbidden(/受管安装/))
 await assert.rejects(authorizer({selected:'b1234567-1234-4123-8123-123456789abc'}).as(task),forbidden(/安装已变化/))
 await assert.rejects(authorizer({selected:undefined}).as(task),forbidden(/安装已变化/))
 await assert.rejects(authorizer({run:null}).as(task),forbidden(/无法核对本次运行/))
 await assert.rejects(authorizer({run:{id:'run-1',roleId:'role-1',sessionId:'s-other',skills:[managedSkill]}}).as(task),forbidden(/无法核对本次运行/))
 const {as,calls}=authorizer({allowedTools:[]});await as(task).catch(()=>{});assert.equal(calls.ordinary,0)
})

test('子代理会话（含任务运行派生的）与群路由会话一律拒绝；谱系断裂也拒绝',async()=>{
 const {as,calls}=authorizer()
 await assert.rejects(as(child),forbidden(/子 Agent/))
 await assert.rejects(as(routing),forbidden(/群路由/))
 await assert.rejects(as({id:'s-orphan',header:{origin:'subagent',parentSession:'s-gone'}}),forbidden())
 assert.equal(calls.ordinary,0);assert.equal(calls.policy,0,'先判会话来源，不白查运行策略')
})

test('运行策略读口抛非 WorkError 时回 host-unavailable，不泄露原始错误',async()=>{
 const authorize=createSkillHttpAuthorizer({agents:{get:id=>sessions.get(id)},isRouting:()=>false,policy:async()=>{throw Error('connect ECONNREFUSED 127.0.0.1:5432')},run:async()=>null,selectedInstallation:async()=>undefined,ordinary:async()=>'x'})
 await assert.rejects(authorize({agent:{session:task},signal:AbortSignal.timeout(5000)} as unknown as ToolExecution,{skill:'x-search'}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/host-unavailable'&&!/5432/.test(error.message))
})

test('审计 use/deny 在任务会话带 runId、roleId；普通会话省略；字段不含值',async()=>{
 const key='xai-'+'k'.repeat(24),audit:Record<string,unknown>[]=[]
 const ports={skillVisible:async()=>true,readForUse:async()=>({secrets:[secret],values:{XAI_API_KEY:key},stale:false}),allow:()=>true,webPolicy:async()=>({version:1 as const,enabled:true,blocked:[]}),resolve:async()=>[{address:'104.18.32.1',family:4 as const}],request:async()=>new Response('{}',{status:200,headers:{'content-type':'application/json'}}),audit:(event:object)=>audit.push(event as Record<string,unknown>)}
 await runSkillHttp(ports,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'},AbortSignal.timeout(5000),{sessionId:'s-task',runId:'run-1',roleId:'role-1'})
 assert.deepEqual(Object.keys(audit[0]!).sort(),['bytes','envVarNames','event','method','origin','pathPrefix','redacted','roleId','runId','sessionId','skill','status'])
 assert.deepEqual([audit[0]!.runId,audit[0]!.roleId],['run-1','role-1'])
 await assert.rejects(runSkillHttp(ports,{skill:'x-search',method:'DELETE',url:'https://api.x.ai/v1/x'},AbortSignal.timeout(5000),{sessionId:'s-task',runId:'run-1',roleId:'role-1'}))
 assert.deepEqual(audit[1],{event:'skill-secret.deny',skill:'x-search',reason:'method',origin:'https://api.x.ai',method:'DELETE',sessionId:'s-task',runId:'run-1',roleId:'role-1'})
 await runSkillHttp(ports,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'},AbortSignal.timeout(5000),{sessionId:'s-own'})
 assert.equal('runId' in audit[2]!||'roleId' in audit[2]!,false)
 assert.doesNotMatch(JSON.stringify(audit),/kkkkkkkk/)
})

test('任务会话 POST 同样出 ask 确认卡；权限模式 never 时 deny；授权失败先 deny；确认阶段拒绝的审计带 runId/roleId',async()=>{
 const handlers=new Map<string,(...args:any[])=>Promise<unknown>>(),audit:unknown[]=[]
 const ctx={tools:{register:()=>()=>{}},on:(name:string,h:(...args:any[])=>Promise<unknown>)=>{handlers.set(name,h);return ()=>{}}} as unknown as Context
 let policy='ask'
 const {authorize}=authorizer()
 registerSkillHttpTool(ctx,{readForUse:async()=>({secrets:[secret],values:{},stale:false}),allow:()=>true,webPolicy:async()=>({version:1,enabled:true,blocked:[]}),audit:event=>audit.push(event),skillVisible:async()=>true,
  authorize,approvalPolicy:()=>policy})
 const pre=(session:Session,args:unknown,callId:string)=>handlers.get('tools/pre-execute')!({name:skillHttpToolName,arguments:args,callId,agent:{session},signal:AbortSignal.timeout(5000)} as unknown as ToolExecution,async()=>({kind:'allow'})) as Promise<PreToolDecision>
 const post={skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x',body:'{}'}
 const decision=await pre(task,post,'c-1')
 assert.equal(decision.kind,'ask');assert.match((decision as {reason:string}).reason,/员工授权不会代替逐次确认/)
 assert.deepEqual(await pre(task,{...post,method:'GET'},'c-2'),{kind:'allow'},'GET 不出卡')
 assert.equal(await handlers.get('approval/request')!({toolName:skillHttpToolName,callId:'c-1'},async()=>'unavailable'),'unavailable','无人值守（无答复者）按 DSH 拒绝处理')
 assert.deepEqual(audit.at(-1),{event:'skill-secret.deny',skill:'x-search',reason:'approval',origin:'https://api.x.ai',method:'POST',sessionId:'s-task',runId:'run-1',roleId:'role-1'})
 policy='never'
 assert.equal((await pre(task,post,'c-3')).kind,'deny')
 assert.deepEqual(await pre(child,post,'c-4'),{kind:'deny',reason:'子 Agent 会话不能调用技能接口。'})
})

test('提示部件：授予且有声明密钥的受管技能时为 [inputText, 代发提示, 日期行]；未授予时为 [inputText, 日期行]；inputText 逐字不变',async()=>{
 const guide={'zh-CN':'先 GET /v1/models',en:'GET /v1/models first'}
 const declared=async(name:string):Promise<ResolvedSkillSecrets|undefined>=>name==='x-search'?{secrets:[secret],httpGuide:guide}:undefined
 const skills=[{...managedSkill},{name:'plain',provider:'teloa-market',managed:{installationId:'c1234567-1234-4123-8123-123456789abc'}},{name:'x-search-copy',provider:'github'}] as unknown as TaskRun['skills']
 const expected=skillSecretHint('x-search',[secret],guide)
 assert.equal(await skillHttpRunHint({allowedTools:[skillHttpToolName],argumentRules:[grantRule(['x-search','plain','x-search-copy'])],skills},declared),expected)
 assert.equal(await skillHttpRunHint({allowedTools:['web_fetch'],skills},declared),undefined)
 assert.equal(await skillHttpRunHint({allowedTools:[skillHttpToolName],argumentRules:[grantRule(['x-search'])],skills:[{name:'x-search',provider:'github'}] as unknown as TaskRun['skills']},declared),undefined,'非受管技能不给提示')
 const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'}
 const send=async(allowedTools:string[])=>{
  const sent:{content:unknown[]}[]=[],agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}}
  const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:{content:unknown[]})=>{sent.push(request);return {accepted:true}}},logger:{warn:()=>{}}} as unknown as Context
  const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,undefined,undefined,loadExact,undefined,undefined,undefined,declared)
  const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'{"task":"固定输入"}',allowedTools,argumentRules:[grantRule(['x-search'])],skills:[runSkill]} as unknown as TaskRun
  await ports.send(run,AbortSignal.timeout(5000),target)
  assert.equal(run.inputText,'{"task":"固定输入"}','提示不写进 inputText')
  return sent[0]!.content
 }
 assert.deepEqual(await send([skillHttpToolName]),[{type:'text',text:'{"task":"固定输入"}'},{type:'text',text:expected},{type:'text',text:runDateLine()}])
 assert.deepEqual(await send([]),[{type:'text',text:'{"task":"固定输入"}'},{type:'text',text:runDateLine()}])
})

test('提示读取失败只降级为不带提示并记警告（只记错误类别），不阻断发送',async()=>{
 const warned:string[]=[],sent:{content:unknown[]}[]=[],agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:{content:unknown[]})=>{sent.push(request);return {accepted:true}}},logger:{warn:(...args:unknown[])=>warned.push(args.map(String).join(' '))}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,undefined,undefined,loadExact,undefined,undefined,undefined,async()=>{throw Error('db down at 10.0.0.9')})
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定',allowedTools:[skillHttpToolName],argumentRules:[grantRule(['x-search'])],skills:[runSkill]} as unknown as TaskRun
 await ports.send(run,AbortSignal.timeout(5000),{taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'})
 assert.deepEqual(sent[0]!.content,[{type:'text',text:'固定'},{type:'text',text:runDateLine()}])
 assert.equal(warned.length,1);assert.doesNotMatch(warned[0]!,/10\.0\.0\.9/)
})

test('审查修复 R1 M-1：授权显式到技能——运行授予了工具、技能也在快照且受管选定，但本人未勾选（如行业职责技能）即拒',async()=>{
 const brief={name:'brief',provider:'teloa-market',managed:{installationId}}
 const {as}=authorizer({skills:[managedSkill,brief],selected:installationId})
 await assert.rejects(as(task,{skill:'brief',method:'GET',url:'https://api.x.ai/v1/x'}),forbidden(/未勾选/))
 assert.deepEqual(await as(task),{sessionId:'s-task',runId:'run-1',roleId:'role-1'},'已勾选的技能照常放行')
 await assert.rejects(authorizer({granted:[]}).as(task),forbidden(/未勾选/),'授权记录里没有任何技能')
 const legacy=createSkillHttpAuthorizer({agents:{get:id=>sessions.get(id)},isRouting:()=>false,policy:async()=>({allowedTools:[skillHttpToolName]}),run:async()=>({id:'run-1',roleId:'role-1',sessionId:'s-task',skills:[managedSkill]}),selectedInstallation:async()=>installationId,ordinary:async()=>'x'})
 await assert.rejects(legacy({agent:{session:task},signal:AbortSignal.timeout(5000)} as unknown as ToolExecution,{skill:'x-search'}),forbidden(/未勾选/),'没有逐项授权记录（旧形状）一律拒')
})

test('审查修复 R1 L-2：调用时授权被拒记 skill-secret.deny reason caller，带会话、运行、岗位标识（已知时），不含请求内容',async()=>{
 const args={skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x?q=secret-ish',body:'body-text'}
 const cases:[Over,Session,Record<string,unknown>][]=[
  [{allowedTools:[]},task,{sessionId:'s-task'}],
  [{granted:['other']},task,{sessionId:'s-task'}],
  [{skills:[]},task,{sessionId:'s-task',runId:'run-1',roleId:'role-1'}],
  [{selected:undefined},task,{sessionId:'s-task',runId:'run-1',roleId:'role-1'}],
  [{},child,{sessionId:'s-child'}],
  [{},routing,{sessionId:'s-routing'}],
 ]
 for(const [over,session,ids] of cases){
  const {as,audit}=authorizer(over)
  await assert.rejects(as(session,args),forbidden())
  assert.deepEqual(audit,[{event:'skill-secret.deny',skill:'x-search',reason:'caller',origin:'https://api.x.ai',method:'POST',...ids}],JSON.stringify(over)+session.id)
  assert.doesNotMatch(JSON.stringify(audit),/secret-ish|body-text/)
 }
 const ok=authorizer();await ok.as(task,args);assert.deepEqual(ok.audit,[],'放行不记 deny')
 const bad=authorizer({allowedTools:[]});await assert.rejects(bad.as(task,{skill:'Bad Name',method:'NOPE',url:'not a url'}));assert.deepEqual(bad.audit,[{event:'skill-secret.deny',skill:'(invalid)',reason:'caller',origin:'',method:'(invalid)',sessionId:'s-task'}])
})

test('审查修复 R1 L-3：确认期间撤销授权（或取消勾选），执行阶段二次授权即拒，不发请求',async()=>{
 let tool:{execute:(args:unknown,exec:unknown)=>Promise<unknown>}|undefined,granted=['x-search'],requests=0
 const ctx={tools:{register:(definition:typeof tool)=>{tool=definition;return ()=>{}}},on:()=>()=>{}} as unknown as Context
 const authorize=createSkillHttpAuthorizer({agents:{get:id=>sessions.get(id)},isRouting:()=>false,policy:async()=>({allowedTools:granted.length?[skillHttpToolName]:[],argumentRules:[grantRule(granted)]}),run:async()=>({id:'run-1',roleId:'role-1',sessionId:'s-task',skills:[managedSkill]}),selectedInstallation:async()=>installationId,ordinary:async()=>'x'})
 registerSkillHttpTool(ctx,{readForUse:async()=>({secrets:[secret],values:{XAI_API_KEY:'xai-'+'k'.repeat(24)},stale:false}),allow:()=>true,webPolicy:async()=>({version:1,enabled:true,blocked:[]}),audit:()=>{},skillVisible:async()=>true,authorize,approvalPolicy:()=>'ask',
  resolve:async()=>[{address:'104.18.32.1',family:4}],request:async()=>{requests++;return new Response('{}',{status:200,headers:{'content-type':'application/json'}})}})
 const exec={agent:{session:task},signal:AbortSignal.timeout(5000)}
 const post={skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x',body:'{}'}
 assert.match(String(await tool!.execute(post,exec)),/"status":200/)
 granted=[]
 await assert.rejects(tool!.execute(post,exec),forbidden(/未获授权/))
 granted=['other']
 await assert.rejects(tool!.execute(post,exec),forbidden(/未勾选/))
 assert.equal(requests,1,'被拒的执行不发请求')
})

test('审查修复 R1：提示部件只列本人已勾选的技能；带图片发送时同样位于 inputText 之后、日期行之前',async()=>{
 const declared=async(name:string):Promise<ResolvedSkillSecrets|undefined>=>({secrets:[{...secret,envVarName:name.toUpperCase().replace(/-/g,'_')+'_KEY'}]})
 const two=[{...managedSkill},{name:'brief',provider:'teloa-market',managed:{installationId:'c1234567-1234-4123-8123-123456789abc'}}] as unknown as TaskRun['skills']
 const hint=await skillHttpRunHint({allowedTools:[skillHttpToolName],argumentRules:[grantRule(['x-search'])],skills:two},declared)
 assert.ok(hint?.includes('x-search')&&!hint.includes('brief'),hint)
 assert.equal(await skillHttpRunHint({allowedTools:[skillHttpToolName],skills:two},declared),undefined,'没有逐项授权记录不给提示')
 const sent:{content:Record<string,unknown>[]}[]=[],agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[],requestHeader:()=>({config:{provider:'p',model:'m'}})}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),modelCatalog:async()=>({default:{provider:'p',model:'m'}}),prompt:async(request:{content:Record<string,unknown>[]})=>{sent.push(request);return {accepted:true}}},llm:{resolveModelInfo:async()=>({provider:'p',id:'m',name:'m',inputModalities:['text','image']})},logger:{warn:()=>{}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,undefined,undefined,loadExact,undefined,undefined,undefined,declared)
 ports.groupPrompt={readAttachmentImageBytes:async()=>new Uint8Array([1,2,3]),readArtifactImageBytes:async()=>new Uint8Array([4,5,6]),markNoVision:()=>{}}
 const png={kind:'attachment',id:'att-png',version:1,sha256:'a'.repeat(64),mime:'image/png',bytes:16,name:'证据.png',width:800,height:600}
 const run={id:'run',taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标',allowedTools:[skillHttpToolName],argumentRules:[grantRule(['x-search'])],skills:[runSkill],groupContext:{taskId:'task',groupId:'group',groupVersion:1,roleId:'role',roleVersion:1,grantVersion:1,source:{messageId:'m',rootId:'r',createdAt:'2026-09-21T00:00:00.000Z',text:'来源'},materials:[],files:[png]}} as unknown as TaskRun
 await ports.send(run,AbortSignal.timeout(5000),{taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'})
 const content=sent[0]!.content
 assert.deepEqual(content.map(part=>part.type),['text','text','text','image'])
 assert.equal(content[0]!.text,'固定目标');assert.equal(content[1]!.text,await skillHttpRunHint(run,declared));assert.equal(content[2]!.text,runDateLine())
})
