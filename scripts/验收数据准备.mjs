/**
 * 浏览器验收的数据准备：把仓库里已有的固定数据脚本指到**验收宿主**的运行目录与临时 schema，
 * 再补两处验收脚本点名、但固定数据脚本不造的夹具（空工具验收岗位、仓库外夹具工作区）。
 *
 * 分档（`TELOA_ACCEPTANCE_SEED=minimal|full`，`1` 等同 `full` 向后兼容）：
 * - `full`：维持原有行为——先跑 `准备本机工作目录.mjs` / `准备知识库示例.mjs`（含 3 条已启用计划），
 *   再补空工具验收岗位与夹具工作区。
 * - `minimal`：只补空工具验收岗位与夹具工作区，不跑那两个会灌计划与行业加载的脚本。
 *   给「断言『已有启用计划则拒绝』」的定时计划两条验收脚本用——它们与 `full` 灌的 3 条已启用计划互斥。
 *   `准备本机工作目录.mjs` 是一段不可分步调用的顶层脚本（无 profile 参数、无法只执行其中一部分），
 *   所以 `minimal` 不去裁剪它，而是直接跳过整段调用。
 *
 * 安全边界（本文件存在的首要理由）：
 * - 只认验收启动器写出的 `<运行目录>/database.json`，其连接串必须带 `-c search_path=teloa_e2e_…`；
 *   不匹配一律拒绝执行。正式 3100 的 `.runtime/teloa` 既不带该 options、也被单独拒绝一次。
 * - 只读环境变量，不接受命令行里的目标路径，避免"看起来像验收"的参数把数据灌进正式库。
 * - 不复制任何凭据：本机模型凭据由验收启动器的 `TELOA_ACCEPTANCE_REUSE_LOCAL_MODEL=1` 负责。
 *
 * 用法：`TELOA_RUNTIME_ROOT=<验收运行目录> TELOA_ACCEPTANCE_SEED=minimal|full node scripts/验收数据准备.mjs`
 * 由 `scripts/启动浏览器验收.mjs` 在 `TELOA_ACCEPTANCE_SEED` 非空时自动调用（并透传归一化后的档位）。
 */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {RoleService} from '../packages/backend/src/index.ts'

const projectRoot=fileURLToPath(new URL('../',import.meta.url))
const {Pool}=createRequire(resolve(projectRoot,'packages/backend/package.json'))('pg')
const formalRuntimeRoot=resolve(projectRoot,'.runtime/teloa')
const ownerId='local:teloa-owner'
// 与验收启动器 `quoteIdentifier` 同一判据：schema 名字本身就是"这是验收库"的唯一证据。
const acceptanceSchemaPattern=/^teloa_e2e_[a-f0-9]{24}$/
// 夹具工作区不能落在仓库内 `.runtime/` 之外：`runtime-paths.ts` 的 workspaceRefusedForRepository
// 会把这类目录判成不可用于新建会话，所以固定放到仓库外的临时目录。
const fixtureWorkspaceRoot=resolve(tmpdir(),'teloa-e2e-workspaces')
const fixtureWorkspaceNames=['目录甲','目录乙']
// 两条定时计划脚本按这个固定身份找"不带任何授权工具"的岗位。
const emptyToolRoleId='3958a10b-9ce8-4220-ac8b-638d4cbd6bb4'

/** 与 `准备本机工作目录.mjs` 同一做法：按名字派生稳定 requestId，重复执行收敛到同一条记录。 */
function requestId(name){
 const bytes=Buffer.from(createHash('sha256').update('teloa-acceptance-seed:v1:'+name).digest().subarray(0,16))
 bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

/** 解析 `TELOA_ACCEPTANCE_SEED`：`1`/`full` 走原有整包流程，`minimal` 只做空工具岗位与夹具工作区。 */
function resolveSeedMode(raw){
 if(raw===undefined||raw==='1'||raw==='full')return 'full'
 if(raw==='minimal')return 'minimal'
 throw Error('TELOA_ACCEPTANCE_SEED 只允许设为 minimal 或 full（1 等同 full）。')
}

/** 守卫：解析出验收 schema 名并逐条核对；任何一处不成立都在写任何数据之前拒绝。 */
async function assertAcceptanceTarget(runtimeRoot){
 if(!runtimeRoot)throw Error('验收数据准备需要 TELOA_RUNTIME_ROOT 指向验收宿主的运行目录。')
 const root=resolve(runtimeRoot)
 if(root===formalRuntimeRoot)throw Error('验收数据准备拒绝写入正式运行目录。')
 let config
 try{config=JSON.parse(await readFile(resolve(root,'database.json'),'utf8'))}
 catch{throw Error('验收运行目录下没有可读的 database.json；请先由验收启动器创建验收 schema。')}
 if(typeof config.connectionString!=='string')throw Error('验收数据库配置格式不正确。')
 const schema=/^-c search_path=(\S+)$/.exec(new URL(config.connectionString).searchParams.get('options')??'')?.[1]
 if(!schema||!acceptanceSchemaPattern.test(schema))throw Error('验收数据准备只允许写入 teloa_e2e_ 开头的验收 schema；当前目标不是验收库，已拒绝执行。')
 return {root,schema,connectionString:config.connectionString}
}

function runPreparationScript(name,root){
 return new Promise((done,fail)=>{
  const child=spawn(process.execPath,[resolve(projectRoot,'scripts',name)],{cwd:projectRoot,env:{...process.env,TELOA_RUNTIME_ROOT:root},stdio:['ignore','ignore','inherit']})
  child.once('error',fail)
  child.once('exit',(code,signal)=>code===0?done():fail(Error(name+(signal?' 被 '+signal+' 中止':' 退出码 '+code))))
 })
}

/**
 * 一位固定身份、不带任何技能与资料引用的在岗同事。
 * `RoleService.create` 的行 ID 取 `identity.id()`，所以固定 identity 即可落固定 ID；
 * 重复执行按固定 requestId 命中既有记录并原样返回，不会新增第二条。
 */
async function ensureEmptyToolRole(pool){
 const service=new RoleService(pool,{id:()=>emptyToolRoleId,now:()=>new Date().toISOString()})
 const role=await service.create(ownerId,{
  requestId:requestId('role:empty-tool'),
  fields:{
   name:'空工具验收岗位',kind:'employee',scopes:['general'],
   duty:'只按计划目标的文字回复，用于验收定时调度链路。',
   dataScope:'不读取任何资料；只使用计划目标本身的文字。',
   executionScope:'没有任何授权工具；不执行、不外发、不改动任何对象。',
   skills:[],knowledge:[],
   responsibility:{
    triggers:['被定时计划按调度触发'],
    autonomousActions:['按计划目标的文字生成一句纯文本回复'],
    confirmationPoints:['除纯文本回复外的任何动作都交回本人'],
    escalationRules:['目标不清楚时说明阻塞并回流，不自行补设定'],
    deliveryChecks:['交付只含一句纯文本，不含工具调用'],
   },
  },
 })
 if(role.id!==emptyToolRoleId)throw Error('空工具验收岗位没有落到固定身份，已停止准备。')
 if(role.state!=='active'||role.skills.length||role.knowledge.length)throw Error('空工具验收岗位的状态或能力声明不符合验收前置。')
 return role
}

/** 仓库外的夹具工作区目录；只建目录，不代替本人在工作区设置里登记。 */
async function ensureFixtureWorkspaces(){
 await mkdir(fixtureWorkspaceRoot,{recursive:true,mode:0o700})
 for(const name of fixtureWorkspaceNames)await mkdir(resolve(fixtureWorkspaceRoot,name),{recursive:true,mode:0o700})
 return fixtureWorkspaceNames.map(name=>resolve(fixtureWorkspaceRoot,name))
}

const seedMode=resolveSeedMode(process.env.TELOA_ACCEPTANCE_SEED?.trim())
const {root,schema,connectionString}=await assertAcceptanceTarget(process.env.TELOA_RUNTIME_ROOT?.trim())
if(seedMode==='full'){
 await runPreparationScript('准备本机工作目录.mjs',root)
 await runPreparationScript('准备知识库示例.mjs',root)
}
const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:15000})
try{
 const role=await ensureEmptyToolRole(pool)
 const workspaces=await ensureFixtureWorkspaces()
 console.log(JSON.stringify({seeded:true,mode:seedMode,schema,runtimeRoot:root,emptyToolRole:{id:role.id,state:role.state},fixtureWorkspaces:workspaces},null,2))
}finally{await pool.end()}
