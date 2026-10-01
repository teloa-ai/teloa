import test from 'node:test'
import assert from 'node:assert/strict'
import {BusinessTaskListController} from '../src/client/business-task-list.ts'
import type {BusinessTaskListPage} from '../src/client/business-task-list-api.ts'

const task=(id:string)=>({task:{id,ownerId:'owner',title:id,scope:'sales',version:1,state:'ready' as const,assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T00:00:00.000Z'},source:null,progress:null,completion:null})
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}

test('目录显式加载、分页和刷新只读，保留同一 scope/object 查询',async()=>{
 const calls:unknown[]=[],responses=[{items:[task('a')],nextCursor:'p2'},{items:[task('b')]},{items:[]}] satisfies BusinessTaskListPage[]
 const controller=new BusinessTaskListController({list:async input=>{calls.push(input);return responses.shift()!}},{scope:'sales',object:{type:'customer',id:'one'}})
 assert.equal(calls.length,0)
 await controller.refresh();await controller.more()
 assert.deepEqual(controller.getSnapshot().items.map(row=>row.task.id),['a','b'])
 await controller.refresh();assert.deepEqual(controller.getSnapshot().items,[])
 assert.deepEqual(calls,[{scope:'sales',object:{type:'customer',id:'one'}},{scope:'sales',object:{type:'customer',id:'one'},cursor:'p2'},{scope:'sales',object:{type:'customer',id:'one'}}])
})

test('卸载/同 scope 换本人 API 后旧响应不能出现在新实例；旧请求被取消',async()=>{
 const pending=deferred<BusinessTaskListPage>();let signal:AbortSignal|undefined
 const old=new BusinessTaskListController({list:async(_,s)=>{signal=s;return pending.promise}},{scope:'sales'})
 const loading=old.refresh();old.dispose()
 const current=new BusinessTaskListController({list:async()=>({items:[task('new')]})},{scope:'sales'})
 await current.refresh();pending.resolve({items:[task('old')]});await loading
 assert.equal(signal?.aborted,true);assert.deepEqual(old.getSnapshot().items,[])
 assert.deepEqual(current.getSnapshot().items.map(row=>row.task.id),['new'])
})

test('刷新立刻清旧授权数据，迟到分页不能恢复旧列表',async()=>{
 const pending=deferred<BusinessTaskListPage>();let count=0
 const controller=new BusinessTaskListController({list:async()=>++count===1?{items:[task('old')],nextCursor:'p2'}:count===2?pending.promise:{items:[task('new')]}},{scope:'sales'})
 await controller.refresh();const more=controller.more();const fresh=controller.refresh()
 assert.deepEqual(controller.getSnapshot().items,[])
 await fresh;pending.resolve({items:[task('late')]});await more
 assert.deepEqual(controller.getSnapshot().items.map(row=>row.task.id),['new'])
})

test('读取失败清空已有内容并可显式重试，不冒充空成功',async()=>{
 let failed=false
 const controller=new BusinessTaskListController({list:async()=>{if(failed)throw Error('forbidden');return {items:[task('one')],nextCursor:'next'}}},{scope:'sales'})
 await controller.refresh();failed=true;await controller.more()
 assert.equal(controller.getSnapshot().phase,'failed');assert.deepEqual(controller.getSnapshot().items,[])
 failed=false;await controller.refresh();assert.equal(controller.getSnapshot().phase,'ready')
})

test('拒绝重复页和游标环路，双击加载更多只发送一次',async()=>{
 const pending=deferred<BusinessTaskListPage>();let calls=0
 const controller=new BusinessTaskListController({list:async()=>++calls===1?{items:[task('a')],nextCursor:'p2'}:pending.promise},{scope:'sales'})
 await controller.refresh();const more=controller.more();await controller.more();assert.equal(calls,2)
 pending.resolve({items:[task('a')],nextCursor:'p2'});await more
 assert.equal(controller.getSnapshot().phase,'failed');assert.deepEqual(controller.getSnapshot().items,[])
})
