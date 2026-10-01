import assert from 'node:assert/strict'
import test from 'node:test'
import {detectMarketRemoteExclusion} from '../../harness-dsh/src/market-remote.ts'
const runtime=await import('../../../scripts/runtime/profile.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any

test('本机宿主环境只继承明确允许的变量，并覆盖安装身份路径',()=>{
 assert.equal(typeof runtime.runtimeEnvironment,'function','缺少原生运行环境组装')
 const layout={programRoot:'/app',dshHome:'/state/dsh',runtimeRoot:'/state/data',workspaceRoot:'/work',profileName:'teloa'}
 const environment=runtime.runtimeEnvironment(layout,{PATH:'/tools',LANG:'zh_CN.UTF-8',AWS_SECRET_ACCESS_KEY:'private',TELOA_PROJECT_ROOT:'/wrong',NODE_OPTIONS:'--require injected.js'})
 assert.equal(environment.TELOA_PROJECT_ROOT,'/app')
 assert.equal(environment.TELOA_WORKSPACE_ROOT,'/work')
 assert.equal(environment.DSH_HOME,'/state/dsh')
 assert.equal(environment.AWS_SECRET_ACCESS_KEY,undefined)
 assert.equal(environment.NODE_OPTIONS,undefined)
 assert.ok(environment.PATH.endsWith('/tools'))
})

test('npm 发行宿主默认开启使用统计，外部显式值优先',()=>{
 const layout={programRoot:'/app',dshHome:'/state/dsh',runtimeRoot:'/state/data',workspaceRoot:'/work',profileName:'teloa'}
 assert.equal(runtime.runtimeEnvironment(layout,{PATH:'/tools'}).TELOA_USAGE_STATS,'on')
 assert.equal(runtime.runtimeEnvironment(layout,{PATH:'/tools',TELOA_USAGE_STATS:'off'}).TELOA_USAGE_STATS,'off')
})

test('npm 在线市场默认开启，显式值与宿主排除规则仍优先',()=>{
 const layout={programRoot:'/app',dshHome:'/state/dsh',runtimeRoot:'/state/data',workspaceRoot:'/work',profileName:'teloa'}
 const cases:[Record<string,string>,string,string|undefined][]=[
  [{},'on',undefined],
  [{TELOA_MARKET_REMOTE:'off'},'off','env-off'],
  [{TELOA_MARKET_REMOTE:''},'','default-off'],
  [{TELOA_MARKET_REMOTE:'yes'},'yes','default-off'],
  [{CI:'true'},'on','ci'],
  [{TELOA_BROWSER_ACCEPTANCE:'1'},'on','acceptance'],
  [{NODE_ENV:'development'},'on','dev'],
 ]
 for(const [overrides,value,excluded] of cases){
  const env=runtime.runtimeEnvironment(layout,{PATH:'/tools',TELOA_USAGE_STATS:'off',...overrides})
  assert.equal(env.TELOA_MARKET_REMOTE,value)
  assert.equal(env.TELOA_USAGE_STATS,'off')
  assert.equal(detectMarketRemoteExclusion(env),excluded)
 }
 assert.equal(detectMarketRemoteExclusion({}),'default-off','源码宿主缺省保持关闭')
})

test('npm 发行宿主透传使用统计排除变量，CI / 验收 / 开发环境不上报',()=>{
 const layout={programRoot:'/app',dshHome:'/state/dsh',runtimeRoot:'/state/data',workspaceRoot:'/work',profileName:'teloa'}
 const environment=runtime.runtimeEnvironment(layout,{PATH:'/tools',CI:'true',TELOA_BROWSER_ACCEPTANCE:'1',NODE_ENV:'development'})
 assert.equal(environment.CI,'true')
 assert.equal(environment.TELOA_BROWSER_ACCEPTANCE,'1')
 assert.equal(environment.NODE_ENV,'development')
})

test('npm 入口：凭据形变量不入宿主，_FILE 与钥匙串变量放行',()=>{
 const layout={programRoot:'/p',dshHome:'/h',runtimeRoot:'/r',workspaceRoot:'/w',profileName:'teloa'}
 const environment=runtime.runtimeEnvironment(layout,{PATH:'/tools',DEEPSEEK_API_KEY:'x',DEEPSEEK_API_KEY_FILE:'/run/k',TELOA_CREDENTIALS_KEY_FILE:'/run/m',DBUS_SESSION_BUS_ADDRESS:'unix:path=/b',XDG_RUNTIME_DIR:'/run/user/1'})
 assert.equal(environment.DEEPSEEK_API_KEY,undefined)
 assert.equal(environment.DEEPSEEK_API_KEY_FILE,'/run/k');assert.equal(environment.TELOA_CREDENTIALS_KEY_FILE,'/run/m')
 assert.equal(environment.DBUS_SESSION_BUS_ADDRESS,'unix:path=/b');assert.equal(environment.XDG_RUNTIME_DIR,'/run/user/1')
})

test('npm 入口：凭据验收开关任何情况下都不透传（验收只走源码启动器）',()=>{
 const layout={programRoot:'/p',dshHome:'/h',runtimeRoot:'/r',workspaceRoot:'/w',profileName:'teloa'}
 const switches={TELOA_CREDENTIALS_KEYRING:'off',TELOA_CREDENTIALS_KEY_DIR:'/k',TELOA_CREDENTIALS_STORE:'file',CREDENTIALS_DIRECTORY:'/c'}
 const formal=runtime.runtimeEnvironment(layout,{PATH:'/tools',...switches})
 assert.equal(formal.TELOA_CREDENTIALS_KEYRING,undefined);assert.equal(formal.TELOA_CREDENTIALS_KEY_DIR,undefined)
 assert.equal(formal.TELOA_CREDENTIALS_STORE,'file');assert.equal(formal.CREDENTIALS_DIRECTORY,'/c')
 const acceptance=runtime.runtimeEnvironment(layout,{PATH:'/tools',TELOA_BROWSER_ACCEPTANCE:'1',...switches})
 assert.equal(acceptance.TELOA_BROWSER_ACCEPTANCE,'1')
 assert.equal(acceptance.TELOA_CREDENTIALS_KEYRING,undefined);assert.equal(acceptance.TELOA_CREDENTIALS_KEY_DIR,undefined)
})
