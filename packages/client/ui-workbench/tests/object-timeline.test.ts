import assert from 'node:assert/strict'
import test from 'node:test'
import {foldTimeline,sortTimeline} from '../src/client/object-timeline.ts'
import type {TimelineEvent,TimelineEventKind} from '../src/client/object-timeline.ts'
import {focusObjectAnchor} from '../src/client/object-page-anchor.ts'
import type {AnchorNode} from '../src/client/object-page-anchor.ts'

const ev=(id:string,kind:TimelineEventKind,at:string,extra:Partial<TimelineEvent>={}):TimelineEvent=>({id,kind,at,title:id,...extra})

test('倒序且同时刻按 id 稳定',()=>{assert.deepEqual(sortTimeline([ev('b','run','2026-09-21T01:00:00Z'),ev('a','run','2026-09-21T01:00:00Z'),ev('c','change','2026-09-21T02:00:00Z')]).map(e=>e.id),['c','a','b'])})
test('相邻同 foldKey 折成一条，组数按 minFold',()=>{const runs=[1,2,3,4,5].map(n=>ev('r'+n,'run',`2026-09-21T0${n}:00:00Z`,{foldKey:'run'}));const entries=foldTimeline(runs);assert.equal(entries.length,1);assert.equal(entries[0]!.kind,'fold');if(entries[0]!.kind==='fold'){assert.equal(entries[0]!.events.length,5);assert.equal(entries[0]!.at,'2026-09-21T05:00:00Z');assert.equal(entries[0]!.eventKind,'run')}})
test('被别类事件隔开就不折，且单条不折',()=>{const entries=foldTimeline([ev('r1','run','2026-09-21T01:00:00Z',{foldKey:'run'}),ev('a','approval','2026-09-21T02:00:00Z'),ev('r2','run','2026-09-21T03:00:00Z',{foldKey:'run'})]);assert.deepEqual(entries.map(e=>e.kind),['event','event','event'])})
test('pending 事件永不折叠并打断折叠',()=>{const entries=foldTimeline([ev('r1','run','2026-09-21T01:00:00Z',{foldKey:'run'}),ev('r2','run','2026-09-21T02:00:00Z',{foldKey:'run',pending:true}),ev('r3','run','2026-09-21T03:00:00Z',{foldKey:'run'})]);assert.deepEqual(entries.map(e=>e.kind),['event','event','event'])})
test('minFold=3 时两条不折三条折',()=>{const two=[ev('a','change','2026-09-21T01:00:00Z',{foldKey:'change'}),ev('b','change','2026-09-21T02:00:00Z',{foldKey:'change'})];assert.equal(foldTimeline(two,3).length,2);assert.equal(foldTimeline([...two,ev('c','change','2026-09-21T03:00:00Z',{foldKey:'change'})],3).length,1)})
test('sortTimeline 不改原数组，foldTimeline 组内保持倒序',()=>{
 const input=[ev('a','run','2026-09-21T01:00:00Z',{foldKey:'run'}),ev('b','run','2026-09-21T02:00:00Z',{foldKey:'run'})]
 const sorted=sortTimeline(input)
 assert.deepEqual(input.map(e=>e.id),['a','b'])
 assert.deepEqual(sorted.map(e=>e.id),['b','a'])
 const [entry]=foldTimeline(input)
 assert.ok(entry&&entry.kind==='fold')
 if(entry.kind==='fold')assert.deepEqual(entry.events.map(e=>e.id),['b','a'])
})

// 手写鸭子节点：记录调用序列，不依赖 DOM。
type Fake=AnchorNode&{name:string}
const log:string[]=[]
const node=(name:string,attrs:Record<string,string>={},children:Fake[]=[]):Fake=>{
 const self:Fake={
  name,
  getAttribute:key=>attrs[key]??null,
  querySelector:selectors=>{
   const match=/^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selectors)
   const walk=(items:Fake[]):Fake|null=>{for(const item of items){if(match?(match[2]===undefined?item.getAttribute(match[1]!)!==null:item.getAttribute(match[1]!)===match[2]):item.name==='button')return item;const inner=walk((item as unknown as {children:Fake[]}).children);if(inner)return inner}return null}
   return walk(children)
  },
  scrollIntoView:options=>{log.push(name+':scroll:'+(options?.block??''))},
  focus:options=>{log.push(name+':focus:'+String(options?.preventScroll))},
  click:()=>{log.push(name+':click')},
 }
 ;(self as unknown as {children:Fake[]}).children=children
 for(const child of children)child.parentElement=self
 return self
}

test('命中锚点：先点开折叠按钮、再滚到中间、再聚焦目标',()=>{
 log.length=0
 const toggle=node('toggle',{'aria-expanded':'false'})
 const target=node('target',{'data-teloa-focus':'primary'})
 const anchor=node('anchor',{'data-teloa-anchor':'run-1'},[toggle,target])
 const root=node('root',{},[anchor])
 assert.equal(focusObjectAnchor(root,'run-1','primary'),true)
 assert.deepEqual(log,['toggle:click','anchor:scroll:center','target:focus:true'])
})
test('无目标属性时聚焦锚点内第一个 button；没有 button 就聚焦锚点本身',()=>{
 log.length=0
 const button=node('button')
 const anchor=node('anchor',{'data-teloa-anchor':'x'},[button])
 assert.equal(focusObjectAnchor(node('root',{},[anchor]),'x'),true)
 assert.deepEqual(log,['anchor:scroll:center','button:focus:true'])
 log.length=0
 const bare=node('bare',{'data-teloa-anchor':'y'})
 assert.equal(focusObjectAnchor(node('root',{},[bare]),'y'),true)
 assert.deepEqual(log,['bare:scroll:center','bare:focus:true'])
})
test('找不到锚点或 root 为空时返回 false 且不抛',()=>{
 log.length=0
 assert.equal(focusObjectAnchor(node('root'),'missing'),false)
 assert.equal(focusObjectAnchor(null,'missing'),false)
 assert.deepEqual(log,[])
})

test('锚点藏在折叠组时先展开外层组，再展开事件并聚焦',()=>{
 log.length=0
 const target=node('target',{'data-teloa-focus':'prepare'})
 const anchor=node('anchor',{'data-teloa-anchor':'run'},[node('event-toggle',{'aria-expanded':'false'}),target])
 const fold=node('fold',{'data-teloa-fold':'run'},[node('fold-toggle',{'aria-expanded':'false'}),anchor])
 assert.equal(focusObjectAnchor(node('root',{},[fold]),'run','prepare'),true)
 assert.deepEqual(log,['fold-toggle:click','event-toggle:click','anchor:scroll:center','target:focus:true'])
})

test('外层已经展开时不能把内层按钮点击两次，也不能展开另一管理面',()=>{
 log.length=0
 const target=node('target',{'data-teloa-focus':'prepare'})
 const anchor=node('anchor',{'data-teloa-anchor':'owner'},[node('owner-toggle',{'aria-expanded':'false'}),target])
 const fold=node('fold',{'data-teloa-fold':'task-detail'},[node('fold-toggle',{'aria-expanded':'true'}),anchor])
 assert.equal(focusObjectAnchor(node('root',{},[fold]),'owner','prepare'),true)
 assert.deepEqual(log,['owner-toggle:click','anchor:scroll:center','target:focus:true'])
 log.length=0
 const approval=node('approval',{'data-teloa-anchor':'approval'},[node('button')])
 const open=node('fold',{'data-teloa-fold':'task-detail'},[node('fold-toggle',{'aria-expanded':'true'}),anchor,approval])
 assert.equal(focusObjectAnchor(node('root',{},[open]),'approval'),true)
 assert.deepEqual(log,['approval:scroll:center','button:focus:true'])
})
