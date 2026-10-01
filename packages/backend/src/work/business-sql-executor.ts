import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto'
import {link,lstat,open,readFile,unlink} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {Client,Connection,DatabaseError,Query,types,type FieldDef,type Pool,type PoolClient,type PoolConfig,type QueryArrayConfig} from 'pg'
import {WorkError,businessDashboardLimits,isRecord,type BusinessWidgetCell,type BusinessWidgetColumn} from '@teloa/contract'
import {businessSafeFunctions} from './business-warehouse.ts'
import type {BusinessSqlRewrite} from './business-sql-rewrite.ts'
import {isBusinessSqlPlatformSchema} from './business-sql-guard.ts'

/**
 * 看板 SQL 执行边界（规格 §6「执行边界与审计」）：白名单与改写器之后的第二道防线，任何 rewrite 对象（哪怕绕过了白名单）都在这里被兜住。
 *
 * 一次 execute = 一个只读事务：`begin isolation level repeatable read read only` → SET 阶段（超时、work_mem、search_path=pg_temp；
 * fallback 模式另设 temp_file_limit）→ 读边界基线（now()、会话用户、会话参数）→ 流式执行 `select * from (改写产物) limit rowLimit+1`
 * → 再读一次边界，与基线不同即拒绝 → `rollback` → `pg_advisory_unlock_all()`。
 *
 * 收尾用 rollback 而不是 commit：只读事务本无可提交；语句里若用 `set_config(…,false)` 改了会话级参数，rollback 一并撤销；
 * 会话级 advisory 锁 rollback 撤不掉，另行 unlock_all。任何失败路径（超时、取消、超限、报错）一律销毁连接，不归还连接池。
 *
 * 连接池：执行器独占一个专用连接池（默认上限 businessSqlPoolSize），不与应用共享池争连接；进程内全局信号量 concurrencyTotal
 * 严格小于池上限。取消走 PG 协议级 CancelRequest（新开一条裸连接发 processID/secretKey），不从任何连接池借连接。
 *
 * 身份：role 模式下专用池以本 schema 的只读角色（`businessSqlReaderRoleOf`）**直接登录**（session_user 就是只读角色），语句里 `set_config('role',…)` 无论改成什么
 * 都换不回更高权限；执行前核对会话用户，不是只读角色、或只读角色本身是超级用户即拒绝。fallback（事务只读 + 白名单）只许非超级用户（托管库）使用，
 * 会话用户是超级用户即拒绝。拒绝一律 `teloa/dependency-unavailable`「看板查询暂不可用」，原因只进服务端日志。
 */

/** 旧版全集群共用的只读角色名：只在初始化时收回它在**本 schema** 上的授权，不删角色、不动其他 schema。 */
export const businessSqlLegacyReaderRole='teloa_business_reader'
/**
 * 只读角色按「库 + schema」派生：角色是集群级对象，同一集群上各宿主（不同库或同库不同 schema）各用各的角色与口令，
 * 启动时互不改写口令，授权也只落在自己的 schema。取 sha256 前 16 位十六进制，名长 38，是普通小写标识符。
 */
export function businessSqlReaderRoleOf(database:string,schema:string):string{
 return businessSqlLegacyReaderRole+'_'+createHash('sha256').update(database+'\u0000'+schema).digest('hex').slice(0,16)
}
/** 口令文件按角色区分：`<secretPath 去掉 .json>.<角色哈希>.json`，同一运行目录换了 schema 也不会拿旧角色的口令。 */
function readerSecretPath(secretPath:string,role:string):string{
 return (secretPath.endsWith('.json')?secretPath.slice(0,-5):secretPath)+'.'+role.slice(businessSqlLegacyReaderRole.length+1)+'.json'
}

export type BusinessSqlExecutionLimits={statementTimeoutMs:number;rowLimit:number;rowBytesLimit:number;resultBytesLimit:number;workMem:string;tempFileLimit:string;concurrencyPerScope:number;concurrencyTotal:number;queueWaitMs:number}
export type BusinessSqlExecution={columns:BusinessWidgetColumn[];rows:Array<Array<string|number|boolean|null>>;rowCount:number;bytes:number;computedAt:string;throttled:boolean}
/** role：只读角色可登录；fallback：非超级用户降级为事务只读 + 白名单；unavailable：超级用户且只读角色不可用（或未配置口令文件），拒绝执行。
 * schema：Teloa 表所在模式（应用连接的 current_schema()，个人版为 public）；授权与改写产物都按它限定。取不到合法模式名时为 unavailable、不带 schema。
 * role：本 schema 的只读角色名（随 schema 一并给出）。 */
export type BusinessSqlRoleStatus={mode:'role'|'fallback'|'unavailable';reason?:string;skippedSettings:string[];schema?:string;role?:string}

/** 白名单解析器（libpg-query）内置的 PG 语法主版本：取包的主版本号，随依赖升级自动跟上。 */
export const businessSqlParserMajor=Number((createRequire(import.meta.url)('libpg-query/package.json') as {version:string}).version.split('.')[0])
/**
 * 数据库主版本与解析器主版本的关系（执行器每次在边界基线里读 server_version_num 判定）：
 *  - 低于 14：拒绝——白名单按 PG14+ 的语法形态（COERCE_SQL_SYNTAX 等）写，老版本不在支持面。
 *  - 14 到解析器主版本之间：放行；低于解析器时记录一次。执行的是由语法树 deparse 出、再经二次校验的改写产物，
 *    不是用户原文；只有新版才有的语法在旧库上执行时被库拒绝（42601 → invalid-input），不会被旧库解释成别的意思。
 *  - 高于解析器主版本：拒绝——新版语法的语义解析器不认识，白名单无法担保，升级解析器后放行。
 */
export function businessSqlServerSupport(serverVersionNum:number,parserMajor:number=businessSqlParserMajor):'same'|'older'|'unsupported'{
 const major=Math.floor(serverVersionNum/10000)
 if(!Number.isSafeInteger(serverVersionNum)||major<14||major>parserMajor)return 'unsupported'
 return major===parserMajor?'same':'older'
}

const limits=businessDashboardLimits
/** 执行器专用连接池的上限（独立于应用共享池）；全局并发 concurrencyTotal 必须严格小于它。 */
export const businessSqlPoolSize=4
export const businessSqlExecutionDefaults:BusinessSqlExecutionLimits={
 statementTimeoutMs:limits.statementTimeoutMs,rowLimit:limits.resultRows,rowBytesLimit:limits.rowBytes,resultBytesLimit:limits.resultBytes,
 workMem:limits.workMem,tempFileLimit:limits.tempFileLimit,concurrencyPerScope:limits.concurrencyPerScope,concurrencyTotal:businessSqlPoolSize-1,queueWaitMs:limits.queueWaitMs,
}

const sqlState=(error:unknown):string|undefined=>error instanceof DatabaseError&&typeof error.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:undefined
const megabytes=(bytes:number)=>String(Math.round(bytes/1_048_576*100)/100)
const unavailable=(reason:string)=>new WorkError('teloa/dependency-unavailable',reason)
const invalid=(reason:string)=>new WorkError('teloa/invalid-input',reason)
const aborted=()=>unavailable('查询已中止')
const refused=()=>unavailable('看板查询暂不可用')
const forbiddenReason='当前主体未获准读取此业务范围'

/** SET 阶段：每条独立执行。skippable 的几条遇 42501（如托管库上 temp_file_limit 仅超级用户可设）跳过；超时与搜索路径不许跳过。值只来自校验过的 limits，不来自声明。
 * temp_file_limit 是超级用户级参数，只读角色设不了：role 模式改由初始化时 `alter role … set temp_file_limit` 在角色级固定（语句里也改不掉），这里不再设。 */
const settingsOf=(value:BusinessSqlExecutionLimits)=>[
 {name:'statement_timeout',sql:`set local statement_timeout='${value.statementTimeoutMs}ms'`,skippable:false},
 {name:'work_mem',sql:`set local work_mem='${value.workMem}'`,skippable:true},
 {name:'temp_file_limit',sql:`set local temp_file_limit='${value.tempFileLimit}'`,skippable:true},
 {name:'search_path',sql:'set local search_path=pg_temp',skippable:false},
]

/** 在保存点里执行一条可能 42501 的语句：42501 回到保存点、事务继续，返回 false；其他错误照常抛。 */
async function tryInSavepoint(client:PoolClient,sql:string):Promise<boolean>{
 await client.query('savepoint teloa_business_boundary')
 let denied=false
 try{await client.query(sql)}catch(error){
  if(sqlState(error)!=='42501')throw error
  denied=true
  await client.query('rollback to savepoint teloa_business_boundary')
 }
 await client.query('release savepoint teloa_business_boundary')
 return !denied
}

async function applySettings(client:PoolClient,value:BusinessSqlExecutionLimits,roleLevelTempFileLimit=false):Promise<string[]>{
 const skipped:string[]=[]
 for(const setting of settingsOf(value)){
  if(roleLevelTempFileLimit&&setting.name==='temp_file_limit')continue
  if(!setting.skippable)await client.query(setting.sql)
  else if(!(await tryInSavepoint(client,setting.sql)))skipped.push(setting.name)
 }
 return skipped
}

/** 边界快照：事务时刻、会话用户（及其是否超级用户）与语句可能改动的会话参数。执行前后各读一次，参数不同即说明语句里有人改了边界。 */
const boundarySql=`select now() as computed_at, current_database()::text as database, session_user::text as session_user, (select rolsuper from pg_catalog.pg_roles where rolname=session_user) as session_super,
 current_setting('server_version_num')::int as server_version, concat_ws(chr(31), session_user, current_user, current_setting('role'), current_setting('search_path'), current_setting('statement_timeout'),
 current_setting('work_mem'), current_setting('temp_file_limit'), current_setting('transaction_read_only'), current_setting('transaction_isolation')) as state`
async function readBoundary(client:PoolClient):Promise<{computedAt:string;database:string;sessionUser:string;sessionSuper:boolean;serverVersion:number;state:string}>{
 const row=(await client.query<{computed_at:Date;database:string;session_user:string;session_super:boolean|null;server_version:number;state:string}>(boundarySql)).rows[0]!
 return {computedAt:row.computed_at.toISOString(),database:row.database,sessionUser:row.session_user,sessionSuper:row.session_super!==false,serverVersion:row.server_version,state:row.state}
}

/**
 * PG 错误 → 平台错误。报错文本一律固定文案 + SQLSTATE，不透出 PG 原文：原文可能带表名、约束名、列名，
 * 类型转换错误（22P02 等）还会带出取值本身。
 */
const syntaxReasons:Readonly<Record<string,string>>={
 '42601':'查询语法错误','42P01':'查询引用了不存在的表','42703':'查询引用了不存在的列','42883':'查询调用了不存在的函数或参数类型不符',
 '42804':'查询里的数据类型不匹配','42P18':'查询里有无法确定类型的值','42803':'查询的分组或聚合用法不正确',
}
function mapExecutionError(error:unknown,value:BusinessSqlExecutionLimits):WorkError{
 if(error instanceof WorkError)return error
 const code=sqlState(error)
 if(!code)return unavailable('数据库暂不可用')
 // 服务端只记 SQLSTATE 与出错的 PG 内部例程名，不记原文（原文可能带表名、列名与取值）。
 console.warn('[teloa] 看板 SQL 执行失败：SQLSTATE '+code+'（'+((error as DatabaseError).routine??'unknown')+'）')
 if(code==='57014')return unavailable(`查询超过 ${value.statementTimeoutMs/1000} 秒已中止`)
 if(code==='42501')return new WorkError('teloa/forbidden',forbiddenReason)
 if(code==='53400')return unavailable('查询临时文件超限')
 if(code==='25006')return new WorkError('teloa/forbidden','查询只允许读取，不能写入')
 if(code.startsWith('42'))return invalid(`${syntaxReasons[code]??'查询不合法'}（SQLSTATE ${code}）`)
 if(['08','28','53','57','58','XX'].includes(code.slice(0,2)))return unavailable(`查询执行中断（SQLSTATE ${code}）`)
 return invalid(`查询执行失败（SQLSTATE ${code}）`)
}

/** 结果单元按列类型从 PG 文本表示转换；取值全部以文本收（types 覆盖为原样返回），避免 int8/numeric 的默认解析与时区相关的 Date 解析。 */
const numberTypes=new Set([20,21,23,26,700,701,1700])
const parseTimestamptz=types.getTypeParser(1184) as (value:string)=>unknown
const isoOf=(value:unknown)=>value instanceof Date&&!Number.isNaN(value.getTime())?value.toISOString():null
const rawText={getTypeParser:()=>(value:string)=>value} as unknown as {getTypeParser:typeof types.getTypeParser}
function columnOf(field:FieldDef):{column:BusinessWidgetColumn;convert:(value:string)=>BusinessWidgetCell}{
 const name=field.name,oid=field.dataTypeID
 if(numberTypes.has(oid))return {column:{name,type:'number'},convert:value=>{const number=Number(value);return Number.isFinite(number)?number:null}}
 if(oid===16)return {column:{name,type:'boolean'},convert:value=>value==='t'}
 if(oid===1184)return {column:{name,type:'datetime'},convert:value=>isoOf(parseTimestamptz(value))}
 // 不带时区的 timestamp 一律按 UTC 解释，结果不随宿主时区漂移；date 保持 YYYY-MM-DD 原样。
 if(oid===1114)return {column:{name,type:'datetime'},convert:value=>isoOf(parseTimestamptz(value+'+00'))}
 if(oid===1082)return {column:{name,type:'datetime'},convert:value=>value}
 if(oid===2278||oid===705)return {column:{name,type:'null'},convert:()=>null}
 return {column:{name,type:'text'},convert:value=>value}
}

const memorySetting=/^[1-9][0-9]{0,6}(kB|MB|GB)$/
function checkedLimits(value:BusinessSqlExecutionLimits):BusinessSqlExecutionLimits{
 const counts=[value.statementTimeoutMs,value.rowLimit,value.rowBytesLimit,value.resultBytesLimit,value.concurrencyPerScope,value.concurrencyTotal,value.queueWaitMs]
 if(!counts.every(count=>Number.isSafeInteger(count)&&count>0)||!memorySetting.test(value.workMem)||!memorySetting.test(value.tempFileLimit))throw Error('看板 SQL 执行上限配置不合法。')
 return {...value}
}

/**
 * 只读角色口令文件 `{"password":"…"}`：0600、非符号链接、属主为当前进程用户（非 POSIX 平台无 getuid，跳过属主核对）；
 * 不存在时生成（crypto 随机 32 字节 base64url）：先写同目录临时文件并 fsync，再 link 到正式路径——正式路径要么不存在、要么是写完整的文件，
 * 并发初始化输掉 link 的一方读赢家那份。临时文件无论成败都删。口令不入日志、不入回包；解析失败只报固定文案，不带文件原文。
 */
async function readerPassword(path:string,create:boolean):Promise<string>{
 const malformed=()=>new WorkError('teloa/storage-unavailable','只读角色口令文件格式不正确')
 try{
  const entry=await lstat(path)
  if(entry.isSymbolicLink()||!entry.isFile()||(entry.mode&0o077)!==0||(process.getuid&&entry.uid!==process.getuid()))throw new WorkError('teloa/storage-unavailable','只读角色口令文件身份或权限不正确')
  let value:unknown
  try{value=JSON.parse(await readFile(path,'utf8'))}catch{throw malformed()}
  const password=isRecord(value)?value.password:undefined
  if(typeof password!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(password))throw malformed()
  return password
 }catch(error){
  if(!create||(error as NodeJS.ErrnoException|null)?.code!=='ENOENT')throw error
 }
 const password=randomBytes(32).toString('base64url')
 const temporary=`${path}.${randomBytes(8).toString('hex')}.tmp`
 try{
  const file=await open(temporary,'wx',0o600)
  try{
   await file.writeFile(JSON.stringify({password})+'\n','utf8')
   await file.sync()
  }finally{await file.close()}
  try{await link(temporary,path)}catch(error){
   if((error as NodeJS.ErrnoException|null)?.code==='EEXIST')return readerPassword(path,false)
   throw error
  }
  return password
 }finally{await unlink(temporary).catch(()=>{})}
}

/** 客户端算好的 SCRAM-SHA-256 校验值（RFC 5802/7677）：`alter role … password` 只送校验值，明文口令不经数据库语句日志。 */
function scramVerifier(password:string):string{
 const salt=randomBytes(16),iterations=4096,salted=pbkdf2Sync(password,salt,iterations,32,'sha256')
 const hmac=(text:string)=>createHmac('sha256',salted).update(text).digest()
 const storedKey=createHash('sha256').update(hmac('Client Key')).digest()
 return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${hmac('Server Key').toString('base64')}`
}

function readerConfig(base:PoolConfig,role:string,password:string):PoolConfig{
 if(typeof base.connectionString!=='string')return {...base,user:role,password}
 const url=new URL(base.connectionString)
 url.username=role
 url.password=password
 return {...base,connectionString:url.toString()}
}

/**
 * 执行器专用连接池的配置（与应用共享池分开，上限 businessSqlPoolSize）：role 模式按本角色的口令文件以只读角色登录，其余模式沿用应用的连接配置。
 * 用法：`new BusinessSqlExecutor(new Pool(await businessSqlPoolConfig({connectionString},status,口令文件)),identity,status.mode,undefined,status.schema)`；
 * secretPath 与初始化时传的同一个，实际文件按 status.role 区分。
 */
export async function businessSqlPoolConfig(base:PoolConfig,status:Pick<BusinessSqlRoleStatus,'mode'|'role'>,secretPath:string):Promise<PoolConfig>{
 if(status.mode==='role'&&!status.role)throw Error('看板 SQL 只读角色状态缺少角色名。')
 const config=status.mode==='role'?readerConfig(base,status.role!,await readerPassword(readerSecretPath(secretPath,status.role!),false)):{...base}
 return {...config,max:businessSqlPoolSize}
}

/**
 * 角色：本库本 schema 专用的 `businessSqlReaderRoleOf(current_database(), current_schema())`，仅 `select on <schema>.teloa_business_object_snapshots`、
 * `execute on <schema>.teloa_safe_*`；可登录，口令为随机生成、存运行目录口令文件（按角色区分，0600，已有则复用），执行器专用池以它直接登录。
 * temp_file_limit 由超级用户在角色级固定。同一集群上其他宿主用的是各自的角色，本宿主启动不改它们的口令，也不在别的 schema 上授权。
 * 旧版共用角色 `teloa_business_reader` 若存在：只收回它在**本 schema** 上的授权（public 与其他 schema 不动，角色不删）。
 * 环境判定（按 pg_roles 实测，不猜）：
 *  - 本 schema 的四个安全转换函数属主既不是当前用户、也不是超级用户（他人抢先建了同名函数，之后还能改函数体）→ unavailable，不论何种身份。
 *  - 超级用户（个人版 `teloa`）：全部可做 → role；任何一步不成立 → unavailable（**不许**降级为以超级用户身份执行的事务只读），告警记原因。
 *  - 有 createrole 的非超级用户，且与建表方同一用户：自己建的角色自带 ADMIN，能设登录口令 → role（temp_file_limit 设不了，列入 skippedSettings）。
 *  - 无 createrole：fallback（事务只读 + 改写器只引用快照表），reason 注明「无 createrole 权限」，告警。
 *  - 角色由别人建过、当前用户没有 ADMIN：设登录口令报 42501 → fallback，reason 注明「无权设置只读角色的登录口令」。
 * 超级用户路径把只读角色属性显式收回到最小（nosuperuser … nobypassrls、connection limit 8）。PUBLIC 能在本 schema 建对象时：
 * schema 不是 public 且当前用户能以属主身份操作 → 收回；schema 是 public（整库共用的命名空间，收回会改到同库其他应用）或做不到 → 列入 skippedSettings（public_schema_create）。
 * 最后以只读角色真实登录一次，核对 session_user、快照表 select 权限、角色属性全为假且不是任何角色的成员；不成立按上面的环境降级。不阻断启动。
 * 未给 secretPath（如安装期初始化）：不做任何角色工作，返回 unavailable，不告警。
 */
export async function initializeBusinessSqlRole(pool:Pool,secretPath?:string):Promise<BusinessSqlRoleStatus>{
 if(!secretPath)return {mode:'unavailable',reason:'未配置只读角色口令文件位置',skippedSettings:[]}
 const where=(await pool.query<{schema:string|null;database:string}>('select current_schema() as schema, current_database()::text as database')).rows[0]
 const schema=where?.schema
 if(!isBusinessSqlPlatformSchema(schema)){
  console.warn('[teloa] 看板查询不可用：Teloa 表所在模式名不是普通小写标识符。')
  return {mode:'unavailable',reason:'Teloa 表所在模式名不受支持',skippedSettings:[]}
 }
 const role=businessSqlReaderRoleOf(where!.database,schema)
 const foreign=(await pool.query(`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles o on o.oid=p.proowner
   where n.nspname=$1 and p.proname=any($2) and o.rolname<>current_user and not o.rolsuper`,[schema,[...businessSafeFunctions]])).rowCount
 if(foreign){
  console.warn('[teloa] 看板查询不可用：安全转换函数属主不是 Teloa 数据库用户。')
  return {mode:'unavailable',reason:'安全转换函数属主不是 Teloa 数据库用户',skippedSettings:[],schema,role}
 }
 const self=(await pool.query<{rolsuper:boolean;rolcreaterole:boolean}>('select rolsuper, rolcreaterole from pg_roles where rolname=current_user')).rows[0]
 const superuser=self?.rolsuper===true
 const degrade=async(reason:string):Promise<BusinessSqlRoleStatus>=>{
  if(superuser){
   console.warn('[teloa] 看板查询不可用：'+reason+'。超级用户不降级为事务只读执行。')
   return {mode:'unavailable',reason,skippedSettings:[],schema,role}
  }
  console.warn('[teloa] 看板查询降级为事务只读：'+reason+'。')
  return {mode:'fallback',reason,skippedSettings:await probeSettings(pool),schema,role}
 }
 if(!superuser&&!self?.rolcreaterole)return degrade('当前数据库用户无 createrole 权限')
 const reasons={create:'无法建立只读角色',grant:'当前数据库用户无权把快照表授予只读角色',secret:'只读角色口令文件不可用',login:'当前数据库用户无权设置只读角色的登录口令',probe:'只读角色无法登录或读取快照表'}
 const functions=businessSafeFunctions.map(name=>`${schema}.${name}(text)`).join(', ')
 let stage:keyof typeof reasons='create',tempFileLimitFixed=false,publicCreateSkipped=false
 try{
  const exists=(await pool.query('select 1 from pg_roles where rolname=$1',[role])).rowCount===1
  if(!exists)await pool.query(`create role ${role} nologin`).catch((error:unknown)=>{if(sqlState(error)!=='42710')throw error})
  stage='grant'
  await pool.query(`grant usage on schema ${schema} to ${role}`)
  await pool.query(`grant select on ${schema}.teloa_business_object_snapshots to ${role}`)
  await pool.query(`grant execute on function ${functions} to ${role}`)
  // 旧版共用角色：只收回本 schema 上的三组授权。不是授权方时 PG 只发警告；当前用户对对象毫无权限（42501）时跳过，不影响本角色。
  if((await pool.query('select 1 from pg_roles where rolname=$1',[businessSqlLegacyReaderRole])).rowCount===1){
   for(const sql of [`revoke all on ${schema}.teloa_business_object_snapshots from ${businessSqlLegacyReaderRole}`,`revoke all on function ${functions} from ${businessSqlLegacyReaderRole}`,`revoke all on schema ${schema} from ${businessSqlLegacyReaderRole}`])
    await pool.query(sql).catch((error:unknown)=>{if(sqlState(error)!=='42501')throw error})
  }
  // 旧库（PG14 及以前）默认 PUBLIC 可在 public schema 建对象。只收回 Teloa 专用 schema 上的；public 是整库共用的命名空间，不替同库其他应用改。
  const publicCreate=(await pool.query<{create:boolean;owner:boolean}>("select has_schema_privilege('public', nspname, 'create') as create, pg_has_role(current_user, nspowner, 'member') as owner from pg_namespace where nspname=$1",[schema])).rows[0]
  if(publicCreate?.create){
   if(schema!=='public'&&publicCreate.owner)await pool.query(`revoke create on schema ${schema} from public`)
   else publicCreateSkipped=true
  }
  stage='secret'
  const password=await readerPassword(readerSecretPath(secretPath,role),true)
  stage='login'
  await pool.query(`alter role ${role} with login password '${scramVerifier(password)}'`)
  // 同名角色可能被预先建成带多余属性：超级用户路径显式收回到最小（非超级用户改不了这些属性，交给下面的探测核对）。
  if(superuser)await pool.query(`alter role ${role} with nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 8`)
  tempFileLimitFixed=await pool.query(`alter role ${role} set temp_file_limit='${businessSqlExecutionDefaults.tempFileLimit}'`).then(()=>true,(error:unknown)=>{
   if(sqlState(error)!=='42501')throw error
   return false
  })
  stage='probe'
  const probe=new Client(readerConfig(pool.options,role,password))
  probe.on('error',()=>{})
  try{
   await probe.connect()
   const row=(await probe.query<{who:string;readable:boolean;elevated:boolean;memberships:number}>(`select session_user::text as who, has_table_privilege($1,'select') as readable,
     (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls) as elevated,
     (select count(*)::int from pg_auth_members where member=r.oid) as memberships from pg_roles r where r.rolname=session_user`,[schema+'.teloa_business_object_snapshots'])).rows[0]
   if(row?.who!==role||!row.readable)return degrade(reasons.probe)
   if(row.elevated||row.memberships!==0)return degrade('只读角色带有多余的角色属性或角色成员资格')
  }finally{await probe.end().catch(()=>{})}
 }catch(error){
  const code=sqlState(error)
  if(!code&&stage!=='secret'&&stage!=='probe')throw error
  return degrade(reasons[stage]+(code?`（SQLSTATE ${code}）`:''))
 }
 return {mode:'role',skippedSettings:[...(tempFileLimitFixed?[]:['temp_file_limit']),...(publicCreateSkipped?['public_schema_create']:[])],schema,role}
}

async function probeSettings(pool:Pool):Promise<string[]>{
 const client=await pool.connect()
 try{
  await client.query('begin read only')
  try{return await applySettings(client,businessSqlExecutionDefaults)}finally{await client.query('rollback')}
 }finally{client.release()}
}

type Slot={active:number;waiting:Array<()=>void>}
/** 全局信号量在 slots 里的键：scopeKey 校验为非空串，空串不会与任何范围相撞。 */
const totalSlot=''

export class BusinessSqlExecutor{
 private readonly pool:Pool
 private readonly mode:BusinessSqlRoleStatus['mode']
 private readonly limits:BusinessSqlExecutionLimits
 private readonly slots=new Map<string,Slot>()
 private readonly skipped=new Set<string>()
 private versionNoted=false
 /** Teloa 表所在模式：改写产物按它限定快照表与安全转换函数（取 initializeBusinessSqlRole 返回的 schema，个人版为 public）。 */
 readonly schema:string
 /** 刷新时刻取库内 now()（与 SQL 里的 now() 同值），不取宿主时钟；identity 保留为与其他服务一致的构造签名。 */
 constructor(pool:Pool,_identity:{now:()=>string},mode:BusinessSqlRoleStatus['mode'],limitsValue:BusinessSqlExecutionLimits=businessSqlExecutionDefaults,schema='public'){
  if(!isBusinessSqlPlatformSchema(schema))throw Error('看板 SQL 快照表模式名不合法。')
  this.pool=pool
  this.mode=mode
  this.schema=schema
  this.limits=checkedLimits(limitsValue)
  if(this.limits.concurrencyTotal>=(pool.options.max??10))throw Error('看板 SQL 全局并发必须小于专用连接池上限。')
 }

 /** 本进程记录：哪些 SET LOCAL 因 42501 被跳过（首次遇到时告警一行，之后静默）。 */
 get skippedSettings():ReadonlySet<string>{return this.skipped}

 /** 只执行改写产物 rewrite.sql（由语法树 deparse、经二次校验），调用方不得把用户原文直接塞进来；超时与行数上限对任何 rewrite 一律生效。
  * 每范围并发 concurrencyPerScope、全局并发 concurrencyTotal（均为**进程内信号量**，多宿主共库不共享——一期已知限制）：超出的排队；
  * 排队与取连接共用一个 queueWaitMs 期限，超过 → 「查询排队超时」。throttled=本次排过队。 */
 async execute(scopeKey:string,rewrite:BusinessSqlRewrite,signal?:AbortSignal):Promise<BusinessSqlExecution>{
  if(typeof scopeKey!=='string'||!scopeKey||typeof rewrite?.sql!=='string'||!rewrite.sql.trim()||!Array.isArray(rewrite.params)||!rewrite.params.every(param=>typeof param==='string'))throw invalid('查询不合法')
  if(this.mode==='unavailable')throw refused()
  if(signal?.aborted)throw aborted()
  const deadline=Date.now()+this.limits.queueWaitMs
  const throttled=await this.acquire(scopeKey,this.limits.concurrencyPerScope,deadline,signal)
  try{
   const waited=await this.acquire(totalSlot,this.limits.concurrencyTotal,deadline,signal)
   try{return {...await this.run(rewrite,deadline,signal),throttled:throttled||waited}}finally{this.release(totalSlot)}
  }finally{this.release(scopeKey)}
 }

 /** 当前排队（未开始执行）的条数。 */
 pending(scopeKey:string):number{return this.slots.get(scopeKey)?.waiting.length??0}

 private acquire(scopeKey:string,capacity:number,deadline:number,signal?:AbortSignal):Promise<boolean>{
  const slot=this.slots.get(scopeKey)??{active:0,waiting:[]}
  this.slots.set(scopeKey,slot)
  if(slot.active<capacity){slot.active++;return Promise.resolve(false)}
  return new Promise((resolve,reject)=>{
   const settle=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort)}
   // 放行时名额由 release 直接交接（active 不减），这里不再加一。
   const grant=()=>{settle();resolve(true)}
   const leave=(error:WorkError)=>{
    settle()
    const index=slot.waiting.indexOf(grant)
    if(index>=0)slot.waiting.splice(index,1)
    this.tidy(scopeKey,slot)
    reject(error)
   }
   const onAbort=()=>leave(aborted())
   const timer=setTimeout(()=>leave(unavailable('查询排队超时')),Math.max(0,deadline-Date.now()))
   signal?.addEventListener('abort',onAbort,{once:true})
   slot.waiting.push(grant)
  })
 }

 private release(scopeKey:string){
  const slot=this.slots.get(scopeKey)
  if(!slot)return
  const next=slot.waiting.shift()
  if(next){next();return}
  slot.active--
  this.tidy(scopeKey,slot)
 }

 private tidy(scopeKey:string,slot:Slot){if(!slot.active&&!slot.waiting.length)this.slots.delete(scopeKey)}

 /** 从专用连接池取连接，等待受排队期限与中止信号约束；输掉竞争的连接到手后直接销毁。 */
 private connect(deadline:number,signal?:AbortSignal):Promise<PoolClient>{
  const connecting=this.pool.connect()
  return new Promise((resolve,reject)=>{
   let settled=false
   const settle=()=>{settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort)}
   const quit=(error:WorkError)=>{if(!settled){settle();reject(error)}}
   const onAbort=()=>quit(aborted())
   const timer=setTimeout(()=>quit(unavailable('查询排队超时')),Math.max(0,deadline-Date.now()))
   signal?.addEventListener('abort',onAbort,{once:true})
   connecting.then(client=>{if(settled)client.release(true);else{settle();resolve(client)}},(error:unknown)=>{if(!settled){settle();reject(error)}})
  })
 }

 private async run(rewrite:BusinessSqlRewrite,deadline:number,signal?:AbortSignal):Promise<Omit<BusinessSqlExecution,'throttled'>>{
  let client:PoolClient|undefined,clean=false
  try{
   client=await this.connect(deadline,signal)
   await client.query('begin isolation level repeatable read read only')
   for(const name of await applySettings(client,this.limits,this.mode==='role')){
    if(this.skipped.has(name))continue
    this.skipped.add(name)
    console.warn('[teloa] 看板 SQL 执行边界：当前数据库用户无权设置 '+name+'（42501），已跳过该项，其余边界照常生效。')
   }
   const boundary=await readBoundary(client)
   const expectedRole=businessSqlReaderRoleOf(boundary.database,this.schema)
   const identityProblem=this.mode==='role'
    ?(boundary.sessionUser!==expectedRole?'专用连接池的会话用户不是只读角色 '+expectedRole:boundary.sessionSuper?'只读角色 '+expectedRole+' 是超级用户':undefined)
    :(boundary.sessionSuper?'事务只读降级不允许以超级用户身份执行':undefined)
   if(identityProblem){
    console.warn('[teloa] 看板查询拒绝执行：'+identityProblem+'。')
    throw refused()
   }
   const support=businessSqlServerSupport(boundary.serverVersion)
   if(support==='unsupported')throw unavailable(`数据库版本不在看板查询支持范围（PostgreSQL ${Math.floor(boundary.serverVersion/10000)}）`)
   if(support==='older'&&!this.versionNoted){
    this.versionNoted=true
    console.warn('[teloa] 看板 SQL 解析器按 PostgreSQL '+businessSqlParserMajor+' 语法校验，当前数据库是 PostgreSQL '+Math.floor(boundary.serverVersion/10000)+'：仅新版才有的语法会在执行时被数据库拒绝。')
   }
   const result=await this.stream(client,rewrite,signal)
   if((await readBoundary(client)).state!==boundary.state)throw new WorkError('teloa/forbidden','查询不允许修改执行边界')
   await client.query('rollback')
   await client.query('select pg_advisory_unlock_all()')
   clean=true
   return {...result,computedAt:boundary.computedAt}
  }catch(error){
   throw mapExecutionError(error,this.limits)
  }finally{
   client?.release(!clean)
  }
 }

 /**
  * 流式收行：不让驱动先把整份结果攒进内存。行数、单行字节、累计字节任一超限，或中止信号到来，
  * 立即记下原因并对本连接发协议级 CancelRequest（不借池里的连接），等语句结束（被取消或恰好跑完）后以记下的原因失败。
  * 用户 SQL 放进子查询、另起一行收尾：行注释注释不掉外包的 limit；扩展协议下多语句直接被 PG 拒绝。
  */
 private stream(client:PoolClient,rewrite:BusinessSqlRewrite,signal?:AbortSignal):Promise<{columns:BusinessWidgetColumn[];rows:BusinessWidgetCell[][];rowCount:number;bytes:number}>{
  const limit=this.limits,values=[...rewrite.params,String(limit.rowLimit+1)]
  const text='select * from (\n'+rewrite.sql+'\n) as teloa_result limit $'+values.length
  return new Promise((resolve,reject)=>{
   if(signal?.aborted)return reject(aborted())
   const rows:BusinessWidgetCell[][]=[]
   let bytes=0,columns:ReturnType<typeof columnOf>[]|undefined,failure:WorkError|undefined
   const stop=(error:WorkError)=>{
    if(failure)return
    failure=error
    // 协议级取消：新开一条裸连接，发本连接的 processID/secretKey（CancelRequest），不走任何连接池；连不上时语句仍受 statement_timeout 兜底。
    // 不用 Client#cancel：它按已弃用的 activeQuery 判定，查询已发上线时只会静默丢弃回调、不发取消。
    const target=client as unknown as {host:string;port:number;processID:number;secretKey:number}
    // @types/pg 未声明 Connection 的 connect/cancel（运行时 pg 8.23 lib/connection.js 有）。
    const canceller=new Connection() as Connection&{connect(port:number|string,host?:string):void;cancel(processID:number,secretKey:number):void}
    canceller.on('error',()=>{})
    canceller.on('connect',()=>canceller.cancel(target.processID,target.secretKey))
    if(target.host.startsWith('/'))canceller.connect(target.host+'/.s.PGSQL.'+target.port)
    else canceller.connect(target.port,target.host)
   }
   const onAbort=()=>stop(aborted())
   const finish=(error?:unknown)=>{
    signal?.removeEventListener('abort',onAbort)
    if(failure)reject(failure)
    else if(error)reject(error)
    else resolve({columns:(columns??[]).map(entry=>entry.column),rows,rowCount:rows.length,bytes})
   }
   const config:QueryArrayConfig<string[]>={text,values,rowMode:'array',types:rawText}
   const query=client.query(new Query(config))
   signal?.addEventListener('abort',onAbort,{once:true})
   query.on('row',(row:Array<string|null>,result)=>{
    if(failure)return
    columns??=(result?.fields??[]).map(columnOf)
    if(rows.length>=limit.rowLimit)return stop(invalid(`结果超过 ${limit.rowLimit.toLocaleString('en-US').replaceAll(',',' ')} 行`))
    const cells=row.map((value,index)=>value===null?null:columns![index]!.convert(value))
    const size=Buffer.byteLength(JSON.stringify(cells))
    if(size>limit.rowBytesLimit)return stop(invalid(`单行超过 ${megabytes(limit.rowBytesLimit)} MB`))
    if(bytes+size>limit.resultBytesLimit)return stop(invalid(`结果超过 ${megabytes(limit.resultBytesLimit)} MB`))
    bytes+=size
    rows.push(cells)
   })
   query.on('error',error=>finish(error))
   query.on('end',result=>{columns??=(result.fields??[]).map(columnOf);finish()})
  })
 }
}
