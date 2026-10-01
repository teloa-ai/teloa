import type {SessionEvent} from '@deepseek-ai/dsh-session'

/**
 * 原生会话事件的唯一读口（规格 §八 G5）。
 *
 * 上游在 `0.1.6-alpha.1` 把三个同步读（`snapshotEvents` / `ownEvents` / `eventAt`）整体标了
 * `@deprecated`：「既有逻辑可以先不迁，但禁止新增调用」。生产侧原来有 8 个文件 12 处直接
 * 调用，"禁止新增"在静态扫描上判不出来；全部收进本模块之后判得出来（用例
 * `session-events.test.ts` 的全仓扫描），将来换成上游的订阅式读口也只改这一处。
 *
 * 读取模型从"每次整表快照"改成订阅式增量投影：
 * - `projectSessionEvent()` 由宿主挂在 `session/event`（落库后的 fire-and-forget 追加流）上，
 *   把刚接受的事件原样接到投影尾部；
 * - `readSessionEvents()` 正常路径直接交出投影，不碰同步读；只有投影缺席或与 `session.seq`
 *   对不上（宿主漏收、会话是别处造的）才回落到一次整表快照。
 *
 * 投影按会话对象挂在 `WeakMap` 上：会话被回收即一起回收，不需要会话 id，也不需要
 * `session/disposed` 钩子去手工清理。
 */
type ReadableSession={seq?:number;snapshotEvents:()=>readonly SessionEvent[]}

/** `events` 是已经交出去过的稳定快照，`appended` 是订阅收到还没并进去的尾巴。 */
type Projection={events:readonly SessionEvent[];appended:SessionEvent[]}
const projections=new WeakMap<object,Projection>()

export function readSessionEvents(session:ReadableSession):readonly SessionEvent[]{
 // 没有 seq 的（`Session.create` 造的游离会话、单测替身）无从判断投影是否落后，一律现读。
 if(typeof session.seq!=='number')return session.snapshotEvents()
 const projected=projections.get(session)
 if(!projected||projected.events.length+projected.appended.length!==session.seq){
  const events=[...session.snapshotEvents()]
  projections.set(session,{events,appended:[]})
  return events
 }
 if(projected.appended.length===0)return projected.events
 // 并尾巴时新建数组而不是原地 push：上游对快照的承诺是"先前返回的快照在后续追加之后
 // 仍然稳定"，读口换了实现也得守住，否则拿着上一份快照的调用方会看见历史自己变长。
 const events=projected.events.concat(projected.appended)
 projections.set(session,{events,appended:[]})
 return events
}

/** 宿主在 `session/event` 上调用；只接得上的那一条才推进，错位就丢投影等下一次读取重建。 */
export function projectSessionEvent(session:ReadableSession,event:SessionEvent):void{
 const projected=projections.get(session)
 if(!projected)return
 if(projected.events.length+projected.appended.length===event.seq)projected.appended.push(event)
 else projections.delete(session)
}
