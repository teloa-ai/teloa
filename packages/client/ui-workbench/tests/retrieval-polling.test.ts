import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

// 执行真实 hook 函数/effect，以确定性 hook 存储、文档事件和时钟代替 DOM；没有浏览器或监听。
const source=await readFile(new URL('../src/client/use-retrieval-snapshot.ts',import.meta.url),'utf8')
function fixture(initialVisibility='visible'){
 const slots:unknown[]=[],effects:{deps:unknown[];cleanup?:()=>void}[]=[]
 let cursor=0,effectCursor=0
 const pending:(()=>void)[]=[],listeners=new Set<()=>void>(),timers=new Map<number,()=>void>()
 let serial=0
 const document={visibilityState:initialVisibility,addEventListener:(_name:string,fn:()=>void)=>listeners.add(fn),removeEventListener:(_name:string,fn:()=>void)=>listeners.delete(fn)}
 const hooks={
  useRef:(value:unknown)=>{const i=cursor++;return slots[i]??(slots[i]={current:value})},
  useState:(value:unknown)=>{const i=cursor++;if(!(i in slots))slots[i]=value;return [slots[i],(next:unknown)=>{slots[i]=typeof next==='function'?next(slots[i]):next}]},
  useEffect:(run:()=>void|(()=>void),deps:unknown[])=>{const i=effectCursor++,prev=effects[i];if(prev&&prev.deps.length===deps.length&&prev.deps.every((v,n)=>v===deps[n]))return;pending.push(()=>{prev?.cleanup?.();const cleanup=run();effects[i]={deps,...(cleanup?{cleanup}:{})}})},
 }
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const module={exports:{} as {useRetrievalSnapshot:typeof import('../src/client/use-retrieval-snapshot.ts').useRetrievalSnapshot}}
 new Function('require','module','exports','document','setTimeout','clearTimeout',output)(
  ()=>hooks,module,module.exports,document,(fn:()=>void)=>{const id=++serial;timers.set(id,fn);return id},(id:number)=>timers.delete(id))
 const identity={}
 return {
  render<T>(read:(signal:AbortSignal)=>Promise<T>,enabled=true){cursor=0;effectCursor=0;const result=module.exports.useRetrievalSnapshot(read,identity,enabled);while(pending.length)pending.shift()!();return result},
  visibility(state:string){document.visibilityState=state;for(const fn of listeners)fn()},
  tick(){const jobs=[...timers.values()];timers.clear();for(const job of jobs)job()},
  dispose(){for(const effect of effects)effect?.cleanup?.()},
  timers,listeners,
 }
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve()}

test('审查 P3-1：初始后台零读取，显示立即读，隐藏停止轮询，再显示立即刷新',async()=>{
 const f=fixture('hidden');let reads=0
 const read=async()=>++reads
 f.render(read);await settle();assert.equal(reads,0)
 f.visibility('visible');await settle();assert.equal(reads,1)
 f.tick();await settle();assert.equal(reads,2)
 f.visibility('hidden');f.tick();await settle();assert.equal(reads,2);assert.equal(f.timers.size,0)
 f.visibility('visible');await settle();assert.equal(reads,3)
 f.dispose();assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0)
})

test('隐藏只中止读取；显示立即读且拒绝迟到结果，操作 signal 与已受理任务继续',async()=>{
 const f=fixture(),requests:{signal:AbortSignal;resolve:(n:number)=>void}[]=[]
 const read=(signal:AbortSignal)=>new Promise<number>(resolve=>requests.push({signal,resolve}))
 let state=f.render(read);assert.equal(requests.length,1)
 let finish!:(n:number)=>void,operationSignal:AbortSignal|undefined
 const operation=state.run(signal=>{operationSignal=signal;return new Promise(resolve=>{finish=resolve})})
 await state.run(async()=>{assert.fail('同组件双击不能再次提交');return 0})
 f.visibility('hidden');assert.equal(requests[0]!.signal.aborted,true);assert.equal(operationSignal?.aborted,false)
 f.visibility('visible');assert.equal(requests.length,2,'恢复可见即使操作在途也立即读取')
 requests[0]!.resolve(10);requests[1]!.resolve(20);await settle()
 state=f.render(read);assert.equal(state.value,undefined,'操作期间与隐藏前的迟到读取都不能覆盖')
 finish(30);await operation;state=f.render(read);assert.equal(state.value,30)
 f.tick();assert.equal(requests.length,3)
 f.visibility('hidden');requests[2]!.resolve(40);await settle()
 state=f.render(read);assert.equal(state.value,30)
 f.dispose();assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0)
})
test('路由离开清理在途读取、事件与计时器；迟到回包不发布',async()=>{
 const f=fixture();let release!:(n:number)=>void,signal:AbortSignal|undefined
 const read=(s:AbortSignal)=>{signal=s;return new Promise<number>(resolve=>{release=resolve})}
 f.render(read);f.render(read,false);assert.equal(signal?.aborted,true)
 release(7);await settle();assert.equal(f.render(read,false).value,undefined)
 f.visibility('visible');f.tick();assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0)
})
