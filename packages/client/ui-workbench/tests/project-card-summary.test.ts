import assert from 'node:assert/strict'
import test from 'node:test'
import {createProjectCardSummaryReader,projectCardSummary,invalidateProjectCardSummary} from '../src/client/project-card-summary.ts'
const row=(id:string)=>({id,ownerId:'owner',scope:'general',version:1,updatedAt:'2026-10-21T00:00:00Z'}) as any
const summary={completedTasks:2,attentionTasks:1,taskStates:{completed:2,running:1}}
test('项目摘要合并同身份同版本请求，并发上限四个',async()=>{
 let active=0,max=0,calls=0;const finish:Array<()=>void>=[]
 const reader=createProjectCardSummaryReader({get:(id:string)=>{calls++;active++;max=Math.max(max,active);return new Promise(resolve=>finish.push(()=>{active--;resolve({project:row(id),summary} as any)}))}})
 const first=reader(row('one'));assert.equal(reader(row('one')),first)
 const pending=[first,...['two','three','four','five','six'].map(id=>reader(row(id)))];assert.equal(calls,4)
 while(finish.length){finish.shift()!();await new Promise(resolve=>setImmediate(resolve))}
 await Promise.all(pending);assert.equal(calls,6);assert.equal(max,4)
})
test('摘要拒绝身份或版本不一致，失败不缓存，不跨连接复用',async()=>{
 let valid=false,calls=0;const api={get:async()=>{calls++;return {project:{...row('one'),ownerId:valid?'owner':'other'},summary} as any}}
 await assert.rejects(projectCardSummary(api,row('one')),/项目已更新/);valid=true
 assert.deepEqual(await projectCardSummary(api,row('one')),summary);assert.equal(calls,2)
 const changed={get:async()=>({project:{...row('one'),version:2},summary} as any)}
 await assert.rejects(projectCardSummary(changed,row('one')),/项目已更新/)
})

test('明确刷新立即重读任务摘要，即使项目自身版本未变化',async()=>{
 let completed=0,calls=0
 const api={get:async()=>{calls++;return {project:row('one'),summary:{...summary,completedTasks:completed}} as any}}
 assert.equal((await projectCardSummary(api,row('one'))).completedTasks,0)
 completed=1
 invalidateProjectCardSummary(api)
 assert.equal((await projectCardSummary(api,row('one'))).completedTasks,1)
 assert.equal(calls,2)
})
