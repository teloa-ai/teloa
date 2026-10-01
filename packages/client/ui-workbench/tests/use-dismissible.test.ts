import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'

/**
 * `use-dismissible.ts` 只依赖 `document.addEventListener`/`removeEventListener` 与全局 `Node`（给
 * `event.target instanceof Node` 判断用）；Node.js 测试进程本身没有 DOM，这里搭一套最小假体：
 * 一个能记录/派发监听器的假 `document`，和一个可 `instanceof` 的假 `Node` 类。
 * React 部分同样是最小假体：`useRef` 照原值建一个盒子，`useEffect` 只记下待执行的 effect，
 * 由测试自己按需 `flush()`，与仓库里其余 hook 测试同一手法（真实执行 effect 清理，不寄望真实调度器）。
 */
function load(){
 const source=readFileSync(new URL('../src/client/use-dismissible.ts',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const pending:Array<()=>(void|(()=>void))>=[]
 const React={
  useRef:(initial:unknown)=>({current:initial}),
  useEffect:(run:()=>void|(()=>void))=>{pending.push(run)},
 }
 const exports:Record<string,any>={}
 const require=(id:string)=>{if(id==='react')return React;throw Error('未声明的依赖：'+id)}
 new Function('require','exports','React',js)(require,exports,React)
 const flush=()=>{const cleanups=pending.map(run=>run());pending.length=0;return cleanups.filter((value):value is ()=>void=>typeof value==='function')}
 return {useDismissible:exports.useDismissible as (ref:{current:unknown},open:boolean,close:()=>void,guard?:(source:'outside'|'escape')=>boolean,outsideEvent?:'pointerdown'|'click')=>void,flush}
}

class FakeNode{}

function fakeDocument(){
 const listeners=new Map<string,Set<(event:unknown)=>void>>()
 return {
  addEventListener:(type:string,handler:(event:unknown)=>void)=>{
   if(!listeners.has(type))listeners.set(type,new Set())
   listeners.get(type)!.add(handler)
  },
  removeEventListener:(type:string,handler:(event:unknown)=>void)=>{listeners.get(type)?.delete(handler)},
  dispatch:(type:string,event:unknown)=>{for(const handler of [...listeners.get(type)??[]])handler(event)},
  listenerCount:(type:string)=>listeners.get(type)?.size??0,
 }
}

/** 每个用例独立替身全局 document/Node，跑完照旧还原，不泄漏进其它测试文件。 */
function withFakeDom(run:(doc:ReturnType<typeof fakeDocument>)=>void){
 const previousDocument=(globalThis as {document?:unknown}).document
 const previousNode=(globalThis as {Node?:unknown}).Node
 const doc=fakeDocument()
 ;(globalThis as {document?:unknown}).document=doc
 ;(globalThis as {Node?:unknown}).Node=FakeNode
 try{run(doc)}finally{
  ;(globalThis as {document?:unknown}).document=previousDocument
  ;(globalThis as {Node?:unknown}).Node=previousNode
 }
}

test('open 为真时，点在 ref 外面触发 close；点在 ref 内不触发',()=>{
 withFakeDom(doc=>{
  const {useDismissible,flush}=load()
  const inside=new FakeNode(),outside=new FakeNode()
  const ref={current:{contains:(node:unknown)=>node===inside}}
  let closed=0
  useDismissible(ref,true,()=>{closed++})
  flush()
  doc.dispatch('pointerdown',{target:inside})
  assert.equal(closed,0,'点在 ref 内不应关闭')
  doc.dispatch('pointerdown',{target:outside})
  assert.equal(closed,1,'点在 ref 外应关闭一次')
 })
})

test('open 为真时，Escape 触发 close',()=>{
 withFakeDom(doc=>{
  const {useDismissible,flush}=load()
  const ref={current:{contains:()=>false}}
  let closed=0
  useDismissible(ref,true,()=>{closed++})
  flush()
  doc.dispatch('keydown',{key:'Enter'})
  assert.equal(closed,0,'非 Escape 不关闭')
  doc.dispatch('keydown',{key:'Escape'})
  assert.equal(closed,1)
 })
})

test('open 为假时不监听任何事件',()=>{
 withFakeDom(doc=>{
  const {useDismissible,flush}=load()
  const ref={current:{contains:()=>false}}
  let closed=0
  useDismissible(ref,false,()=>{closed++})
  flush()
  assert.equal(doc.listenerCount('pointerdown'),0)
  assert.equal(doc.listenerCount('keydown'),0)
 })
})

test('guard 可以单独放行 escape 但拦住 outside（一句话描述有未提交内容时不因点外面丢字）',()=>{
 withFakeDom(doc=>{
  const {useDismissible,flush}=load()
  const outside=new FakeNode()
  const ref={current:{contains:()=>false}}
  let closed=0,hasContent=true
  useDismissible(ref,true,()=>{closed++},source=>source==='escape'||!hasContent)
  flush()
  doc.dispatch('pointerdown',{target:outside})
  assert.equal(closed,0,'有未提交内容时点外面不应关闭')
  doc.dispatch('keydown',{key:'Escape'})
  assert.equal(closed,1,'Escape 应始终放行')
  hasContent=false
  doc.dispatch('pointerdown',{target:outside})
  assert.equal(closed,2,'内容清空后点外面照旧能关闭')
 })
})

test('卸载（effect 清理）之后不再响应事件',()=>{
 withFakeDom(doc=>{
  const {useDismissible,flush}=load()
  const outside=new FakeNode()
  const ref={current:{contains:()=>false}}
  let closed=0
  useDismissible(ref,true,()=>{closed++})
  const cleanups=flush()
  assert.equal(cleanups.length,1)
  cleanups[0]!()
  doc.dispatch('pointerdown',{target:outside})
  doc.dispatch('keydown',{key:'Escape'})
  assert.equal(closed,0)
  assert.equal(doc.listenerCount('pointerdown'),0)
  assert.equal(doc.listenerCount('keydown'),0)
 })
})

// 文档流面板在完整点击后关闭：按下时保持目标位置，点击后才收起。
test('click 模式不在 pointerdown 收起，并清理对应监听器',()=>{
 withFakeDom(doc=>{
  const {useDismissible,flush}=load(),outside=new FakeNode();let closed=0
  useDismissible({current:{contains:()=>false}},true,()=>{closed++},undefined,'click')
  const cleanups=flush();doc.dispatch('pointerdown',{target:outside});assert.equal(closed,0)
  doc.dispatch('click',{target:outside});assert.equal(closed,1)
  cleanups.forEach(cleanup=>cleanup());doc.dispatch('click',{target:outside});assert.equal(closed,1)
 })
})
