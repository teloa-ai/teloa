import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,symlink,readFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createRequire} from 'node:module'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {prepareDatabase} from '../../cli/src/database.ts'
import type {InstallState} from '../../cli/src/contracts.ts'

let pool:Pool,container:StartedPostgreSqlContainer,state:InstallState,configFile:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 const root=await mkdtemp(join(tmpdir(),'teloa-cli-ownership-')),releaseRoot=join(root,'release'),runtimeRoot=join(root,'runtime')
 await mkdir(join(releaseRoot,'node_modules'),{recursive:true,mode:0o700});await mkdir(runtimeRoot,{mode:0o700})
 await writeFile(join(releaseRoot,'package.json'),'{}',{mode:0o600})
 // prepareDatabase 从固定发行目录解析 pg；测试只映射本仓实际安装的驱动，不替代数据库或查询。
 await symlink(dirname(dirname(createRequire(import.meta.url).resolve('pg'))),join(releaseRoot,'node_modules/pg'))
 configFile=join(root,'connection.json');await writeFile(configFile,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 state={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-alpha.7',port:3999,phase:'maintenance',database:{kind:'existing',configFile},layout:{home:root,releaseRoot,runtimeRoot,instanceRoot:join(root,'instance'),dshHome:join(root,'dsh'),workspaceRoot:join(root,'workspace')}}
 await pool.query('create table teloa_installation(id uuid primary key,data_version integer not null)')
 await pool.query('insert into teloa_installation values($1,1)',[state.id])
 await pool.query('create table original_records(id integer primary key,value text not null)')
 await pool.query("insert into original_records values(1,'保留原资料')")
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function original(){return {owner:(await pool.query('select * from teloa_installation order by id')).rows,records:(await pool.query('select * from original_records')).rows,tables:(await pool.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows}}
test('真实 PG 的同安装数据版本 1 可准备已有连接，原表与内容保持',async()=>{
 const before=await original()
 const result=await prepareDatabase(state,{initialize:false})
 assert.deepEqual(JSON.parse(await readFile(result.configPath,'utf8')),JSON.parse(await readFile(configFile,'utf8')))
 assert.deepEqual(await original(),before)
})
test('真实 PG 未支持的数据版本在正常和恢复准备时均拒绝，不初始化或改写原表',async()=>{
 try{
  for(const version of [0,2,99]){
   await pool.query('update teloa_installation set data_version=$1 where id=$2',[version,state.id])
   const before=await original()
   for(const options of [{},{initialize:false}]){await assert.rejects(prepareDatabase(state,options),/数据库数据版本尚不支持/);assert.deepEqual(await original(),before)}
  }
 }finally{await pool.query('update teloa_installation set data_version=1 where id=$1',[state.id])}
})
test('真实 PG 的其他安装身份拒绝接管，归属和全部原表保持',async()=>{
 const before=await original()
 await assert.rejects(prepareDatabase({...state,id:randomUUID()},{initialize:false}),/数据库已归属/)
 assert.deepEqual(await original(),before)
})
test('真实 PG 多份或缺失的安装身份均拒绝，不能把异常状态当作新库',async()=>{
 const extra=randomUUID()
 await pool.query('insert into teloa_installation values($1,1)',[extra])
 try{const before=await original();await assert.rejects(prepareDatabase(state,{initialize:false}),/数据库已归属/);assert.deepEqual(await original(),before)}
 finally{await pool.query('delete from teloa_installation where id=$1',[extra])}
 await pool.query('delete from teloa_installation where id=$1',[state.id])
 try{const before=await original();await assert.rejects(prepareDatabase(state,{initialize:false}),/数据库已归属/);assert.deepEqual(await original(),before)}
 finally{await pool.query('insert into teloa_installation values($1,1)',[state.id])}
})
