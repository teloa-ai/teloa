import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import TeloaPluginManager,{protectedNativePlugin,pendingNativeBundle,marketManagedBundle,reservedInstallSpec,teloaDependencyDrift} from '../src/native-plugin-manager.ts'

test('原生插件管理保护宿主必需行与预设，仍可启停可选能力',()=>{
 for(const id of ['sandbox-policy','teloa-harness-dsh','teloa-ui-workbench','teloa-agent-preset','agent-preset-registry','preset-standard','agent-team','tool-agent-team','ui-agent-team','teloa-session-model-scope','teloa-tool-resource-provenance'])assert.equal(protectedNativePlugin({patchId:id,moduleName:'any'}),true,id)
 assert.equal(protectedNativePlugin({moduleName:'@teloa/harness-dsh',entryId:'include:other-name'}),true)
 assert.equal(protectedNativePlugin({moduleName:'@teloa/im-gateway'}),true)
 assert.equal(protectedNativePlugin({moduleName:'any',entryId:'x:teloa-im-gateway'}),true)
 // 本地中文检索继续作为可选官方扩展，原生页不能单独关掉其必需行
 assert.equal(protectedNativePlugin({moduleName:'@teloa/local-embedding'}),true)
 assert.equal(protectedNativePlugin({moduleName:'any',entryId:'x:teloa-local-embedding'}),true)
 assert.equal(marketManagedBundle('@teloa/local-embedding'),true)
 for(const id of ['browser-use','teloa-browser-use-playwright','speech-to-text-sensevoice','ui-voice-input','auto-review'])assert.equal(protectedNativePlugin({patchId:id,moduleName:'@deepseek-ai/optional'}),false,id)
})

test('原生启用不得绕过既有市场包的精确待启用记录',()=>{
 const records={'@vendor/example@1.0.0':'a'.repeat(64),'@vendor/other@2.0.0':'b'.repeat(64)}
 assert.equal(pendingNativeBundle(records,'@vendor/example'),true)
 assert.equal(pendingNativeBundle(records,'@vendor/example-extra'),false)
 assert.equal(pendingNativeBundle({},'@vendor/example'),false)
})

test('IM 通道内置且不归市场启停；行与模块仍受保护',()=>{
 assert.equal(marketManagedBundle('@teloa/im-gateway'),false)
 assert.equal(marketManagedBundle('@Teloa/im-gateway'),false)
 assert.equal(marketManagedBundle('@TELOA/IM-GATEWAY'),false)
 assert.equal(marketManagedBundle('@teloa/native-browser'),false)
 assert.equal(protectedNativePlugin({moduleName:'any',entryId:'x:teloa-im-gateway'}),true)
 // 本地中文检索继续作为可选官方扩展，原生页不能单独关掉其必需行
 assert.equal(protectedNativePlugin({moduleName:'@teloa/local-embedding'}),true)
 assert.equal(protectedNativePlugin({moduleName:'any',entryId:'x:teloa-local-embedding'}),true)
 assert.equal(marketManagedBundle('@teloa/local-embedding'),true)
})
test('原生扩展管理拒收 @teloa/ 作用域的安装规格',()=>{
 for(const spec of ['@teloa/im-gateway@0.2.0','npm:@teloa/im-gateway',' @teloa/x','@Teloa/im-gateway','npm:@TELOA/x'])assert.equal(reservedInstallSpec(spec),true,spec)
 for(const spec of ['@vendor/teloa@1.0.0','github:teloa-ai/x','@teloa-ai/x'])assert.equal(reservedInstallSpec(spec),false,spec)
})
test('安装后核对：@teloa/ 依赖被新增、改写或删除都算漂移，其它依赖不算',()=>{
 const before={'@teloa/im-gateway':'link:/p/im','@vendor/x':'1.0.0'}
 assert.deepEqual(teloaDependencyDrift(before,{...before,'@vendor/y':'2.0.0'}),[])
 assert.deepEqual(teloaDependencyDrift(before,{...before,'@teloa/im-gateway':'1.0.0'}),['@teloa/im-gateway'])
 assert.deepEqual(teloaDependencyDrift(before,{...before,'@teloa/evil':'npm:x@1'}),['@teloa/evil'])
 assert.deepEqual(teloaDependencyDrift(before,{'@vendor/x':'1.0.0'}),['@teloa/im-gateway'])
 // macOS 文件系统不区分大小写：@Teloa/x 会与官方包落同一目录，同样算漂移。
 assert.deepEqual(teloaDependencyDrift(before,{...before,'@Teloa/im-gateway':'1.0.0'}),['@Teloa/im-gateway'])
})

test('构造检查：官方插件管理器缺少 runPnpm 时拒绝构造；存在时在实例上包一层守卫',()=>{
 const proto=PluginManager.prototype as unknown as Record<string,unknown>
 const create=()=>{
  const ctx=new Context()
  ctx.provide('profileContext',{name:'fixture',dir:'/nonexistent/profile',home:'/nonexistent',patchPath:'/nonexistent/patch.yml',installAnchor:'/nonexistent/package.json',cwd:'/nonexistent',startedBundles:[],overlays:[],packageManager:{command:process.execPath,args:[]}})
  return new TeloaPluginManager(ctx,{fallbackRegistries:[]} as never)
 }
 assert.ok(Object.hasOwn(create(),'runPnpm'),'实例上应有守卫包装')
 const saved=Object.getOwnPropertyDescriptor(proto,'runPnpm')
 assert.ok(saved,'官方插件管理器原型上应有 runPnpm')
 delete proto.runPnpm
 try{assert.throws(create,/缺少 runPnpm/)}
 finally{Object.defineProperty(proto,'runPnpm',saved)}
})
