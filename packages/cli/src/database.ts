import {randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {readFile,writeFile,lstat} from 'node:fs/promises'
import type {InstallState,Status} from './contracts.ts'
import {privateDirectory,readPrivateJson,writePrivateJson} from './state.ts'
import {command} from './process.ts'

export const databaseImage='postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
export const databaseName=(state:InstallState)=>'teloa-'+state.id
export const databaseConfig=(state:InstallState)=>join(state.layout.runtimeRoot,'database.json')
export function localConnection(value:string):URL{
 let url:URL
 try{url=new URL(value)}catch{throw Error('仅接受本机的独立 teloa 数据库。')}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/teloa'||url.search||url.hash)throw Error('仅接受本机的独立 teloa 数据库；不能附加连接覆盖参数。')
 return url
}
export async function docker(args:string[],timeout=30_000):Promise<string>{
 const result=await command('docker',args,{timeout})
 if(result.code!==0)throw Error('Docker 操作失败；请检查 docker info、镜像访问和本机容器状态。')
 return result.stdout.trim()
}
export async function assertLocalDocker():Promise<void>{
 const context=process.env.DOCKER_CONTEXT
 const host=context?undefined:process.env.DOCKER_HOST
 const endpoint=host??JSON.parse(await docker(['context','inspect',...(context?[context]:[])]))[0]?.Endpoints?.docker?.Host
 if(typeof endpoint!=='string'||!endpoint.startsWith('unix://'))throw Error('需要本机 Docker；当前连接为远程或不支持的 Docker context。')
 await docker(['info','--format','{{.OSType}}'])
}
export const dockerResourceAbsent=(message:string)=>/no such (?:object|container|volume)(?:[:\s]|$)/i.test(message)
async function inspect(kind:'container'|'volume',name:string):Promise<any|null>{
 const result=await command('docker',[kind,'inspect',name])
 if(result.code===0)return JSON.parse(result.stdout)[0]
 if(result.code===1&&dockerResourceAbsent(result.stderr))return null
 throw Error('无法核对本安装的 Docker 资源。')
}
export async function ownContainer(state:InstallState):Promise<any>{
 await assertLocalDocker()
 const info=await inspect('container',databaseName(state))
 if(!info||info.Config?.Labels?.['ai.teloa.install']!==state.id)throw Error('数据库容器归属不符，已停止操作。')
 return info
}
async function prepareDocker(state:InstallState):Promise<void>{
 await assertLocalDocker()
 const name=databaseName(state),envPath=join(state.layout.runtimeRoot,'postgres.env')
 await privateDirectory(state.layout.runtimeRoot)
 let container=await inspect('container',name)
 const volume=await inspect('volume',name+'-data')
 if(container&&container.Config?.Labels?.['ai.teloa.install']!==state.id||volume&&volume.Labels?.['ai.teloa.install']!==state.id)throw Error('同名数据库资源属于其他安装，已停止。')
 let env:string
 try{
  const entry=await lstat(envPath)
  if(!entry.isFile()||entry.isSymbolicLink()||(entry.mode&0o077)!==0)throw Error('数据库凭据文件身份或权限不正确。')
  env=await readFile(envPath,'utf8')
 }catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
  if(container||volume)throw Error('已有数据库资源但本机凭据缺失，拒绝重设密码。')
  env='POSTGRES_DB=teloa\nPOSTGRES_USER=teloa\nPOSTGRES_PASSWORD='+randomBytes(32).toString('hex')+'\n'
  await writeFile(envPath,env,{flag:'wx',mode:0o600})
 }
 if(!volume)await docker(['volume','create','--label','ai.teloa.install='+state.id,name+'-data'])
 if(!container){
  await docker(['run','--detach','--name',name,'--label','ai.teloa.install='+state.id,'--env-file',envPath,'--publish','127.0.0.1::5432','--mount','type=volume,source='+name+'-data,target=/var/lib/postgresql/data',databaseImage],180_000)
 }else if(!container.State.Running)await docker(['start',name])
 container=await ownContainer(state)
 const ports=container.NetworkSettings?.Ports?.['5432/tcp'],password=/^POSTGRES_PASSWORD=([a-f0-9]{64})$/m.exec(env)?.[1]
 if(!password||ports?.length!==1||ports[0].HostIp!=='127.0.0.1'||!/^\d+$/.test(ports[0].HostPort))throw Error('数据库凭据或回环端口不完整。')
 await writePrivateJson(databaseConfig(state),{connectionString:'postgresql://teloa:'+password+'@127.0.0.1:'+ports[0].HostPort+'/teloa'})
}
export async function databasePool(state:InstallState):Promise<any>{
 const config=await readPrivateJson(databaseConfig(state)) as {connectionString?:unknown}
 if(typeof config?.connectionString!=='string')throw Error('数据库配置无效。')
 localConnection(config.connectionString)
 const {Pool}=createRequire(join(state.layout.releaseRoot,'package.json'))('pg')
 const pool=new Pool({connectionString:config.connectionString,max:3,connectionTimeoutMillis:2000,statement_timeout:15000})
 pool.on('error',()=>{})
 return pool
}
export async function prepareDatabase(state:InstallState,options:{initialize?:boolean}={}):Promise<{configPath:string}>{
 if(state.database.kind==='docker')await prepareDocker(state)
 else{
  const value=await readPrivateJson(state.database.configFile) as {connectionString?:unknown}
  if(typeof value?.connectionString!=='string')throw Error('已有数据库配置无效。')
  localConnection(value.connectionString)
  await writePrivateJson(databaseConfig(state),{connectionString:value.connectionString})
 }
 const pool=await databasePool(state)
 let client
 try{
  for(let attempt=0;attempt<30;attempt++){
   try{client=await pool.connect();break}catch{if(attempt===29)throw Error('本机数据库未就绪；请检查服务、凭据及端口。');await new Promise(done=>setTimeout(done,500))}
  }
  // 跨安装同一专库也串行认领。先记录归属，初始化中断后同身份可以重试。
  await client.query("select pg_advisory_lock(hashtext('teloa-install-owner'))")
  const marker=await client.query("select to_regclass('public.teloa_installation') as marker")
  if(marker.rows[0].marker){
   const rows=await client.query('select id,data_version from public.teloa_installation')
   if(rows.rows.length!==1||rows.rows[0].id!==state.id)throw Error('数据库已归属另一安装，拒绝接管。')
   // 当前发行只支持已验收的数据版本 1；不能先初始化或改表，再发现旧程序不兼容。
   if(rows.rows[0].data_version!==1)throw Error('数据库数据版本尚不支持，拒绝初始化或接管；请使用匹配版本恢复。')
  }else{
   const tables=await client.query("select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S') limit 1")
   if(tables.rows.length)throw Error('已有数据库不是空库，拒绝接管。请使用新的本机 teloa 专库。')
   await client.query('begin')
   try{await client.query('create table public.teloa_installation (id uuid primary key, data_version integer not null)');await client.query('insert into public.teloa_installation values ($1,1)',[state.id]);await client.query('commit')}catch(error){await client.query('rollback');throw error}
  }
  if(options.initialize!==false){
   const {initializeTeloaDatabase}=await import(pathToFileURL(join(state.layout.releaseRoot,'packages/backend/lib/work/initialize-database.js')).href)
   await initializeTeloaDatabase(pool)
  }
 }catch(error){
  if(error instanceof Error&&/^(数据库已归属|数据库数据版本|已有数据库不是空库|本机数据库未就绪)/.test(error.message))throw error
  throw Error('数据库初始化失败；已保留本安装数据，可修复连接后重试。')
 }finally{if(client){await client.query("select pg_advisory_unlock(hashtext('teloa-install-owner'))").catch(()=>{});client.release()}await pool.end()}
 return {configPath:databaseConfig(state)}
}
export async function inspectDatabase(state:InstallState):Promise<Status['database']>{
 let pool
 try{pool=await databasePool(state);const result=await pool.query('select id from public.teloa_installation');return result.rows.length===1&&result.rows[0].id===state.id?'ready':'unavailable'}catch{return 'unavailable'}finally{await pool?.end()}
}
export async function stopDatabase(state:InstallState):Promise<void>{
 if(state.database.kind!=='docker')return
 const container=await ownContainer(state)
 if(container.State.Running)await docker(['stop','--time','30',databaseName(state)],40_000)
}
