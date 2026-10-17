import assert from 'node:assert/strict'
import test from 'node:test'
import type {WorkAttentionItem,WorkAttentionPage} from '@teloa/contract'
import {createWorkAttentionDirectory} from '../src/client/work-attention-directory.ts'
import type {WorkAttentionApi,WorkAttentionQuery} from '../src/client/work-attention-api.ts'

const item=(id:string,basis='a'):WorkAttentionItem=>({id:'task:'+id,kind:'review',reason:'task-waiting',title:id,occurredAt:'2026-10-17T00:00:00.000Z',source:{kind:'task',taskId:id,version:basis==='a'?1:2},target:{kind:'task',taskId:id},basisHash:basis.repeat(64)})
const page=(items:WorkAttentionItem[]=[],nextCursor?:string,incomplete:WorkAttentionPage['incomplete']=[]):WorkAttentionPage=>({schema:'teloa.work-attention/v1',items,incomplete,...(nextCursor?{nextCursor}:{})})
function harness(){
 const calls:{query:WorkAttentionQuery;signal:AbortSignal|undefined;resolve:(page:WorkAttentionPage)=>void;reject:(error:unknown)=>void}[]=[]
 const api:WorkAttentionApi={list:(query={},signal)=>new Promise((resolve,reject)=>calls.push({query,signal,resolve,reject}))}
 return {calls,directory:createWorkAttentionDirectory(api)}
}

test('首次读取未完成和失败不冒已知空目录，成功空页才确认已知',async()=>{
 const {calls,directory}=harness(),initial=directory.getSnapshot();let notices=0
 const unsubscribe=directory.subscribe(()=>notices++)
 assert.equal(directory.getSnapshot(),initial)
 const first=directory.reload();assert.equal(calls.length,1);assert.deepEqual(calls[0]!.query,{})
 assert.equal(directory.getSnapshot().loading,true);assert.equal(directory.getSnapshot().loaded,false);assert.equal(directory.getSnapshot().known,false)
 const unavailable={code:'teloa/unavailable'};calls[0]!.reject(unavailable);await first
 assert.equal(directory.getSnapshot().error,unavailable);assert.equal(directory.getSnapshot().known,false)
 const retry=directory.reload();calls[1]!.resolve(page());await retry
 assert.deepEqual(directory.getSnapshot(),{items:[],loaded:true,loading:false,known:true,incomplete:[]})
 assert.equal(notices,4);unsubscribe();directory.dispose()
})

test('失败刷新和失败续页保留条目与原始错误，成功刷新整体替换',async()=>{
 const {calls,directory}=harness(),first=directory.reload();calls[0]!.resolve(page([item('old')],'next'));await first
 const refresh=directory.reload();assert.equal(directory.getSnapshot().items[0]!.title,'old')
 const failure=Error('original read failure');calls[1]!.reject(failure);await refresh
 assert.equal(directory.getSnapshot().loaded,true);assert.equal(directory.getSnapshot().error,failure);assert.equal(directory.getSnapshot().nextCursor,'next')
 const more=directory.more();calls[2]!.reject(null);await more
 assert.equal(directory.getSnapshot().error,null);assert.equal(directory.getSnapshot().items[0]!.title,'old');assert.equal(directory.getSnapshot().nextCursor,'next')
 const replacement=directory.reload();calls[3]!.resolve(page([item('new')]));await replacement
 assert.deepEqual(directory.getSnapshot().items,[item('new')]);assert.equal(directory.getSnapshot().known,true);assert.equal('error'in directory.getSnapshot(),false)
})

test('分页按稳定id采用新依据，保顺序及四真源的不完整事实（含business-scope）',async()=>{
 const {calls,directory}=harness(),incomplete:WorkAttentionPage['incomplete']=[{source:'business-scope',reason:'unavailable'},{source:'business-sync',scope:'SOC',reason:'page-limit'}]
 const first=directory.reload();calls[0]!.resolve(page([item('a'),item('b')],'next',incomplete));await first
 assert.equal(directory.getSnapshot().known,false)
 const more=directory.more();assert.deepEqual(calls[1]!.query,{cursor:'next'})
 calls[1]!.resolve(page([item('a','b'),item('c')],undefined,[{reason:'unavailable',source:'business-scope'},{source:'page-create-draft',reason:'unavailable'}]));await more
 assert.deepEqual(directory.getSnapshot().items,[item('a','b'),item('b'),item('c')])
 assert.deepEqual(directory.getSnapshot().incomplete,[...incomplete,{source:'page-create-draft',reason:'unavailable'}]);assert.equal(directory.getSnapshot().known,false)
 const doneCalls=calls.length;await directory.more();assert.equal(calls.length,doneCalls)
})

test('重复cursor拒绝且保原分页供显式重试，不循环或接纳循环页',async()=>{
 const {calls,directory}=harness(),first=directory.reload();calls[0]!.resolve(page([item('a')],'c1'));await first
 const loop=directory.more();calls[1]!.resolve(page([item('must-not-enter')],'c1'));await loop
 assert.equal(Reflect.get(directory.getSnapshot().error as object,'code'),'teloa/invalid-host-response')
 assert.deepEqual(directory.getSnapshot().items,[item('a')]);assert.equal(directory.getSnapshot().nextCursor,'c1');assert.equal(calls.length,2)
 const retry=directory.more();calls[2]!.resolve(page([item('b')],'c2'));await retry
 const backwards=directory.more();calls[3]!.resolve(page([item('must-not-enter')],'c1'));await backwards
 assert.equal(directory.getSnapshot().nextCursor,'c2');assert.deepEqual(directory.getSnapshot().items,[item('a'),item('b')])
 const final=directory.more();calls[4]!.resolve(page([item('c')]));await final;assert.equal(directory.getSnapshot().known,true)
})

test('刷新取代旧pending代际，忽略不遵守AbortSignal的迟答与失败',async()=>{
 const {calls,directory}=harness(),first=directory.reload(),second=directory.reload()
 assert.equal(calls[0]!.signal?.aborted,true);assert.equal(calls[1]!.signal?.aborted,false)
 calls[1]!.resolve(page([item('current')]));await second;const current=directory.getSnapshot()
 calls[0]!.resolve(page([item('late')]));await first;assert.equal(directory.getSnapshot(),current)
 const old=directory.reload(),fresh=directory.reload();calls[2]!.reject(Error('late failure'));await old
 assert.equal(directory.getSnapshot().loading,true);assert.equal('error'in directory.getSnapshot(),false)
 calls[3]!.resolve(page());await fresh
})

test('重复more不并发，刷新中不续旧页，dispose终止请求并禁止迟答通知',async()=>{
 const {calls,directory}=harness(),first=directory.reload();await directory.more();assert.equal(calls.length,1)
 calls[0]!.resolve(page([item('old')],'next'));await first
 const more=directory.more();await directory.more();assert.equal(calls.length,2)
 const refresh=directory.reload();assert.equal(calls[1]!.signal?.aborted,true);calls[1]!.resolve(page([item('late-more')]));await more
 let notices=0;directory.subscribe(()=>notices++);const before=directory.getSnapshot();directory.dispose()
 assert.equal(calls[2]!.signal?.aborted,true);calls[2]!.resolve(page([item('late')]));await refresh
 assert.equal(directory.getSnapshot(),before);assert.equal(notices,0)
 await directory.reload();await directory.more();assert.equal(calls.length,3)
})
