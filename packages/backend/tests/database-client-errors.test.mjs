import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Pool} from 'pg'
import {protectBorrowedDatabaseClients} from '../src/database-client-errors.ts'
import {SecurityRequestJournal} from '../src/security/request-journal.ts'

// 复用真实 pg-pool acquire/release 次序；仅传输客户端为受控夹具，不冒充 PG 回滚实测。
class TransportClient extends EventEmitter{
 _queryable=true
 connect(done){queueMicrotask(()=>done())}
 end(done){this.emit('end');done?.()}
 ref(){}
 unref(){}
}
test('真实 pg-pool 借出/归还反复切换，监听不累积且原错误仍可观察',async()=>{
 const pool=new Pool({Client:TransportClient,max:1})
 pool.on('error',()=>{})
 protectBorrowedDatabaseClients(pool);protectBorrowedDatabaseClients(pool)
 try{
  for(let i=0;i<20;i++){
   const client=await pool.connect()
   assert.equal(client.listenerCount('error'),1)
   const failure=new Error('connection lost')
   let observed
   const own=error=>{observed=error}
   client.on('error',own)
   client.emit('error',failure)
   assert.equal(observed,failure)
   client.removeListener('error',own)
   client.release()
   assert.equal(client.listenerCount('error'),1,'归还后仅保留 pg 自己的 idleListener')
  }
 }finally{await pool.end()}
 assert.equal(pool.totalCount,0)
})

function fixture(query){
 const client=new EventEmitter(),calls=[]
 client.query=async sql=>{calls.push(sql);return query(sql,client)}
 client.release=value=>{calls.push(['release',value]);assert.equal(client.listenerCount('error'),1)}
 const journal=new SecurityRequestJournal({connect:async()=>client})
 return {client,calls,journal}
}
test('正常事务提交，业务失败回滚，所有出口移除借用监听',async()=>{
 for(const fail of [false,true]){
  const f=fixture(async()=>({rows:[]})),failure=new Error('work rejected')
  const run=f.journal.transaction(async()=>{if(fail)throw failure;return 'ok'})
  if(fail)await assert.rejects(run,error=>error===failure)
  else assert.equal(await run,'ok')
  assert.deepEqual(f.calls,['begin',fail?'rollback':'commit',['release',false]])
  assert.equal(f.client.listenerCount('error'),0)
 }
})
test('query 断连失败及 rollback 二次失败保留原错误并销毁连接',async()=>{
 const original=new Error('original query disconnected'),rollback=new Error('rollback unavailable')
 const f=fixture(async(sql,client)=>{
  if(sql==='select waiting'){client.emit('error',original);throw original}
  if(sql==='rollback')throw rollback
  return {rows:[]}
 })
 await assert.rejects(f.journal.transaction(db=>db.query('select waiting')),error=>error===original)
 assert.deepEqual(f.calls,['begin','select waiting','rollback',['release',true]])
 assert.equal(f.client.listenerCount('error'),0)
})
test('借出空档收到 error 不能把已完成业务或 commit 当成功',async()=>{
 for(const point of ['work','commit']){
  const failure=new Error('lost while '+point)
  const f=fixture(async(sql,client)=>{if(sql==='commit'&&point==='commit')client.emit('error',failure);return {rows:[]}})
  await assert.rejects(f.journal.transaction(async()=>{if(point==='work')f.client.emit('error',failure);return 'not success'}),error=>error===failure)
  assert.equal(f.calls.includes('commit'),point==='commit')
  assert.deepEqual(f.calls.at(-1),['release',true])
  assert.equal(f.client.listenerCount('error'),0)
 }
})
