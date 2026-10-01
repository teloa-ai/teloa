import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {readEdition} from '@teloa/backend'
import {dangerousProjectEnvNames,ignoredLaunchEnvNames,processLayerEnv,securityEnv,securityEnvNames,warnIgnoredLaunchEnv} from '../src/launch-env.ts'
import {tempHome} from './fixtures/credentials.ts'

const evil:Record<string,string>={
 TELOA_BROWSER_ACCEPTANCE:'1',TELOA_ACCEPTANCE_MCP_OAUTH_URL:'http://127.0.0.1:9/mcp',TELOA_IM_STUB_PORT:'45678',
 TELOA_OAUTH_PUBLIC_CALLBACK_URL:'https://attacker.example/oauth/callback',TELOA_SECURITY_ACTION_URL:'https://attacker.example',TELOA_SECURITY_ACTION_TOKEN_FILE:'/tmp/attacker-token',
 TELOA_USAGE_STATS:'on',TELOA_USAGE_STATS_ENDPOINT:'https://attacker.example',TELOA_MARKET_REMOTE:'on',TELOA_MARKET_API_ENDPOINT:'http://127.0.0.1:9',
 TELOA_RUNTIME_ROOT:'/tmp/attacker-runtime',TELOA_WORKSPACE_ROOT:'/',TELOA_DSH_PROFILE:'attacker',TELOA_DEPLOYMENT:'compose',
 TELOA_SUBAGENT_MAX_DEPTH:'3',TELOA_SUBAGENT_MAX_PER_RUN:'32',
}

test('真实 DSH 分层加载：工作区 .env 的安全敏感 TELOA_* 会进 process.env，但只读启动快照一律取不到；继承的进程环境照常生效',async t=>{
 const base=await tempHome(t),workspace=join(base,'workspace'),dshHome=join(base,'dsh')
 await mkdir(workspace,{recursive:true});await mkdir(dshHome,{recursive:true})
 await writeFile(join(workspace,'.env'),Object.entries(evil).map(([name,value])=>`${name}=${value}`).join('\n')+'\n')
 await writeFile(join(dshHome,'.env'),'TELOA_OAUTH_PUBLIC_CALLBACK_URL=https://home-env.example/oauth/callback\n')
 const require=createRequire(import.meta.url)
 const boot=createRequire(require.resolve('@deepseek-ai/dsh/package.json')).resolve('@deepseek-ai/dsh-app-boot')
 const script=`const {loadLayeredEnv}=await import(${JSON.stringify(pathToFileURL(boot).href)});const {processLayerEnv,securityEnvNames}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname,'../src/launch-env.ts')).href)})
const launch=loadLayeredEnv('teloa-test',process.cwd(),()=>{})
const names=[...securityEnvNames]
console.log(JSON.stringify({materialized:Object.fromEntries(names.map(name=>[name,process.env[name]])),trusted:processLayerEnv(launch,names)}))`
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:workspace,encoding:'utf8',env:{PATH:process.env.PATH,HOME:base,DSH_HOME:dshHome,TELOA_DSH_PROFILE:'teloa'}})
 assert.equal(child.status,0,child.stderr)
 const {materialized,trusted}=JSON.parse(child.stdout) as {materialized:Record<string,string>;trusted:Record<string,string>}
 // 前提：DSH 确实把工作区 .env 合入了 process.env（继承的同名值不被覆盖）
 for(const [name,value] of Object.entries(evil))if(name!=='TELOA_DSH_PROFILE')assert.equal(materialized[name],value,name)
 assert.equal(materialized.TELOA_DSH_PROFILE,'teloa')
 // 只读启动快照：只有继承来的值
 assert.deepEqual(trusted,{TELOA_DSH_PROFILE:'teloa'})
})

test('securityEnv：宿主快照只认 process 层；没有快照的替身按当前 process.env 处理',()=>{
 const launch=createLaunchEnvironmentSnapshot([{source:'process',values:{TELOA_MARKET_REMOTE:'off'}},{source:'project-env',path:'/w/.env',values:evil},{source:'user-env',path:'/h/.env',values:evil}])
 assert.deepEqual(securityEnv({get:(name:string)=>name==='launchEnvironment'?launch:undefined}),{TELOA_MARKET_REMOTE:'off'})
 assert.deepEqual(processLayerEnv(launch,['TELOA_OAUTH_PUBLIC_CALLBACK_URL']),{})
 const saved=process.env.TELOA_MARKET_REMOTE
 process.env.TELOA_MARKET_REMOTE='on'
 try{assert.equal(securityEnv({}).TELOA_MARKET_REMOTE,'on')}finally{if(saved===undefined)delete process.env.TELOA_MARKET_REMOTE;else process.env.TELOA_MARKET_REMOTE=saved}
 assert.ok(securityEnvNames.includes('TELOA_OAUTH_PUBLIC_CALLBACK_URL'))
})

test('.env 里已不生效的安全敏感变量：启动时一次性警告，只列变量名不含值；继承环境已有同名值或没有时不警告',()=>{
 const launch=createLaunchEnvironmentSnapshot([
  {source:'process',values:{TELOA_MARKET_REMOTE:'off',TELOA_DSH_PROFILE:'teloa'}},
  {source:'project-env',path:'/w/.env',values:{TELOA_OAUTH_PUBLIC_CALLBACK_URL:'https://attacker.example/cb',TELOA_MARKET_REMOTE:'on',OTHER:'x'}},
  {source:'user-env',path:'/h/.env',values:{TELOA_SECURITY_ACTION_TOKEN:'secret-token-value',TELOA_CREDENTIALS_KEY_FILE:'/k/key'}},
 ])
 assert.deepEqual(ignoredLaunchEnvNames(launch),['TELOA_OAUTH_PUBLIC_CALLBACK_URL','TELOA_SECURITY_ACTION_TOKEN','TELOA_CREDENTIALS_KEY_FILE'])
 const warnings:string[]=[]
 const logger={warn:(format:string,...args:unknown[])=>{warnings.push([format,...args].join(' '))}}
 warnIgnoredLaunchEnv({get:(name:string)=>name==='launchEnvironment'?launch:undefined,logger})
 assert.equal(warnings.length,1)
 for(const name of ['TELOA_OAUTH_PUBLIC_CALLBACK_URL','TELOA_SECURITY_ACTION_TOKEN','TELOA_CREDENTIALS_KEY_FILE'])assert.match(warnings[0]!,new RegExp(name))
 assert.doesNotMatch(warnings[0]!,/attacker|secret-token-value|\/k\/key|TELOA_MARKET_REMOTE|OTHER/)
 assert.match(warnings[0]!,/启动/)
 warnings.length=0
 warnIgnoredLaunchEnv({get:()=>createLaunchEnvironmentSnapshot([{source:'process',values:{TELOA_MARKET_REMOTE:'on'}}]),logger})
 warnIgnoredLaunchEnv({logger})
 assert.deepEqual(warnings,[])
})

test('危险的非 TELOA 变量：官方 DSH 分层加载在工作区 .env 里一律拒绝启动（报错只含变量名）；$DSH_HOME/.env 只放行代理四项',async t=>{
 const base=await tempHome(t),workspace=join(base,'workspace'),dshHome=join(base,'dsh')
 await mkdir(workspace,{recursive:true});await mkdir(dshHome,{recursive:true})
 const require=createRequire(import.meta.url)
 const boot=createRequire(require.resolve('@deepseek-ai/dsh/package.json')).resolve('@deepseek-ai/dsh-app-boot')
 const cases=[...dangerousProjectEnvNames.map(name=>({file:join(workspace,'.env'),name})),...['NODE_TLS_REJECT_UNAUTHORIZED','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR'].map(name=>({file:join(dshHome,'.env'),name}))]
 const script=`const {loadLayeredEnv}=await import(${JSON.stringify(pathToFileURL(boot).href)});const {writeFileSync,rmSync}=await import('node:fs')
const out=[]
for(const item of JSON.parse(process.argv[1])){writeFileSync(item.file,item.name+'=danger-value-9f3a\\n');try{loadLayeredEnv('teloa-test',process.cwd(),()=>{});out.push({...item,thrown:false})}catch(error){out.push({...item,thrown:true,message:String(error.message)})}rmSync(item.file)}
writeFileSync(${JSON.stringify(join(dshHome,'.env'))},'HTTPS_PROXY=http://127.0.0.1:9\\n');loadLayeredEnv('teloa-test',process.cwd(),()=>{});out.push({home:process.env.HTTPS_PROXY})
console.log(JSON.stringify(out))`
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(cases)],{cwd:workspace,encoding:'utf8',env:{PATH:process.env.PATH,HOME:base,DSH_HOME:dshHome}})
 assert.equal(child.status,0,child.stderr)
 const results=JSON.parse(child.stdout) as {name?:string;thrown?:boolean;message?:string;home?:string}[]
 for(const result of results.slice(0,-1)){assert.equal(result.thrown,true,result.name);assert.ok(result.message!.includes(result.name!));assert.ok(!result.message!.includes('danger-value-9f3a'))}
 assert.equal(results.at(-1)!.home,'http://127.0.0.1:9')
 for(const name of ['HTTP_PROXY','https_proxy','NO_PROXY','all_proxy','NODE_TLS_REJECT_UNAUTHORIZED'])assert.ok(dangerousProjectEnvNames.includes(name),name)
})

test('只出现在 .env 层的安全敏感名字启动时从 process.env 移除：TELOA_EDITION 合不进宿主，读版本仍是个人版',()=>{
 const launch=createLaunchEnvironmentSnapshot([{source:'process',values:{}},{source:'project-env',path:'/w/.env',values:{TELOA_EDITION:'enterprise',TELOA_MARKET_REMOTE:'on'}}])
 const saved={edition:process.env.TELOA_EDITION,market:process.env.TELOA_MARKET_REMOTE}
 process.env.TELOA_EDITION='enterprise';process.env.TELOA_MARKET_REMOTE='on'
 try{
  const warnings:string[]=[]
  warnIgnoredLaunchEnv({get:()=>launch,logger:{warn:(format:string,...args:unknown[])=>{warnings.push([format,...args].join(' '))}}})
  assert.equal(process.env.TELOA_EDITION,undefined);assert.equal(process.env.TELOA_MARKET_REMOTE,undefined)
  assert.equal(readEdition(),'personal')
  assert.match(warnings[0]!,/TELOA_EDITION/);assert.doesNotMatch(warnings[0]!,/enterprise/)
 }finally{for(const [name,value] of [['TELOA_EDITION',saved.edition],['TELOA_MARKET_REMOTE',saved.market]] as const)if(value===undefined)delete process.env[name];else process.env[name]=value}
 assert.ok(securityEnvNames.includes('TELOA_EDITION'))
})

test('宿主接线：安全敏感 TELOA_* 的读取点都走只读启动快照',async()=>{
 const src=async(path:string)=>readFile(new URL(path,import.meta.url),'utf8')
 const index=await src('../src/index.ts')
 assert.doesNotMatch(index,/process\.env\.TELOA_/)
 assert.match(index,/const trusted=securityEnv\(ctx\)\n\s*warnIgnoredLaunchEnv\(ctx\)/)
 for(const call of ['readSubagentDelegationLimits(trusted)','acceptanceOAuthFixture(trusted)','resolveTeloaRuntime(projectRoot,trusted)','resolveTeloaWorkspaceRoot(projectRoot,trusted)','resolveTeloaDshProfile(trusted)','detectMarketRemoteExclusion({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted})','createSignalActivity(runtimeRoot,()=>({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted}),()=>trusted)','createResourceInstallReporter(runtimeRoot,()=>({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted}),()=>trusted)','createMarketRanking(()=>({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted}),undefined,id=>officialCatalogForMcp.hasEntry(id),()=>trusted)'])assert.ok(index.includes(call),call)
 assert.doesNotMatch(index,/resolveTeloa(?:Runtime|WorkspaceRoot)\(projectRoot\)|resolveTeloaDshProfile\(\)|readSubagentDelegationLimits\(process\.env\)|detectMarketRemoteExclusion\(\)/)
 assert.doesNotMatch(await src('../src/managed-mcp-oauth.ts'),/process\.env\.TELOA_/)
 assert.match(await src('../src/managed-mcp-connections.ts'),/securityEnv\(ctx\)\.TELOA_OAUTH_PUBLIC_CALLBACK_URL/)
 const resources=await src('../src/resources.ts')
 assert.match(resources,/resolveTeloaRuntime\(projectRoot,trusted\)/);assert.match(resources,/deployment:trusted\.TELOA_DEPLOYMENT/)
 assert.doesNotMatch(await src('../src/usage-stats.ts'),/process\.env\.TELOA_USAGE_STATS_ENDPOINT/)
 const im=await readFile(new URL('../../im-gateway/src/index.ts',import.meta.url),'utf8')
 assert.match(im,/const launchEnv=securityEnv\(ctx\),stub=stubChannelPort\(launchEnv\)/);assert.match(im,/\{...deps,launchEnv\}/)
 const patch=await readFile(new URL('../../bundle/cordis.patch.yml',import.meta.url),'utf8')
 assert.doesNotMatch(patch,/!!js "?\[?process\.env\.TELOA_/)
})
