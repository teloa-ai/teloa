import test from 'node:test'
import assert from 'node:assert/strict'
import {scheduleTaskRunRefresh} from '../src/client/task-run-refresh.ts'
import type {RunView} from '../src/client/task-run-api.ts'
const active={id:'one',state:'active'} as RunView
test('仅核对未结束的已提交记录，完成快照不再安排刷新',async()=>{
 let scheduled:(()=>void)|undefined,calls=0
 let finish:()=>void=()=>{}
 const done=new Promise<void>(resolve=>{finish=resolve})
 scheduleTaskRunRefresh([active,{...active,id:'two',state:'ended'}],{reconcile:async row=>{calls++;return {...row,state:'ended'}}},rows=>{
  assert.equal(rows.length,2)
  scheduleTaskRunRefresh(rows,{reconcile:async()=>{throw Error('不应核对')}},()=>{},()=>{},()=>{throw Error('终态不应定时')})
  finish()
 },error=>{throw error},work=>{scheduled=work;return ()=>{}})
 scheduled!();await done;assert.equal(calls,1)
})
test('运行配置失败是终态，不安排状态核对',()=>{
 scheduleTaskRunRefresh([{...active,state:'configuration_failed'}],{reconcile:async()=>{throw Error('不应核对')}},()=>{},()=>{},()=>{throw Error('配置失败不应定时')})
})
test('取消后迟到响应不发布，也不核对后续记录',async()=>{
 let scheduled:(()=>void)|undefined,resolve!:(row:RunView)=>void,calls=0,published=0
 const pending=new Promise<RunView>(r=>{resolve=r})
 const cancel=scheduleTaskRunRefresh([active,{...active,id:'two'}],{reconcile:async()=>{calls++;return pending}},()=>{published++},()=>{published++},work=>{scheduled=work;return ()=>{}})
 scheduled!();cancel();resolve({...active,state:'ended'})
 await new Promise(r=>setImmediate(r))
 assert.equal(calls,1);assert.equal(published,0)
})
test('核对失败只报告错误，不发布部分结果',async()=>{
 let scheduled:(()=>void)|undefined,published=0
 let finish:()=>void=()=>{};const done=new Promise<void>(r=>{finish=r})
 scheduleTaskRunRefresh([active],{reconcile:async()=>{throw Error('离线')}},()=>{published++},error=>{assert.equal((error as Error).message,'离线');finish()},work=>{scheduled=work;return ()=>{}})
 scheduled!();await done;assert.equal(published,0)
})
test('零行时也排一次延时重读：读到记录就发布，仍为空则不再自转',async()=>{
 let scheduled:(()=>void)|undefined,lists=0
 let finish:()=>void=()=>{};const done=new Promise<void>(r=>{finish=r})
 scheduleTaskRunRefresh([],{reconcile:async()=>{throw Error('不应核对')}},rows=>{assert.deepEqual(rows,[active]);finish()},error=>{throw error},work=>{scheduled=work;return ()=>{}},async()=>{lists++;return [active]})
 scheduled!();await done;assert.equal(lists,1)
 let published=0
 scheduleTaskRunRefresh([],{reconcile:async()=>{throw Error('不应核对')}},()=>{published++},error=>{throw error},work=>{scheduled=work;return ()=>{}},async()=>{lists++;return []})
 scheduled!();await new Promise(r=>setImmediate(r))
 assert.equal(lists,2);assert.equal(published,0,'仍为空不发布，避免没有执行的任务被无限轮询')
})
test('零行重读被取消后不发布，读取失败只报告',async()=>{
 let scheduled:(()=>void)|undefined,published=0
 const cancel=scheduleTaskRunRefresh([],{reconcile:async()=>{throw Error('不应核对')}},()=>{published++},()=>{published++},work=>{scheduled=work;return ()=>{}},async()=>[active])
 scheduled!();cancel();await new Promise(r=>setImmediate(r));assert.equal(published,0)
 let finish:()=>void=()=>{};const done=new Promise<void>(r=>{finish=r})
 scheduleTaskRunRefresh([],{reconcile:async()=>{throw Error('不应核对')}},()=>{throw Error('不应发布')},error=>{assert.equal((error as Error).message,'离线');finish()},work=>{scheduled=work;return ()=>{}},async()=>{throw Error('离线')})
 scheduled!();await done
})
test('没有重读端口时零行保持原样，不安排任何轮询',()=>{
 scheduleTaskRunRefresh([],{reconcile:async()=>{throw Error('不应核对')}},()=>{},()=>{},()=>{throw Error('零行无端口不应定时')})
})
