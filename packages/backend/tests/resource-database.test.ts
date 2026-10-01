import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {chmod,lstat,mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase} from '../src/capabilities/database.ts'

test('打开单机资料数据库时准备受控 Markdown 内容目录', {timeout:60_000}, async t=>{
  process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
  const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
  t.after(()=>container.stop())
  const root=await mkdtemp(join(tmpdir(),'teloa-resource-database-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const runtime=join(root,'.runtime','teloa'),config=join(runtime,'database.json')
  await mkdir(runtime,{recursive:true})
  await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})

  const database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
  t.after(async()=>{if(database.close)await database.close();else await database.pool.end()})
  assert.notEqual(database.dispatchLocks,database.pool)
  assert.equal(database.dispatchLocks.options.max,2)
  assert.equal(database.dispatchLocks.totalCount,0,'锁域在实际请求前不建连接')
  const mainPid=(await database.pool.query('select pg_backend_pid() pid')).rows[0].pid,lockPid=(await database.dispatchLocks.query('select pg_backend_pid() pid')).rows[0].pid
  assert.notEqual(mainPid,lockPid)
  await database.close();await database.close()
  await assert.rejects(database.dispatchLocks.connect(),/after calling end/)
  await assert.rejects(database.pool.connect(),/after calling end/)

  const contentRoot=await lstat(join(runtime,'data'))
  assert.equal(contentRoot.isDirectory(),true)
  assert.equal(contentRoot.isSymbolicLink(),false)
  assert.equal(contentRoot.mode&0o077,0)

  await rm(join(runtime,'data'),{recursive:true,force:true})
  await mkdir(join(runtime,'data'),{mode:0o755})
  await assert.rejects(openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()}),{code:'teloa/storage-corrupt'})

  const external=join(root,'external')
  await rm(join(runtime,'data'),{recursive:true,force:true})
  await mkdir(external)
  await symlink(external,join(runtime,'data'))
  await assert.rejects(openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()}),{code:'teloa/storage-corrupt'})
})

test('资料数据库配置文件权限过宽或为符号链接时拒绝加载', async t=>{
  const root=await mkdtemp(join(tmpdir(),'teloa-resource-database-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const runtime=join(root,'.runtime','teloa'),config=join(runtime,'database.json')
  await mkdir(runtime,{recursive:true})

  await writeFile(config,JSON.stringify({connectionString:'postgres://localhost/teloa'}),{mode:0o600})
  await chmod(config,0o644)
  await assert.rejects(openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()}),{code:'teloa/storage-unavailable'})

  const external=join(root,'external.json')
  await writeFile(external,JSON.stringify({connectionString:'postgres://localhost/teloa'}),{mode:0o600})
  await rm(config,{force:true})
  await symlink(external,config)
  await assert.rejects(openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()}),{code:'teloa/storage-unavailable'})
})
