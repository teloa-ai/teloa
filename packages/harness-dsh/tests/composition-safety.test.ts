import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {assertCompositionSafety,bundledAgentPresetsRoot,compositionRefusalMessage,compositionSnapshot,compositionViolations,pendingPluginsExcluded,presetBodyNormalizedDigest,readCompositionRows,readProfileFacts} from '../src/composition-safety.ts'
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises'
import {parse as parseYaml} from 'yaml'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {apply} from '../src/index.ts'
import {compositionEntries,host} from './fixtures/production-host.ts'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {dirname} from 'node:path'
import {protectedNativePlugin} from '../src/native-plugin-manager.ts'

test('rc1 真实 initProfile 无旧字段时，已关闭 HMR 的生效组合可通过启动复验',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-rc1-profile-'))
 try{
  const require=createRequire(import.meta.url)
  const dshRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
  const boot=await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
  boot.initProfile(join(home,'profiles/teloa'),boot.PROFILE_TEMPLATES.web.bundles)
  const manifest=JSON.parse(await readFile(join(home,'profiles/teloa/package.json'),'utf8'))
  assert.equal(Object.hasOwn(manifest.dsh.profile,'patchReload'),false)
  const entries=[...compositionEntries().entries()].filter(entry=>entry.options.id!=='hmr')
  entries.push({id:'include:hmr',disabled:true,options:{id:'hmr',config:{},name:'@deepseek-ai/dsh-hmr'}})
  assertCompositionSafety({loader:{entries:()=>entries}},await readProfileFacts(home,'teloa'))
 }finally{await rm(home,{recursive:true,force:true})}
})

test('rc1 旧 startup 字段不能掩盖 HMR 重开、替换、别名挂载或服务仍然存在',()=>{
 const baseline=[...compositionEntries().entries()].filter(entry=>entry.options.id!=='hmr')
 const disabled={id:'include:hmr',disabled:true,options:{id:'hmr',config:{},name:'@deepseek-ai/dsh-hmr'}}
 const legacy={patchReload:'startup',bundles:[],pendingPackages:[]}
 const check=(entries:unknown[],hmr?:unknown)=>assertCompositionSafety({loader:{entries:()=>entries},get:()=>hmr},legacy)
 for(const entries of [baseline,[...baseline,{...disabled,disabled:false}],[...baseline,disabled,disabled],[...baseline,{...disabled,options:{...disabled.options,name:'@vendor/hmr'}}],[...baseline,disabled,{...disabled,disabled:false,options:{...disabled.options,id:'alias-hmr'}}]]){
  assert.throws(()=>check(entries),/补丁热加载/)
 }
 assert.throws(()=>check([...baseline,disabled],{watchConfig(){}}),/补丁热加载/)
 assert.doesNotThrow(()=>check([...baseline,disabled]))
})

test('rc1 官方组合的宿主 HMR 行被显式禁用且受原生插件管理保护',async()=>{
 const require=createRequire(import.meta.url),dshRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
 const bootPath=dshRequire.resolve('@deepseek-ai/dsh-app-boot'),bootRequire=createRequire(bootPath)
 const boot=await import(pathToFileURL(bootPath).href)
 const parse=(text:string)=>parseYaml(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(source:string)=>({__jsExpr:source})}]})
 const baseDir=dirname(bootRequire.resolve('@deepseek-ai/dsh-base/package.json'))
 const base=parse(await readFile(join(baseDir,'cordis.patch.yml'),'utf8'))
 const patch=parse(await readFile(new URL('../../bundle/cordis.patch.yml',import.meta.url),'utf8'))
 const entries=boot.composeEntries([base,patch])
 const hmr=entries.filter((entry:{id:string})=>entry.id==='hmr')
 assert.equal(hmr.length,1)
 assert.equal(hmr[0].name,'@deepseek-ai/dsh-hmr')
 assert.equal(hmr[0].disabled,true)
 assert.equal(protectedNativePlugin({patchId:'hmr',moduleName:'@deepseek-ai/dsh-hmr'}),true)
})

const safe={
 telemetryMode:'DISABLED',
 sessionLogUploadDisabled:true,
 productAnalyticsPinned:true,
 sandboxMode:'workspace-write',
 sandboxWorkspaceRoot:{__jsExpr:'process.cwd()'},
 sandboxBackendMounted:true,
 approvalPolicy:'ask',
 toolsMode:'native',
 toolWorkflowDisabled:true,
 toolRalphDisabled:true,
 scheduleServicePinned:true,
 scheduleUiDisabled:true,
 scheduleToolsDisabled:true,
 agentPresetDefault:'teloa-standard',
 agentPresetRegistryPinned:true,
 agentPresetDeclarationPinned:true,
 permissionPresets:{'read-only':{sandbox:'read-only',approval:'ask'},'workspace-write':{sandbox:'workspace-write',approval:'ask'}},
 hmrDisabled:true,
 pendingPluginsExcluded:true,
 // 自带预设正文（teloa-standard/agent.cordis.yml）当前如实写着的取值；见 readPresetBodyFacts。
 presetToolPresentationMode:'native',
 presetToolWorkflowDisabled:false,
 presetToolRalphDisabled:false,
 presetBodyDigestMatches:true,
 // 上网的 provider 选择、检索端点与抓取边界值；`web-fetch-http` 原本没有 config，取的全是上游默认。
 // 三条 name 钉住"这一行挂的是哪个包"：只按 id 定位挡不住同 id 换实现。
 webRowName:'@deepseek-ai/dsh-web',
 webSearchRowName:'@deepseek-ai/dsh-web-search-deepseek',
 webFetchRowName:'@deepseek-ai/dsh-web-fetch-http',
 webSearchProvider:'deepseek-official',
 webFetchProvider:'http',
 webSearchBaseUrl:'https://api.deepseek.com/anthropic/v1',
 webSearchApiKeyEnv:'DEEPSEEK_API_KEY',
 webFetchMaxResponseBytes:5000000,
 webFetchMaxBodyChars:100000,
 webFetchTimeoutMs:30000,
 webFetchMaxRedirects:3,
 // userAgent 是每次外发对目标站点的自我披露，SECURITY.md 逐字承诺了它；逐字取上游默认值，不伪装。
 webFetchUserAgent:'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)',
 credentialsPinned:true,
 promptAdmissionPinned:true,
}
/** 装配期复验要用的 profile 事实；没有待启用插件时三项都取空。 */
const facts={bundles:[] as string[],pendingPackages:[] as string[]}

test('原生提醒的装配安全事实必须明确，缺失或失守都归入工具安全钉',()=>{
 const baseline=readCompositionRows({loader:compositionEntries()})!
 const snapshot=compositionSnapshot(baseline,{bundles:[],packages:[]})
 for(const key of ['scheduleServicePinned','scheduleUiDisabled','scheduleToolsDisabled'] as const){
  assert.equal(snapshot[key],true)
  assert.deepEqual(compositionViolations({...safe,[key]:false}),['tools'])
  assert.deepEqual(compositionViolations({...safe,[key]:undefined}),['tools'])
 }
})

test('原生提醒服务必须唯一来自官方，关闭、替换及宿主和嵌套别名均拒绝装配',()=>{
 const baseline=readCompositionRows({loader:compositionEntries()})!
 const service=baseline.find(row=>row.id==='schedule')!
 const variants=[
  baseline.filter(row=>row!==service),
  baseline.map(row=>row===service?{...row,disabled:true}:row),
  baseline.map(row=>row===service?{...row,name:'@vendor/schedule'}:row),
  baseline.map(row=>row===service?{...row,group:true}:row),
  [...baseline,service],
  [...baseline,{...service,id:'alias-schedule'}],
  [...baseline,{id:'extra-group',group:true,disabled:true,config:[{...service,id:'alias-schedule'}]}],
  [...baseline,{id:'extra-preset',disabled:false,config:{plugins:[{...service,id:'alias-schedule'}]}}],
  [...baseline,{id:'extra-group',group:true,disabled:false,config:[service]}],
 ]
 for(const rows of variants){
  assert.equal(compositionSnapshot(rows).scheduleServicePinned,false)
  const entries=rows.map(row=>({disabled:row.disabled,options:row}))
  assert.throws(()=>assertCompositionSafety({loader:{entries:()=>entries}},facts),/工具/)
 }
})

test('原生自动化 UI 和提醒工具禁止在宿主、group 或预设中重新挂载',()=>{
 const baseline=readCompositionRows({loader:compositionEntries()})!
 const ui=baseline.find(row=>row.id==='ui-schedule')!
 const uiVariants=[
  baseline.filter(row=>row!==ui),
  baseline.map(row=>row===ui?{...row,disabled:false}:row),
  baseline.map(row=>row===ui?{...row,name:'@vendor/ui'}:row),
  baseline.map(row=>row===ui?{...row,group:true}:row),
  [...baseline,ui],
 ]
 for(const rows of uiVariants)assert.equal(compositionSnapshot(rows).scheduleUiDisabled,false)
 for(const [id,name,key] of [
  ['ui-schedule','@deepseek-ai/dsh-client-ui-schedule','scheduleUiDisabled'],
  ['tool-schedule','@deepseek-ai/dsh-tool-schedule','scheduleToolsDisabled'],
 ] as const){
  for(const entry of [{id,name,disabled:false,config:{}},{id:'alias-reminder',name,disabled:false,config:{}},{id,name:'@vendor/reminder',disabled:false,config:{}},{id:'alias-reminder',name,disabled:true,group:true,config:[]}]){
   const variants=[
    [...baseline,entry],
    [...baseline,{id:'extra-group',group:true,disabled:true,config:[entry]}],
    baseline.map(row=>row.id==='preset-standard'?{...row,config:{...(row.config as object),plugins:[entry]}}:row),
   ]
   for(const rows of variants){
    assert.equal(compositionSnapshot(rows)[key],false)
    assert.ok(compositionViolations(compositionSnapshot(rows,{bundles:[],packages:[]})).includes('tools'))
   }
  }
 }
})

test('产品遥测仅通过 Teloa 提供方：换端点、换名、停用或以别名重复挂载均拒绝',()=>{
 const baseline=readCompositionRows({loader:compositionEntries()})!
 const telemetry=baseline.find(row=>row.id==='teloa-product-telemetry')!
 const analytics=baseline.find(row=>row.id==='product-analytics')!
 const check=(rows:typeof baseline)=>compositionViolations(compositionSnapshot(rows,{bundles:[],packages:[]}))
 assert.deepEqual(check(baseline),[])
 for(const target of [telemetry,analytics]){
  const variants=[
   baseline.filter(row=>row!==target),
   baseline.map(row=>row===target?{...row,disabled:true}:row),
   baseline.map(row=>row===target?{...row,config:{endpoint:'https://collector.example.test'}}:row),
   baseline.map(row=>row===target?{...row,name:'@vendor/analytics'}:row),
   [...baseline,target],
   [...baseline,{...target,id:'alias-analytics',disabled:false}],
  ]
  for(const rows of variants)assert.deepEqual(check(rows),['telemetry'])
 }
 assert.deepEqual(check(baseline.map(row=>row.id==='desktop-product-telemetry'?{...row,disabled:false}:row)),['telemetry'])
})

test('原生插件声明按实际生效子插件复验，补丁改正文不能借磁盘原文蒙混过关',async()=>{
 const parsed=parseYaml(await readFile(join(bundledAgentPresetsRoot,'teloa-standard/agent.cordis.yml'),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(source:string)=>({__jsExpr:source})}]})
 const plugins=parsed[0].insert[0].config.plugins
 const rows=(readCompositionRows({loader:compositionEntries()})??[]).filter(row=>row.id!=='agent-presets'&&row.id!=='agent-preset-registry'&&row.id!=='teloa-agent-preset')
 rows.push({id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',disabled:false,config:{default:'teloa-standard'}})
 const declaration={id:'teloa-agent-preset',name:'@deepseek-ai/dsh-agent-preset',disabled:false,config:{id:'teloa-standard',plugins}}
 rows.push(declaration)
 const snapshot=()=>compositionSnapshot(rows,{bundles:[],packages:[]})
 assert.deepEqual(compositionViolations(snapshot()),[])
 declaration.config.plugins=[...plugins,{id:'unexpected-executor',name:'@deepseek-ai/dsh-tool-workflow'}]
 assert.deepEqual(compositionViolations(snapshot()),['tools'])
 declaration.config.plugins=plugins
 rows.push({...declaration,id:'second-preset',config:{id:'unsafe',plugins}})
 assert.deepEqual(compositionViolations(snapshot()),['agentPresets'])
})

test('预设摘要覆盖隔离域、注入依赖和动态关闭条件，防止正文看似相同却改变作用域',()=>{
 const rows=[{id:'planning',name:'cordis:group',group:true,isolate:{planMode:true},config:[]},{id:'shell',name:'@deepseek-ai/dsh-tool-bash',disabled:{__jsExpr:"process.platform === 'win32'"}}]
 const baseline=presetBodyNormalizedDigest(rows)
 assert.notEqual(presetBodyNormalizedDigest([{...rows[0],isolate:{}},rows[1]]),baseline)
 assert.notEqual(presetBodyNormalizedDigest([{...rows[0],inject:['tools']},rows[1]]),baseline)
 assert.notEqual(presetBodyNormalizedDigest([rows[0],{...rows[1],disabled:{__jsExpr:"process.platform !== 'win32'"}}]),baseline)
})

test('钉死的四行取值与预设表全部逐字成立时无违规',()=>{
 assert.deepEqual(compositionViolations(safe),[])
})

test('第三方补丁把任一钉子改回上游取值都会被判为违规',()=>{
 // 攻击者最想改的四行：整段会话外发、放行全盘写、每次征询直接判 rejected、模型可见面换成 run_code。
 assert.deepEqual(compositionViolations({...safe,telemetryMode:'FEEDBACK_ONLY'}),['telemetry'])
 assert.deepEqual(compositionViolations({...safe,sandboxMode:'danger-full-access'}),['sandbox'])
 assert.deepEqual(compositionViolations({...safe,approvalPolicy:'never'}),['approval'])
 assert.deepEqual(compositionViolations({...safe,toolsMode:'ptc'}),['tools'])
 assert.deepEqual(compositionViolations({...safe,toolsMode:'both'}),['tools'])
 // 取值交回 !!js 表达式时读到的不是字面量，同样不成立。
 assert.deepEqual(compositionViolations({...safe,sandboxMode:{expression:'process.env.DSH_PERMISSION_MODE'}}),['sandbox'])
 // 宿主两条入口保持关闭，模型工具由各预设作用域提供。
 assert.deepEqual(compositionViolations({...safe,toolWorkflowDisabled:false}),['tools'])
 assert.deepEqual(compositionViolations({...safe,toolRalphDisabled:false}),['tools'])
 // 缺行（补丁把整行摘掉）与放开同等对待：无从证明那个工具入口没被挂上去。
 const {toolWorkflowDisabled:_noWorkflowRow,...withoutWorkflowRow}=safe
 assert.deepEqual(compositionViolations(withoutWorkflowRow),['tools'])
 const {toolRalphDisabled:_noRalphRow,...withoutRalphRow}=safe
 assert.deepEqual(compositionViolations(withoutRalphRow),['tools'])
 // workspaceRoot 被补丁整块换掉时，mode 仍是 workspace-write 但兜底范围已交回上游默认值。
 assert.deepEqual(compositionViolations({...safe,sandboxWorkspaceRoot:'/'}),['sandbox'])
 assert.deepEqual(compositionViolations({...safe,sandboxWorkspaceRoot:undefined}),['sandbox'])
 assert.deepEqual(compositionViolations({...safe,sandboxBackendMounted:false}),['sandbox'])
 // rc1 以宿主 HMR 的实际禁用事实阻止补丁绕过本次复验。
 assert.deepEqual(compositionViolations({...safe,hmrDisabled:false}),['patchReload'])
 // 待启用插件进了组合 = 本人没确认过的第三方代码会在这次启动被 import；取不到这件事实同样判违规。
 assert.deepEqual(compositionViolations({...safe,pendingPluginsExcluded:false}),['pendingPlugins'])
 const {pendingPluginsExcluded:_omitted,...withoutPending}=safe
 assert.deepEqual(compositionViolations(withoutPending),['pendingPlugins'])
 assert.deepEqual(compositionViolations({...safe,agentPresetDefault:'standard'}),['agentPresets'])
 assert.deepEqual(compositionViolations({...safe,agentPresetRegistryPinned:false}),['agentPresets'])
 assert.deepEqual(compositionViolations({...safe,agentPresetDeclarationPinned:false}),['agentPresets'])
 // Agent 预设**正文**里的三个判据：roster 只钉住选中哪个 id，正文自己被改动时四键判据看不出来，
 // 必须靠这三个字段——它们来自装配期对 teloa-standard/agent.cordis.yml 的一次真实读取。
 assert.deepEqual(compositionViolations({...safe,presetToolPresentationMode:'ptc'}),['tools'])
 assert.deepEqual(compositionViolations({...safe,presetToolPresentationMode:'both'}),['tools'])
 assert.deepEqual(compositionViolations({...safe,presetToolWorkflowDisabled:true}),['tools'])
 assert.deepEqual(compositionViolations({...safe,presetToolRalphDisabled:true}),['tools'])
 // 读不到预设正文（文件被删、解析失败）时同样判违规：无从证明正文没被改动就不该放行。
 const {presetToolWorkflowDisabled:_noPresetWorkflow,...withoutPresetWorkflow}=safe
 assert.deepEqual(compositionViolations(withoutPresetWorkflow),['tools'])
 // 整份正文的规范化摘要：三键之外的任何一行被改、被删、被新增（加一条新 id 的
 // tool-presentation 行、把原行 name 换掉、重新启用 tool-skill/tool-bash……）都会体现为
 // 摘要不符，即便三个已知字段字面看着都对，这一项不符同样判违规。
 assert.deepEqual(compositionViolations({...safe,presetBodyDigestMatches:false}),['tools'])
 const {presetBodyDigestMatches:_noDigest,...withoutDigest}=safe
 assert.deepEqual(compositionViolations(withoutDigest),['tools'])
 // 上网的 provider 选择与抓取边界值：provider 被换掉等于上游那整套 SSRF 保护被整体换掉；
 // 边界值缺键（`web-fetch-http` 那一行本来就没有 config）与被放大同等对待。
 assert.deepEqual(compositionViolations({...safe,webFetchProvider:'something-else'}),['web'])
 assert.deepEqual(compositionViolations({...safe,webSearchProvider:'bing'}),['web'])
 assert.deepEqual(compositionViolations({...safe,webFetchMaxRedirects:50}),['web'])
 assert.deepEqual(compositionViolations({...safe,webFetchMaxResponseBytes:5000000000}),['web'])
 assert.deepEqual(compositionViolations({...safe,webFetchTimeoutMs:600000}),['web'])
 assert.deepEqual(compositionViolations({...safe,webFetchUserAgent:'Mozilla/5.0'}),['web'])
 // 检索端点被改写 = 检索词连同 DEEPSEEK_API_KEY 改投别处；上游那条 env 回落分支正是靠写死 baseURL 关掉的。
 assert.deepEqual(compositionViolations({...safe,webSearchBaseUrl:'https://example.com/v1'}),['web'])
 assert.deepEqual(compositionViolations({...safe,webSearchApiKeyEnv:'OTHER_KEY'}),['web'])
 // 同一个 id 的 name 被换成第三方实现：config 逐字对得上，provider 却已被整包顶替。
 assert.deepEqual(compositionViolations({...safe,webRowName:'@vendor/web'}),['web'])
 assert.deepEqual(compositionViolations({...safe,webSearchRowName:'@vendor/search'}),['web'])
 assert.deepEqual(compositionViolations({...safe,webFetchRowName:'@vendor/fetch'}),['web'])
 const {webFetchRowName:_noFetchName,...withoutFetchName}=safe
 assert.deepEqual(compositionViolations(withoutFetchName),['web'])
 const {webFetchMaxBodyChars:_noBodyChars,...withoutBodyChars}=safe
 assert.deepEqual(compositionViolations(withoutBodyChars),['web'])
 assert.deepEqual(compositionViolations({}),['telemetry','sandbox','approval','tools','agentPresets','permission','patchReload','pendingPlugins','web','credentials','promptAdmission'])
})

test('原生声明无需目录根，环境变量不能改变预设来源',()=>{
 const previous=process.env.TELOA_PROJECT_ROOT
 try{
  for(const value of [undefined,'packages/bundle/..','/tmp/untrusted-preset-root']){
   if(value===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=value
   assert.deepEqual(compositionViolations(safe),[])
  }
 }finally{
  if(previous===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previous
 }
})

test('规范化摘要覆盖完整子插件结构和行序：新增行、换 name 都会改变摘要',()=>{
 const rows=[
  {id:'tool-presentation',name:'@deepseek-ai/dsh-agent-tool-presentation',config:{mode:'native'}},
  {id:'tool-workflow',name:'@deepseek-ai/dsh-tool-workflow',disabled:true},
  {id:'tool-ralph',name:'@deepseek-ai/dsh-tool-ralph',disabled:true},
 ]
 const baseline=presetBodyNormalizedDigest(rows)
 // 行序也影响注册语义，重复调用同一份数据得到同一个摘要。
 assert.notEqual(presetBodyNormalizedDigest([rows[2],rows[0],rows[1]]),baseline)
 assert.equal(presetBodyNormalizedDigest(rows),baseline)
 // 三键字面取值都对，但多出一条新 id 的行——防的正是"新增一条 tool-presentation-2"这类绕过。
 assert.notEqual(presetBodyNormalizedDigest([...rows,{id:'tool-presentation-2',name:'@deepseek-ai/dsh-agent-tool-presentation',config:{mode:'ptc'}}]),baseline)
 // 把原行的 name 换成别的模块：三键判据根本不读 name，看不出来；摘要看得出来。
 assert.notEqual(presetBodyNormalizedDigest([{...rows[0],name:'@vendor/evil'},rows[1],rows[2]]),baseline)
 // 重新"启用"一个原本没出现过的工具行，同样改变摘要。
 assert.notEqual(presetBodyNormalizedDigest([...rows,{id:'tool-bash',name:'@deepseek-ai/dsh-tool-bash'}]),baseline)
})

test('原生注册器或声明被替换、缺失、重复、动态启停时均拒绝',()=>{
 const baseline=readCompositionRows({loader:compositionEntries()})!
 const violations=(rows:typeof baseline)=>compositionViolations(compositionSnapshot(rows,{bundles:[],packages:[]}))
 for(const id of ['agent-preset-registry','teloa-agent-preset','preset-standard','preset-ptc','preset-minimal','preset-cordis']){
  assert.ok(violations(baseline.filter(row=>row.id!==id)).includes('agentPresets'))
  assert.ok(violations([...baseline,baseline.find(row=>row.id===id)!]).includes('agentPresets'))
  assert.ok(violations(baseline.map(row=>row.id===id?{...row,name:'@vendor/replacement'}:row)).includes('agentPresets'))
  assert.ok(violations(baseline.map(row=>row.id===id?{...row,disabled:true}:row)).includes('agentPresets'))
 }
 const registry=(config:unknown)=>baseline.map(row=>row.id==='agent-preset-registry'?{...row,config}:row)
 assert.deepEqual(violations(registry({default:'teloa-standard',selectedDefault:'standard'})),[])
 assert.deepEqual(violations(registry({default:'teloa-standard',selectedDefault:'unknown'})),['agentPresets'])
 assert.deepEqual(violations(registry({default:'teloa-standard',includeUserRoot:true})),['agentPresets'])
 assert.deepEqual(violations(registry({default:'teloa-standard',modeSelectionEnabled:false})),[])
 assert.deepEqual(violations([...baseline,{id:'preset-standard',name:'@vendor/replacement',disabled:false,config:{}}]),['tools','agentPresets'])
})

test('注册器仅允许固定来源监听依赖，遗漏、重复或其他服务仍拒绝',()=>{
 const rows=readCompositionRows({loader:compositionEntries()})!
 const changed=(inject:unknown)=>rows.map(row=>row.id==='agent-preset-registry'?{...row,inject}:row)
 const violations=(entries:typeof rows)=>compositionViolations(compositionSnapshot(entries,{bundles:[],packages:[]}))
 assert.deepEqual(violations(rows),[])
 assert.deepEqual(violations(changed(['teloaToolResourceProvenance','sessionProjections','loader'])),[])
 for(const inject of [[],['tools'],['loader','sessionProjections'],['loader','loader','teloaToolResourceProvenance'],['loader','sessionProjections','other']])assert.deepEqual(violations(changed(inject)),['agentPresets'])
})

test('预设声明外层被改注入或隔离域时同样拒绝，不能让原生声明接到另一份注册器',()=>{
 for(const id of ['agent-preset-registry','teloa-agent-preset','preset-standard','preset-ptc','preset-minimal','preset-cordis']){
  for(const extra of [{isolate:{agentPresets:true}},{inject:[]},{intercept:{agentPresets:{}}},{group:true}]){
   const entries=[...compositionEntries().entries()].map(entry=>entry.options.id===id?{...entry,options:{...entry.options,...extra}}:entry)
   assert.throws(()=>assertCompositionSafety({loader:{entries:function*(){yield* entries}}},facts),/Agent 预设声明/)
  }
 }
})

test('待启用插件的判据同时看 bundles 与组合树里的挂载行',()=>{
 const rows=[{id:'vendor',disabled:false,config:{},name:'@vendor/plugin'}]
 // 没有待启用插件：恒成立。
 assert.equal(pendingPluginsExcluded(rows,['@vendor/plugin'],[]),true)
 // 上游 reconcile 把待启用的包补回了 bundles。
 assert.equal(pendingPluginsExcluded([],['@vendor/plugin'],['@vendor/plugin']),false)
 // 包名不在 bundles 里，但别的补丁把同一个模块当成一行插了进来。
 assert.equal(pendingPluginsExcluded(rows,[],['@vendor/plugin']),false)
 assert.equal(pendingPluginsExcluded(rows,[],['@other/plugin']),true)
 // 快照按同一判据填这一项。
 assert.equal(compositionSnapshot([],{bundles:['@vendor/plugin'],packages:['@vendor/plugin']}).pendingPluginsExcluded,false)
 assert.equal(compositionSnapshot([],{bundles:[],packages:['@vendor/plugin']}).pendingPluginsExcluded,true)
 assert.equal(compositionSnapshot([]).pendingPluginsExcluded,undefined)
})

test('预设表里任何一条放行全盘写或 never 征询都算违规',()=>{
 const presets=(extra:Record<string,unknown>)=>({...safe,permissionPresets:{...safe.permissionPresets,...extra}})
 assert.deepEqual(compositionViolations(presets({'danger-full-access':{sandbox:'danger-full-access',approval:'never'}})),['permission'])
 assert.deepEqual(compositionViolations(presets({quiet:{sandbox:'workspace-write',approval:'never'}})),['permission'])
 assert.deepEqual(compositionViolations(presets({wide:{sandbox:'danger-full-access',approval:'ask'}})),['permission'])
 // 预设表整体缺失就落回上游默认表，那份里带着 danger-full-access。
 assert.deepEqual(compositionViolations({...safe,permissionPresets:undefined}),['permission'])
})

test('同一行出现多次或被关闭时按取不到处理',()=>{
 const rows=[{id:'approval',disabled:false,config:{policy:'ask'}},{id:'approval',disabled:false,config:{policy:'never'}}]
 assert.equal(compositionSnapshot(rows).approvalPolicy,undefined)
 assert.equal(compositionSnapshot([{id:'tools',disabled:true,config:{mode:'native'}}]).toolsMode,undefined)
})

test('诊断只含固定标签，不带路径与补丁取值',()=>{
 const message=compositionRefusalMessage(['sandbox','approval'])
 assert.match(message,/沙箱默认模式、审批征询默认值/)
 assert.doesNotMatch(message,/danger-full-access|never|\//)
})

test('组合树行从 Loader 条目表读出，读不到时返回 undefined',async()=>{
 const rows=readCompositionRows({loader:compositionEntries()})
 assert.ok(rows)
 assert.deepEqual(compositionViolations(compositionSnapshot(rows,{bundles:[],packages:[]})),[])
 assert.equal(readCompositionRows({}),undefined)
 assert.equal(readCompositionRows({loader:{}}),undefined)
 assert.equal(readCompositionRows({loader:{entries:()=>{throw Error('条目表不可读')}}}),undefined)
 assert.equal(readCompositionRows({loader:{entries:function*(){yield {options:{}}}}}),undefined)
 // 条目的定位键是 options.id；entry.id 带子树前缀，拿它去比对会把每一条钉子都判成缺失。
 // `name` 一并读出：待启用插件的判据要认出"这一行挂的是哪个包"。
 assert.deepEqual(
  readCompositionRows({loader:{entries:function*(){yield {id:'root:approval',disabled:false,options:{id:'approval',name:'@deepseek-ai/dsh-user-approval',config:{policy:'ask'}}}}}}),
  [{id:'approval',disabled:false,config:{policy:'ask'},name:'@deepseek-ai/dsh-user-approval'}],
 )
})

test('profile 事实一并读出 bundles 与待启用清单，读不到时整体缺席',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-profile-facts-'))
 try{
  const profileDir=join(home,'profiles/teloa')
  await mkdir(profileDir,{recursive:true})
  assert.equal(await readProfileFacts(home,'teloa'),undefined,'profile 清单不存在时不能给出半份事实')
  await writeFile(join(profileDir,'package.json'),JSON.stringify({dsh:{profile:{patchReload:'startup',bundles:['@deepseek-ai/dsh-base']}}}))
  assert.deepEqual(await readProfileFacts(home,'teloa'),{bundles:['@deepseek-ai/dsh-base'],pendingPackages:[]})
  await writeFile(join(profileDir,'teloa-待启用插件.json'),JSON.stringify({'@vendor/plugin@1.0.0':'a'.repeat(64)}))
  assert.deepEqual((await readProfileFacts(home,'teloa'))?.pendingPackages,['@vendor/plugin'])
 }finally{await rm(home,{recursive:true,force:true})}
})

test('读不到生效组合或钉子不符时装配期直接抛出',async()=>{
 assert.throws(()=>assertCompositionSafety(new Context()),/无从复验/)
 assert.throws(()=>assertCompositionSafety({loader:compositionEntries({approval:{policy:'never'}})},facts),/审批征询默认值/)
 // profile 事实读不到时，待启用清单无从核对；HMR 事实独立取自生效组合。
 assert.throws(()=>assertCompositionSafety({loader:compositionEntries()}),/待启用扩展未进入组合/)
 // 待启用的包被补回 bundles：本人没确认过的代码会在这次启动被 import，装配期直接拒绝。
 assert.throws(()=>assertCompositionSafety({loader:compositionEntries()},{...facts,bundles:['@vendor/plugin'],pendingPackages:['@vendor/plugin']}),/待启用扩展未进入组合/)
 // 预设事实来自 Loader 内声明，无需把磁盘正文作为另一份输入。
 assertCompositionSafety({loader:compositionEntries()},facts)
})

test('宿主装配读真实 profile 清单：待启用插件进了组合就拒绝启动',async()=>{
 const projectRoot=await mkdtemp(join(tmpdir(),'teloa-apply-pending-'))
 const previous=process.env.DSH_HOME
 try{
  const profileDir=join(projectRoot,'.runtime/dsh/profiles/teloa')
  await mkdir(profileDir,{recursive:true})
  process.env.DSH_HOME=join(projectRoot,'.runtime/dsh')
  const manifest=(bundles:string[])=>writeFile(join(profileDir,'package.json'),JSON.stringify({dsh:{profile:{patchReload:'startup',bundles}}}))
  await writeFile(join(profileDir,'teloa-待启用插件.json'),JSON.stringify({'@vendor/plugin@1.0.0':'a'.repeat(64)}))
  // 上游 reconcile 把待启用的包补回了 bundles：装配期读清单即发现，`/teloa` 通道不会注册。
  await manifest(['@deepseek-ai/dsh-base','@vendor/plugin'])
  const refused=host({composition:compositionEntries()})
  await assert.rejects(apply(refused.ctx,{projectRoot}),/待启用扩展未进入组合/)
  assert.throws(()=>refused.rpc,/尚未注册/)
  // 正常压制着（有记录、不在 bundles）时这一项成立，装配不再因为它被拦下。
  await manifest(['@deepseek-ai/dsh-base'])
  const allowed=host({composition:compositionEntries()})
  await assert.rejects(apply(allowed.ctx,{projectRoot}),error=>!/待启用扩展未进入组合/.test(String(error)))
 }finally{
  if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
  await rm(projectRoot,{recursive:true,force:true})
 }
})

test('宿主装配在安全钉被改动时拒绝启动，且不注册 /teloa 通道',async()=>{
 const runtime=host({composition:compositionEntries({'sandbox-policy':{mode:'danger-full-access'}})})
 await assert.rejects(apply(runtime.ctx,{projectRoot:'/nonexistent-teloa-root'}),/沙箱默认模式/)
 assert.throws(()=>runtime.rpc,/尚未注册/)
 // 同一上下文不缓存失败结论：改回合规组合后仍可重新装配。
 await assert.rejects(apply(runtime.ctx,{projectRoot:'/nonexistent-teloa-root'}),/沙箱默认模式/)
})

test('凭据与提交前闸两枚钉：官方行复挂、Teloa 行缺失都判违规',()=>{
 assert.deepEqual(compositionViolations({...safe,credentialsPinned:false}),['credentials'])
 assert.deepEqual(compositionViolations({...safe,promptAdmissionPinned:false}),['promptAdmission'])
 const rows=[{id:'credentials',disabled:true,config:{},name:'@deepseek-ai/dsh-credentials-local'},{id:'teloa-credentials',disabled:false,config:{},name:'@teloa/harness-dsh/credentials'},{id:'attachment-local',disabled:true,config:{},name:'@deepseek-ai/dsh-attachment-local'},{id:'teloa-attachment-guard',disabled:false,config:{},name:'@teloa/harness-dsh/attachment-guard'}]
 assert.equal(compositionSnapshot(rows).credentialsPinned,true)
 assert.equal(compositionSnapshot([...rows,{id:'vendor-cred',disabled:false,config:{},name:'@deepseek-ai/dsh-credentials-local'}]).credentialsPinned,false)
 assert.equal(compositionSnapshot(rows.filter(row=>row.id!=='teloa-attachment-guard')).promptAdmissionPinned,false)
 // 官方行重新启用、Teloa 行换实现、Teloa 行重复、官方包以别的 id 挂在 group 子行里
 const swap=(id:string,patch:Record<string,unknown>)=>rows.map(row=>row.id===id?{...row,...patch}:row)
 assert.equal(compositionSnapshot(swap('credentials',{disabled:false})).credentialsPinned,false)
 assert.equal(compositionSnapshot(swap('teloa-credentials',{name:'@vendor/credentials'})).credentialsPinned,false)
 assert.equal(compositionSnapshot([...rows,rows[1]!]).credentialsPinned,false)
 assert.equal(compositionSnapshot(swap('attachment-local',{disabled:false})).promptAdmissionPinned,false)
 assert.equal(compositionSnapshot(swap('teloa-attachment-guard',{name:'@vendor/guard'})).promptAdmissionPinned,false)
 assert.equal(compositionSnapshot([...rows,rows[3]!]).promptAdmissionPinned,false)
 const groupChild={id:'vendor-extras:attach',disabled:false,config:{},name:'@deepseek-ai/dsh-attachment-local',group:false}
 assert.equal(compositionSnapshot([...rows,{id:'vendor-extras',disabled:false,config:[],name:'cordis:group',group:true},groupChild]).promptAdmissionPinned,false)
})

test('会话日志附带上传必须关闭：缺行、重新开启、表达式、重复或别名挂载都拒绝',()=>{
 const entries=[...compositionEntries().entries()]
 const rows=entries.map(entry=>({id:entry.options.id,disabled:entry.disabled,config:entry.options.config,name:entry.options.name}))
 const row={id:'session-log-deepseek',disabled:true,name:'@deepseek-ai/dsh-session-log-deepseek',config:{enabled:false}}
 const rest=rows.filter(item=>item.id!==row.id)
 const check=(list:typeof rows)=>compositionViolations(compositionSnapshot(list,{bundles:[],packages:[]}))
 assert.deepEqual(check([...rest,row]),[])
 for(const bad of [rest,[...rest,{...row,disabled:false}],[...rest,row,row],[...rest,row,{...row,id:'alias-log',disabled:false}],[...rest,{...row,name:'@other/log'}]]){
  assert.ok(check(bad).includes('telemetry'))
 }
 assert.equal(protectedNativePlugin({patchId:row.id,moduleName:row.name}),true)
})

test('DSH 0.2 官方日志插件动态开关：注册不等于上传，prepare 每次读取 enabled',async()=>{
 const require=createRequire(import.meta.url),dshRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
 const bootRequire=createRequire(dshRequire.resolve('@deepseek-ai/dsh-app-boot'))
 const baseRequire=createRequire(bootRequire.resolve('@deepseek-ai/dsh-base/package.json'))
 const plugin=await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-session-log-deepseek')).href)
 let enabled=false,reads=0,prepare:(request:unknown)=>unknown=()=>{throw Error('未注册')}
 const ctx={deepseekLlmApiExtensions:{register:(name:string,extension:{prepare:typeof prepare})=>{assert.equal(name,'dsh_session_log');prepare=extension.prepare}},sessions:{get:()=>{reads++;return undefined}}}
 plugin.apply(ctx,{enabled:{get:()=>enabled},maxBytes:1024})
 assert.equal(prepare({sessionId:'synthetic-log-check'}),undefined)
 assert.equal(reads,0,'关闭时不读取会话日志')
 enabled=true
 assert.equal(prepare({sessionId:'synthetic-log-check'}),undefined)
 assert.equal(reads,1,'正对照证明开关在每次请求时求值')
})
