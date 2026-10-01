import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('完整行业资源目录只挂载到数字员工，业务空间使用落点摘要',async()=>{
  const [frame,navigation]=await Promise.all([
    readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/WorkNavigation.tsx',import.meta.url),'utf8'),
  ])
  assert.match(frame,/const industryResources=/)
  assert.doesNotMatch(frame,/industryResources\(\{scope\}\)/)
  assert.match(frame,/industryResources\(\{roleId:id\}\)/)
  assert.doesNotMatch(frame,/TeamCapabilitiesPage industry=/)
  assert.doesNotMatch(frame,/<IndustryDirectory\b/)
  assert.doesNotMatch(frame,/<IndustryTaskForm\b/)
  assert.doesNotMatch(navigation,/127\.0\.0\.1:3098|原型图与页面全景/)
})

test('已加载行业模板明确区分资源集合与逐项启用入口',async()=>{
  const directory=await readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
  assert.match(directory,/market\.industry\.saved\.the.pool.of.resources.has.been.loaded.to/)
  assert.match(directory,/market\.industry\.saved\.status\.connectionPending/)
  assert.match(directory,/market\.industry\.saved\.status\.installPending/)
  assert.match(directory,/market\.industry\.saved\.status\.integrationPending/)
  assert.match(directory,/market\.industry\.saved\.status\.authorizationPending/)
  assert.match(directory,/market\.industry\.saved\.open.connection.and.running.environment/)
  assert.match(directory,/market\.industry\.saved\.registerExecutionTool/)
})

test('真实业务总览保留对象台账，工作环境从更多按需展开',async()=>{
  const business=await readFile(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8')
  assert.match(business,/target\.section==='overview'/)
  assert.match(business,/ledgerTool==='resources'/)
  assert.match(business,/action==='sources'\?'resources'/)
  assert.match(business,/<BusinessMoreMenu scope=\{target\.scope\} choose=\{chooseMore\}\/>/)
  assert.match(business,/className=\{css\.workEnvironment\}/)
  assert.equal(business.match(/capabilities\(target\.scope\)/g)?.length,1)
  assert.match(business,/manageIndustryResources\(target\.scope\)/)
  assert.match(business,/business\.industry\.resources\.title/)
})

test('行业模板加载后可从市场来源进入同一个真实资源工作台',async()=>{
  const [market,frame,directory]=await Promise.all([
    readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8'),
  ])
  assert.match(market,/manageIndustryLoad:\(loadId:string\)=>void/)
  // 「看看它带进来什么 · 空间」入口抽成本机页与官方方案页共用的 SolutionLoadLinks（审查 L5）
  assert.match(market,/<SolutionLoadLinks loads=\{matchingLoads\} manage=\{props\.manageIndustryLoad\}\/>/)
  assert.match(market,/loads\.map\(load=><button type="button" key=\{load\.id\} onClick=\{\(\)=>manage\(load\.id\)\}>/)
  assert.match(frame,/actions\.openIndustryResources\(\{loadId\}\)/)
  assert.match(frame,/industryResourceTarget/)
  assert.match(directory,/loadId\?:string/)
  assert.match(directory,/!loadId\|\|load\.id===loadId/)
})

test('行业数据源在资源工作台中实例化并经本人显式授权',async()=>{
  const [directory,frame]=await Promise.all([
    readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
  ])
  assert.match(directory,/dataSources\.instantiate\(\{requestId:crypto\.randomUUID\(\),loadId:load\.id,itemInstanceId:item\.instanceId\}\)/)
  assert.match(directory,/dataSources\.authorize\(\{requestId:crypto\.randomUUID\(\),instanceId:dataSourceInstance\.id,expectedRevision:dataSourceInstance\.revision\}\)/)
  assert.match(frame,/industryDataSourceApi\.list\(\)/)
  assert.match(frame,/dataSources=\{\{items:industryDataSources/)
})

test('行业执行工具在业务空间中真实登记并经本人显式授权',async()=>{
  const [directory,frame]=await Promise.all([
    readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
  ])
  assert.match(directory,/executionTools\.instantiate\(\{requestId:crypto\.randomUUID\(\),loadId:load\.id,itemInstanceId:item\.instanceId\}\)/)
  assert.match(directory,/executionToolInstance\?\.state==='needs_authorization'/)
  assert.match(directory,/executionTools\.authorize\(\{requestId:crypto\.randomUUID\(\),instanceId:executionToolInstance\.id,expectedRevision:executionToolInstance\.revision\}\)/)
  assert.match(frame,/industryExecutionToolApi\.list\(\)/)
  assert.match(frame,/industryExecutionToolApi\.authorize\(input\)/)
  assert.match(frame,/executionTools=\{\{items:industryExecutionTools/)
})

test('工作环境按业务对象分类并保留来源版本与就绪状态',async()=>{
  const directory=await readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
  // 分组按市场标签称呼：同事、技能、扩展、连接（数据源、MCP 连接、执行工具合三为一），业务看板单独一组。
  for(const key of ['market.industry.saved.working.environment','market.presentation.category.agent','market.industry.saved.group.knowledge','market.teamCapabilities','market.presentation.category.plugin','market.industry.saved.group.tasks','market.industry.saved.group.plans','market.presentation.category.connector','composition.row.board'])assert.match(directory,new RegExp(key.replaceAll('.','\\.')))
  // 来源与版本收进「详细信息」；就绪进度由准备就绪面板一句话说明。
  assert.match(directory,/market\.industry\.saved\.template.source.and.version/)
  assert.match(directory,/<IndustryReadinessPanel/)
  // 当前业务没有方案与指定方案尚未添加各用自己的说明；两条路径均保留原目标。
  assert.match(directory,/market\.industry\.saved\.scopeEmpty/)
  assert.match(directory,/market\.industry\.saved\.the\.current\.template\.only\.contains\.resource\.statements\.in/)
  assert.doesNotMatch(directory,/market\.industry\.saved\.the\.current\.business\.space\.has\.not\.yet\.loaded/)
  assert.match(directory,/market\.industry\.saved\.load.industry.templates.from.market/)
  assert.match(directory,/if\(!rows\.length\)\{/)
  assert.match(directory,/market\.industry\.saved\.work.environment.reading.failed/)
})

test('行业计划创建要求本人显式核对通知策略并随请求提交',async()=>{
  const form=await readFile(new URL('../src/client/SavedIndustryPlanForm.tsx',import.meta.url),'utf8')
  assert.match(form,/aria-label=\{t\('continuous\.form\.notificationPolicy'\)\}/)
  assert.match(form,/<option value="">\{t\('continuous\.form\.review'\)\}<\/option>/)
  assert.match(form,/notificationPolicy/)
  assert.match(form,/!notificationPolicy/)
})

test('数据源条目使用连接语义文案',async()=>{
 const source=await readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 assert.match(source,/market\.industry\.saved\.status\.dataSourceConnected/)
 assert.match(source,/market\.industry\.saved\.connectDataSource/)
 assert.match(source,/dataSourceInstance\.binding\.sourceId/)
})

test('MCP 条目提供登记、连接并核验与原生设置入口',async()=>{
 const source=await readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 assert.match(source,/mcpConnections\.instantiate\(/)
 assert.match(source,/mcpConnections\.connect\(/)
 assert.match(source,/market\.industry\.saved\.registerMcpConnection/)
 assert.match(source,/market\.industry\.saved\.connectMcpConnection/)
 assert.match(source,/market\.industry\.saved\.status\.mcpConnected/)
 const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(frame,/mcpConnections=\{/)
})

test('MCP 连接目录读取失败时给出可恢复的错误提示',async()=>{
 const source=await readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 assert.match(source,/\{mcpConnections\.error&&<p role="alert">\{localizeWorkError\(locale,mcpConnections\.error\)\}/)
 assert.match(source,/mcpConnections\.refresh\(\)/)
 assert.match(source,/market\.industry\.saved\.refreshMcpConnections/)
})

test('插件条目提供登记、安装与安装状态核对入口',async()=>{
 const source=await readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 assert.match(source,/plugins\.instantiate\(/)
 assert.match(source,/plugins\.install\(/)
 assert.match(source,/plugins\.reconcile\(/)
 assert.match(source,/market\.industry\.saved\.registerPlugin/)
 // 安装与启用改走与市场路径同一套知情同意：安装前逐条摆出权限、发布者、信任结论与完整性摘要，
 // 落到「已安装 · 待启用」再由本人第二次显式启用。安装按钮因此长在共用控件里。
 assert.match(source,/<IndustryPluginInstallControl/)
 assert.match(source,/preview=\{plugins\.preview\}/)
 assert.match(source,/plugins\.enable\(instanceId,preview\)/)
 const control=await readFile(new URL('../src/client/IndustryPluginInstallControl.tsx',import.meta.url),'utf8')
 assert.match(control,/market\.industry\.saved\.installPlugin/)
 assert.match(control,/PluginPreviewFacts|PluginInstallConfirm|EnableConfirm/)
 for(const piece of ['PluginPreviewFacts','PluginInstallConfirm','EnableConfirm','trustKey','trustNoticeKey'])assert.ok(control.includes(piece),piece)
 assert.match(source,/market\.industry\.saved\.reconcilePlugin/)
 assert.match(source,/market\.industry\.saved\.status\.pluginRegistered/)
 assert.match(source,/market\.industry\.saved\.status\.pluginInstalled/)
 assert.match(source,/market\.industry\.saved\.status\.pluginRestartRequired/)
 assert.match(source,/market\.industry\.saved\.status\.pluginPendingEnable/)
 assert.match(source,/pluginInstance\.definition\.packageName\}@\{pluginInstance\.definition\.version/)
 assert.match(source,/pluginInstance\?\.state==='installing'\|\|pluginInstance\?\.state==='pending-enable'\|\|pluginInstance\?\.state==='restart-required'\|\|pluginInstance\?\.state==='failed'/)
 assert.doesNotMatch(source,/item\.kind==='plugin'&&item\.status==='pending-adapter'&&<button type="button" onClick=\{nativeSettings\}/)
 const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(frame,/industryPluginApi\.list\(\)/)
 assert.match(frame,/industryPluginApi\.install\(input\)/)
 assert.match(frame,/plugins=\{\{items:industryPlugins/)
})

test('插件目录读取失败时给出可恢复的错误提示',async()=>{
 const source=await readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 assert.match(source,/\{plugins\.error&&<p role="alert">\{localizeWorkError\(locale,plugins\.error\)\}/)
 assert.match(source,/plugins\.refresh\(\)/)
 assert.match(source,/market\.industry\.saved\.refreshPlugins/)
})
