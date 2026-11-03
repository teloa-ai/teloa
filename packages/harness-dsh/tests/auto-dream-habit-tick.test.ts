import test from 'node:test'
import assert from 'node:assert/strict'
import {createAutoDreamHabitTick} from '../src/auto-dream-habit-tick.ts'

test('分身观察在后台定期执行，不依赖页面；失败留待下一次，停止后不再执行',async()=>{
 let calls=0,fail=true
 const errors:string[]=[]
 const tick=createAutoDreamHabitTick({
  observe:async()=>{calls++;if(fail)throw new Error('offline')},
  report:code=>errors.push(code),
 })
 const controller=new AbortController()
 await tick('2026-09-23T00:00:00Z',controller.signal)
 await tick('2026-09-23T00:00:02Z',controller.signal)
 assert.equal(calls,1);assert.deepEqual(errors,['teloa/habit-observation-unavailable'])
 fail=false
 await tick('2026-09-23T00:01:00Z',controller.signal)
 assert.equal(calls,2)
 controller.abort()
 await tick('2026-09-23T00:02:00Z',controller.signal)
 assert.equal(calls,2)
})

test('AD11 无新日志也执行到期维护，观察失败不阻断维护，维护失败保留重试与观察',async()=>{
 const calls:string[]=[],errors:string[]=[]
 let maintenanceFails=false
 const tick=createAutoDreamHabitTick({
  maintain:async()=>{calls.push('maintain');if(maintenanceFails)throw new Error('db unavailable')},
  observe:async()=>{calls.push('observe');throw new Error('observation unavailable')},
  report:code=>errors.push(code),
 })
 const controller=new AbortController()
 await tick('2026-09-23T00:00:00Z',controller.signal)
 assert.deepEqual(calls,['maintain','observe'])
 maintenanceFails=true
 await tick('2026-09-23T00:01:00Z',controller.signal)
 assert.deepEqual(calls,['maintain','observe','maintain','observe'])
 assert.deepEqual(errors,['teloa/habit-observation-unavailable','teloa/log-retention-unavailable','teloa/habit-observation-unavailable'])
 controller.abort()
 await tick('2026-09-23T00:02:00Z',controller.signal)
 assert.equal(calls.length,4)
})
