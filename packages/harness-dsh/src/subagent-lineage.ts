import {SessionId} from '@deepseek-ai/dsh-session'

/** 子 Agent 谱系上溯的唯一实现。三处判据（岗位授权、岗位记忆、Run Skill 作用域）必须看见同一条链。 */
export type LineageSession={id:string;header:{origin?:string;parentSession?:string;delegationDepth?:number}}
export type LineageResult<Session extends LineageSession=LineageSession>={
 /** 非子 Agent 的根会话——策略、岗位记忆、Run Skill 一律按它判。 */
 root:Session
 /** 从调用方到根，自近到远的祖先 id（调用方自身不在内）。根会话时为空。 */
 ancestors:readonly string[]
 /** 调用方自身的委派深度：`header.delegationDepth ?? 0`，取不到按 0（上游承诺持久 header 是单调下限）。 */
 depth:number
}
/**
 * 上溯到非子 Agent 会话。失败一律抛（`parentSession` 缺失、层数 > 32、`ctx.agents.get` 取不到即父级离线），
 * 调用方必须把抛错转成 fail-closed 的拒绝，不得默认按"根会话"处理——那等于让离线父级的子级自动升权。
 */
export function resolveSessionLineage<Session extends LineageSession>(ctx:{agents:{get:(id:SessionId)=>{session:Session}|undefined}},session:Session):LineageResult<Session>{
 // 环上限与三种失败判据逐字沿用 task-tool-guard 原有循环：这里只是把它挪成三处共用的唯一实现。
 // 计数器与 LineageResult.depth 是两回事——前者只防环和病态深链，后者是上游持久 header 的声明值。
 const ancestors:string[]=[]
 let root=session,hops=0
 while(root.header.origin==='subagent'){
  const parentId=root.header.parentSession
  if(parentId===undefined||++hops>32)throw Error('invalid subagent lineage')
  const parent=ctx.agents.get(SessionId(parentId))
  if(parent===undefined)throw Error('subagent parent unavailable')
  root=parent.session
  ancestors.push(root.id)
 }
 return {root,ancestors,depth:session.header.delegationDepth??0}
}
