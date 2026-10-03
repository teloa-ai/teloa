import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import type {TaskExecutionScope,TaskRun,TaskRunSkillDatabase} from '@teloa/backend'
import {dshTaskRunPorts,pickPromptImages,runDateLine,taskKnowledgeAuthorization} from '../src/task-run-dsh.ts'
import {selfAuthorizedToolNames} from '../src/self-authorized-tools.ts'
import type {RunGroupFile} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session'

test('冷读执行证据经官方 inspect，不能为了核对结果激活或重发原生 Agent',async()=>{
 const events=[{seq:0,time:0,type:'turn/start',data:{turn:0}},{seq:1,time:1,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}}] as SessionEvent[]
 let foreign=false,wrongSession=false
 const ctx={sessionController:{inspect:async(id:string)=>({meta:{id:wrongSession?'other':id},events}),resolveAgent:async()=>{throw Error('结果核对不得激活 Agent')},prompt:async()=>{throw Error('不得重发')}},sessions:{get:()=>undefined}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:foreign?'other':'owner',sessionId:'session',status:'ready'})),run={sessionId:'session'} as TaskRun
 assert.deepEqual(await ports.events(run),events)
 foreign=true;await assert.rejects(ports.events(run),{code:'teloa/forbidden'});foreign=false
 wrongSession=true;await assert.rejects(ports.events(run),{code:'teloa/forbidden'})
})

const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'}

test('任务知识授权只使用服务端任务范围，不继承普通会话 general 范围',()=>{
 assert.deepEqual(taskKnowledgeAuthorization('owner',target),{
  actor:{ownerId:'owner',kind:'agent',scopeIds:['SOC']},
  targetScopes:['SOC'],
 })
})

test('通用范围任务里主体范围并上岗位自身范围，业务范围任务仍只用任务范围',()=>{
 assert.deepEqual(taskKnowledgeAuthorization('owner',{...target,scope:'general'},['SOC']),{
  actor:{ownerId:'owner',kind:'agent',scopeIds:['general','SOC']},
  targetScopes:['general','SOC'],
 })
 assert.deepEqual(taskKnowledgeAuthorization('owner',target,['general','AppSec']),{
  actor:{ownerId:'owner',kind:'agent',scopeIds:['SOC']},
  targetScopes:['SOC'],
 })
 assert.deepEqual(taskKnowledgeAuthorization('owner',{...target,scope:'general'},[]).actor.scopeIds,['general'])
})

test('运行专用会话创建时直接传固定 preset，并以回执和会话头双重核对',async()=>{
 const requests:unknown[]=[],signal=new AbortController().signal
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{agentPreset:'security-analyst'},snapshotEvents:()=>[]}}
 const ctx={agentPresets:{resolve:async(id?:string)=>({id:id!})},sessionController:{
  create:async(request:unknown)=>{requests.push(request);return {sessionId:'run-session',agentPreset:'security-analyst'}},
  inspect:async()=>({meta:{id:'run-session',agentPreset:'security-analyst'}}),
  resolveAgent:async()=>({agent}),prompt:async()=>{},
 }} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'run-session',status:'ready'}))
 await ports.prepareSession!('run-session','security-analyst',signal)
 assert.deepEqual(requests,[{sessionId:'run-session',agentPreset:'security-analyst'}])
})

test('岗位未固定 preset 时解析并固定 DSH 当前真实默认配置',async()=>{
 const requests:unknown[]=[],ctx={agentPresets:{resolve:async()=>({id:'default-agent'})},sessionController:{create:async(request:unknown)=>{requests.push(request);return {sessionId:'run-session',agentPreset:'default-agent'}},inspect:async()=>({meta:{id:'run-session',agentPreset:'default-agent'}})}} as unknown as Context
 const resolved=await dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'run-session',status:'ready'})).prepareSession!('run-session',undefined,new AbortController().signal)
 assert.equal(resolved,'default-agent');assert.deepEqual(requests,[{sessionId:'run-session',agentPreset:'default-agent'}])
})

test('preset 创建回执或会话头不一致时保留明确阶段，且绝不发送提示词',async()=>{
 for(const changed of ['receipt-missing','receipt-mismatch','inspect-missing','inspect-mismatch','create-failed']){
  let prompts=0
  const actual=changed.endsWith('mismatch')?'security-reviewer':undefined
  const ctx={agentPresets:{resolve:async(id?:string)=>({id:id!})},sessionController:{
   create:async()=>{if(changed==='create-failed')throw Error('native private detail');return {sessionId:'run-session',...(changed.startsWith('receipt')?(actual===undefined?{}:{agentPreset:actual}):{agentPreset:'security-analyst'})}},
   inspect:async()=>({meta:{id:'run-session',...(changed.startsWith('inspect')?(actual===undefined?{}:{agentPreset:actual}):{agentPreset:'security-analyst'})}}),
   resolveAgent:async()=>({agent:{status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{agentPreset:actual},snapshotEvents:()=>[]}}}),
   prompt:async()=>{prompts++},
  }} as unknown as Context
  const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'run-session',status:'ready'})),signal=new AbortController().signal
  const error=await ports.prepareSession!('run-session','security-analyst',signal).then(()=>undefined,value=>value)
  assert.equal(error.code,'teloa/preset-unavailable')
  assert.equal(error.stage,changed.startsWith('receipt')?'session-receipt':changed.startsWith('inspect')?'session-inspect':'session-create')
  assert.equal(error.actualAgentPresetId,changed==='create-failed'?'security-analyst':actual)
  const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'run-session',agentPresetId:'security-analyst',nativeRequestId:'native',inputText:'固定目标'} as TaskRun
  await assert.rejects(ports.send(run,signal,{...target,sessionId:'run-session'}))
  assert.equal(prompts,0)
 }
})

test('发送前再次核对 Run 固定 preset，岗位目录之后变化也不能让旧 Run 漂移',async()=>{
 let prompts=0,currentPreset='security-reviewer'
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{get header(){return {agentPreset:currentPreset}},snapshotEvents:()=>[]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{prompts++}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'})),run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',agentPresetId:'security-analyst',nativeRequestId:'native',inputText:'固定目标'} as TaskRun,signal=new AbortController().signal
 await assert.rejects(ports.send(run,signal,target),{code:'teloa/version-conflict'});assert.equal(prompts,0)
 currentPreset='security-analyst';await ports.send(run,signal,target);assert.equal(prompts,1)
})

test('DSH 适配器核对会话与空闲状态，发送固定身份，并只返回落盘前快照',async()=>{
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标'} as TaskRun
 const events:object[]=[],agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[...events]}},sent:unknown[]=[]
 let persisted=true,foreign=false
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:unknown)=>{sent.push(request);return {accepted:true}}},sessions:{get:()=>agent.session,flush:async()=>{events.push({type:'late-event'});return persisted}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:foreign?'other':'owner',sessionId:'session',status:'ready'})),signal=new AbortController().signal
 await assert.rejects((ports.send as unknown as (run:TaskRun,signal:AbortSignal,target?:TaskExecutionScope)=>Promise<void>)(run,signal),{code:'teloa/conflict'});assert.equal(sent.length,0)
 foreign=true;await assert.rejects(ports.check(run,signal),{code:'teloa/forbidden'});foreign=false
 agent.inbox.nextTurn.length=1;await assert.rejects(ports.send(run,signal,target),{code:'teloa/conflict'});assert.equal(sent.length,0);agent.inbox.nextTurn.length=0
 agent.inbox.nextStep.length=1;await assert.rejects(ports.send(run,signal,target),{code:'teloa/conflict'});assert.equal(sent.length,0);agent.inbox.nextStep.length=0
 agent.status='running';await assert.rejects(ports.send(run,signal,target),{code:'teloa/conflict'});agent.status='idle'
 await ports.send(run,signal,target)
 assert.deepEqual(sent,[{sessionId:'session',requestId:'native',mode:'queue',content:[{type:'text',text:'固定目标'},{type:'text',text:runDateLine()}]}])
 assert.deepEqual(await ports.events(run),[])
 events.push({type:'turn/start'});await assert.rejects(ports.send(run,signal,target),{code:'teloa/conflict'})
 persisted=false;await assert.rejects(ports.events(run),{code:'teloa/session-unavailable'})
})

test('停止只针对原请求活跃轮次，无排队无混入，结束后不取消后续轮次',async()=>{
 const run={sessionId:'session',nativeRequestId:'native'} as TaskRun
 const start={seq:0,time:0,type:'turn/start',data:{turn:0}}
 const message={seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}}
 const end={seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}}
 let events:object[]=[],cancelled=0,foreign=false
 const agent={status:'running',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[...events]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),cancel:(request:unknown)=>{assert.deepEqual(request,{sessionId:'session'});cancelled++;return {accepted:true}}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:foreign?'other':'owner',sessionId:'session',status:'ready'})),signal=new AbortController().signal
 await assert.rejects(ports.stop(run,signal),{code:'teloa/conflict'})
 events=[start,message];agent.inbox.nextTurn.length=1
 await assert.rejects(ports.stop(run,signal),{code:'teloa/conflict'});agent.inbox.nextTurn.length=0
 agent.inbox.nextStep.length=1;await assert.rejects(ports.stop(run,signal),{code:'teloa/conflict'});assert.equal(cancelled,0);agent.inbox.nextStep.length=0
 events=[start,message,{...message,seq:2,data:{...message.data,source:{kind:'user',rpcId:'other'}}}]
 await assert.rejects(ports.stop(run,signal),{code:'teloa/conflict'})
 events=[start,{...message,data:{...message.data,source:{kind:'user',rpcId:'other'}}},{...message,seq:2}]
 await assert.rejects(ports.stop(run,signal),{code:'teloa/conflict'})
 events=[start,message];foreign=true
 await assert.rejects(ports.stop(run,signal),{code:'teloa/forbidden'});foreign=false
 const aborted=new AbortController();aborted.abort()
 await assert.rejects(ports.stop(run,aborted.signal));assert.equal(cancelled,0)
 events=[start,message,{...message,seq:2,data:{...message.data,source:{kind:'plugin',plugin:'test'}}},{...message,seq:3,data:{...message.data,source:{kind:'agent-instructions'}}},{...message,seq:4,data:{...message.data,source:{kind:'skill-catalog'}}}]
 // 日志未闭合但 agent 已无活跃活动：上游取消在这种情况下是 no-op，不能让它伪装成已停止。
 agent.status='idle'
 await assert.rejects(ports.stop(run,signal),error=>error instanceof Error&&'code' in error&&(error as {code?:string}).code==='teloa/conflict'&&error.message==='这次执行已经没有在跑的动作，等待原生收口。')
 assert.equal(cancelled,0);agent.status='running'
 await ports.stop(run,signal);assert.equal(cancelled,1)
 events=[start,message,end,{...start,seq:3,data:{turn:1}}]
 await ports.stop(run,signal);assert.equal(cancelled,1)
})

test('准备后原生技能变化时不发送，技能一致时保留固定输入',async()=>{
 const {createHash}=await import('node:crypto')
 const snapshot={name:'review',provider:'native',source:'project',description:'核对',content:'旧正文',sha256:createHash('sha256').update('旧正文').digest('hex')}
 let content='新正文',sent=0
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:'/target'},snapshotEvents:()=>[]}}
 const skills={get:async()=>({...snapshot,content,invocation:{modelInvocable:true,userInvocable:true}})}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{sent++}},agentPresets:{serviceFor:()=>skills}} as unknown as Context
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',skills:[snapshot],nativeRequestId:'request',inputText:'固定目标'} as TaskRun
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'})),signal=new AbortController().signal
 await assert.rejects(ports.send(run,signal,target),{code:'teloa/version-conflict'});assert.equal(sent,0)
 content='旧正文';await ports.send(run,signal,target);assert.equal(sent,1)
})

test('受管 Skill 发送前按安装身份重新解析完整文件快照，附件变化时不提交',async()=>{
 const {createHash}=await import('node:crypto')
 const files=[{path:'SKILL.md',hash:'a'.repeat(64),size:100},{path:'references/source.txt',hash:'b'.repeat(64),size:12}]
 const managed={installationId:'12345678-1234-4234-8234-123456789012',bundleHash:createHash('sha256').update(JSON.stringify(files.map(file=>[file.path,file.hash]))).digest('hex'),files}
 const snapshot={name:'review',provider:'teloa-market',source:'custom',description:'核对',content:'固定正文',sha256:createHash('sha256').update('固定正文').digest('hex'),resourceBase:{kind:'directory' as const,path:'/managed/12345678-1234-4234-8234-123456789012'},managed}
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:'/target'},snapshotEvents:()=>[]}},sent:unknown[]=[]
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(value:unknown)=>{sent.push(value)}}} as unknown as Context
 let changed=true
 const loadExact=async(_sessionId:string,installationIds:readonly string[])=>{assert.deepEqual(installationIds,[managed.installationId]);if(!changed)return [snapshot];const currentFiles=[managed.files[0]!,{...managed.files[1]!,hash:'c'.repeat(64)}];return [{...snapshot,managed:{...managed,bundleHash:createHash('sha256').update(JSON.stringify(currentFiles.map(file=>[file.path,file.hash]))).digest('hex'),files:currentFiles}}]}
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,undefined,undefined,loadExact)
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',skills:[snapshot],nativeRequestId:'request',inputText:'固定目标'} as TaskRun
 await assert.rejects(ports.send(run,new AbortController().signal,target),{code:'teloa/version-conflict'});assert.equal(sent.length,0)
 changed=false;await ports.send(run,new AbortController().signal,target);assert.equal(sent.length,1)
})

test('行业 Skill 准备按安装身份合并，发送复核保留固定版本和原始顺序',async()=>{
 const {createHash}=await import('node:crypto')
 const ordinary={name:'review',provider:'native',source:'project',description:'核对',content:'普通正文',sha256:createHash('sha256').update('普通正文').digest('hex')}
 const files=[{path:'SKILL.md',hash:'a'.repeat(64),size:100}],managed={installationId:'12345678-1234-4234-8234-123456789012',bundleHash:createHash('sha256').update(JSON.stringify([['SKILL.md','a'.repeat(64)]])).digest('hex'),files}
 const industry={name:'research',provider:'teloa-market',source:'custom',description:'研究',content:'行业旧版本',sha256:createHash('sha256').update('行业旧版本').digest('hex'),resourceBase:{kind:'directory' as const,path:'/managed/'+managed.installationId},managed}
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:'/target'},snapshotEvents:()=>[]}},sent:unknown[]=[],byName:string[]=[],exact:Array<{ids:readonly string[];database:TaskRunSkillDatabase|undefined}>=[]
 const skills={get:async(name:string)=>{byName.push(name);assert.equal(name,'review','行业受管 Skill 不得按全局同名赢家读取');return {...ordinary,invocation:{modelInvocable:true,userInvocable:true}}}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(value:unknown)=>{sent.push(value)}},agentPresets:{serviceFor:()=>skills}} as unknown as Context
 let current=industry
 const loadExact=async(_sessionId:string,ids:readonly string[],_signal:AbortSignal,database?:TaskRunSkillDatabase)=>{exact.push({ids,database});return [current]}
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,undefined,undefined,loadExact),database={} as TaskRunSkillDatabase,signal=new AbortController().signal
 assert.deepEqual(await ports.loadSkills!('session',['review'],signal,database,[managed.installationId]),[ordinary,industry])
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',skills:[industry,ordinary],nativeRequestId:'request',inputText:'固定目标'} as TaskRun
 await ports.send(run,signal,target);assert.equal(sent.length,1)
 assert.deepEqual(byName,['review','review']);assert.deepEqual(exact,[{ids:[managed.installationId],database},{ids:[managed.installationId],database:undefined}])
 current={...industry,content:'行业内容被改写',sha256:createHash('sha256').update('行业内容被改写').digest('hex')}
 await assert.rejects(ports.send(run,signal,target),{code:'teloa/version-conflict'});assert.equal(sent.length,1)
})

test('运行含受管 Skill 但宿主未配置精确版本加载器时明确拒绝',async()=>{
 const {createHash}=await import('node:crypto')
 const files=[{path:'SKILL.md',hash:'a'.repeat(64),size:100}],managed={installationId:'12345678-1234-4234-8234-123456789012',bundleHash:createHash('sha256').update(JSON.stringify([['SKILL.md','a'.repeat(64)]])).digest('hex'),files}
 const snapshot={name:'research',provider:'teloa-market',source:'custom',description:'研究',content:'行业正文',sha256:createHash('sha256').update('行业正文').digest('hex'),resourceBase:{kind:'directory' as const,path:'/managed/'+managed.installationId},managed}
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}},sent:unknown[]=[]
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(value:unknown)=>{sent.push(value)}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'})),signal=new AbortController().signal
 await assert.rejects(ports.loadSkills!('session',[],signal,undefined,[managed.installationId]),{code:'teloa/skill-unavailable'})
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',skills:[snapshot],nativeRequestId:'request',inputText:'固定目标'} as TaskRun
 await assert.rejects(ports.send(run,signal,target),{code:'teloa/skill-unavailable'});assert.equal(sent.length,0)
})

test('岗位 Skill 准备与发送复核都经按名可用状态闸，准备沿用事务 client',async()=>{
 const {createHash}=await import('node:crypto')
 const snapshot={name:'review',provider:'native',source:'project',description:'核对',content:'固定正文',sha256:createHash('sha256').update('固定正文').digest('hex')}
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:'/target'},snapshotEvents:()=>[]}},sent:unknown[]=[],databases:Array<TaskRunSkillDatabase|undefined>=[]
 let reads=0
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(value:unknown)=>{sent.push(value)}},agentPresets:{serviceFor:()=>({get:async()=>{reads++;return {...snapshot,invocation:{modelInvocable:true,userInvocable:true}}}})}} as unknown as Context
 const gate=async(_name:string,database?:TaskRunSkillDatabase)=>{databases.push(database);return 'disabled' as const}
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,gate)
 const database={} as TaskRunSkillDatabase,signal=new AbortController().signal
 await assert.rejects(ports.loadSkills!('session',['review'],signal,database),{code:'teloa/skill-unavailable'})
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',skills:[snapshot],nativeRequestId:'request',inputText:'固定目标'} as TaskRun
 await assert.rejects(ports.send(run,signal,target),{code:'teloa/skill-unavailable'})
 assert.deepEqual(databases,[database,undefined]);assert.equal(reads,0);assert.equal(sent.length,0)
})

test('知识来源变化或撤回阻止发送，一致时传递固定正文',async()=>{
 const {createHash}=await import('node:crypto')
 const {readRunKnowledge}=await import('@teloa/backend')
 const knowledge=readRunKnowledge([{id:'d87222d1-d5a2-4d4b-8860-9b1bfd331ddb',version:1,title:'依据',sourceId:'source',sourceVersion:createHash('sha256').update('正文').digest('hex'),scopeIds:['general'],text:'正文'}])
 let changed=true,withdrawn=false,sent=0
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{sent++}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),async(actualTarget,ids)=>{
  assert.deepEqual(actualTarget,target);assert.deepEqual(ids,knowledge.map(item=>item.id))
  if(withdrawn)throw Object.assign(new Error('已撤回'),{code:'teloa/resource-withdrawn'})
  return knowledge.map(item=>({...item,version:changed?2:1}))
 })
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',knowledge,nativeRequestId:'native',inputText:JSON.stringify({task:{scope:'伪造范围'},knowledge:{contents:knowledge}})} as TaskRun
 const signal=new AbortController().signal
 await assert.rejects(ports.send(run,signal,target),{code:'teloa/version-conflict'});assert.equal(sent,0)
 changed=false;withdrawn=true;await assert.rejects(ports.send(run,signal,target),{code:'teloa/resource-withdrawn'});assert.equal(sent,0)
 withdrawn=false;await ports.send(run,signal,target);assert.equal(sent,1)
})

test('知识重检按 Run 快照的 roleId 补读岗位自身范围；读不到岗位就不传，退回任务范围',async()=>{
 const {createHash}=await import('node:crypto')
 const {readRunKnowledge}=await import('@teloa/backend')
 const knowledge=readRunKnowledge([{id:'d87222d1-d5a2-4d4b-8860-9b1bfd331ddb',version:1,title:'依据',sourceId:'source',sourceVersion:createHash('sha256').update('正文').digest('hex'),scopeIds:['SOC'],text:'正文'}])
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{}}} as unknown as Context
 const reads:(readonly string[]|undefined)[]=[],roleReads:string[]=[]
 let roleScopes:readonly string[]|undefined=['SOC']
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),async(_target,_ids,_signal,scopes)=>{reads.push(scopes);return knowledge},undefined,undefined,undefined,undefined,async(actor,roleId)=>{assert.equal(actor,'owner');roleReads.push(roleId);return roleScopes})
 const general={...target,scope:'general'},signal=new AbortController().signal
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',roleId:'role-soc',knowledge,nativeRequestId:'native',inputText:'固定输入'} as TaskRun
 await ports.check(run,signal,general)
 roleScopes=undefined;await ports.check(run,signal,general)
 await ports.check({...run,roleId:undefined} as unknown as TaskRun,signal,general)
 assert.deepEqual(reads,[['SOC'],undefined,undefined])
 assert.deepEqual(roleReads,['role-soc','role-soc'])
})

test('知识重检只接受与固定执行记录一致的可信任务关联',async()=>{
 const {createHash}=await import('node:crypto')
 const {readRunKnowledge}=await import('@teloa/backend')
 let reads=0,sent=0
 const knowledge=readRunKnowledge([{id:'d87222d1-d5a2-4d4b-8860-9b1bfd331ddb',version:1,title:'依据',sourceId:'source',sourceVersion:createHash('sha256').update('正文').digest('hex'),scopeIds:['SOC'],text:'正文'}])
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{sent++}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),async()=>{reads++;return knowledge})
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',knowledge,nativeRequestId:'native',inputText:'固定输入'} as TaskRun
 const signal=new AbortController().signal
 await assert.rejects(ports.check(run,signal),{code:'teloa/conflict'})
 for(const mismatch of [
  {...target,taskId:'other'},
  {...target,sessionId:'other'},
 ])await assert.rejects(ports.send(run,signal,mismatch),{code:'teloa/forbidden'})
 for(const mismatch of [
  {...target,taskVersion:4},
  {...target,linkVersion:3},
 ])await assert.rejects(ports.send(run,signal,mismatch),{code:'teloa/version-conflict'})
 assert.equal(reads,0);assert.equal(sent,0)
 await ports.send(run,signal,target)
 assert.equal(reads,1);assert.equal(sent,1)
})

test('行业模板逐项输入和交付要求原样交给DSH提示入口，声明不转成工具配置',async()=>{
 const industryContext={taskId:'task',sourceDigest:'a'.repeat(64),method:'比较原始来源',requirements:['原文','范围'],inputs:['资料 A','本周'],output:'带出处的简报',skills:[{id:'research',title:'研究',version:'1.0.0'}]},inputText=JSON.stringify({task:{id:'task'},industryContext})
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',skills:[],knowledge:[],allowedTools:[],inputText} as unknown as TaskRun
 const sent:unknown[]=[],agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:unknown)=>{sent.push(request);return {accepted:true}}}} as unknown as Context
 await dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'})).send(run,new AbortController().signal,target)
 assert.deepEqual(sent,[{sessionId:'session',requestId:'native',mode:'queue',content:[{type:'text',text:inputText},{type:'text',text:runDateLine()}]}])
 const request=sent[0] as {content:Array<{text:string}>}
 assert.deepEqual(JSON.parse(request.content[0]!.text).industryContext,industryContext)
 assert.deepEqual(run.allowedTools,[])
})

test('行业持续计划的待获取要求和说明完整送入DSH，不伪造输入或安装Skill',async()=>{
 const planWorkContextNotice='以下模板要求是本轮待获取或核实的资料，不表示已经提供输入；方法与交付要求仅供任务参考，Skill 声明不代表已安装或授权，不增加执行权限。'
 const work={sourceDigest:'b'.repeat(64),method:'先查原始来源',requirements:['本轮资料'],output:'带出处的简报',skills:[{id:'research',title:'研究',version:'1.0.0'}],notice:planWorkContextNotice}
 const inputText=JSON.stringify({task:{id:'task'},planContext:{occurrenceId:'12345678-1234-4234-8234-123456789012',goal:'定期核对',dataScope:'已授权资料',delivery:'简报',work}})
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',skills:[],knowledge:[],allowedTools:[],inputText} as unknown as TaskRun
 const sent:unknown[]=[],agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:unknown)=>{sent.push(request);return {accepted:true}}}} as unknown as Context
 await dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'})).send(run,new AbortController().signal,target)
 assert.deepEqual(sent,[{sessionId:'session',requestId:'native',mode:'queue',content:[{type:'text',text:inputText},{type:'text',text:runDateLine()}]}])
 const actual=JSON.parse((sent[0] as {content:Array<{text:string}>}).content[0]!.text).planContext.work
 assert.deepEqual(actual,work);assert.equal('inputs' in actual,false);assert.deepEqual(run.skills,[]);assert.deepEqual(run.allowedTools,[])
})

test('提交原生prompt之前必须完成运行Skill作用域，失败或取消不发送',async()=>{
 const run={id:'run',taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标'} as TaskRun
 const calls:string[]=[],agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}},ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{calls.push('prompt')}}} as unknown as Context
 let fail=true
 const controller=new AbortController(),ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,undefined,async(value,signal)=>{assert.deepEqual(value,run);assert.equal(signal,controller.signal);calls.push('scope');if(fail)throw Error('scope unavailable')})
 await assert.rejects(ports.send(run,controller.signal,target),/scope unavailable/);assert.deepEqual(calls,['scope'])
 fail=false;await ports.send(run,controller.signal,target);assert.deepEqual(calls,['scope','scope','prompt'])
 const cancelled=new AbortController(),cancelPorts=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,undefined,async()=>{cancelled.abort()})
 await assert.rejects(cancelPorts.send(run,cancelled.signal,target));assert.equal(calls.filter(x=>x==='prompt').length,1)
})

test('停止读数取宿主自报的运行状态与日志末位 seq，静止首次只开始计时',async()=>{
 const run={id:'run',sessionId:'session',nativeRequestId:'native'} as TaskRun
 const events=[{seq:0,time:0,type:'turn/start',data:{turn:0}},{seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}}]
 const agent={status:'running',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[...events]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent})}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}))
 assert.deepEqual(await ports.stopState!(run),{running:true,settledSeq:null})
 agent.status='idle'
 // 第一次读到静止只是把计时起点记下来，这一轮不给收口依据。
 assert.deepEqual(await ports.stopState!(run),{running:false,settledSeq:null})
})

// ---- 群附件一期：已授权图片进模型（T10）----

const png=(size:number)=>({kind:'attachment' as const,id:'att-png',version:1,sha256:'a'.repeat(64),mime:'image/png',bytes:size,name:'证据.png',width:800,height:600})
const artifactPng=(size:number)=>({kind:'artifact' as const,id:'11111111-1111-4111-8111-111111111111',version:2,sha256:'b'.repeat(64),mime:'image/png',bytes:size,name:'成果图.png'})
const groupRun=(files:RunGroupFile[])=>({id:'run',taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标',groupContext:{taskId:'task',groupId:'group',groupVersion:1,roleId:'role',roleVersion:1,grantVersion:1,source:{messageId:'m',rootId:'r',createdAt:'2026-09-21T00:00:00.000Z',text:'来源'},materials:[],files}} as unknown as TaskRun)

function visionHarness(modalities:readonly string[]|undefined|'throw',files:RunGroupFile[]){
 const sent:Array<{content:Array<Record<string,unknown>>}> = [],attachmentReads:Array<Record<string,unknown>>=[],artifactReads:Array<Record<string,unknown>>=[],noVision:string[][]=[]
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[],requestHeader:()=>({config:{provider:'p',model:'m'}})}}
 let rejectImages=false
 const ctx={sessionController:{
  resolveAgent:async()=>({agent}),
  modelCatalog:async()=>({default:{provider:'p',model:'m'}}),
  prompt:async(request:{content:Array<Record<string,unknown>>})=>{
   if(rejectImages&&request.content.some(part=>part.type==='image')){const error=Object.assign(Error('denied'),{code:'session/attachment-invalid'});throw error}
   sent.push(request);return {accepted:true}
  },
 },llm:{resolveModelInfo:async()=>{if(modalities==='throw')throw Error('catalog offline');return modalities===undefined?{provider:'p',id:'m',name:'m'}:{provider:'p',id:'m',name:'m',inputModalities:modalities}}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}))
 ports.groupPrompt={
  readAttachmentImageBytes:async ref=>{attachmentReads.push(ref);return new Uint8Array([1,2,3])},
  readArtifactImageBytes:async ref=>{artifactReads.push(ref);return new Uint8Array([4,5,6])},
  markNoVision:(sessionId,requestId)=>{noVision.push([sessionId,requestId])},
 }
 return {ports,sent,attachmentReads,artifactReads,noVision,run:groupRun(files),rejectImages:()=>{rejectImages=true}}
}

test('视觉能力为 supported 时授权图片按引用顺序进 content，text 仍是第一部件',async()=>{
 const second={...png(16),id:'att-2',name:'第二张.jpeg',mime:'image/jpeg' as const}
 const {ports,sent,attachmentReads,artifactReads,run,noVision}=visionHarness(['text','image'],[png(16),second])
 await ports.send(run,new AbortController().signal,{...target,sessionId:'session'})
 assert.equal(sent.length,1)
 assert.deepEqual(sent[0]!.content,[
  {type:'text',text:'固定目标'},{type:'text',text:runDateLine()},
  {type:'image',mediaType:'image/png',data:'AQID',name:'证据.png'},
  {type:'image',mediaType:'image/jpeg',data:'AQID',name:'第二张.jpeg'},
 ])
 assert.deepEqual(attachmentReads,[{attachmentId:'att-png',mediaType:'image/png',bytes:16,width:800,height:600},{attachmentId:'att-2',mediaType:'image/jpeg',bytes:16,width:800,height:600}])
 assert.deepEqual(artifactReads,[])
 assert.deepEqual(noVision,[])
})

test('GIF 与 SVG 不进 content，成果图片按固定版本快照读口进入模型',async()=>{
 const gif={...png(16),id:'att-gif',mime:'image/gif',name:'动画.gif'}
 const svg={...png(16),id:'att-svg',mime:'application/octet-stream',name:'图.svg'}
 const artifact=artifactPng(16)
 const {ports,sent,attachmentReads,artifactReads,run}=visionHarness(['text','image'],[gif,svg,artifact])
 await ports.send(run,new AbortController().signal,{...target,sessionId:'session'})
 assert.deepEqual(sent[0]!.content,[{type:'text',text:'固定目标'},{type:'text',text:runDateLine()},{type:'image',mediaType:'image/png',data:'BAUG',name:'成果图.png'}])
 assert.deepEqual(attachmentReads,[])
 assert.deepEqual(artifactReads,[{artifactId:artifact.id,version:2,sha256:'b'.repeat(64),mediaType:'image/png',bytes:16,name:'成果图.png'}])
})

test('附件与成果图片共用 4 张预算，按混合引用顺序取前缀并报告剩余张数',async()=>{
 const files=[
  {...png(16),id:'att-0',name:'第0张.png'},
  {...artifactPng(16),id:'11111111-1111-4111-8111-111111111112',name:'第1张.png'},
  {...png(16),id:'att-2',name:'第2张.png'},
  {...artifactPng(16),id:'11111111-1111-4111-8111-111111111114',name:'第3张.png'},
  {...png(16),id:'att-4',name:'第4张.png'},
 ] as RunGroupFile[]
 const {ports,sent,attachmentReads,artifactReads,run}=visionHarness(['text','image'],files)
 await ports.send(run,new AbortController().signal,{...target,sessionId:'session'})
 const content=sent[0]!.content
 assert.equal(content.filter(part=>part.type==='image').length,4)
 assert.deepEqual(content.filter(part=>part.type==='image').map(part=>part.name),['第0张.png','第1张.png','第2张.png','第3张.png'])
 assert.equal(String(content[0]!.text).includes('本轮还有 1 张已授权图片未进模型'),true)
 assert.equal(String(content[0]!.text).startsWith('固定目标'),true)
 assert.deepEqual(attachmentReads.map(read=>read.attachmentId),['att-0','att-2'])
 assert.deepEqual(artifactReads.map(read=>read.artifactId),['11111111-1111-4111-8111-111111111112','11111111-1111-4111-8111-111111111114'])
})

test('附件与成果图片共用 16 MiB 预算，超限后停止而不跳过成果图',async()=>{
 const first={...png(9*1024*1024),id:'att-0',name:'大图0.png'},second={...artifactPng(9*1024*1024),name:'大图1.png'},third={...png(1),id:'att-2',name:'小图2.png'}
 const {ports,sent,attachmentReads,artifactReads,run}=visionHarness(['text','image'],[first,second,third])
 await ports.send(run,new AbortController().signal,{...target,sessionId:'session'})
 const content=sent[0]!.content
 assert.equal(content.filter(part=>part.type==='image').length,1)
 assert.equal(String(content[0]!.text).includes('本轮还有 2 张已授权图片未进模型'),true)
 assert.deepEqual(attachmentReads.map(read=>read.attachmentId),['att-0'])
 assert.deepEqual(artifactReads,[])
})

test('成果图片固定事实读取失败时在 prompt 前拒绝，不回退附件仓',async()=>{
 const artifact=artifactPng(16),{ports,sent,attachmentReads,artifactReads,run}=visionHarness(['text','image'],[artifact])
 ports.groupPrompt!.readArtifactImageBytes=async ref=>{artifactReads.push(ref);throw Object.assign(Error('artifact mismatch'),{code:'teloa/storage-corrupt'})}
 await assert.rejects(ports.send(run,new AbortController().signal,{...target,sessionId:'session'}),{code:'teloa/storage-corrupt'})
 assert.deepEqual(sent,[])
 assert.deepEqual(attachmentReads,[])
 assert.equal(artifactReads.length,1)
})

test('视觉能力为 unsupported 时一张图都不发，并把无视觉前置句交给发布器',async()=>{
 const {ports,sent,attachmentReads,artifactReads,noVision,run}=visionHarness(['text'],[png(16)])
 await ports.send(run,new AbortController().signal,{...target,sessionId:'session'})
 assert.deepEqual(sent[0]!.content,[{type:'text',text:'固定目标'},{type:'text',text:runDateLine()}])
 assert.deepEqual(attachmentReads,[])
 assert.deepEqual(artifactReads,[])
 assert.deepEqual(noVision,[['session','native']])
})

test('视觉能力查不到时先发图；被原生以 session/attachment-invalid 拒后去图重发并登记前置句',async()=>{
 for(const modalities of ['throw',undefined] as const){
  const {ports,sent,noVision,run,rejectImages}=visionHarness(modalities,[png(16)])
  rejectImages()
  await ports.send(run,new AbortController().signal,{...target,sessionId:'session'})
  assert.equal(sent.length,1)
  assert.deepEqual(sent[0]!.content,[{type:'text',text:'固定目标'},{type:'text',text:runDateLine()}])
  assert.deepEqual(noVision,[['session','native']])
 }
})

test('视觉能力查不到但原生接受图片时照发，不登记无视觉前置句',async()=>{
 const {ports,sent,noVision,run}=visionHarness(undefined,[png(16)])
 await ports.send(run,new AbortController().signal,{...target,sessionId:'session'})
 assert.equal(sent[0]!.content.filter(part=>part.type==='image').length,1)
 assert.deepEqual(noVision,[])
})

test('声明支持视觉却被原生拒图时不吞错：只有查不到那一条才去图重发',async()=>{
 const {ports,run,rejectImages,noVision}=visionHarness(['text','image'],[png(16)])
 rejectImages()
 await assert.rejects(ports.send(run,new AbortController().signal,{...target,sessionId:'session'}),/denied/)
 assert.deepEqual(noVision,[])
})

test('没有可进模型的图片时不去读模型能力，普通运行的 content 只有文本部件',async()=>{
 let resolved=0
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}},sent:unknown[]=[]
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:unknown)=>{sent.push(request);return {accepted:true}}},llm:{resolveModelInfo:async()=>{resolved++;return {}}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}))
 ports.groupPrompt={readAttachmentImageBytes:async()=>new Uint8Array(),readArtifactImageBytes:async()=>new Uint8Array(),markNoVision:()=>{throw Error('不应登记')}}
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标'} as TaskRun
 await ports.send(run,new AbortController().signal,target)
 assert.deepEqual(sent,[{sessionId:'session',requestId:'native',mode:'queue',content:[{type:'text',text:'固定目标'},{type:'text',text:runDateLine()}]}])
 assert.equal(resolved,0)
})

test('未接入群图片端口时群运行照旧只发文本，不读模型能力也不登记前置句',async()=>{
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}},sent:Array<{content:unknown[]}>=[]
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:{content:unknown[]})=>{sent.push(request);return {accepted:true}}},llm:{resolveModelInfo:async()=>{throw Error('不应读取')}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}))
 await ports.send(groupRun([png(16)]),new AbortController().signal,{...target,sessionId:'session'})
 assert.deepEqual(sent[0]!.content,[{type:'text',text:'固定目标'},{type:'text',text:runDateLine()}])
})

test('pickPromptImages 同时认附件与成果图片白名单，排除 GIF 并保持引用顺序',()=>{
 const files=[{...png(16),id:'a'},{...png(16),id:'b',mime:'image/webp'},{...png(16),kind:'artifact' as const,id:'c'},{...png(16),id:'d',mime:'image/gif'}] as RunGroupFile[]
 assert.deepEqual(pickPromptImages(files),{picked:[files[0]!,files[1]!,files[2]!],skipped:0})
 assert.deepEqual(pickPromptImages([]),{picked:[],skipped:0})
})

test('通用任务并集越过资源主体范围上限（16 条）时退回任务范围，不比改前更差',()=>{
 const general:TaskExecutionScope={...target,scope:'general'}
 const many=Array.from({length:16},(_,index)=>'scope-'+index)
 assert.deepEqual(taskKnowledgeAuthorization('owner',general,many).actor.scopeIds,['general'])
 assert.deepEqual(taskKnowledgeAuthorization('owner',general,many.slice(0,15)).actor.scopeIds,['general',...many.slice(0,15)])
})

test('运行日期行只到「日」并带本机时区名，不含时分秒',()=>{
 const line=runDateLine(new Date('2026-09-25T12:00:00Z'))
 assert.match(line,/^本次运行日期：\d{4}-\d{2}-\d{2}（时区 [A-Za-z0-9_+\-\/]+）$/)
 assert.equal(/\d{2}:\d{2}/.test(line),false)
})

test('本次运行日期作为独立 text 部件紧随固定输入，图片与剩余张数提示不受影响',async()=>{
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标',allowedTools:[]} as unknown as TaskRun
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]}},sent:Array<{content:Array<{type:string;text?:string}>}>=[]
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:{content:Array<{type:string;text?:string}>})=>{sent.push(request);return {accepted:true}}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}))
 await ports.send(run,new AbortController().signal,target)
 assert.equal(sent.length,1)
 assert.deepEqual(sent[0]!.content.map(part=>part.type),['text','text'])
 assert.equal(sent[0]!.content[0]!.text,'固定目标')
 assert.match(String(sent[0]!.content[1]!.text),/^本次运行日期：\d{4}-\d{2}-\d{2}（时区 [^）]+）$/)
 const {ports:vision,sent:visionSent,run:groupRun5}=visionHarness(['text','image'],Array.from({length:5},(_,index)=>({...png(16),id:'att-'+index,name:index+'.png'})))
 await vision.send(groupRun5,new AbortController().signal,{...target,sessionId:'session'})
 assert.deepEqual(visionSent[0]!.content.map(part=>part.type),['text','text','image','image','image','image'])
 assert.equal(visionSent[0]!.content[0]!.text,'固定目标\n\n本轮还有 1 张已授权图片未进模型。')
 assert.match(String(visionSent[0]!.content[1]!.text),/^本次运行日期：/)
})

test('发送前按本次运行的授权清单收窄该会话可见的全局工具：未授权的不再出现在工具列表',async()=>{
 const restrictions:Array<{allow?:readonly string[];deny?:readonly string[]}>=[],order:string[]=[]
 const visible=['bash','skill','write','teloa_capabilities','mcp__playwright-mcp__browser_navigate','mcp__playwright-mcp__browser_close',selfAuthorizedToolNames[0]!,'run_code']
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]},ctx:{tools:{schemas:(scope:unknown)=>{assert.equal(scope,agent);return visible.map(name=>({name}))},restrict:(filter:{allow?:readonly string[];deny?:readonly string[]})=>{restrictions.push(filter);order.push('restrict');return ()=>{}}}}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{order.push('prompt');return {accepted:true}}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'})),signal=new AbortController().signal
 const base={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标'}
 // 无任何授权：只留自授权工具，其余全部收起；run_code 是保留传输名，不能出现在过滤里。
 await ports.send({...base,allowedTools:[]} as unknown as TaskRun,signal,target)
 assert.deepEqual(restrictions,[{allow:[selfAuthorizedToolNames[0]]}])
 assert.deepEqual(order,['restrict','prompt'])
 // 有授权：只留清单内且当前可见的名字；清单里宿主没有的名字不进过滤（restrict 对未知名会抛）。
 await ports.send({...base,allowedTools:['teloa_capabilities','glob']} as unknown as TaskRun,signal,target)
 assert.deepEqual(restrictions[1],{allow:['teloa_capabilities',selfAuthorizedToolNames[0]]})
 // 授权了浏览器工具时保留 browser_close：停止后的浏览器收尾由宿主自己调用它，不在授权清单里也得可见。
 await ports.send({...base,allowedTools:['mcp__playwright-mcp__browser_navigate']} as unknown as TaskRun,signal,target)
 assert.deepEqual(restrictions[2],{allow:['mcp__playwright-mcp__browser_navigate','mcp__playwright-mcp__browser_close',selfAuthorizedToolNames[0]]})
})

test('收窄之后、交给原生之前就失败：撤掉这次收窄；已交给原生（结果未知）或成功时收窄保留',async()=>{
 const lifted:string[]=[]
 let abortOnRestrict:AbortController|undefined,promptFails=false,label=''
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]},ctx:{tools:{schemas:()=>[{name:selfAuthorizedToolNames[0]!}],restrict:()=>{const mine=label;abortOnRestrict?.abort();return ()=>{lifted.push(mine)}}}}}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{if(promptFails)throw new Error('回包丢失');return {accepted:true}}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}))
 const run={taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标',allowedTools:[]} as unknown as TaskRun
 // 收窄之后才取消：请求一定没发出去，会话不能一直带着这次运行的收窄留给别人。
 label='aborted';abortOnRestrict=new AbortController()
 await assert.rejects(ports.send(run,abortOnRestrict.signal,target),{name:'AbortError'})
 abortOnRestrict=undefined
 // prompt 抛错：原生可能已经接了这一轮（上层按「需要核对，不要重发」处理），收窄必须留着。
 label='prompt-failed';promptFails=true
 await assert.rejects(ports.send(run,new AbortController().signal,target),/回包丢失/)
 promptFails=false
 label='sent'
 await ports.send(run,new AbortController().signal,target)
 assert.deepEqual(lifted,['aborted'])
})

test('发送只解析一次执行会话：核对用的就是被收窄、被发送的那一个 agent',async()=>{
 let resolves=0,inspects=0
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[]},ctx:{tools:{schemas:()=>[],restrict:()=>()=>{}}}}
 const ctx={sessionController:{resolveAgent:async()=>{resolves+=1;return {agent}},prompt:async()=>({accepted:true})}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>{inspects+=1;return {ownerId:'owner',sessionId:'session',status:'ready'}})
 await ports.send({taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标',allowedTools:[]} as unknown as TaskRun,new AbortController().signal,target)
 assert.deepEqual({resolves,inspects},{resolves:1,inspects:1})
})
