import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkError,type BusinessChangeSet,type BusinessSyncStatus,type PageCreateDraft} from '@teloa/contract'
import {WorkAttentionService,type WorkAttentionPorts} from '../src/work/work-attention.ts'
import type {TaskAttentionItem} from '../src/work/task-attention.ts'

const owner='local:owner'
const at=(n:number)=>new Date(Date.UTC(2026,9,1,0,0,n)).toISOString()
const task=(n:number,state:'blocked'|'waiting'|'ready',scope='general'):TaskAttentionItem=>({task:{id:randomUUID(),ownerId:owner,version:n+1,state,createdAt:at(0),updatedAt:at(n),title:'任务'+n,goal:'目标',scope,assigneeRoleId:null,assigneeRoleVersion:null} as unknown as TaskAttentionItem['task'],attention:state==='blocked'?{kind:'error',reason:'task-blocked'}:state==='waiting'?{kind:'review',reason:'task-waiting'}:null})
const changeSet=(scope:string,n:number,state:BusinessChangeSet['state']='draft'):BusinessChangeSet=>({schema:'teloa.business-change-set/v1',id:randomUUID(),scope,revision:n,digest:'d'.repeat(64),state,sessionId:randomUUID(),batch:{} as BusinessChangeSet['batch'],preview:{} as BusinessChangeSet['preview'],createdAt:at(0),updatedAt:at(n)})
const draft=(n:number,scope?:string,bodyHash='a'.repeat(64)):PageCreateDraft=>({id:randomUUID(),ownerId:owner,requestId:randomUUID(),entity:scope?'business-definition':'role',...(scope?{scope}:{}),body:'{}',bodyHash,title:'草案'+n,status:'draft',createdAt:at(0),updatedAt:at(n)})

type Fake={tasks?:TaskAttentionItem[];changeSets?:Record<string,BusinessChangeSet[]>;sync?:Record<string,BusinessSyncStatus[]>;drafts?:PageCreateDraft[];draftsTruncated?:boolean;scopeIds?:string[];fail?:Partial<Record<'tasks'|'changeSets'|'sync'|'drafts',unknown>>}
function ports(fake:Fake){
 const calls={scopes:[] as string[],writes:0,pages:0}
 const value:WorkAttentionPorts={
  scopes:async()=>({scopeIds:fake.scopeIds??['SOC'],truncated:false}),
  tasks:{list:async()=>{if(fake.fail?.tasks)throw fake.fail.tasks;return {items:fake.tasks??[]}}},
  changeSets:{listPage:async(actor,input)=>{
   if(fake.fail?.changeSets)throw fake.fail.changeSets
   assert.ok(actor.scopeIds.includes(input.scope));calls.scopes.push(input.scope);calls.pages++
   const rows=(fake.changeSets?.[input.scope]??[]).slice().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id))
   const start=input.cursor?rows.findIndex(row=>row.id===input.cursor!.id)+1:0,items=rows.slice(start,start+20),last=items.at(-1)
   return {items,...(start+20<rows.length&&last?{nextCursor:{at:last.updatedAt,id:last.id}}:{})}
  }},
  sync:{status:async(actor,scope)=>{if(fake.fail?.sync)throw fake.fail.sync;assert.ok(actor.scopeIds.includes(scope));return fake.sync?.[scope]??[]}},
  drafts:{pendingForAttention:async()=>{if(fake.fail?.drafts)throw fake.fail.drafts;return {drafts:fake.drafts??[],truncated:fake.draftsTruncated===true}}},
 }
 // 有副作用或写入的接口一律不得被聚合调用。
 for(const name of ['get','apply','reject','settle','approve','stop'])Object.assign(value.changeSets,{[name]:()=>{calls.writes++;throw Error('不得调用 '+name)}})
 return {value,calls}
}

test('同一任务只出一项；无注意判定的任务不出项；目标仅是原任务类型化路由',async()=>{
 const blocked=task(3,'blocked'),{value}=ports({tasks:[blocked,task(2,'ready'),blocked]})
 const page=await new WorkAttentionService(value).listWorkAttention(owner,{})
 assert.equal(page.items.length,1)
 const [item]=page.items
 assert.deepEqual(item!.target,{kind:'task',taskId:blocked.task.id})
 assert.deepEqual(item!.source,{kind:'task',taskId:blocked.task.id,version:blocked.task.version})
 assert.equal(item!.id,'task:'+blocked.task.id)
 assert.equal(JSON.stringify(page).includes('http'),false)
 assert.equal('dueAt' in item!,false)
})

test('无权业务范围不读取不出现；显式请求无权范围直接拒绝',async()=>{
 const {value,calls}=ports({scopeIds:['SOC'],changeSets:{SOC:[changeSet('SOC',1)],FIN:[changeSet('FIN',1)]},sync:{FIN:[{mappingId:'m',consecutiveFailures:1,quota:{rows:0,limit:1},lastRun:{id:'r',mappingId:'m',scope:'FIN',startedAt:at(1),finishedAt:at(2),status:'failed',upserted:0,tombstoned:0,fetched:0,durationMs:1,trigger:'manual'}}]}})
 const service=new WorkAttentionService(value),page=await service.listWorkAttention(owner,{})
 assert.deepEqual(page.items.map(item=>item.scope),['SOC'])
 assert.deepEqual([...new Set(calls.scopes)],['SOC'])
 await assert.rejects(()=>service.listWorkAttention(owner,{scope:'FIN'}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/forbidden')
})

test('全局待办也核对任务当前范围；错误本人的来源不混入其余可读待办',async()=>{
 const allowed=task(1,'blocked','SOC'),outside=task(2,'blocked','FIN'),general=task(3,'blocked')
 const page=await new WorkAttentionService(ports({scopeIds:['SOC'],tasks:[allowed,outside,general]}).value).listWorkAttention(owner,{})
 assert.deepEqual(new Set(page.items.map(item=>item.id)),new Set(['task:'+allowed.task.id,'task:'+general.task.id]))
 const wrong=task(4,'blocked','SOC');wrong.task.ownerId='local:other'
 const saved=draft(5),invalid=await new WorkAttentionService(ports({tasks:[wrong],drafts:[saved]}).value).listWorkAttention(owner,{})
 assert.deepEqual(invalid.items.map(item=>item.id),['page-create-draft:'+saved.id])
 assert.deepEqual(invalid.incomplete,[{source:'task',reason:'unavailable'}])
})

test('业务修改按原状态出项，失效不投影成功，且不调用有副作用的 get',async()=>{
 const fresh=changeSet('SOC',2,'draft'),stale=changeSet('SOC',1,'stale'),{value,calls}=ports({changeSets:{SOC:[fresh,stale]}})
 const page=await new WorkAttentionService(value).listWorkAttention(owner,{})
 const byId=new Map(page.items.map(item=>[item.id,item]))
 assert.equal(byId.get('business-change-set:'+fresh.id)?.reason,'business-change-review')
 assert.equal(byId.get('business-change-set:'+fresh.id)?.kind,'approval')
 assert.equal(byId.get('business-change-set:'+stale.id)?.reason,'business-change-stale')
 assert.equal(byId.get('business-change-set:'+stale.id)?.kind,'error')
 assert.deepEqual(byId.get('business-change-set:'+fresh.id)?.target,{kind:'business-change-set',scope:'SOC',changeSetId:fresh.id})
 assert.equal(calls.writes,0)
})

test('业务修改分页有界，超过上限显式标记来源不完整而不是静默截断',async()=>{
 const many=Array.from({length:130},(_,n)=>changeSet('SOC',n+1)),{value,calls}=ports({changeSets:{SOC:many}})
 const page=await new WorkAttentionService(value).listWorkAttention(owner,{limit:50})
 assert.equal(calls.pages,5)
 assert.deepEqual(page.incomplete,[{source:'business-change-set',scope:'SOC',reason:'page-limit'}])
})

test('同步仅在最近一次真实失败时出项；只有下次运行时间不生成期限',async()=>{
 const failed:BusinessSyncStatus={mappingId:'orders',consecutiveFailures:2,quota:{rows:0,limit:1},nextRunAt:at(99),lastRun:{id:'run-1',mappingId:'orders',scope:'SOC',startedAt:at(5),finishedAt:at(6),status:'failed',upserted:0,tombstoned:0,fetched:0,durationMs:1,trigger:'schedule',error:{code:'teloa/dependency-unavailable',reason:'x'}}}
 const ok:BusinessSyncStatus={mappingId:'clients',consecutiveFailures:0,quota:{rows:0,limit:1},nextRunAt:at(99),lastRun:{...failed.lastRun!,id:'run-2',mappingId:'clients',status:'ok'}}
 const {value}=ports({sync:{SOC:[failed,ok,{mappingId:'never',consecutiveFailures:0,quota:{rows:0,limit:1},nextRunAt:at(9)}]}})
 const page=await new WorkAttentionService(value).listWorkAttention(owner,{})
 assert.equal(page.items.length,1)
 const [item]=page.items
 assert.deepEqual(item!.source,{kind:'business-sync',scope:'SOC',mappingId:'orders',runId:'run-1'})
 assert.deepEqual(item!.target,{kind:'business-sync',scope:'SOC',mappingId:'orders'})
 assert.equal(item!.occurredAt,at(6))
 assert.equal(JSON.stringify(item).includes(at(99)),false)
})

test('页内草稿以真实 bodyHash 为依据；依据变化才改变 basisHash，不臆造版本',async()=>{
 const first=draft(1),{value}=ports({drafts:[first]}),service=new WorkAttentionService(value)
 const a=(await service.listWorkAttention(owner,{})).items[0]!,again=(await service.listWorkAttention(owner,{})).items[0]!
 assert.deepEqual(a.source,{kind:'page-create-draft',entity:'role',draftId:first.id,bodyHash:first.bodyHash})
 assert.deepEqual(a.target,{kind:'page-create-draft',draftId:first.id})
 assert.equal('revision' in a.source,false)
 assert.equal(a.basisHash,again.basisHash)
 const changed=(await new WorkAttentionService(ports({drafts:[{...first,bodyHash:'b'.repeat(64)}]}).value).listWorkAttention(owner,{})).items[0]!
 assert.notEqual(changed.basisHash,a.basisHash)
 const truncated=await new WorkAttentionService(ports({drafts:[first],draftsTruncated:true}).value).listWorkAttention(owner,{})
 assert.deepEqual(truncated.incomplete,[{source:'page-create-draft',reason:'page-limit'}])
})

test('单一来源读取失败显式标记不完整，其余来源照常；非业务错误不被吞掉',async()=>{
 const blocked=task(1,'blocked'),{value}=ports({tasks:[blocked],fail:{sync:new WorkError('teloa/storage-corrupt','坏')}})
 const page=await new WorkAttentionService(value).listWorkAttention(owner,{})
 assert.deepEqual(page.items.map(item=>item.id),['task:'+blocked.task.id])
 assert.deepEqual(page.incomplete,[{source:'business-sync',scope:'SOC',reason:'unavailable'}])
 await assert.rejects(()=>new WorkAttentionService(ports({fail:{drafts:new TypeError('bug')}}).value).listWorkAttention(owner,{}),TypeError)
})

test('确定性排序与游标分页：上限 50，跨页不重不漏；非法上限、游标与身份被拒',async()=>{
 const tasks=Array.from({length:40},(_,n)=>task(n+1,n%2?'blocked':'waiting')),drafts=Array.from({length:20},(_,n)=>draft(n+1))
 const service=new WorkAttentionService(ports({tasks,drafts}).value)
 const first=await service.listWorkAttention(owner,{limit:50})
 assert.equal(first.items.length,50);assert.equal(typeof first.nextCursor,'string')
 const cursor=first.nextCursor;assert.ok(cursor)
 const second=await service.listWorkAttention(owner,{limit:50,cursor})
 assert.equal(second.items.length,10);assert.equal(second.nextCursor,undefined)
 const ids=[...first.items,...second.items].map(item=>item.id)
 assert.equal(new Set(ids).size,60)
 const kinds=[...first.items,...second.items].map(item=>item.kind)
 assert.deepEqual(kinds,[...kinds].sort((a,b)=>['approval','error','review'].indexOf(a)-['approval','error','review'].indexOf(b)))
 assert.deepEqual((await service.listWorkAttention(owner,{limit:50})).items.map(item=>item.id),first.items.map(item=>item.id))
 await assert.rejects(()=>service.listWorkAttention(owner,{limit:51}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input')
 await assert.rejects(()=>service.listWorkAttention(owner,{cursor:'bad'}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input')
 await assert.rejects(()=>service.listWorkAttention(owner,{extra:1} as never),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input')
 await assert.rejects(()=>service.listWorkAttention('',{}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/forbidden')
})

test('按业务范围筛选只返回该范围任务与业务来源，无范围草稿不混入',async()=>{
 const soc=task(1,'blocked','SOC'),general=task(2,'blocked'),{value}=ports({tasks:[soc,general],drafts:[draft(1),draft(2,'SOC')]})
 const page=await new WorkAttentionService(value).listWorkAttention(owner,{scope:'SOC'})
 assert.deepEqual(page.items.map(item=>item.scope).sort(),['SOC','SOC'])
})


test('业务范围枚举截断显式不完整，指定已登记范围不依赖全局截断页',async()=>{
 const late=task(1,'blocked','late-business'),{value}=ports({tasks:[late]})
 value.scopes=async(_owner,query)=>query.scope===undefined?{scopeIds:['SOC'],truncated:true}:{scopeIds:[query.scope],truncated:false}
 const service=new WorkAttentionService(value),global=await service.listWorkAttention(owner,{})
 assert.deepEqual(global.items,[])
 assert.deepEqual(global.incomplete,[{source:'business-scope',reason:'page-limit'}])
 const exact=await service.listWorkAttention(owner,{scope:'late-business'})
 assert.deepEqual(exact.items.map(item=>item.id),['task:'+late.task.id])
 assert.deepEqual(exact.incomplete,[])
})
