import test from 'node:test'
import assert from 'node:assert/strict'
import {readdir,readFile} from 'node:fs/promises'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {readSessionEvents,projectSessionEvent} from '../src/session-events.ts'

const event=(seq:number):SessionEvent=>({seq,time:'2026-09-17T00:00:00.000Z',type:'turn/start',data:{}} as unknown as SessionEvent)

/** 带 seq 的会话替身：log 是它的私有事件表，snapshots 记下整表快照被读了几次。 */
function liveSession(count=0){
 const log=Array.from({length:count},(_value,index)=>event(index))
 const session={log,snapshots:0,get seq(){return log.length},snapshotEvents(){session.snapshots++;return Object.freeze([...log])}}
 return session
}

test('没有 seq 的会话（游离会话与单测替身）每次现读，不留投影',()=>{
 let reads=0
 const session={snapshotEvents:()=>{reads++;return [event(0)]}}
 assert.equal(readSessionEvents(session).length,1)
 assert.equal(readSessionEvents(session).length,1)
 assert.equal(reads,2,'无从判断投影是否落后时只能现读')
})

test('订阅式增量投影：首读一次整表快照，之后同一 seq 的重复读取不再读表',()=>{
 const session=liveSession(3)
 assert.equal(readSessionEvents(session).length,3)
 assert.equal(session.snapshots,1)
 for(let i=0;i<5;i++)assert.equal(readSessionEvents(session).length,3)
 assert.equal(session.snapshots,1,'投影命中就不该再碰一次被上游标了 @deprecated 的同步读')
})

test('订阅推进投影：落库的事件原样接上，读取仍然不碰整表快照',()=>{
 const session=liveSession(2)
 assert.equal(readSessionEvents(session).length,2)
 const appended=event(2);session.log.push(appended)
 projectSessionEvent(session,appended)
 const events=readSessionEvents(session)
 assert.equal(events.length,3)
 assert.equal(events[2],appended)
 assert.equal(session.snapshots,1,'订阅已经把这一条送到了，不需要再整表读一次')
})

test('已经交出去的快照在之后的追加里保持稳定，不被原地改写',()=>{
 const session=liveSession(1)
 const before=readSessionEvents(session)
 const appended=event(1);session.log.push(appended)
 projectSessionEvent(session,appended)
 assert.equal(readSessionEvents(session).length,2)
 assert.equal(before.length,1,'上游对 snapshotEvents 的承诺是"先前返回的快照在后续追加之后仍然稳定"，投影不能破坏它')
})

test('事件错位（漏了一条或投影缺席）丢掉投影，下一次读取整表重建且结果正确',()=>{
 const session=liveSession(1)
 assert.equal(readSessionEvents(session).length,1)
 // seq 跳号：宿主漏掉了 1，直接送来 2。
 const skipped=event(2);session.log.push(event(1),skipped)
 projectSessionEvent(session,skipped)
 const events=readSessionEvents(session)
 assert.deepEqual(events.map(row=>row.seq),[0,1,2])
 assert.equal(session.snapshots,2,'投影不可信时必须回落到一次整表快照，而不是交出漏了一条的历史')
})

test('投影缺席时收到事件不会凭空造出一段历史',()=>{
 const session=liveSession(2)
 projectSessionEvent(session,event(0))
 assert.deepEqual(readSessionEvents(session).map(row=>row.seq),[0,1])
})

test('全仓生产侧只有 session-events.ts 一处调用上游的同步会话读',async()=>{
 const dir=new URL('../src/',import.meta.url)
 const deprecated=/\.(snapshotEvents|ownEvents|eventAt)\s*\(/
 const strays:string[]=[]
 for(const name of (await readdir(dir)).filter(file=>file.endsWith('.ts')&&file!=='session-events.ts')){
  const text=await readFile(new URL(name,dir),'utf8')
  // 同步读被上游整体标了 @deprecated（"既有逻辑可以先不迁，但禁止新增调用"）：
  // 全仓收到唯一一处之后，"新增调用"这件事才在静态扫描上判得出来。
  if(text.split('\n').some(line=>!line.trimStart().startsWith('*')&&!line.trimStart().startsWith('//')&&deprecated.test(line)))strays.push(name)
 }
 assert.deepEqual(strays,[],'这些文件还在直接调用上游的同步会话读，应改走 readSessionEvents()')
})

test('宿主接线：投影挂在 session/event 上，否则每次读取都退化成整表快照',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/ctx\.on\('session\/event'/,'没有订阅就没有增量投影')
 assert.match(source,/projectSessionEvent/,'订阅里必须真的推进投影')
})
