import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {prepareRuntimeProfile} from '../scripts/runtime/profile.mjs'
import {runManagedNativeProfile} from '../scripts/runtime/native-runtime-entry.mjs'

// 真实宿主：官方注册器挂载的预设常驻作用域 → sessionController.create → 系统提示装配（即发给模型提供方的工具面）。
// 根因（官方 0.2.1-alpha.1）：dsh-agent-tool-presentation 在 ptc 下于 ctx.inject(['ptcRuntime']) 子上下文调用 tools.presentAs，
// 后者还要注册 systemPrompt 段；严格注入下子上下文拿不到未声明的 systemPrompt，呈现回滚为 native。
// 修正只在生成的官方 ptc 预设行上用加载器公开的行级 inject 补依赖，部署默认与标准预设仍为 native。
const programRoot=dirname(dirname(fileURLToPath(import.meta.url)))

test('PTC 预设的真实会话：模型线上的工具面只有 run_code 与生成 SDK；收窄后 SDK 只含获准工具；标准预设仍是 native',{timeout:600000},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-ptc-wire-')))
 const layout={programRoot,runtimeRoot:join(root,'runtime'),workspaceRoot:join(root,'workspace'),dshHome:join(root,'dsh'),profileName:'ptc-wire-'+randomUUID()}
 let container,pool,host
 t.after(async()=>{try{await host?.shutdown?.shutdown(0)}catch{};await pool?.end().catch(()=>{});await container?.stop().catch(()=>{});await rm(root,{recursive:true,force:true})})
 for(const path of [layout.runtimeRoot,layout.workspaceRoot,layout.dshHome])await mkdir(path,{recursive:true,mode:0o700})
 Object.assign(process.env,{DSH_HOME:layout.dshHome,TELOA_DSH_HOME:layout.dshHome,TELOA_PROJECT_ROOT:programRoot,TELOA_RUNTIME_ROOT:layout.runtimeRoot,TELOA_WORKSPACE_ROOT:layout.workspaceRoot,TELOA_DSH_PROFILE:layout.profileName,TELOA_USAGE_STATS:'off',TELOA_MARKET_REMOTE:'off',TELOA_CREDENTIALS_STORE:'file',TELOA_CREDENTIALS_KEY_FILE:join(root,'credentials-key')})
 await writeFile(process.env.TELOA_CREDENTIALS_KEY_FILE,randomBytes(32).toString('hex')+'\n',{mode:0o600})
 if(process.platform==='darwin'&&!process.env.DOCKER_HOST){process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'}
 const require=createRequire(join(programRoot,'packages/backend/package.json')),{Pool}=require('pg'),{PostgreSqlContainer}=require('@testcontainers/postgresql')
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start();pool=new Pool({connectionString:container.getConnectionUri()})
 const backend=await import('../packages/backend/src/index.ts')
 await backend.initializeTeloaDatabase(pool,{businessSqlSecretPath:join(root,'sql-role')})
 await writeFile(join(layout.runtimeRoot,'database.json'),JSON.stringify({connectionString:container.getConnectionUri()})+'\n',{mode:0o600})
 await prepareRuntimeProfile(layout)
 host=await runManagedNativeProfile(layout,['--no-open','--host','127.0.0.1','--port','0'])
 const ctx=host.ctx
 const session=async preset=>{
  const sessionId='ptc-wire-'+preset+'-'+randomUUID()
  const receipt=await ctx.sessionController.create({sessionId,agentPreset:preset});assert.equal(receipt.agentPreset,preset)
  const resolved=await ctx.sessionController.resolveAgent(sessionId);assert.ok(!('error' in resolved))
  return resolved.agent
 }
 const assembled=async agent=>{const value=await ctx.systemPrompt.assemble({scope:agent});return {tools:value.tools.map(tool=>tool.name),sections:value.sections}}
 const ptc=await session('ptc')
 assert.equal(ctx.agentPresets.composedPreset(ptc.ctx),'ptc')
 const wire=await assembled(ptc)
 assert.deepEqual(wire.tools,['run_code'],'PTC 会话发给模型的工具面只有 run_code 传输')
 assert.ok(wire.sections.some(section=>section.name==='tools:sdk'&&section.text.length>0),'附生成 SDK')
 // 受管任务按冻结授权收窄可见工具：保留传输不受影响，SDK 只列获准工具，未授予工具不出现在模型可见面。
 const allow=ptc.ctx.tools.schemas(ptc).map(schema=>schema.name).filter(name=>['write','teloa_group_attach'].includes(name))
 assert.deepEqual(allow.sort(),['teloa_group_attach','write'])
 ptc.ctx.tools.restrict({allow})
 const narrowed=await assembled(ptc),sdk=narrowed.sections.find(section=>section.name==='tools:sdk').text
 assert.deepEqual(narrowed.tools,['run_code'])
 assert.match(sdk,/\bwrite\b/);assert.match(sdk,/teloa_group_attach/)
 // subagent 由官方 dsh-tool-subagent 注册在每个 Agent 自己的作用域层，官方 restrict 按设计不过滤自身层，SDK 仍会列出它；
 // 调用时由任务工具守卫按冻结授权拒绝。这一项广告面缺口单独记录，不在此断言为已解决。
 for(const denied of ['bash','web_fetch','teloa_business_records_write'])assert.doesNotMatch(sdk,new RegExp('\\b'+denied+'\\b'),denied+' 未授予，不能出现在 SDK')
 // 部署默认与 Teloa 标准预设保持 native：不强制全局 PTC。
 const standard=await session('teloa-standard'),plain=await assembled(standard)
 assert.ok(!plain.tools.includes('run_code'));assert.ok(plain.tools.includes('write'));assert.ok(!plain.sections.some(section=>section.name==='tools:sdk'))
})
