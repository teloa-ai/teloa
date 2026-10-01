import {spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {chmod,copyFile,lstat,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {initializeTeloaDatabase} from './初始化资料数据库.mjs'
import {waitForExit,writeRestartMarker} from './验收进程.mjs'

const projectRoot=fileURLToPath(new URL('../',import.meta.url))
const formalRuntimeRoot=resolve(projectRoot,'.runtime/teloa')
// 系统验收可传一次性 PG 配置，避免依赖或读取开发者正在使用的数据库。
// 地址与库名仍经过下方相同的 loopback 校验；未指定时保持原有独立 schema 跑法。
const formalDatabaseConfig=resolve(process.env.TELOA_ACCEPTANCE_DATABASE_CONFIG??resolve(formalRuntimeRoot,'database.json'))
const formalCredentialsFile=resolve(projectRoot,'.runtime/dsh/.credentials.yaml')
const verifyCleanup=process.argv.slice(2).includes('--verify-cleanup')
const restartable=process.argv.slice(2).includes('--restartable')
if(process.argv.slice(2).some(value=>!['--verify-cleanup','--restartable'].includes(value)))throw Error('验收启动器仅接受 --verify-cleanup 或 --restartable。')
const reuseLocalModelCredentials=process.env.TELOA_ACCEPTANCE_REUSE_LOCAL_MODEL
if(reuseLocalModelCredentials!==undefined&&reuseLocalModelCredentials!=='1')throw Error('TELOA_ACCEPTANCE_REUSE_LOCAL_MODEL 只允许设为 1。')
// 可选：在宿主起来之前把固定验收数据灌进本次的临时 schema 与运行目录。
// 放在启动之前而不是之后：装配期会把受管 Skill 可用性、工作区登记与 conversations.json
// 各读一次做成启动快照，起完再灌数据只会让宿主拿着旧快照对外服务。
// `minimal` 只补空工具验收岗位与夹具工作区，不灌计划与行业加载——给断言「已有启用计划则拒绝」
// 的定时计划验收脚本用，它们与 `full`（`1` 的向后兼容别名）灌的 3 条已启用计划互斥。
const seedAcceptanceData=process.env.TELOA_ACCEPTANCE_SEED
if(seedAcceptanceData!==undefined&&!['1','minimal','full'].includes(seedAcceptanceData))throw Error('TELOA_ACCEPTANCE_SEED 只允许设为 minimal 或 full（1 等同 full）。')
const seedMode=seedAcceptanceData===undefined?undefined:seedAcceptanceData==='1'?'full':seedAcceptanceData

const require=createRequire(resolve(projectRoot,'packages/backend/package.json'))
const {Pool}=require('pg')

const quoteIdentifier=value=>{
  if(!/^teloa_e2e_[a-f0-9]{24}$/.test(value))throw Error('验收 schema 名称不合法。')
  return '"'+value+'"'
}
const freePort=()=>new Promise((done,fail)=>{
  const server=createServer()
  server.once('error',fail)
  server.listen(0,'127.0.0.1',()=>{
    const address=server.address()
    if(!address||typeof address==='string'){server.close();fail(Error('无法分配验收端口。'));return}
    server.close(error=>error?fail(error):done(address.port))
  })
})
async function snapshotFormalDirectoryIds(pool){
  const result=await pool.query(`
    select 'resource:'||id::text as id from teloa_resources
    union all select 'space:'||owner_id||':'||id from teloa_knowledge_spaces
    union all select 'node:'||owner_id||':'||id from teloa_knowledge_nodes
    order by id
  `)
  return result.rows.map(row=>row.id)
}
const sameIds=(left,right)=>left.length===right.length&&left.every((value,index)=>value===right[index])
async function assertFormalDirectoryIdsUnchanged(pool,before){
  const after=await snapshotFormalDirectoryIds(pool)
  if(!sameIds(before,after))throw Error('正式资料目录 ID 集合在验收期间发生变化，已停止并报告污染。')
}
const redact=error=>String(error?.message??error).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[数据库连接]')
async function copyLocalModelCredentials(dshHome){
  const source=await lstat(formalCredentialsFile)
  if(!source.isFile()||source.isSymbolicLink())throw Error('本机模型凭据不是受保护的普通文件，拒绝复制到验收宿主。')
  if(source.mode&0o077)throw Error('本机模型凭据权限过宽，拒绝复制到验收宿主。')
  const target=resolve(dshHome,'.credentials.yaml')
  await copyFile(formalCredentialsFile,target)
  await chmod(target,0o600)
  const copied=await lstat(target)
  if(!copied.isFile()||copied.isSymbolicLink()||copied.mode&0o077)throw Error('验收模型凭据权限核对失败。')
}

let root,schema,formalPool,formalIdsBefore,server,signalCode=0,failure
const stop=signal=>{
  signalCode=signal==='SIGINT'?130:143
  server?.kill(signal)
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop)

try{
  const config=JSON.parse(await readFile(formalDatabaseConfig,'utf8'))
  if(typeof config.connectionString!=='string')throw Error('正式数据库配置格式不正确。')
  const formalUrl=new URL(config.connectionString)
  if(!['postgres:','postgresql:'].includes(formalUrl.protocol)||!['127.0.0.1','localhost'].includes(formalUrl.hostname)||formalUrl.pathname!=='/teloa')throw Error('验收只允许从本机 Teloa 数据库创建独立 schema。')
  formalPool=new Pool({connectionString:config.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:15000})
  formalIdsBefore=await snapshotFormalDirectoryIds(formalPool)
  const identity=randomUUID().replaceAll('-','').slice(0,24)
  schema='teloa_e2e_'+identity
  await formalPool.query('create schema '+quoteIdentifier(schema))

  const temporaryRoot=process.env.TELOA_ACCEPTANCE_TEMP_ROOT??resolve(projectRoot,'.runtime')
  await mkdir(temporaryRoot,{recursive:true,mode:0o700})
  root=await mkdtemp(resolve(temporaryRoot,'teloa-e2e-'))
  const runtimeRoot=resolve(root,'runtime'),dshHome=resolve(root,'dsh'),workspaceRoot=resolve(root,'workspace'),port=await freePort()
  await Promise.all([mkdir(runtimeRoot,{recursive:true,mode:0o700}),mkdir(dshHome,{recursive:true,mode:0o700}),mkdir(workspaceRoot,{recursive:true,mode:0o700})])
  if(reuseLocalModelCredentials==='1')await copyLocalModelCredentials(dshHome)
  const acceptanceUrl=new URL(config.connectionString)
  acceptanceUrl.searchParams.set('options','-c search_path='+schema)
  const acceptanceDatabaseConfig=resolve(runtimeRoot,'database.json')
  await writeFile(acceptanceDatabaseConfig,JSON.stringify({connectionString:acceptanceUrl.toString()},null,2)+'\n',{mode:0o600})
  await initializeTeloaDatabase(acceptanceDatabaseConfig,{expectedSearchPath:schema})
  // 可选：把一次性的本机 loopback 合成告警源写进验收运行目录，供行业数据源就绪核验真实探测；不设置该变量时不生成任何配置文件。
  const alertSourceUrl=process.env.TELOA_ACCEPTANCE_ALERT_SOURCE_URL
  if(alertSourceUrl){
    const parsed=new URL(alertSourceUrl)
    if(parsed.protocol!=='http:'||!['127.0.0.1','localhost'].includes(parsed.hostname))throw Error('验收告警源只允许本机 loopback HTTP 地址。')
    await writeFile(resolve(runtimeRoot,'security-alert-source.json'),JSON.stringify({url:parsed.toString()},null,2)+'\n',{mode:0o600})
  }

  const profileName='teloa-e2e-'+identity
  const {TELOA_ACCEPTANCE_REUSE_LOCAL_MODEL:_reuseLocalModelCredentials,TELOA_ACCEPTANCE_SEED:_seedAcceptanceData,...parentEnv}=process.env
  const env={
    ...parentEnv,
    DSH_HOME:dshHome,
    TELOA_BROWSER_ACCEPTANCE:'1',
    // IM 验收桩端口原样透传；启动器只在验收环境接受它。
    ...(process.env.TELOA_IM_STUB_PORT===undefined?{}:{TELOA_IM_STUB_PORT:process.env.TELOA_IM_STUB_PORT}),
    TELOA_RUNTIME_ROOT:runtimeRoot,
    TELOA_WORKSPACE_ROOT:workspaceRoot,
    TELOA_DSH_HOME:dshHome,
    TELOA_DSH_PROFILE:profileName,
    TELOA_DSH_PORT:String(port),
    TELOA_USAGE_STATS:'off',
  }
  if(signalCode)throw Error('验收启动在准备期间被中止。')
  if(verifyCleanup)throw Error('验收清理自检：主动触发失败路径。')
  const prepare=spawn(process.execPath,[resolve(projectRoot,'scripts/准备DSH插件.mjs')],{cwd:projectRoot,env,stdio:'inherit'})
  await waitForExit(prepare)
  // IM 验收：设了桩端口就直接启用随附的 IM 通道（等同本人在市场点过启用），宿主启动即加载。
  if(process.env.TELOA_IM_STUB_PORT!==undefined){
    const {setBundledExtension,IM_GATEWAY_PACKAGE}=await import('../packages/harness-dsh/src/bundled-extensions-profile.ts')
    await setBundledExtension(resolve(dshHome,'profiles',profileName),projectRoot,IM_GATEWAY_PACKAGE,true)
  }
  if(signalCode)throw Error('验收启动在准备期间被中止。')
  if(seedMode){
    const seed=spawn(process.execPath,[resolve(projectRoot,'scripts/验收数据准备.mjs')],{cwd:projectRoot,env:{...env,TELOA_ACCEPTANCE_SEED:seedMode},stdio:'inherit'})
    await waitForExit(seed)
    if(signalCode)throw Error('验收启动在准备期间被中止。')
  }
  console.log('浏览器验收宿主：http://127.0.0.1:'+port+'；数据仅写入临时 profile 与 schema '+schema+'。')
  // 重启专项保留同一临时 profile/schema；只有最终退出才执行原有清理。
  let restarting=false,generation=0
  const restart=()=>{if(server&&!signalCode){restarting=true;server.kill('SIGTERM')}}
  if(restartable)process.on('SIGUSR2',restart)
  try{do{
    restarting=false
    server=spawn(process.execPath,[resolve(projectRoot,'scripts/启动DSH.mjs')],{cwd:projectRoot,env,stdio:'inherit'})
    // 立即订阅并承接拒绝，写盘等待期间的快速退出也必须进入 finally 清理。
    const exit=waitForExit(server).then(()=>({}),error=>({error}))
    if(restartable)await writeRestartMarker(resolve(projectRoot,'.runtime'),{origin:'http://127.0.0.1:'+port,generation:++generation,pid:server.pid,launcher:process.pid,profile:profileName})
    const outcome=await exit
    if(outcome.error&&!restarting)throw outcome.error
  }while(restarting&&!signalCode)}finally{if(restartable)process.removeListener('SIGUSR2',restart)}

}catch(error){failure=error}
finally{
  const cleanupErrors=[]
  if(server&&server.exitCode===null&&server.signalCode===null){const exit=waitForExit(server);server.kill('SIGTERM');try{await exit}catch{/* 非零退出由回收动作预期产生。 */}}
  if(formalPool&&schema){try{await formalPool.query('drop schema if exists '+quoteIdentifier(schema)+' cascade')}catch(error){cleanupErrors.push(error)}}
  // 看板只读角色按「库 + schema」派生（与 packages/backend/src/work/business-sql-executor.ts 的 businessSqlReaderRoleOf 同一算法），
  // 是集群级对象、不随 schema 删除：一并删掉本次验收 schema 的那一个，不碰其他角色。
  if(formalPool&&schema){try{
    const database=(await formalPool.query('select current_database()::text as name')).rows[0].name
    const role='teloa_business_reader_'+createHash('sha256').update(database+'\u0000'+schema).digest('hex').slice(0,16)
    await formalPool.query('drop role if exists '+role)
  }catch(error){cleanupErrors.push(error)}}
  if(root){try{await rm(root,{recursive:true,force:true})}catch(error){cleanupErrors.push(error)}}
  if(formalPool&&formalIdsBefore){try{await assertFormalDirectoryIdsUnchanged(formalPool,formalIdsBefore)}catch(error){cleanupErrors.push(error)}}
  if(formalPool){try{await formalPool.end()}catch(error){cleanupErrors.push(error)}}
  for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,stop)
  if(cleanupErrors.length)failure=new AggregateError([...(failure?[failure]:[]),...cleanupErrors],'浏览器验收环境清理失败。')
}

if(failure){console.error(redact(failure));process.exitCode=signalCode||1}
else process.exitCode=signalCode
