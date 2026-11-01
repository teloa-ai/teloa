import test from 'node:test'
import assert from 'node:assert/strict'
import type {Pool} from 'pg'
import {RoleRunConversationDirectory} from '../src/work/role-run-conversation-directory.ts'

test('取消的目录请求不查询数据库，也不读取任何运行',async()=>{
 let queries=0,reads=0
 const directory=new RoleRunConversationDirectory({query:async()=>{queries++;return {rows:[]}}} as unknown as Pool,async()=>{reads++;throw Error('不能读取')})
 const controller=new AbortController();controller.abort()
 await assert.rejects(directory.list('owner',{},controller.signal),{name:'AbortError'})
 assert.equal(queries,0);assert.equal(reads,0)
})
test('读取期间取消沿原signal传给会话，剩余同批和后续批次不再开始',async()=>{
 let queries=0,reads=0
 const controller=new AbortController(),pool={query:async()=>{queries++;return {rows:Array.from({length:65},(_,index)=>({session_id:'session-'+index}))}}}
 const directory=new RoleRunConversationDirectory(pool as unknown as Pool,async(_owner,_id,signal)=>{
  assert.equal(signal,controller.signal);reads++;controller.abort();signal!.throwIfAborted();throw Error('不可达')
 })
 await assert.rejects(directory.list('owner',{},controller.signal),{name:'AbortError'})
 assert.equal(queries,1);assert.equal(reads,1)
})
