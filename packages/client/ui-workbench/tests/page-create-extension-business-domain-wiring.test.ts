import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import {businessDomainAutoShortName,businessDomainScopeKeyValid,createSentencePrompt} from '../src/client/page-create-presentation.ts'
import {PAGE_CREATE_MESSAGE_ROWS} from '../src/client/i18n/locales/page-create.ts'

const client=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')
const dictionary=new Map<string,string>(PAGE_CREATE_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
const t=(key:string,params?:Record<string,string|number>)=>{
 const value=dictionary.get(key)??key
 return value.replace(/\{(\w+)\}/g,(_,name:string)=>String(params?.[name]??''))
}

test('插件安装仍走既有市场安装控件；能力页扩展分节接一份知情同意版新建入口，不越过它直接落定草案',async()=>{
 const [entry,installations,market,capabilities,frame]=await Promise.all([
  client('ExtensionCreateEntry.tsx'),
  client('MarketPluginInstallations.tsx'),
  client('MarketPage.tsx'),
  client('TeamCapabilitiesPage.tsx'),
  client('WorkbenchFrame.tsx'),
 ])
 assert.match(entry,/readMarketPluginRegistrySource\(JSON\.parse\(preview\.draft\.body\)\)/)
 assert.match(entry,/<MarketPluginInstallControl\b/)
 assert.match(entry,/onInstalled=\{record=>\{void apply\(record\.id\)/)
 assert.match(installations,/onInstalled\?:\(record:MarketPluginInstallation\)=>void/)
 assert.match(installations,/const saved=await api\.install\(/)
 assert.ok(installations.indexOf('const saved=await api.install(')<installations.indexOf('onInstalled?.(saved)'))
 assert.match(market,/<MarketPluginInstallControl\b/)
 assert.match(market,/marketPluginInstallApi/)
 // 能力页的扩展分节重新接上 ExtensionCreateEntry（2e05edd 接过、61363c6 拆掉、隔离宿主实跑发现全仓无渲染点）：
 // 走 CreateEntry 的 renderConfirmation 形态，安装控件自己知情同意后回调 apply 落定草案，不传 onConfirm 抢它的活。
 assert.match(capabilities,/import \{ExtensionCreateEntry\} from '\.\/ExtensionCreateEntry\.js'/)
 const extensionStart=capabilities.indexOf("category==='extension'&&pageCreate?.marketPluginInstallApi&&<div className={css.createEntry}><CreateEntry entity=\"extension\"")
 const extensionEnd=capabilities.indexOf('</div>} ',extensionStart)
 assert.ok(extensionStart>=0&&extensionEnd>extensionStart,'没有抓到扩展分节的新建入口装配段')
 const extensionEntry=capabilities.slice(extensionStart,extensionEnd)
 assert.match(extensionEntry,/renderConfirmation=\{\(\{preview,apply\}\)=><ExtensionCreateEntry preview=\{preview\} api=\{pageCreate\.marketPluginInstallApi!\} apply=\{apply\}\/>\}/)
 assert.doesNotMatch(extensionEntry,/onConfirm=/)
 assert.doesNotMatch(extensionEntry,/openForm=/,'扩展新建没有「自己填」那一支')
 assert.match(frame,/<MarketPage[\s\S]*?marketPluginInstallApi=\{marketPluginInstallApi\}/)
 // WorkbenchFrame 把真实的插件安装 API 与「去市场挑」目标（扩展分类）一起交给能力页，不是能力页自己另起一份。
 assert.match(frame,/<TeamCapabilitiesPage[\s\S]*?marketPluginInstallApi:marketPluginInstallApi,openExtensionMarket:\(\)=>openMarketCategory\('plugin'\)/)
})

test('旧行业包创建入口保留显示名与合规范围键，确认仍按固定范围加载真实行业包',async()=>{
 const [entry,frame]=await Promise.all([
  client('BusinessDomainCreateEntry.tsx'),
  client('WorkbenchFrame.tsx'),
 ])
 // 显示名（任意文字，进清单标题）与英文短名（范围键）是两个输入框；只有短名合规才渲染 CreateEntry，
 // 且传给它的 scope 是短名，不是显示名——两者必须是不同的 state，不能拿同一段文字顶两份差事。
 assert.match(entry,/const \[name,setName\]=useState\(''\)/)
 assert.match(entry,/const \[shortName,setShortName\]=useState\(''\)/)
 assert.match(entry,/const value=shortName\.trim\(\)/)
 assert.match(entry,/businessDomainScopeKeyValid\(value\)/)
 assert.match(entry,/\{scopeValid&&<CreateEntry entity="business-domain" scope=\{value\}/)
 assert.doesNotMatch(entry,/scope=['"]general['"]/)
 assert.match(frame,/const scope=preview\.draft\.scope/)
 assert.match(frame,/pageCreateBusinessDomainIndustryItem\(JSON\.parse\(preview\.draft\.body\),t\('create\.businessDomain\.source'\),scope\)/)
 assert.match(frame,/const load=await industryLoadApi\.create\(/)
})

test('新业务由独立搭建草案预览，采用后按服务端正式范围打开，不要求先填写内部范围键',async()=>{
 const frame=await client('WorkbenchFrame.tsx')
 const ast=ts.createSourceFile('WorkbenchFrame.tsx',frame,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let panel:ts.JsxSelfClosingElement|undefined
 const visit=(node:ts.Node)=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText()==='BusinessBuilderPanel')panel=node;ts.forEachChild(node,visit)}
 visit(ast);assert.ok(panel,'新业务预览必须接入正式搭建面板')
 const renderedPanel=panel
 const callback=(name:string,scope:Record<string,unknown>)=>{
  const prop=renderedPanel.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText()===name) as ts.JsxAttribute|undefined
  assert.ok(prop?.initializer&&ts.isJsxExpression(prop.initializer)&&prop.initializer.expression)
  const js=ts.transpileModule('const callback='+prop.initializer.expression.getText(),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
  return new Function(...Object.keys(scope),js+';return callback')(...Object.values(scope))
 }
 const page=Symbol('BusinessConfigurationPage'),projection={mode:'preview',scope:'platform-generated',page:{definition:{title:'客户业务'}}}
 const render=callback('renderPage',{React:{createElement:(type:unknown,props:unknown)=>({type,props})},BusinessConfigurationPage:page,state:{colorScheme:'light'}})
 assert.deepEqual(render(projection),{type:page,props:{projection,colorScheme:'light'}})
 const opened:string[]=[],open=callback('onOpenSaved',{openBusinessScope:(scope:string)=>opened.push(scope)})
 assert.deepEqual(opened,[],'预览不能把草案范围当作正式业务打开')
 open({scope:'adopted-scope',version:1})
 assert.deepEqual(opened,['adopted-scope'])
 assert.doesNotMatch(frame,/<BusinessDomainCreateEntry\b/,'普通新建不能重新要求用户手填内部范围键')
})

test('业务范围键只认 ASCII 短名；显示名合规时才顺手代填，用户改过短名后不再跟随',()=>{
 assert.equal(businessDomainScopeKeyValid('recruiting'),true)
 assert.equal(businessDomainScopeKeyValid('招聘'),false)
 assert.equal(businessDomainScopeKeyValid('general'),true,'格式判据不认 general 语义，general 的排除留给后端与工具描述')
 assert.equal(businessDomainScopeKeyValid('a'.repeat(65)),false)
 assert.equal(businessDomainAutoShortName('招聘',false),undefined,'中文显示名不自动转写，短名保持不动')
 assert.equal(businessDomainAutoShortName('recruiting',false),'recruiting','ASCII 显示名合规时顺手代填短名')
 assert.equal(businessDomainAutoShortName('recruiting',true),undefined,'用户已手动改过短名后不再跟随显示名')
})

test('业务台账一句话预备文本同时点名范围键与显示名，清单 title 交代用显示名',()=>{
 const prompt=createSentencePrompt('business-domain','recruiting','帮我拟一份招聘行业模板。',t,'招聘')
 assert.match(prompt.text,/recruiting/)
 assert.match(prompt.text,/招聘/)
 assert.equal(prompt.sourceId,'business-domain:recruiting')
})

test('业务范围内把业务定义与数据连接分成两段，避免两个同名的新建入口',async()=>{
 const page=await client('BusinessPage.tsx')
 assert.match(page,/<CreateEntry entity="business-definition" titleKey="create\.title\.businessDefinition"/)
 assert.match(page,/<CreateEntry entity="connector" titleKey="create\.title\.connector"/)
})

test('页内新建的两条加载确认路径把整包内容哈希（packageContent.hash）传给 industry-loads/create，不用 teloa.json 单文件的 item.hash',async()=>{
 const source=await client('WorkbenchFrame.tsx')
 const calls=source.match(/industryLoadApi\.create\(\{requestId:crypto\.randomUUID\(\),contentId:item\.contentStorage\.contentId,contentHash:item\.packageContent\.hash/g)??[]
 assert.equal(calls.length,2,'连接器与新业务两条确认路径都要传 packageContent.hash')
 assert.doesNotMatch(source,/contentHash:item\.hash/)
})
