import * as marketIdentity from '../src/client/market-item-identity.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {marketSolutionResourceKinds} from '@teloa/contract'
import {createIndustryLoadApi} from '../src/client/industry-load-api.ts'
import {industryResourceDestinationGroups} from '../src/client/industry-template-presentation.ts'

// 方案详情页（已加入的行业模板）：标题层级、按钮层级、白话文案、筛选与列表口径一致。
type Node={type:unknown;props:Record<string,any>;children:Node[]}
const loadId='12345678-1234-4234-8234-123456789012',spaceId='22345678-1234-4234-8234-123456789012',mappingHash='b'.repeat(64)
const id=(n:number)=>'3234567'+n+'-1234-4234-8234-123456789012'
const item=(n:number,kind:string,title:string,extra:Record<string,unknown>={})=>({localId:'l'+n,instanceId:id(n),kind,title,version:'1.0.0',required:true,status:'pending-adapter',...extra})
const load={id:loadId,ownerId:'local:teloa-owner',contentId:spaceId,contentHash:'a'.repeat(64),templateId:'teloa.soc',templateVersion:'1.0.2',templateTitle:'安全运营',domain:'SOC',description:'安全工作资源',targetVersion:1,
 space:{id:spaceId,name:'安全运营',version:1,scope:'space-'+spaceId},
 items:[item(1,'role','告警分析员'),item(2,'knowledge','告警判据'),item(3,'skill','告警研判记录'),item(4,'data-source','告警数据来源'),item(5,'work-template','告警核对'),item(6,'plan','每日告警分诊'),item(7,'object-type','告警'),item(8,'business-view','告警看板')],
 relations:[{kind:'role-knowledge',from:id(1),to:id(2)}],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash,status:'active'}
function mount(props:Record<string,unknown>){
 const source=readFileSync(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const React={
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:Node[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useEffect:()=>{},
 }
 const exports:Record<string,any>={}
 // 阻塞项读取本身由 industry-load-api 的用例覆盖，这里只注入真实形状以核对界面如何呈现。
 const readBlockers=(reason:unknown):unknown[]=>{
  const details=reason&&typeof reason==='object'&&'details' in reason?(reason as {details?:{blockers?:unknown[]}}).details:undefined
  return Array.isArray(details?.blockers)?details.blockers:[]
 }
 const require=(id:string)=>id.endsWith('market-item-identity.js')?marketIdentity:id==='react'?React:id.endsWith('provider.js')?{useI18n:()=>({locale:'zh-CN',t:(key:string)=>key,dateTime:(value:string)=>value})}:id.endsWith('errors.js')?{localizeWorkError:(_:string,value:unknown)=>String(value)}:id.endsWith('industry-load-api.js')?{readUnloadBlockers:readBlockers}:new Proxy({default:new Proxy({},{get:(_,key)=>String(key)})},{get:(_,key)=>key==='default'?new Proxy({},{get:(_inner,name)=>String(name)}):()=>'none'})
 new Function('require','exports','React',js)(require,exports,React)
 return ()=>{cursor=0;return exports.SavedIndustryDirectory(props) as Node}
}
const nodes=(root:Node):Node[]=>root&&typeof root==='object'?[root,...root.children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]:[]
const text=(node:Node):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''
const buttons=(view:Node,label:string)=>nodes(view).filter(node=>node.type==='button'&&text(node)===label)
const empty={items:[],error:undefined,partial:false,refresh:async()=>{},pending:undefined,recoveryError:undefined,instantiate:async()=>{throw Error()},recover:async()=>{throw Error()}}
const props=(rows:unknown[],unload:Record<string,unknown>)=>({
 loads:rows,error:undefined,refresh:async()=>{},openMarket:()=>{},nativeSettings:()=>{},
 knowledge:{...empty},
 dataSources:{...empty,authorize:async()=>{throw Error()}},
 executionTools:{...empty,authorize:async()=>{throw Error()}},
 mcpConnections:{...empty,connect:async()=>{throw Error()}},
 plugins:{...empty,install:async()=>{throw Error()},reconcile:async()=>{throw Error()}},
 roles:{...empty,open:async()=>{}},
 tasks:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{}},
 plans:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{},openRole:async()=>{}},
 unload,
 skillInstallApi:{},
})

const textN=(node:any):string=>typeof node==='string'||typeof node==='number'?String(node):node?.children?.map(textN).join('')??''
const unload={pending:false,recoveryError:undefined,recover:async()=>{},run:async()=>{}}
const browserOf=(view:Node)=>nodes(view).find(node=>typeof node.type==='function'&&'resources' in node.props&&'render' in node.props)!
const readiness={read:async()=>({}),prepare:async()=>({})}

test('从能力页等处带着某一项进来：列表仍是全部资源，只是先选中那一项；筛选的「全部」与列表条数一致',()=>{
 const view=mount({...props([load],unload),loadId,target:{loadId,itemInstanceId:id(3)},readiness})()
 const browser=browserOf(view)
 assert.equal(browser.props.resources.length,load.items.length,'不再把列表筛成只剩那一项')
 assert.equal(browser.props.initialSelectedId,id(3))
 const all=nodes(view).find(node=>node.type==='button'&&node.props['aria-pressed']===true)!
 assert.match(textN(all),new RegExp('market.industry.saved.all\\s*'+load.items.length))
 assert.ok(nodes(view).some(node=>typeof node.type==='function'&&node.props.loadId===loadId&&'port' in node.props),'带着某一项进来也照常显示「还差几项就能用」')
})

test('模板名是页面主标题，版本是次要信息；加入编号只在详细信息里',()=>{
 const view=mount({...props([load],unload),loadId,readiness})()
 const heading=nodes(view).find(node=>node.type==='h2')!
 assert.equal(text(heading),'安全运营')
 assert.ok(!nodes(view).some(node=>node.type==='h3'&&text(node)==='market.industry.saved.working.environment'),'不再用「工作环境」压在模板名上面')
 const details=nodes(view).filter(node=>node.type==='details')
 const inDetails=new Set(details.flatMap(nodes))
 const idHolders=nodes(view).filter(node=>typeof node==='object'&&(node.children as unknown[]|undefined)?.some(child=>typeof child==='string'&&child.includes(loadId)))
 assert.ok(idHolders.length>0&&idHolders.every(node=>inDetails.has(node)),'加入编号只出现在折叠的详细信息里')
 for(const key of ['market.industry.saved.check.item.by.item','market.industry.saved.resources.required','market.industry.saved.item.skipped','market.industry.saved.ready'])assert.ok(!nodes(view).some(node=>text(node).includes(key)),key+' 不再出现')
 assert.ok(nodes(view).some(node=>text(node)==='market.industry.saved.the.pool.of.resources.has.been.loaded.to'),'状态一句：已加入你的业务')
})

test('按钮分层：查看模板来源是文字按钮，卸载是危险按钮且要先确认；确认条里的卸载同样是危险样式',()=>{
 const render=mount({...props([load],unload),loadId})
 const view=render()
 const source=buttons(view,'market.industry.saved.view.regular.template.sources')[0]!
 assert.match(String(source.props.className),/textButton/)
 const unloadButton=buttons(view,'market.industry.saved.unload')[0]!
 assert.match(String(unloadButton.props.className),/dangerButton/)
 unloadButton.props.onClick()
 const confirming=render()
 const confirm=buttons(confirming,'market.industry.saved.unload')[1]!
 assert.match(String(confirm.props.className),/dangerSolid/)
 assert.match(String(buttons(confirming,'market.industry.saved.unloadCancel')[0]!.props.className),/secondaryButton/)
})

test('分类筛选是分段控件：按市场标签命名，业务看板单独一组，没有内容的分组不显示',()=>{
 const view=mount({...props([load],unload),loadId})()
 const nav=nodes(view).find(node=>node.type==='nav')!
 assert.match(String(nav.props.className),/segmented/)
 const labels=nodes(nav).filter(node=>node.type==='button').map(textN).map(value=>value.replace(/\s*\d+$/,''))
 assert.deepEqual(labels,['market.industry.saved.all','market.presentation.category.agent','market.industry.saved.group.knowledge','market.teamCapabilities','market.industry.saved.group.tasks','market.industry.saved.group.plans','market.presentation.category.connector','composition.row.board'])
 const counts=nodes(nav).filter(node=>node.type==='button').slice(1).map(node=>Number(textN(node).match(/(\d+)$/)![1]))
 assert.equal(counts.reduce((sum,value)=>sum+value,0),load.items.length,'各组加起来等于「全部」')
})

test('完整业务配置经正式加载解码后仍归业务看板，分类计数与筛选保留全部合法资源',async()=>{
 const fixed={...load,templateId:'example-team',scope:load.space.scope,relations:[],items:marketSolutionResourceKinds.map((kind,index)=>({
  ...item(index+1,kind,'资源 '+kind),localId:'resource-'+index,instanceId:'32345678-1234-4234-8234-'+String(index+1).padStart(12,'0'),
 }))}
 const decoded=await createIndustryLoadApi(async(method,payload)=>{
  assert.equal(method,'industry-loads/get');assert.deepEqual(payload,{loadId});return fixed
 }).get(loadId)
 const draw=mount({...props([decoded],unload),loadId}),view=draw(),nav=nodes(view).find(node=>node.type==='nav')!
 const categories=nodes(nav).filter(node=>node.type==='button')
 const counts=categories.slice(1).map(node=>Number(textN(node).match(/(\d+)$/)![1]))
 assert.equal(counts.reduce((sum,value)=>sum+value,0),decoded.items.length,'每种宿主合法资源恰好归入一个分类')
 const boardKinds=industryResourceDestinationGroups.find(group=>group.key==='market.industry.destination.business')!.kinds
 const expected=decoded.items.filter(item=>boardKinds.includes(item.kind))
 const board=categories.find(node=>textN(node).startsWith('composition.row.board'))!
 assert.equal(Number(textN(board).match(/(\d+)$/)![1]),expected.length)
 board.props.onClick()
 assert.deepEqual(browserOf(draw()).props.resources.map((row:{instanceId:string})=>row.instanceId),expected.map(row=>row.instanceId),'业务筛选保留原完整配置及旧业务声明身份')
 categories[0]!.props.onClick()
 assert.equal(browserOf(draw()).props.resources.length,decoded.items.length)
 const configuration=decoded.items.find(item=>item.kind==='business-configuration')!
 const only=mount({...props([{...decoded,items:[configuration]}],unload),loadId})()
 assert.ok(nodes(only).some(node=>node.type==='button'&&/^composition\.row\.board\s*1$/.test(textN(node))),'只有完整业务配置时也有业务看板入口')
})

test('资源列表里的类型名与市场标签一致：同事、技能、资料、连接、扩展、持续计划',()=>{
 const browser=browserOf(mount({...props([load],unload),loadId})())
 const label=browser.props.kindLabel as (kind:string)=>string
 assert.deepEqual(['role','skill','knowledge','mcp','data-source','execution-tool','plugin','work-template','plan'].map(label),['market.presentation.category.agent','market.teamCapabilities','market.industry.saved.group.knowledge','market.presentation.category.connector','market.presentation.category.connector','market.presentation.category.connector','market.presentation.category.plugin','market.industry.saved.group.tasks','market.industry.saved.group.plans'])
})

test('右侧详情：没有关联资源时不显示空的「关联资源」标题；有关联时照常列出',()=>{
 const browser=browserOf(mount({...props([load],unload),loadId})())
 const render=(n:number)=>browser.props.render({id:id(n),...load.items[n-1]})
 const flat=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(flat):value&&typeof value==='object'?nodes(value as Node):[]
 assert.ok(!flat(render(3)).some(node=>text(node)==='market.industry.saved.associated.resources'),'技能没有关联时不显示标题')
 assert.ok(flat(render(1)).some(node=>text(node)==='market.industry.saved.associated.resources'),'员工关联了资料时显示')
})

test('右侧详情：实例编号、修订号、包名@版本等工程细节只在默认收起的「技术详情」里',()=>{
 const dsId='42345678-1234-4234-8234-123456789012',kId='52345678-1234-4234-8234-123456789012'
 const base={ownerId:'local:teloa-owner',loadId,contentId:spaceId,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+spaceId,createdAt:load.createdAt,updatedAt:load.createdAt}
 const all=props([load],unload)
 const view=mount({...all,loadId,
  dataSources:{...all.dataSources,items:[{...base,id:dsId,itemInstanceId:id(4),itemLocalId:'l4',state:'active',revision:3,binding:{sourceId:'src-secret-id'}}]},
  knowledge:{...all.knowledge,items:[{...base,id:'k',itemInstanceId:id(2),itemLocalId:'l2',state:'active',revision:1,resource:{id:kId,version:7}}]},
 })()
 const browser=browserOf(view)
 const flat=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(flat):value&&typeof value==='object'?nodes(value as Node):[]
 for(const [n,secret] of [[4,dsId],[4,'src-secret-id'],[2,kId]] as const){
  const tree=flat(browser.props.render({id:id(n),...load.items[n-1]}))
  const holders=tree.filter(node=>(node.children as unknown[]|undefined)?.some(child=>typeof child==='string'&&child.includes(secret)))
  assert.ok(holders.length>0,secret+' 仍可在技术详情里查到')
  const tech=tree.filter(node=>node.type==='details'&&nodes(node).some(child=>child.type==='summary'&&text(child)==='market.industry.saved.techDetails'))
  assert.equal(tech.length,1)
  assert.ok(!tech[0]!.props.open,'技术详情默认收起')
  const inside=new Set(nodes(tech[0]!))
  assert.ok(holders.every(node=>inside.has(node)),secret+' 不出现在技术详情之外')
 }
})

test('同事详情用白话：指定的资料、模板声明的技能连接和工具；读屏名只念模板名，不念编号',()=>{
 const roleInstance={ownerId:'local:teloa-owner',loadId,contentId:spaceId,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+spaceId,createdAt:load.createdAt,updatedAt:load.createdAt,
  id:'r',itemInstanceId:id(1),itemLocalId:'l1',state:'active',revision:1,role:{id:'62345678-1234-4234-8234-123456789012',version:1},
  knowledge:[{itemInstanceId:id(2),resourceId:'72345678-1234-4234-8234-123456789012',resourceVersion:2}],omittedKnowledge:[],declarations:[{kind:'skill',itemInstanceId:id(3),status:'pending-adapter'}]}
 const all=props([load],unload)
 const view=mount({...all,loadId,roles:{...all.roles,items:[roleInstance]}})()
 const section=nodes(view).find(node=>typeof node.props['aria-label']==='string'&&node.props['aria-label'].startsWith('market.industry.saved.loadTemplateAria'))!
 assert.equal(section.props['aria-label'],'market.industry.saved.loadTemplateAria','读屏名只带模板名参数（mount 的 t 只回键名）')
 const flat=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(flat):value&&typeof value==='object'?nodes(value as Node):[]
 const tree=flat(browserOf(view).props.render({id:id(1),...load.items[0]}))
 const all_=tree.map(text).join('\n')
 assert.ok(tree.some(node=>node.type==='h4'&&text(node)==='market.industry.saved.fixed.knowledge.reference'))
 assert.ok(tree.some(node=>node.type==='h4'&&text(node)==='market.industry.saved.declaration.dependence'))
 // N24：声明快照只记录创建员工时的模板声明；没有可核实的当前状态时只列声明本身，不冒充「待准备」或「可用」。
 assert.ok(tree.some(node=>node.type==='li'&&text(node)==='告警研判记录'),'读不到准备清单时只列模板声明')
 assert.ok(!tree.some(node=>node.type==='li'&&text(node).startsWith('告警研判记录 · ')),'不显示初始声明状态')
 assert.ok(!all_.includes('market.industry.saved.to.fit.not.installed.or.authorized'))
 const tech=tree.find(node=>node.type==='details')!,inTech=new Set(nodes(tech))
 assert.ok(tree.filter(node=>(node.children as unknown[]|undefined)?.some(child=>typeof child==='string'&&child.includes('72345678'))).every(node=>inTech.has(node)),'指定资料的编号只在技术详情里')
})

test('同事详情的模板声明复用准备清单的真实状态：与「都准备好了」同源，跳过项仍写已跳过',()=>{
 const roleInstance={ownerId:'local:teloa-owner',loadId,contentId:spaceId,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+spaceId,createdAt:load.createdAt,updatedAt:load.createdAt,
  id:'r',itemInstanceId:id(1),itemLocalId:'l1',state:'active',revision:1,role:{id:'62345678-1234-4234-8234-123456789012',version:3},
  knowledge:[],omittedKnowledge:[],declarations:[{kind:'skill',itemInstanceId:id(3),status:'pending-adapter'},{kind:'data-source',itemInstanceId:id(4),status:'pending-adapter'},{kind:'mcp',itemInstanceId:id(8),status:'skipped'}]}
 const all=props([load],unload)
 const draw=mount({...all,loadId,readiness,roles:{...all.roles,items:[roleInstance]}})
 // 只取三条模板声明（「关联资源」另有自己的目录状态，不在本断言范围）
 const titleOf=(n:number)=>load.items.find(row=>row.instanceId===id(n))?.title??id(n)
 const declared=()=>{const flat=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(flat):value&&typeof value==='object'?nodes(value as Node):[];return flat(browserOf(draw()).props.render({id:id(1),...load.items[0]})).filter(node=>node.type==='li').map(text).filter(value=>[3,4,8].some(n=>value.startsWith(titleOf(n))))}
 const panel=nodes(draw()).find(node=>typeof node.type==='function'&&node.props.loadId===loadId&&'port' in node.props)!
 assert.equal(panel.props.relations,load.relations,'准备清单按方案关联判断员工依赖')
 // 清单读到之前：只有模板声明，跳过项照旧
 const before=declared()
 assert.deepEqual(before,['告警研判记录','告警数据来源',titleOf(8)+' · market.industry.saved.skipped'])
 // 宿主清单回报后：与面板同一真实状态
 panel.props.onRead({loadId,status:'active',title:'安全运营',version:'1.0.2',digest:'9'.repeat(64),counts:{ready:1,auto:0,needsUser:1,optional:0,pending:0},rows:[
  {itemInstanceId:id(3),kind:'skill',title:'告警研判记录',state:'ready',step:null,entry:null},
  {itemInstanceId:id(4),kind:'data-source',title:'告警数据来源',state:'needs-user',step:null,entry:'connector-settings'}]})
 assert.deepEqual(declared(),['告警研判记录 · market.industry.saved.declaration.state.ready','告警数据来源 · market.industry.saved.declaration.state.needsUser',titleOf(8)+' · market.industry.saved.skipped'])
 // 面板重读开始或失败时回报 undefined：撤下已有的成功快照，只列名称，不把上次的「已就绪」当现在
 panel.props.onRead(undefined)
 assert.deepEqual(declared(),before)
 // 其他加载的清单不能写进本加载
 panel.props.onRead({loadId:'82345678-1234-4234-8234-123456789012',status:'active',title:'其他方案',version:'1.0.0',digest:'8'.repeat(64),counts:{ready:1,auto:0,needsUser:0,optional:0,pending:0},rows:[{itemInstanceId:id(3),kind:'skill',title:'告警研判记录',state:'ready',step:null,entry:null}]})
 assert.deepEqual(declared(),before)
 // 重新核对成功：同一条目的准确状态
 panel.props.onRead({loadId,status:'active',title:'安全运营',version:'1.0.2',digest:'7'.repeat(64),counts:{ready:1,auto:0,needsUser:1,optional:0,pending:0},rows:[
  {itemInstanceId:id(3),kind:'skill',title:'告警研判记录',state:'needs-user',step:null,entry:'skill-confirm'},
  {itemInstanceId:id(4),kind:'data-source',title:'告警数据来源',state:'ready',step:null,entry:null}]})
 assert.deepEqual(declared(),['告警研判记录 · market.industry.saved.declaration.state.needsUser','告警数据来源 · market.industry.saved.declaration.state.ready',titleOf(8)+' · market.industry.saved.skipped'])
})

test('方案词条十语白话：不再出现锁定的知识引用、所需依赖、待适配、岗位',async()=>{
 const {MARKET_SAVED_RESTORED_ROWS}=await import('../src/client/i18n/locales/market-saved-restored.ts')
 const {MARKET_INSTALLATION_MESSAGE_ROWS}=await import('../src/client/i18n/locales/market-installations.ts')
 const rows=[...MARKET_SAVED_RESTORED_ROWS,...MARKET_INSTALLATION_MESSAGE_ROWS].filter(row=>row[0].startsWith('market.industry.saved.'))
 const zh=rows.map(row=>row[1]+row[2]).join('\n')
 for(const word of ['锁定的知识引用','所需依赖','待适配','岗位','崗位','AI 员工','數位員工','加载编号'])assert.ok(!zh.includes(word),word)
 const en=rows.map(row=>row[3]).join('\n')
 for(const word of ['Added-as ID','Adapter pending','Other Organiser','Locked knowledge reference'])assert.ok(!en.includes(word),word)
 const get=(key:string)=>rows.find(row=>row[0]===key)!
 assert.equal(get('market.industry.saved.techDetails')[1],'技术详情');assert.equal(get('market.industry.saved.techDetails')[3],'Technical details')
 assert.equal(get('market.industry.saved.load.numbering')[1],'本机标识')
 assert.equal(get('market.industry.saved.fixed.knowledge.reference')[1],'指定的资料')
 assert.equal(get('market.industry.saved.status.adapterPending')[1],'待准备')
})


test('两份固定内容字节相同，查看来源仍逐项打开原 contentId，不能退回 hash 别名',()=>{
 const other={...load,id:'42345678-1234-4234-8234-123456789012',contentId:'52345678-1234-4234-8234-123456789012',templateTitle:'另一署名的安全运营'}
 const opened:string[]=[],view=mount({...props([load,other],unload),openMarket:(id:string)=>opened.push(id)})()
 const sources=buttons(view,'market.industry.saved.view.regular.template.sources')
 assert.equal(sources.length,2);for(const source of sources)source.props.onClick()
 assert.deepEqual(opened,['stored-'+load.contentId,'stored-'+other.contentId])
 assert.equal(load.contentHash,other.contentHash)
})
