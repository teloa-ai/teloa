import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {BusinessCustomization}=await import('../lib/types/client/BusinessCustomization.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}

test('初始读取态是独立的会话定制面板，不把失败文案伪装成加载结果',()=>{
 const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(BusinessCustomization as never,{scope:'SOC',api:{directory:async()=>{throw Error('not reached')},preview:async()=>{throw Error('not reached')},apply:async()=>{throw Error('not reached')},revert:async()=>{throw Error('not reached')}},changed:()=>{}} as never)))
 assert.match(html,/业务定制/)
 assert.match(html,/正在加载业务定制/)
 assert.ok(!html.includes('暂时无法核对'))
})

test('完整预览三块复用 ObjectTypeBlock，所有内容以 React 文本节点渲染',()=>{
 const source=readFileSync(new URL('../src/client/BusinessCustomization.tsx',import.meta.url),'utf8')
 assert.match(source,/business\.custom\.preview\.diff/)
 assert.match(source,/business\.custom\.preview\.impact/)
 assert.match(source,/business\.custom\.preview\.trial/)
 assert.match(source,/<ObjectTypeBlock block=\{preview\.trial\}/)
 assert.doesNotMatch(source,/dangerouslySetInnerHTML/)
})

const {CustomizationPreview}=await import('../lib/types/client/BusinessCustomization.js')
const now='2026-09-17T00:00:00.000Z',hash='a'.repeat(64)
const draftOf=(kind:string,body:Record<string,unknown>)=>({id:'11111111-1111-4111-8111-111111111111',ownerId:'local:teloa-owner',requestId:'22222222-2222-4222-8222-222222222222',scope:'SOC',kind,localId:body.id,semver:'1.0.0',definitionHash:hash,body:JSON.stringify(body),status:'draft',createdAt:now,updatedAt:now})
const widget={format:'teloa.business-widget/v1',id:'alert-count',version:'1.0.0',domain:'SOC',title:'告警数',kind:'metric',query:'select count(*) as n from soc_alert',metric:{valueColumn:'n'}}
const head={schema:'teloa.business-definition-preview/v1',receipt:hash,base:{origin:'none'},diff:[],diffTruncated:false,computedAt:now}
const impact={scope:'SOC',objectType:'',views:[],actions:[],fields:[],widgets:['alert-count'],dashboards:['soc-ops']}
const trial=(status:'ok'|'failed')=>({widgetId:'alert-count',definitionHash:hash,computedAt:now,status,columns:status==='ok'?[{name:'n',type:'number'}]:[],rows:status==='ok'?[[3]]:[],rowCount:status==='ok'?1:0,truncated:false,bytes:3,stale:false,...(status==='failed'?{error:{code:'teloa/invalid-input',reason:'不允许的函数 pg_sleep'}}:{})})
const renderPreview=(preview:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(CustomizationPreview as never,{scope:'SOC',preview,busy:false,colorScheme:'light',confirm:()=>{},cancel:()=>{}} as never)))
const confirmButton=(html:string)=>html.match(/<button[^>]*>确认采用<\/button>/)?.[0]??assert.fail('没有确认按钮')

test('组件草案：试算失败只显示固定文案且确认禁用；试算通过时渲染组件、确认可点；影响含组件与看板',()=>{
 const failed=renderPreview({...head,draft:draftOf('widget',widget),impact,widgetTrial:trial('failed')})
 assert.match(failed,/SQL 不符合规则：不允许的函数 pg_sleep/)
 assert.match(failed,/试算没有通过/)
 assert.match(confirmButton(failed),/disabled/)
 const ok=renderPreview({...head,draft:draftOf('widget',widget),impact,widgetTrial:trial('ok')})
 assert.match(ok,/告警数/)
 assert.doesNotMatch(confirmButton(ok),/disabled/)
 assert.match(ok,/受影响组件/)
 assert.match(ok,/受影响看板/)
 assert.match(ok,/soc-ops/)
})

test('看板草案画只读网格缩略；映射草案画映射后前 5 条对象字段表',()=>{
 const dashboard={format:'teloa.business-dashboard/v1',id:'soc-ops',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets:['alert-count','risk'],layout:[{widget:'alert-count',x:0,y:0,w:6,h:2},{widget:'risk',x:6,y:0,w:6,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const board=renderPreview({...head,draft:draftOf('dashboard',dashboard),impact:{...impact,widgets:[]},dashboardTrial:{layout:dashboard.layout}})
 assert.match(board,/data-trial="dashboard"/)
 assert.match(board,/--widget-column:7 \/ span 6/)
 assert.match(board,/>risk</)
 assert.doesNotMatch(confirmButton(board),/disabled/)
 const mapping={format:'teloa.business-source-mapping/v1',id:'soc-alerts',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'soc-alert',source:{kind:'business-data-port',sourceId:'security-alerts'},mapping:[{path:'$.id',field:'alert-id'}],primaryKey:['alert-id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:600},acknowledgeShortInterval:false}
 const objects=Array.from({length:7},(_,index)=>({objectId:'a'+index,fields:[{field:'alert-id',value:'a'+index},{field:'severity',value:'<b>高</b>'}]}))
 const table=renderPreview({...head,draft:draftOf('source-mapping',mapping),impact:{...impact,objectType:'soc-alert',widgets:[],dashboards:[]},mappingTrial:{fetched:7,objects}})
 assert.match(table,/测试读取 7 条，以下为转换后的前 5 条/)
 assert.equal(table.match(/<tr>/g)?.length,1+5)
 assert.match(table,/&lt;b&gt;高&lt;\/b&gt;/)
 assert.doesNotMatch(table,/>a5</)
})

test('受管 MCP 来源的映射草案：未试拉时列出 server / tool / 参数与「试拉」按钮，不画空结果',()=>{
 const mapping={format:'teloa.business-source-mapping/v1',id:'soc-alerts',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'soc-alert',source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{status:'open',limit:20},itemsPath:'$.items'},mapping:[{path:'$.id',field:'alert-id'}],primaryKey:['alert-id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:600},acknowledgeShortInterval:false}
 const html=renderPreview({...head,draft:draftOf('source-mapping',mapping),impact:{...impact,objectType:'soc-alert',widgets:[],dashboards:[]},trialUnavailable:'pull-required'})
 assert.match(html,/data-trial="pull"/)
 assert.match(html,/soc/)
 assert.match(html,/list_alerts/)
 assert.match(html,/status = open/)
 assert.match(html,/limit = 20/)
 assert.match(html,/<button[^>]*>测试读取<\/button>/)
 assert.doesNotMatch(html,/暂时没有可试算的数据结果/)
})

test('试拉三态：受管连接未建立 / 数据源没接上各一句；pull-failed 固定句且保留可点的「试拉」按钮；no-objects 仍是通用句',()=>{
 const mapping=(source:Record<string,unknown>)=>({format:'teloa.business-source-mapping/v1',id:'soc-alerts',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'soc-alert',source,mapping:[{path:'$.id',field:'alert-id'}],primaryKey:['alert-id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:600},acknowledgeShortInterval:false})
 const mcp=mapping({kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{},itemsPath:'$.items'}),port=mapping({kind:'business-data-port',sourceId:'security-alerts'})
 const mappingImpact={...impact,objectType:'soc-alert',widgets:[],dashboards:[]}
 const connection=renderPreview({...head,draft:draftOf('source-mapping',mcp),impact:mappingImpact,trialUnavailable:'source-disconnected'})
 assert.match(connection,/连接 soc 尚未建立。请先在「连接」中完成配置，再测试读取。/)
 assert.doesNotMatch(connection,/暂时没有可试算的数据结果/)
 const source=renderPreview({...head,draft:draftOf('source-mapping',port),impact:mappingImpact,trialUnavailable:'source-disconnected'})
 assert.match(source,/数据源尚未连接。请完成连接和密钥配置后重新预览。/)
 // 对象类型 / 视图草案的 source-disconnected 同样按「数据源没接上」说。
 const objectType={format:'teloa.business-object-type/v1',id:'soc-alert',version:'1.0.0',domain:'SOC',title:'告警',unit:'条',lead:'告警',sourceId:'security-alerts',fields:[{name:'alert-id',label:'标识',type:'text',required:true,from:'标识'}]}
 assert.match(renderPreview({...head,draft:draftOf('object-type',objectType),impact:mappingImpact,trialUnavailable:'source-disconnected'}),/数据源尚未连接/)
 const failed=renderPreview({...head,draft:draftOf('source-mapping',mcp),impact:mappingImpact,trialUnavailable:'pull-failed'})
 assert.match(failed,/data-trial="pull-failed"/)
 assert.match(failed,/测试读取未返回可用数据。请重试，或在对话中检查数据接入规则。/)
 assert.match(failed,/<button type="button">测试读取<\/button>/,'pull-failed 保留可点的「测试读取」按钮')
 assert.doesNotMatch(failed,/数据源暂不可读|source-unavailable/)
 assert.match(renderPreview({...head,draft:draftOf('source-mapping',port),impact:mappingImpact,trialUnavailable:'no-objects'}),/暂时没有可试算的数据结果/)
 const unreadable=renderPreview({...head,draft:draftOf('source-mapping',port),impact:mappingImpact,trialUnavailable:'config-unreadable'})
 assert.match(unreadable,/data-trial="config-unreadable"/)
 assert.match(unreadable,/数据源配置文件无法读取，请检查配置文件后再预览。/)
 assert.doesNotMatch(unreadable,/数据源尚未连接|测试读取未返回可用数据/)
})

/**
 * 预览读取失败的显示要经过组件内部状态（点「查看变化」→ api.preview 拒绝 → message），renderToStaticMarkup 跑不到；
 * 照 project-overview-page.test.ts 的做法用最小假 React 驱动一遍：状态按调用序存放、effect 与 useCallback 按 deps 记忆，手动 render/settle。
 */
function interactive(api:Record<string,(...args:unknown[])=>Promise<unknown>>){
 const source=readFileSync(new URL('../src/client/BusinessCustomization.tsx',import.meta.url),'utf8')
 const states:unknown[]=[],effects:Array<{deps:unknown[];cleanup?:(()=>void)|undefined}|undefined>=[],memos:Array<{deps:unknown[];value:unknown}|undefined>=[];let cursor=0,pending:Array<()=>void>=[]
 const changed=(slot:{deps:unknown[]}|undefined,deps:unknown[])=>!slot||deps.length!==slot.deps.length||deps.some((value,index)=>value!==slot.deps[index])
 const React={
  Fragment:Symbol('fragment'),
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useState(initial:unknown){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],(value:unknown)=>{states[i]=typeof value==='function'?value(states[i]):value}]},
  useCallback(fn:unknown,deps:unknown[]){const i=cursor++;if(changed(memos[i],deps))memos[i]={deps,value:fn};return memos[i]!.value},
  useEffect(fn:()=>void|(()=>void),deps:unknown[]){const i=cursor++;if(changed(effects[i],deps)){effects[i]?.cleanup?.();pending.push(()=>{effects[i]={deps,cleanup:fn()??undefined}})}},
 }
 const t=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
 const modules:Record<string,unknown>={
  react:React,'@teloa/contract':contract,'./BusinessLedger.js':{ObjectTypeBlock:()=>null},'./BusinessWidgets.js':{BusinessWidget:()=>null},
  './business-customization-presentation.js':presentation,'./i18n/provider.js':{useI18n:()=>({t,locale:'zh-CN'})},
  './TaskPage.module.css':{default:new Proxy({},{get:(_,key)=>String(key)})},'./BusinessCustomization.module.css':{default:new Proxy({},{get:(_,key)=>String(key)})},'./BusinessDashboardPage.module.css':{default:new Proxy({},{get:(_,key)=>String(key)})},
 }
 const out:Record<string,(props:unknown)=>unknown>={}
 new Function('require','exports','React',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText)((id:string)=>modules[id],out,React)
 type Node={type:unknown;props:Record<string,unknown>;children:unknown[]}
 const nodes=(node:unknown):Node[]=>node&&typeof node==='object'&&'props' in node?[node as Node,...(node as Node).children.flatMap(nodes)]:[]
 const props={scope:'SOC',api,changed:()=>{},colorScheme:'light'}
 const render=()=>{cursor=0;const tree=out.BusinessCustomization!(props),jobs=pending;pending=[];jobs.forEach(fn=>fn());return nodes(tree)}
 const settle=()=>new Promise(resolve=>setTimeout(resolve,10))
 return {render,settle}
}
const contract=await import('@teloa/contract')
const presentation=await import('../lib/types/client/business-customization-presentation.js')

test('预览读取失败：跨声明核对的 invalid-input 显示「这份草案与本业务已有的定义对不上：{reason}」，其他 invalid-input 显示通用原因句；reason 截 200 字、作文本子节点不解释标记；其余码维持固定句',async()=>{
 const reason=('<b>数据源映射的目标字段不在对象类型声明里。</b>'+'字'.repeat(300)).slice(0,300)
 const directory={schema:'teloa.business-customization/v1',scope:'SOC',readAt:now,drafts:[draftOf('object-type',{format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:'SOC',title:'工单',unit:'条',lead:'工单',sourceId:'source-http',fields:[{name:'title',label:'标题',type:'text',required:true,from:'标题'}]})],entries:[]}
 let error:unknown=Object.assign(Error(reason),{code:'teloa/invalid-input',details:{crossReference:true}})
 const {render,settle}=interactive({directory:async()=>directory,preview:async()=>{throw error},apply:async()=>{throw Error('not reached')},revert:async()=>{throw Error('not reached')}})
 render();await settle()
 const open=render().find(node=>node.type==='button'&&node.children[0]==='查看变化')
 assert.ok(open,'目录读出后有「查看变化」按钮')
 ;(open.props.onClick as()=>void)();await settle()
 const alert=render().find(node=>node.props.role==='alert')
 assert.ok(alert,'失败信息以 role=alert 段落显示')
 assert.equal(alert.children.length,1)
 assert.equal(alert.children[0],'草案与当前业务配置不兼容，请在对话中修改草案：'+reason.slice(0,200),'reason 截 200 字后作单个文本子节点，标记原样进文本')
 error=Object.assign(Error('看板同步只允许只读工具：soc/list_alerts 不存在或不是只读工具。'),{code:'teloa/invalid-input'})
 ;(open.props.onClick as()=>void)();await settle()
 assert.equal(render().find(node=>node.props.role==='alert')?.children[0],'这次操作没有通过检查：看板同步只允许只读工具：soc/list_alerts 不存在或不是只读工具。','不带 crossReference 的 invalid-input 用通用原因句')
 error=Object.assign(Error('secret detail'),{code:'teloa/source-unavailable'})
 ;(open.props.onClick as()=>void)();await settle()
 const generic=render().find(node=>node.props.role==='alert')
 assert.equal(generic?.children[0],'暂时无法核对业务定制状态，请刷新后查看。','其余码只显示固定句，不带服务端原文')
})
