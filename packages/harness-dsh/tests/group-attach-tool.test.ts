import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import type {Context} from '@deepseek-ai/cordis'
import {groupAttachToolName,registerGroupAttachTool,type GroupAttachRunContext} from '../src/group-attach-tool.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {roleMemoryProposalToolName} from '../src/role-memory.ts'
import {roleDailyDigestToolNames} from '../src/role-daily-log.ts'

type Tool={name:string;execute:(args:unknown,exec:unknown)=>Promise<unknown>}
type PreHandler=(exec:{name:string;agent?:{session:unknown};signal:AbortSignal;callId?:unknown},next:()=>Promise<{kind:string}>)=>Promise<{kind:string;reason?:string}>

// 事件流只为 task-tool-guard 的「本轮是获准执行的原生轮次」那条判据准备；本工具自己的闸不读它。
const session={id:'run-session',header:{},snapshotEvents:()=>[
 {seq:0,time:0,type:'turn/start',data:{turn:0}},
 {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},
]}
const requestId='22222222-2222-4222-8222-222222222222'
const path='out/report.md'
const sha=(value:string)=>value.repeat(64).slice(0,64)

function harness(context:(sessionId:string)=>Promise<GroupAttachRunContext|undefined>){
 const tools:Tool[]=[],pre:PreHandler[]=[],disposed:((value:{id:string})=>void)[]=[]
 const ctx={
  agents:{get:()=>undefined},
  tools:{register:(tool:Tool)=>{tools.push(tool)}},
  on:(event:string,handler:unknown)=>{
   if(event==='tools/pre-execute')pre.push(handler as PreHandler)
   if(event==='session/disposed')disposed.push(handler as (value:{id:string})=>void)
   return ()=>{}
  },
 } as unknown as Context
 const registry=registerGroupAttachTool(ctx,{context:async id=>context(id)})
 const tool=tools.find(item=>item.name===groupAttachToolName)!
 const gate=async(name:string,agent:boolean,signal=new AbortController().signal)=>{
  let reached=false
  const decision=await pre[0]!({name,...(agent?{agent:{session}}:{}),signal},async()=>{reached=true;return {kind:'allow'}})
  return {decision,reached}
 }
 return {ctx,tool,gate,registry,dispose:(id:string)=>disposed.forEach(handler=>handler({id}))}
}

const exec={agent:{session},signal:new AbortController().signal,callId:'call-1'}
const inGroup=async():Promise<GroupAttachRunContext>=>({canPost:true,nativeRequestId:requestId})

test('没有群执行上下文的运行里工具不可用，闸给固定中文理由且不含会话身份',async()=>{
 const {tool,gate}=harness(async()=>undefined)
 const {decision,reached}=await gate(groupAttachToolName,true)
 assert.equal(decision.kind,'deny')
 assert.equal(reached,false)
 assert.equal(decision.reason,'这个工具只能在群任务的运行里使用。')
 assert.equal(decision.reason!.includes('run-session'),false)
 await assert.rejects(tool.execute({path,sha256:sha('a')},exec),{code:'teloa/forbidden'})
})

test('canPost 为假的运行里工具不可用，理由与「不在群里」可分辨',async()=>{
 const {tool,gate}=harness(async()=>({canPost:false,nativeRequestId:requestId}))
 const {decision}=await gate(groupAttachToolName,true)
 assert.equal(decision.kind,'deny')
 assert.equal(decision.reason,'本员工没有当前群内发言授权，不能把文件贴回群。')
 await assert.rejects(tool.execute({path,sha256:sha('a')},exec),{code:'teloa/forbidden'})
})

test('读不出授权时按拒绝办，理由与确定性否定分开，且不透传上游文本',async()=>{
 const {gate}=harness(async()=>{throw new Error('数据库连接 db://secret 失败')})
 const {decision,reached}=await gate(groupAttachToolName,true)
 assert.equal(decision.kind,'deny')
 assert.equal(reached,false)
 assert.equal(decision.reason,'无法核对当前运行的群内发言授权。')
 assert.equal(/secret|db:\/\//.test(decision.reason!),false)
})

test('本闸只管自己这个工具，其它工具原样交给后面的闸',async()=>{
 const {gate}=harness(async()=>undefined)
 const {decision,reached}=await gate('read',true)
 assert.equal(decision.kind,'allow')
 assert.equal(reached,true)
})

test('一次运行最多登记 8 条，第 9 条整次拒绝且不改动已登记的 8 条',async()=>{
 const {tool,registry}=harness(inGroup)
 for(let index=0;index<8;index++)await tool.execute({path:`out/${index}.md`,sha256:sha(String(index%10))},exec)
 assert.equal(registry.claims('run-session',requestId).length,8)
 await assert.rejects(tool.execute({path:'out/9.md',sha256:sha('b')},exec),{code:'teloa/conflict'})
 assert.equal(registry.claims('run-session',requestId).length,8)
})

test('同一 {path,sha256} 重复登记去重，不占额度也不重复入表',async()=>{
 const {tool,registry}=harness(inGroup)
 await tool.execute({path,sha256:sha('a')},exec)
 await tool.execute({path,sha256:sha('a')},exec)
 assert.deepEqual(registry.claims('run-session',requestId),[{path,sha256:sha('a')}])
 await tool.execute({path,sha256:sha('c')},exec)
 assert.equal(registry.claims('run-session',requestId).length,2)
})

test('参数内容不对一律 teloa/invalid-input，登记表不受影响',async()=>{
 const {tool,registry}=harness(inGroup)
 for(const args of [{path,sha256:'ABC'},{path,sha256:sha('A')},{path,sha256:sha('a'),source:'artifact'},{path:'../外部.md',sha256:sha('a')},{path:'.runtime/x.md',sha256:sha('a')},{path:'out/',sha256:sha('a')},{path:'/abs.md',sha256:sha('a')},{path:'file:///etc/passwd',sha256:sha('a')}]){
  await assert.rejects(tool.execute(args,exec),{code:'teloa/invalid-input'})
 }
 assert.equal(registry.claims('run-session',requestId).length,0)
})

test('缺必填参数由 DSH 的参数闸先拒，工具体不执行，登记表不受影响',async()=>{
 const {tool,registry}=harness(inGroup)
 for(const args of [{path},{sha256:sha('a')},{}])await assert.rejects(tool.execute(args,exec),{code:'INVALID_ARGS'})
 assert.equal(registry.claims('run-session',requestId).length,0)
})

test('模型不能声明来源或成果身份：参数表只有 path 与 sha256 两个键',()=>{
 const {tool}=harness(inGroup)
 const schema=(tool as unknown as {parameters:{properties:Record<string,unknown>;required:string[]}}).parameters
 assert.deepEqual(Object.keys(schema.properties),['path','sha256'])
 assert.deepEqual(schema.required,['path','sha256'])
})

test('登记表按 (sessionId, nativeRequestId) 归集，清空后不跨轮次残留',async()=>{
 const {tool,registry,dispose}=harness(inGroup)
 await tool.execute({path,sha256:sha('a')},exec)
 assert.equal(registry.claims('run-session','33333333-3333-4333-8333-333333333333').length,0)
 registry.clear('run-session',requestId)
 assert.deepEqual(registry.claims('run-session',requestId),[])
 await tool.execute({path,sha256:sha('a')},exec)
 dispose('run-session')
 assert.deepEqual(registry.claims('run-session',requestId),[])
})

test('无视觉登记只落在本次运行身份上，取用后仍随清空一起消失',async()=>{
 const {registry}=harness(inGroup)
 assert.equal(registry.noVision('run-session',requestId),false)
 registry.markNoVision('run-session',requestId)
 assert.equal(registry.noVision('run-session',requestId),true)
 assert.equal(registry.noVision('run-session','33333333-3333-4333-8333-333333333333'),false)
 registry.clear('run-session',requestId)
 assert.equal(registry.noVision('run-session',requestId),false)
})

test('teloa_group_attach 进自授权集时过得了三条装配期断言，且自授权分支仍要求可核验的运行身份',async()=>{
 const selfAuthorized=[roleMemoryProposalToolName,...roleDailyDigestToolNames,groupAttachToolName]
 assert.deepEqual(selfAuthorized,['teloa_role_memory_propose','teloa_role_day_evidence','teloa_role_daily_digest_submit','teloa_group_attach'])
 // 它不是 MCP 资源工具／编排类／委派工具／外发通道，因此 task-tool-guard.ts:24-29 三条断言都不抛。
 const handlers:Array<(exec:unknown,next:()=>Promise<{kind:string}>)=>Promise<{kind:string;reason?:string}>>=[]
 const guardCtx={tools:{guard:()=>()=>{}},agents:{get:()=>undefined},on:(event:string,handler:unknown)=>{if(event==='tools/pre-execute')handlers.push(handler as typeof handlers[number]);return ()=>{}}} as unknown as Context
 let policy:{allowedTools:string[];nativeRequestId?:string}|null={allowedTools:[],nativeRequestId:'native'}
 registerTaskToolGuard(guardCtx,async()=>policy,selfAuthorized)
 assert.equal(handlers.length,1)
 const guard=handlers[0]!,exec2={name:groupAttachToolName,agent:{session},signal:new AbortController().signal,arguments:{}}
 // allowedTools 为空也照放行：自授权分支在岗位授权闸之前返回，交给本工具自己的 canPost 闸。
 assert.deepEqual(await guard(exec2,async()=>({kind:'allow'})),{kind:'allow'})
 // 但自授权分支要求 policy.nativeRequestId 在：普通会话与没有可核验运行的会话一律拒。
 policy={allowedTools:[]}
 assert.equal((await guard(exec2,async()=>({kind:'allow'}))).kind,'deny')
 policy=null
 assert.equal((await guard(exec2,async()=>({kind:'allow'}))).kind,'deny')
})

test('canPost 为真的群运行里放行并登记意图，声明的是 {path,sha256} 两个键',async()=>{
 const {tool,gate,registry}=harness(inGroup)
 const {decision,reached}=await gate(groupAttachToolName,true)
 assert.equal(decision.kind,'allow')
 assert.equal(reached,true)
 assert.equal(await tool.execute({path,sha256:sha('a')},exec),JSON.stringify({declared:1,duplicate:false}))
 assert.deepEqual(registry.claims('run-session',requestId),[{path,sha256:sha('a')}])
})

// 装配面只能按源码守卫：`apply()` 在本包的桩宿主上跑不完（先例 tests/group-attachments.test.ts:7）。
const wiring=await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),selfAuthorizedSource=await readFile(new URL('../src/self-authorized-tools.ts',import.meta.url),'utf8')

test('装配：自授权集在既有两族之后追加本工具，顺序与既有两项不变',()=>{
 // 自授权集已抽成常量模块（会话内安装一期 功能验证）；尾部允许再追加别的自授权工具（本工具之后已有 teloa_group_react），但既有两族与本工具的相对次序不许动。
 assert.equal(selfAuthorizedSource.includes('[roleMemoryProposalToolName,...roleDailyDigestToolNames,groupAttachToolName'),true)
 assert.equal(wiring.includes('[...selfAuthorizedToolNames],async(sessionId,signal)=>{'),true)
 // 工具名只以常量进入装配，不写字面量：另起一份清单绕过登记闸会红。
 assert.equal(wiring.includes(`'${groupAttachToolName}'`),false);assert.equal(selfAuthorizedSource.includes(`'${groupAttachToolName}'`),false)
 assert.equal(wiring.includes('registerGroupAttachTool(ctx,{context:'),true)
})

test('装配：运行上下文的 groupContext 端口绑上附件字节端口（T7 评审 HIGH）',()=>{
 assert.equal(wiring.includes('groupContext:(db,actor,task,role)=>readRunGroupContext(db,actor,task,role,runGroupFilePorts)'),true)
 // 后端策略类型与其余五处四参调用不动：全仓只有这一处传第五参。
 assert.equal(wiring.includes('groupContext:readRunGroupContext'),false)
 assert.equal(wiring.includes('const runGroupFilePorts:RunGroupFilePorts={readAttachmentBytes:'),true)
})

test('装配：发布器同时拿到声明文件、无视觉登记与两个端口，定版服务按四参构造',()=>{
 for(const anchor of [
  'run:(sessionId,nativeRequestId)=>({files:groupAttachClaims.claims(sessionId,nativeRequestId),noVision:groupAttachClaims.noVision(sessionId,nativeRequestId)})',
  'clear:(sessionId,nativeRequestId)=>groupAttachClaims.clear(sessionId,nativeRequestId)',
  ',artifacts,runGroupFilePorts).post(owner,redactRunMessage(input,safeKnown))',
  "readArtifactFile('artifacts/files/read',{sessionId,path:claim.path},signal)",
  'runPorts.groupPrompt={',
 ])assert.equal(wiring.includes(anchor),true,anchor)
})
