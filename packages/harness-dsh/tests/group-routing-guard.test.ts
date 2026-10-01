import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import {groupRoutingSessionId} from '@teloa/contract'
import {assertRoutingGuardRegisteredFirst,groupRoutingDenyReason,groupRoutingLineageReason,registerGroupRoutingGuard} from '../src/group-routing-guard.ts'
import {isRoutingSession} from '../src/group-routing.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

type Session={id:string;header:{origin?:string;parentSession?:string;delegationDepth?:number}}
type Decision={kind:string;reason?:string}
type PreHandler=(exec:{name:string;agent?:{session:Session};signal:AbortSignal;arguments?:Record<string,unknown>},next:()=>Promise<Decision>)=>Promise<Decision>

const owner='11111111-1111-4111-8111-111111111111'
const groupId='22222222-2222-4222-8222-222222222222'
/** 真实派生出来的路由会话 id：闸按它的**结构**判，不按任何登记表判。 */
const routingId=groupRoutingSessionId(owner,groupId,'2026-09-21')
const routing:Session={id:routingId,header:{}}
const child:Session={id:'sub-1',header:{origin:'subagent',parentSession:routingId,delegationDepth:1}}
const orphan:Session={id:'broken',header:{origin:'subagent',parentSession:'missing'}}
const ordinary:Session={id:'task-run-abc',header:{}}

function harness(){
 const pre:PreHandler[]=[]
 const known=new Map<string,Session>([[routing.id,routing],[ordinary.id,ordinary]])
 const ctx={
  tools:{guard:()=>()=>{}},
  agents:{get:(id:unknown)=>{const found=known.get(String(id));return found?{session:found}:undefined}},
  on:(event:string,handler:unknown)=>{if(event==='tools/pre-execute')pre.push(handler as PreHandler);return ()=>{}},
 } as unknown as Context
 // 按注册顺序把整条 tools/pre-execute 链跑一遍：先注册的先判，next() 才轮到后一道闸。
 const preExecute=async(input:{name:string;agent?:{session:Session};arguments?:Record<string,unknown>}):Promise<Decision&{reached:boolean}>=>{
  let reached=false
  const exec={...input,signal:new AbortController().signal}
  const run=async(index:number):Promise<Decision>=>{
   const handler=pre[index]
   if(!handler){reached=true;return {kind:'allow'}}
   return handler(exec,()=>run(index+1))
  }
  const decision=await run(0)
  return {...decision,reached}
 }
 return {ctx,preExecute}
}

const readPolicy=async()=>null

test('路由会话身份是结构化的：派生出来的 id 恒判真，别的形状一律判假',()=>{
 assert.equal(isRoutingSession(routingId),true)
 assert.equal(isRoutingSession(groupRoutingSessionId(owner,groupId,'2026-09-22')),true)
 for(const other of ['task-run-abc','group-routing-abc','group-routing-','',routingId.slice(0,-1),routingId+'x','GROUP-ROUTING-'+routingId.slice(14)])assert.equal(isRoutingSession(other),false)
})

test('路由会话里任何工具都被拒，理由逐字固定',async()=>{
 const {ctx,preExecute}=harness()
 registerGroupRoutingGuard(ctx,isRoutingSession)
 for(const name of ['reference_read','web_fetch','subagent_task','teloa_group_attach','bash']){
  const decision=await preExecute({name,agent:{session:routing}})
  assert.equal(decision.kind,'deny')
  assert.equal(decision.reason,groupRoutingDenyReason)
  assert.equal(decision.reason,'路由判断不能调用任何工具。')
  assert.equal(decision.reached,false)
 }
})

test('子 Agent 会话的谱系根是路由会话时同样被拒（H1）',async()=>{
 const {ctx,preExecute}=harness()
 registerGroupRoutingGuard(ctx,isRoutingSession)
 const decision=await preExecute({name:'bash',agent:{session:child}})
 assert.equal(decision.kind,'deny')
 assert.equal(decision.reason,'路由判断不能调用任何工具。')
 assert.equal(decision.reached,false)
})

test('谱系断链一律拒，用另一条固定理由',async()=>{
 const {ctx,preExecute}=harness()
 registerGroupRoutingGuard(ctx,isRoutingSession)
 const decision=await preExecute({name:'bash',agent:{session:orphan}})
 assert.equal(decision.kind,'deny')
 assert.equal(decision.reason,groupRoutingLineageReason)
 assert.equal(decision.reason,'无法核对当前会话的子 Agent 谱系。')
 assert.equal(decision.reached,false)
})

test('理由里不含会话 id、工具名、参数或上游异常文本',async()=>{
 const {ctx,preExecute}=harness()
 registerGroupRoutingGuard(ctx,isRoutingSession)
 const decision=await preExecute({name:'bash',agent:{session:routing},arguments:{command:'rm -rf /'}})
 for(const leak of [routingId,'group-routing','bash','rm','sub-1','missing'])assert.equal(decision.reason!.includes(leak),false)
 const broken=await preExecute({name:'bash',agent:{session:orphan}})
 for(const leak of ['broken','missing','bash','lineage'])assert.equal(broken.reason!.includes(leak),false)
})

test('非路由会话不受影响，继续走 next()',async()=>{
 const {ctx,preExecute}=harness()
 registerGroupRoutingGuard(ctx,isRoutingSession)
 const decision=await preExecute({name:'bash',agent:{session:ordinary}})
 assert.notEqual(decision.kind,'deny')
 assert.equal(decision.reached,true)
})

test('没有 agent 的调用交给链上其余的闸，不被路由闸拦下',async()=>{
 const {ctx,preExecute}=harness()
 registerGroupRoutingGuard(ctx,isRoutingSession)
 const decision=await preExecute({name:'bash'})
 assert.notEqual(decision.kind,'deny')
 assert.equal(decision.reached,true)
})

test('装配期断言：路由守卫必须先于任务工具守卫注册（H1）',()=>{
 const ordered=harness()
 assert.doesNotThrow(()=>{
  registerGroupRoutingGuard(ordered.ctx,isRoutingSession)
  registerTaskToolGuard(ordered.ctx,readPolicy,[])
  assertRoutingGuardRegisteredFirst(ordered.ctx)
 })
 const missing=harness()
 assert.throws(()=>{
  registerTaskToolGuard(missing.ctx,readPolicy,[])
  assertRoutingGuardRegisteredFirst(missing.ctx)
 },/路由/)
})

test('注册顺序正确时路由闸先于任务闸拿到判定权',async()=>{
 const {ctx,preExecute}=harness()
 registerGroupRoutingGuard(ctx,isRoutingSession)
 let asked=0
 registerTaskToolGuard(ctx,async()=>{asked++;return null},[])
 const decision=await preExecute({name:'bash',agent:{session:routing}})
 assert.equal(decision.reason,'路由判断不能调用任何工具。')
 // 路由闸不放行，任务闸的策略读口一次都没被问到。
 assert.equal(asked,0)
})

test('生产装配顺序下，谱系断链拿到的是路由闸那句固定文案，不是任务闸那句',async()=>{
 const {ctx,preExecute}=harness()
 // 与 index.ts 的装配顺序逐字一致：路由闸先、任务闸后。
 registerGroupRoutingGuard(ctx,isRoutingSession)
 let asked=0
 registerTaskToolGuard(ctx,async()=>{asked++;return null},[])
 const decision=await preExecute({name:'bash',agent:{session:orphan}})
 assert.equal(decision.kind,'deny')
 assert.equal(decision.reason,'无法核对当前会话的子 Agent 谱系。')
 assert.notEqual(decision.reason,'无法核对任务执行权限，请先恢复授权服务。')
 assert.equal(decision.reached,false)
 assert.equal(asked,0)
})

test('判定不依赖任何在途状态：没人在问、问完很久之后，闸照样拒（C1 反例）',async()=>{
 const {ctx,preExecute}=harness()
 registerGroupRoutingGuard(ctx,isRoutingSession)
 // 本进程从未为这条会话发起过任何一次路由——超时、取消、宿主重启后的情形同此。
 for(let round=0;round<3;round++){
  const decision=await preExecute({name:'bash',agent:{session:routing}})
  assert.equal(decision.kind,'deny')
  assert.equal(decision.reason,'路由判断不能调用任何工具。')
 }
 assert.equal(isRoutingSession(routingId),true)
})
