import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {readFileSync} from 'node:fs'
import {parse} from 'yaml'
import {compositionSnapshot,compositionViolations,readCompositionRows} from '../src/composition-safety.ts'
import {compositionEntries} from './fixtures/production-host.ts'

/**
 * 用**真实**的 Cordis Loader 装一棵小条目树，钉住 `readCompositionRows` 依赖的两处形态：
 * 条目的定位键是 `entry.options.id`（`entry.id` 会带所属子树前缀），
 * 生效取值是 `entry.options.config`。第一版就是在这里读错，装配期把五条钉子全判成缺失。
 *
 * Loader 不是 harness 的直接依赖，按依赖图从 `dsh-agent-preset-registry` 解析到同一份实现；
 * `pnpm check:dsh` 会核对这条依赖链上的版本，不会解析到仓库外的路径。
 */
const require=createRequire(import.meta.url)
const loaderPath=createRequire(require.resolve('@deepseek-ai/dsh-agent-preset-registry/package.json')).resolve('@deepseek-ai/cordis-plugin-loader')
const {EntryGroup,Group,Loader}=await import(loaderPath) as {EntryGroup:{key:symbol};Group:unknown;Loader:new(...args:never[])=>unknown}
const presetPlugins=parse(readFileSync(new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(source:string)=>({__jsExpr:source})}]})[0].insert[0].config.plugins

/** 条目树在内存里就够了；持久化不是本用例要核的东西。 */
class MemoryLoader extends (Loader as new(...args:never[])=>{builtins:Record<string,unknown>;root:{update:(config:unknown[])=>Promise<void>}}){
 write(){}
}

/** 任何 config 都接受的占位插件：本用例只关心条目的 options，不关心插件做什么。 */
const pin={apply(){}}

/** 记录自己是否真的被 apply 过；用来证明 `disabled: true` 在 group 行上不成立。 */
const applied:string[]=[]
const recorder={apply(_ctx:unknown,config:unknown){applied.push(JSON.stringify(config)??'null')}}

async function tree(entries:unknown[]){
 const ctx=new Context()
 await (ctx.plugin as (plugin:unknown,config?:unknown)=>PromiseLike<unknown>)(MemoryLoader,{})
 const loader=Reflect.get(ctx,'loader') as {builtins:Record<string,unknown>;root:{update:(config:unknown[])=>Promise<void>}}
 loader.builtins.pin=pin
 loader.builtins.preset={...pin,[EntryGroup.key]:true}
 loader.builtins.recorder=recorder
 loader.builtins.group=Group
 await loader.root.update(entries)
 return ctx
}

test('真实 Loader 条目树里定位键是 options.id，取值是 options.config',async()=>{
 const ctx=await tree([
  {id:'approval',name:'cordis:pin',config:{policy:'ask'}},
  {id:'tool-workflow',name:'cordis:pin',disabled:true},
 ])
 const rows=readCompositionRows(ctx)
 assert.ok(rows)
 assert.deepEqual(rows.find(row=>row.id==='approval'),{id:'approval',disabled:false,config:{policy:'ask'},name:'cordis:pin'})
 assert.deepEqual(rows.find(row=>row.id==='tool-workflow')?.disabled,true)
})

test('嵌套子树里的行也按本地 id 读出，前缀不进定位键',async()=>{
 const ctx=await tree([
  {id:'profile',name:'cordis:group',group:true,config:[
   {id:'sandbox-policy',name:'cordis:pin',config:{mode:'workspace-write'}},
  ]},
 ])
 const rows=readCompositionRows(ctx)
 assert.ok(rows)
 // 真实宿主里 entry.id 是 `<根 Include 条目 id>:sandbox-policy`；定位键必须是不带前缀的那个。
 assert.ok(rows.some(row=>row.id==='sandbox-policy'),'嵌套子树里的行应按本地 id 出现')
 assert.equal(compositionSnapshot(rows).sandboxMode,'workspace-write')
})

test('整棵树装起来后判据函数能直接吃这份行快照',async()=>{
 const ctx=await tree([
  {id:'session-telemetry-otel',name:'cordis:pin',config:{mode:'DISABLED'}},
  {id:'session-log-deepseek',name:'cordis:pin',disabled:true,config:{enabled:false}},
  {id:'desktop-product-telemetry',name:'cordis:pin',disabled:true},
  {id:'teloa-product-telemetry',name:'cordis:pin',config:{endpoint:'https://metrics.teloa.ai/v1/product-events',channel:'teloa_product_analytics',serviceName:'teloa-free'}},
  {id:'product-analytics',name:'cordis:pin',config:{enabled:true}},
  {id:'sandbox-policy',name:'cordis:pin',config:{mode:'workspace-write',workspaceRoot:{__jsExpr:'process.cwd()'}}},
  {id:'sandbox',name:'cordis:pin'},
  {id:'approval',name:'cordis:pin',config:{policy:'ask'}},
  {id:'tools',name:'cordis:pin',config:{mode:'native'}},
  {id:'tool-workflow',name:'cordis:pin',disabled:true},
  {id:'tool-ralph',name:'cordis:pin',disabled:true},
  {id:'schedule',name:'cordis:pin'},
  {id:'ui-schedule',name:'cordis:pin',disabled:true},
  {id:'hmr',name:'cordis:pin',disabled:true},
  // 原生预设声明把动态子插件作为数据留给注册器，不在宿主行求值。
  {id:'agent-preset-registry',name:'cordis:pin',config:{default:'teloa-standard'}},
  {id:'teloa-agent-preset',name:'cordis:preset',config:{id:'teloa-standard',plugins:presetPlugins}},
  ...[...compositionEntries().entries()].filter(entry=>entry.options.id.startsWith('preset-')).map(entry=>({...entry.options,name:'cordis:preset'})),
  {id:'permission',name:'cordis:pin',config:{presets:{'read-only':{sandbox:'read-only',approval:'ask'},'workspace-write':{sandbox:'workspace-write',approval:'ask'}}}},
  {id:'web',name:'cordis:pin',config:{searchProvider:'deepseek-official',fetchProvider:'http'}},
  {id:'web-search-deepseek',name:'cordis:pin',config:{baseURL:'https://api.deepseek.com/anthropic/v1',apiKeyEnv:'DEEPSEEK_API_KEY'}},
  {id:'web-fetch-http',name:'cordis:pin',config:{maxResponseBytes:5000000,maxBodyChars:100000,timeoutMs:30000,maxRedirects:3,userAgent:'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'}},
  {id:'credentials',name:'cordis:pin',disabled:true},
  {id:'teloa-credentials',name:'cordis:pin',config:{store:'auto'}},
  {id:'attachment-local',name:'cordis:pin',disabled:true},
  {id:'teloa-attachment-guard',name:'cordis:pin'},
 ])
 const rows=readCompositionRows(ctx)
 assert.ok(rows)
 // 本用例装载占位插件，只替换已验证的模块名，保留 Loader 提供的声明正文和表达式。
 assert.equal(rows.find(row=>row.id==='teloa-agent-preset')?.name,'cordis:preset')
 const names:Record<string,string>={hmr:'@deepseek-ai/dsh-hmr','agent-preset-registry':'@deepseek-ai/dsh-agent-preset-registry','teloa-agent-preset':'@deepseek-ai/dsh-agent-preset',web:'@deepseek-ai/dsh-web','web-search-deepseek':'@deepseek-ai/dsh-web-search-deepseek','web-fetch-http':'@deepseek-ai/dsh-web-fetch-http',credentials:'@deepseek-ai/dsh-credentials-local','teloa-credentials':'@teloa/harness-dsh/credentials','attachment-local':'@deepseek-ai/dsh-attachment-local','teloa-attachment-guard':'@teloa/harness-dsh/attachment-guard'}
 for(const id of ['standard','ptc','minimal','cordis'])names['preset-'+id]='@deepseek-ai/dsh-agent-preset'
 names['session-log-deepseek']='@deepseek-ai/dsh-session-log-deepseek'
 names['desktop-product-telemetry']='@deepseek-ai/dsh-host-product-telemetry-otel'
 names['teloa-product-telemetry']='@teloa/harness-dsh/product-telemetry'
 names['product-analytics']='@deepseek-ai/dsh-client-product-analytics'
 names.schedule='@deepseek-ai/dsh-schedule'
 names['ui-schedule']='@deepseek-ai/dsh-client-ui-schedule'
 const snapshot=compositionSnapshot(rows.map(row=>({...row,name:names[row.id]??row.name})),{bundles:[],packages:[]})
 assert.deepEqual(compositionViolations(snapshot),[])
})



test('上游对 group 行的 disabled 恒不生效：逐行压制挡不住声明成 group 的插件',async()=>{
 applied.length=0
 const ctx=await tree([
  // cordis-plugin-loader 的 _disabled()：`if (options.group) return false`，
  // 所以这一行即便写着 disabled: true 也照样被 import 并 apply。
  {id:'vendor-extras',name:'cordis:recorder',group:true,disabled:true,config:[]},
  // 对照：不是 group 的行，disabled: true 如实生效。
  {id:'plain-row',name:'cordis:recorder',disabled:true},
 ])
 const rows=readCompositionRows(ctx)
 assert.ok(rows)
 assert.equal(rows.find(row=>row.id==='vendor-extras')?.disabled,false,'group 行的 disabled 在上游恒为 false')
 assert.equal(rows.find(row=>row.id==='plain-row')?.disabled,true)
 assert.equal(applied.length,1,'group 行仍被执行，plain 行没有——这就是轮 2 逐行压制被打穿的原因')
})

test('真实 Loader 中嵌套 group 的原生提醒工具即使声明 disabled 也不能通过安全钉',async()=>{
 const ctx=await tree([
  {id:'schedule',name:'cordis:pin'},
  {id:'ui-schedule',name:'cordis:pin',disabled:true},
  {id:'reminder-scope',name:'cordis:group',group:true,disabled:true,config:[
   {id:'tool-schedule',name:'cordis:recorder',group:true,disabled:true,config:[]},
  ]},
 ])
 const rows=readCompositionRows(ctx)
 assert.ok(rows)
 assert.equal(rows.find(row=>row.id==='tool-schedule')?.disabled,false)
 const names:Record<string,string>={schedule:'@deepseek-ai/dsh-schedule','ui-schedule':'@deepseek-ai/dsh-client-ui-schedule'}
 const snapshot=compositionSnapshot(rows.map(row=>({...row,name:names[row.id]??row.name})))
 assert.equal(snapshot.scheduleServicePinned,true)
 assert.equal(snapshot.scheduleUiDisabled,true)
 assert.equal(snapshot.scheduleToolsDisabled,false)
 assert.ok(compositionViolations(snapshot).includes('tools'))
})
