import type {Context} from '@deepseek-ai/cordis'
import type {PreToolDecision} from '@deepseek-ai/dsh-tools'
import {resolveSessionLineage,type LineageSession} from './subagent-lineage.ts'

/** 两句固定中文理由：不含会话 id、工具名、工具参数、数据库文本或上游异常消息。 */
export const groupRoutingDenyReason='路由判断不能调用任何工具。'
export const groupRoutingLineageReason='无法核对当前会话的子 Agent 谱系。'

/** 本进程里已经装过路由闸的 Context；`assertRoutingGuardRegisteredFirst` 只认这张表。 */
const guarded=new WeakSet<object>()

/**
 * 路由会话一律不许调工具：它只做归属判断，不做任何动作。
 *
 * `index.ts` 上网闸那条「普通会话没有 Run 作用域，放行且不记录」是按 Run 判的，而路由会话没有 Run，
 * 于是它在 `registerTaskToolGuard` 眼里就是一条普通会话、工具是放行的。这道闸补的就是这个洞。
 *
 * 注册顺序放在 `registerTaskToolGuard` 之前：`tools/pre-execute` 是链式的，先注册的先判。
 * **顺序影响的是「拿到哪一句固定理由」与「任务闸的策略读口要不要白查一次库」，不影响是否被拒**——
 * 任务闸对路由会话给的是普通会话那条路，最终仍会走到本闸；两道闸都拒，只是文案与记账先后不同。
 * 装配处用 `assertRoutingGuardRegisteredFirst` 钉住「本闸确实装上了」。
 *
 * 判定按**谱系根会话**取，逐字照 `group-attach-tool.ts:62` 的既有写法：子 Agent 自己不持有 Run，
 * 谱系根若是路由会话，子 Agent 的调用同样拒；谱系断链一律拒（同族先例 `role-memory.ts:53`），
 * 判不出来就拒，不静默放行。
 */
export function registerGroupRoutingGuard(ctx:Context,isRouting:(sessionId:string)=>boolean):void{
 guarded.add(ctx)
 ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  // 没有 agent 的调用取不到会话身份，也不可能来自路由会话：交给链上其余的闸照常判。
  if(!exec.agent)return next()
  let root:LineageSession
  try{root=resolveSessionLineage(ctx,exec.agent.session).root}
  catch{return {kind:'deny',reason:groupRoutingLineageReason}}
  if(isRouting(root.id))return {kind:'deny',reason:groupRoutingDenyReason}
  return next()
 })
}

/**
 * 装配期断言：本 Context 上必须已经装过路由闸。
 * 在 `registerTaskToolGuard` 之后调用一次，少装或被挪走时装配直接失败，而不是等到有人在路由会话里
 * 调出一次工具才发现。**顺序本身由调用点保证**（本函数看不见别的闸的注册时刻），它钉住的是「装了」。
 */
export function assertRoutingGuardRegisteredFirst(ctx:Context):void{
 if(!guarded.has(ctx))throw Error('路由会话工具全拒闸必须先于任务工具闸注册。')
}
