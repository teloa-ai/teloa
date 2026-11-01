import test from 'node:test'
import assert from 'node:assert/strict'
import type {Pool,PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'
import {RoleDailyLogService} from '../src/work/role-daily-logs.ts'

function failingReader(error:Error,stage:'connect'|'read'='read',rollbackError?:Error){
 let released=0
 const queries:string[]=[]
 const db={async query(sql:string){
  queries.push(sql)
  if(sql==='rollback'){if(rollbackError)throw rollbackError;return {rows:[]}}
  if(sql.startsWith('begin'))return {rows:[]}
  throw error
 },release(){released++}} as unknown as PoolClient
 const pool={async connect(){if(stage==='connect')throw error;return db}} as unknown as Pool
 const service=new RoleDailyLogService(pool,{id:()=>'',now:()=>''},{remember:async()=>{throw Error('读取不可写入经验。')}})
 return {service,queries,released:()=>released}
}

test('AD09 日结交付核对把明确的数据库并发和连接故障归为暂不可用',async()=>{
 for(const code of ['40001','40P01','08006','57P01','ECONNRESET'])for(const stage of ['connect','read'] as const){
  const f=failingReader(Object.assign(Error('数据库暂不可读。'),{code}),stage)
  await assert.rejects(f.service.deliveryCheck('owner','00000000-0000-4000-8000-000000000001'),error=>error instanceof WorkError&&error.code==='teloa/storage-unavailable',`${stage}:${code}`)
  assert.equal(f.released(),stage==='read'?1:0)
  if(stage==='read')assert.equal(f.queries.at(-1),'rollback')
 }
})

test('AD09 日结交付核对保留程序错误，回滚失败不覆盖原始故障',async()=>{
 for(const error of [new TypeError('程序错误。'),Object.assign(Error('表结构错误。'),{code:'42P01'})]){
  const f=failingReader(error,'read',Error('连接已断开，回滚失败。'))
  await assert.rejects(f.service.deliveryCheck('owner','00000000-0000-4000-8000-000000000001'),caught=>caught===error)
  assert.equal(f.released(),1)
 }
})
