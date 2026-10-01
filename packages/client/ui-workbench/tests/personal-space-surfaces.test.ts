import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {businessScopeNames,initialBusinessSpaces,type BusinessScopeLabel} from '../src/client/business-directory.ts'
import {checkMarketTarget,marketTargetKey,marketTargets} from '../src/client/market-target.ts'
import {emptyCollaboration} from '../src/client/collaboration-preview.ts'
import {EDITION_MESSAGE_ROWS} from '../src/client/i18n/locales/edition.ts'

const root=new URL('../src/client/',import.meta.url)
const read=(name:string)=>readFile(new URL(name,root),'utf8')

type Node={type:unknown;props:Record<string,any>;children:Node[]}
const nodes=(node:unknown):Node[]=>node&&typeof node==='object'&&'children' in (node as Node)
 ?[node as Node,...(node as Node).children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]
 :[]
const text=(node:unknown):string=>typeof node==='string'?node:typeof node==='number'?String(node):node&&typeof node==='object'?((node as Node).children??[]).map(text).join(''):''
const buttons=(view:Node,label:string)=>nodes(view).filter(node=>node.type==='button'&&text(node)===label)

/** 门控的哨兵：转译执行时用它替代真实 `EditionGate`，便于断言“哪个控件被包住了”。 */
const gateMarker=Symbol('EditionGate')

/**
 * 把单个客户端组件转译进测试进程执行：React 只需三个钩子，其余依赖按名注入。
 * 与 `industry-unload.test.ts` 同一手法——渲染真实按钮与真实提交入参，而不是断言源码字符串。
 */
function mount(file:string,props:Record<string,unknown>,modules:Record<string,unknown>={}){
 const source=readFileSync(new URL(file,root),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const React={
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useMemo:(factory:()=>unknown)=>factory(),
  useEffect:()=>{},
 }
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const require=(id:string)=>{
  if(id==='react')return React
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  for(const [suffix,value] of Object.entries(modules))if(id.endsWith(suffix))return value
  if(id.endsWith('provider.js'))return {useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):key,dateTime:(value:string)=>value})}
  if(id.endsWith('errors.js'))return {localizeWorkError:(_:string,value:unknown)=>String(value)}
  if(id.endsWith('EditionGate.js'))return {EditionGate:gateMarker}
  if(id.endsWith('.css'))return {default:cssProxy}
  return new Proxy({default:cssProxy},{get:(_,key)=>key==='default'?cssProxy:()=>'none'})
 }
 const exports:Record<string,any>={}
 new Function('require','exports','React',js)(require,exports,React)
 const name=file.replace(/\.tsx$/,'').split('/').at(-1)!
 return ()=>{cursor=0;return exports[name](props) as Node}
}

test('左栏顶部不再有空间入口与切换箭头；账号块提供「我的分身」入口；顶栏面包屑改用用户名',async()=>{
 const [nav,styles,frame]=await Promise.all([read('WorkNavigation.tsx'),read('WorkbenchFrame.module.css'),read('WorkbenchFrame.tsx')])
 // 个人版左栏顶部只剩品牌与「新建」：不再有空间名入口，也不再引用 EditionGate/space-switcher。
 assert.doesNotMatch(nav,/css\.spaceRow|css\.spaceName|css\.spaceSwitch/)
 assert.doesNotMatch(nav,/EditionGate/,'本页不再引用 EditionGate，特性键留给企业版')
 assert.doesNotMatch(styles,/\.spaceRow\{|\.spaceName\{|\.spaceSwitch\{/,'孤儿样式随引用一起清理')
 // 账号块：姓名下面是「我的分身」入口，由主框架直接打开最近关联会话。
 assert.match(nav,/openTwin:\(\)=>Promise<void>/)
 assert.match(nav,/if\(openingTwin\.current\|\|creating\)return/)
 assert.match(nav,/openingTwin\.current=true/)
 assert.match(nav,/t\('navigation\.twin'\)/)
 assert.doesNotMatch(nav,/navigation\.twinMissing|twinNotice/)
 // 窄屏下「我的分身」这行字要有 44px 命中区。
 assert.match(styles,/@media\(max-width:740px\)\{[^@]*\.navigation \.twinLink\{display:flex;align-items:center;min-height:44px\}/)
 // 顶栏面包屑与左栏账号块同源：都读 personalProfile 的 displayName，不再提「我的工作空间」。
 assert.match(frame,/const profile=useSyncExternalStore\(personalProfile\.subscribe,personalProfile\.getSnapshot,personalProfile\.getSnapshot\)/)
 // 分身只负责本人代拟与判断建议，不进入数字员工的岗位资料/任务拆分授权面。
 assert.match(frame,/role\?\.kind==='employee'&&<RoleToolGrants/)
 // 2026-09-20 用户裁定面包屑可点：显示名成为回工作台的按钮，页名成为回列表根的按钮。
 assert.match(frame,/<button type="button" className=\{clsx\(css\.crumb,css\.workspaceName\)\} onClick=\{\(\)=>actions\.navigate\('home'\)\}>\{profile\.displayName\}<\/button>/)
 assert.match(frame,/aria-current="page" onClick=\{\(\)=>openViewRoot\(state\.view\)\}><strong>\{labels\[state\.view\]\}<\/strong><\/button>/)
 assert.doesNotMatch(frame.slice(frame.indexOf('css.crumb,css.workspaceName')-5,frame.indexOf('css.crumb,css.workspaceName')+160),/shell\.workspace\.mine/)
 // WorkbenchFrame 把直接会话入口传给左栏：有历史按最近活跃打开，零历史复用既有创建链路。
 assert.match(frame,/openTwin=\{async\(\)=>\{await openTwinConversation\(\)\}\}/)
 assert.match(frame,/objectConversationApi\.list\('role',role\.id\)/)
 assert.match(frame,/const recent=latestRoleConversation\(presentConversations\(/)
 assert.match(frame,/if\(!recent\)\{[\s\S]{0,180}await requestRoleCreation\(object,role\.scopes\)[\s\S]{0,40}return true/)
 assert.match(frame,/if\(available\.length>1\)\{setRoleScopeIntent\(\{object,scopes:available\}\);return\}/,'跨业务范围先选业务语境，不把业务范围误当成本机执行位置')
 assert.equal(frame.match(/canStart:roleCanStartConversation\(role\.state\)/g)?.length,3,'暂停只是不再接新任务，仍应能开始聊天；只有离职阻断新会话')
 assert.match(frame,/roleConversationOpening\.current\.has\(roleId\)/,'所有分身与AI 员工直达入口应共用防重复打开锁')
 assert.match(frame,/return createWork\(decision\.workspaceId,intent,true\)\.catch\(\(\)=>\{\}\)/,'自动创建必须把 Promise 交回调用者，岗位锁才能覆盖完整创建过程')
 const roleContext=frame.slice(frame.indexOf("conversationObject.object.kind==='role'&&contextRole"),frame.indexOf('nativeConversation',frame.indexOf("conversationObject.object.kind==='role'&&contextRole")))
 assert.equal(roleContext.match(/navigation\.newConversation/g)?.length,1,'岗位上下文只保留页内的新建会话主入口')
 assert.match(frame,/\{!contextRole&&<button type="button" role="menuitem"/,'岗位会话顶部更多菜单只在非岗位会话提供新建入口')
})

test('业务范围内页页头只剩范围名与摘要条：没有「我的工作空间」、没有「个人版 · 单空间」、没有范围下拉',async()=>{
  const page=await read('BusinessPage.tsx')
  assert.match(page,/<h1>\{collaborationScopes\[target\.scope\]\|\|target\.scope\}<\/h1>/)
  // 「只有一个的东西不命名」：空间名、个人版副标题与范围切换器都不在这一页了（词条本身留给别处）。
  assert.doesNotMatch(page,/navigation\.spaceFallback|edition\.personal\.subtitle|business\.scope\.switcherAria|business\.workspace\.label/)
  // 页签条撤掉之后，页头到范围摘要条之间就是整个页头区。
  const header=page.slice(page.indexOf('<header className={css.pageHeader}'),page.indexOf('<section className={css.scopeBar}'))
  assert.doesNotMatch(header,/<select|<details/,'页头里既没有范围切换器也没有管理菜单')
  assert.match(page,/const collaborationScopes=useBusinessScopes\(\)/)
 // 正式页不再携带不可达的演示对象、执行记录或项目数据分支；任务只从已保存任务读取。
 for(const key of ['sandbox-ledger','sandbox-directory','sandbox-section','businessTasksForMode'])assert.doesNotMatch(page,new RegExp(key))
 assert.match(page,/ledgerVisible&&<BusinessLedgerSurface/)
 assert.doesNotMatch(page,/function BusinessCurrent/)
  // 「新建业务空间」「编辑当前空间」随管理菜单一起退场。
  assert.doesNotMatch(page,/business-space-create|business\.workspace\.editCurrent|BusinessSpaceForm/)
})

test('市场加载表单只有一条只读目的地，新建空间项被门控，提交的目标是本空间的 existing',async()=>{
 const spaceId='11111111-1111-4111-8111-111111111111',contentId='22222222-2222-4222-8222-222222222222',contentHash='a'.repeat(64)
 const sent:unknown[]=[]
 const item={id:'directory-'+contentHash,contentStorage:{contentId,loaded:true},manifest:{format:'teloa.business-package/v2',domain:'research',scope:'research',resources:[{kind:'role'},{kind:'knowledge'}]}}
 const space={id:spaceId,name:'我的工作空间',description:'',version:4,kind:'personal',createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-11T00:00:00.000Z'}
 const modules={
  'market-home-presentation.js':{localizedMarketItemCopy:()=>({title:'调查行业模板'})},
  'business-scope-context.js':{useBusinessScopes:()=>({research:'调查行业'})},
  'industry-template-presentation.js':{industryResourceDestinationGroups:[{key:'market.industry.destination.role',kinds:['role']},{key:'market.industry.destination.knowledge',kinds:['knowledge']}],isBusinessDeclarationPackage:()=>false},
 }
 const render=mount('IndustryLoadForm.tsx',{item,space,pending:undefined,recoveryError:undefined,load:async(input:unknown)=>{sent.push(input)},recover:async()=>{}},modules)
 const target=render()
 // 目的地是一行只读文案，范围名取自标签目录（与切换器、目录组标题同源），没有任何目的地选择器。
 const destination='market.industry.load.personalDestination:'+JSON.stringify({domain:'调查行业'})
 assert.ok(nodes(target).some(node=>node.type==='p'&&text(node)===destination),'缺少只读目的地行')
 assert.equal(nodes(target).filter(node=>node.type==='select').length,0,'目的地不再是二选一')
 assert.equal(nodes(target).filter(node=>node.type==='input').length,0,'不再要求填新空间名')
 // 「新建空间…」在门控里，自己没有 onClick。
 const gated=nodes(target).find(node=>node.type===gateMarker)
 assert.ok(gated,'新建空间项必须被 EditionGate 包住')
 assert.equal(gated.props.feature,'industry-load-new-space')
 const entry=nodes(gated).find(node=>node.type==='button')!
 assert.equal(text(entry),'market.industry.load.newSpace')
 assert.equal(entry.props.onClick,undefined)
 // 下一步 → 核对页 → 确认：提交的目标固定是本空间。
 nodes(target).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 const review=render()
 assert.equal(buttons(review,'market.industry.load.confirm').length,1)
 buttons(review,'market.industry.load.confirm')[0]!.props.onClick()
 await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(sent.length,1)
 const input=sent[0] as {requestId:string;contentId:string;contentHash:string;target:Record<string,unknown>}
 assert.deepEqual(Object.keys(input).sort(),['contentHash','contentId','requestId','target'])
 assert.deepEqual(input.target,{kind:'existing',spaceId,expectedVersion:4})
 assert.equal(input.contentId,contentId)
 assert.equal(input.contentHash,contentHash)
 assert.match(input.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
 // 核对页的目的地与第一步同一句话。
 assert.ok(nodes(review).some(node=>node.type==='dd'&&text(node)===destination))
 // 标签目录里没有这个 domain（首次加载的新范围）时用模板标题，不把内部 scope 代码露给用户。
 const bare=mount('IndustryLoadForm.tsx',{item,space,pending:undefined,recoveryError:undefined,load:async()=>{},recover:async()=>{}},{...modules,'business-scope-context.js':{useBusinessScopes:()=>({})}})()
 assert.ok(nodes(bare).some(node=>node.type==='p'&&text(node)==='market.industry.load.personalDestination:'+JSON.stringify({domain:'调查行业模板'})))
 assert.ok(!nodes(bare).some(node=>node.type==='p'&&text(node).includes('"domain":"research"')),'不显示内部 scope 代码')
 // 空间还没读到时不给提交，并用 role="status" 说明原因。
 const unread=mount('IndustryLoadForm.tsx',{item,space:undefined,pending:undefined,recoveryError:undefined,load:async()=>{throw Error('不该被调用')},recover:async()=>{}},modules)()
 const status=nodes(unread).find(node=>node.props.role==='status')
 assert.equal(text(status),'market.industry.load.spaceUnavailable')
 assert.equal(buttons(unread,'market.industry.load.next')[0]!.props.disabled,true)
})

test('已保存行业目录按业务范围标签分组，组标题是标签名，条目仍是模板标题，不再出现空间名',()=>{
 const load=(id:string,scope:string,templateTitle:string)=>({
  id,ownerId:'local:teloa-owner',contentId:id,contentHash:'a'.repeat(64),templateId:'t-'+scope,templateVersion:'1.0.0',templateTitle,
  domain:scope,description:'',targetVersion:1,space:{id:'11111111-1111-4111-8111-111111111111',name:'我的工作空间',version:1,scope},
  items:[],relations:[],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active',
 })
 const rows=[load('load-soc-1','SOC','安全运营模板'),load('load-research','research','调查行业模板'),load('load-soc-2','SOC','应急响应模板')]
 const empty={items:[],error:undefined,partial:false,refresh:async()=>{},pending:undefined,recoveryError:undefined,instantiate:async()=>{throw Error()},recover:async()=>{throw Error()}}
 const render=mount('SavedIndustryDirectory.tsx',{
  loads:rows,error:undefined,refresh:async()=>{},openMarket:()=>{},nativeSettings:()=>{},
  knowledge:{...empty},dataSources:{...empty,authorize:async()=>{throw Error()}},executionTools:{...empty,authorize:async()=>{throw Error()}},
  mcpConnections:{...empty,connect:async()=>{throw Error()}},plugins:{...empty,install:async()=>{throw Error()},reconcile:async()=>{throw Error()}},
  roles:{...empty,open:async()=>{}},
  tasks:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{}},
  plans:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{},openRole:async()=>{}},
  unload:{pending:false,recoveryError:undefined,run:async()=>{},recover:async()=>{}},
  skillInstallApi:{},
 },{'business-scope-context.js':{useBusinessScopes:()=>({SOC:'安全运营',research:'调查行业'})}})
 const view=render()
 // 列出多套模板时范围名是分组标题（h2），模板名降为 h3；只打开一套时模板名自己做主标题（见 saved-industry-detail.test.ts）。
 const hasClass=(node:{props:Record<string,unknown>},name:string)=>String(node.props.className??'').split(' ').includes(name)
 const groups=nodes(view).filter(node=>node.type==='h2'&&hasClass(node,'environmentScopeTitle')).map(text)
 // 首次出现的顺序即目录顺序，同一范围的两次加载合并在一组里。
 assert.deepEqual(groups,['安全运营','调查行业'])
 const sections=nodes(view).filter(node=>hasClass(node,'environmentScope'))
 assert.equal(sections.length,2)
 assert.deepEqual(sections.map(section=>section.props['aria-label']),['安全运营','调查行业'])
 assert.deepEqual(nodes(sections[0]!).filter(node=>hasClass(node,'environmentLoad')).length,2)
 assert.deepEqual(nodes(sections[1]!).filter(node=>hasClass(node,'environmentLoad')).length,1)
 // 条目标题仍是模板标题；个人版下每个加载的 space.name 都一样，不该出现在界面上。
 assert.ok(text(sections[0]!).includes('安全运营模板')&&text(sections[0]!).includes('应急响应模板'))
 assert.ok(text(sections[1]!).includes('调查行业模板'))
 assert.ok(!text(view).includes('我的工作空间'),'不再按空间名区分加载')
 // 加载卡片的读屏名说的是模板，不能沿用“工作空间 {name}：{id}”那条。
 const loadSections=nodes(view).filter(node=>hasClass(node,'environmentLoad'))
 assert.equal(loadSections.length,3)
 for(const section of loadSections)
  assert.equal(section.props['aria-label'],'market.industry.saved.loadTemplateAria:'+JSON.stringify({name:text(nodes(section).find(node=>node.type==='h3')!)}))
 // 组标题是 h2、模板名是 h3：层级不倒挂。
 assert.equal(nodes(sections[0]!).filter(node=>node.type==='h2'&&hasClass(node,'environmentScopeTitle')).length,1)
})

test('已保存行业目录的读屏名用模板语义词条，不再借用“工作空间 {name}”那条',async()=>{
 const [directory,edition]=await Promise.all([read('SavedIndustryDirectory.tsx'),read('i18n/locales/edition.ts')])
 assert.match(directory,/market\.industry\.saved\.loadTemplateAria',\{name:load\.templateTitle\}/)
 assert.doesNotMatch(directory,/market\.industry\.saved\.loadAria/)
 // 读屏只念模板名，编号不念（编号在技术详情里）。
 assert.match(edition,/["']market\.industry\.saved\.loadTemplateAria["'],["']方案 \{name\}["']/)
 // 指定方案未添加与当前业务没有方案仍是两种状态；省去重复标题，用说明区分。
 assert.match(directory,/market\.industry\.saved\.the\.current\.template\.only\.contains\.resource\.statements\.in/)
 assert.match(directory,/market\.industry\.saved\.scopeEmpty/)
})

test('首页与任务页的业务范围筛选项全部来自标签目录，域标签与内置标签一样可选',async()=>{
 const [home,tasks]=await Promise.all([read('HomeComposerContext.tsx'),read('TaskPage.tsx')])
 for(const [name,source] of [['WorkHome.tsx',home],['TaskPage.tsx',tasks]] as const){
  assert.match(source,/useBusinessScopes\(\)/,name)
  // 没有写死的内置范围清单——域标签因此不会被筛选器吞掉。
  assert.doesNotMatch(source,/\['general','SOC','AppSec'/,name)
  assert.doesNotMatch(source,/'Design'/,name)
 }
 assert.match(home,/Object\.entries\(scopes\)/)
 assert.match(tasks,/Object\.entries\(collaborationScopes\)\.map\(\(\[id,label\]\)=><label/)
 assert.match(tasks,/Object\.entries\(collaborationScopes\)\.map\(\(\[id,label\]\)=><option/)
 // 标签目录里出现的域标签确实进得了选项集合；内置名称词典不能凭空增加正式选项。
 const labels:BusinessScopeLabel[]=[{scope:'research',title:'调查行业',kind:'domain',loads:1,activeLoads:1,tasks:0,groups:0}]
 const names=businessScopeNames(labels,{general:'通用工作'})
 assert.deepEqual(Object.keys(names),['research'])
 assert.equal(names.research,'调查行业')
 assert.equal(names.general,undefined)
})

test('市场目标就是业务范围标签本身：按范围识别，没有版本可言',()=>{
 const labels:BusinessScopeLabel[]=[{scope:'research',title:'调查行业',kind:'domain',loads:2,activeLoads:1,tasks:3,groups:0}]
 const [target]=marketTargets([],emptyCollaboration(),labels)
 assert.deepEqual(target,{kind:'business',id:'research',scope:'research',title:'调查行业',version:1,availability:'active'})
 // 身份只由 kind+id+scope 组成，而 id 与 scope 都是标签本身。
 assert.equal(marketTargetKey(target!),marketTargetKey({kind:'business',id:'research',scope:'research'}))
 // 标签没有版本：改标题、改计数都不会把已冻结的使用意图判成 changed。
 const renamed=marketTargets([],emptyCollaboration(),[{...labels[0]!,title:'调查行业（改）',loads:9,tasks:9}])
 assert.deepEqual(checkMarketTarget({kind:'business',id:'research',scope:'research',version:1,title:'调查行业'},renamed),{status:'current',params:{}})
 // 标签被摘掉才算失效。
 assert.equal(checkMarketTarget({kind:'business',id:'research',scope:'research',version:1,title:'调查行业'},marketTargets([],emptyCollaboration(),initialBusinessSpaces())).status,'missing')
})

test('关于页只保留版本与本机部署，个人版不在同页重复出现',async()=>{
 const [about,corePages]=await Promise.all([read('AboutSettings.tsx'),read('i18n/locales/core-pages.ts')])
 assert.doesNotMatch(about,/about\.edition\.personalSingleSpace/)
 assert.match(about,/className=\{css\.release\}[^]*__TELOA_VERSION__[^]*about\.local/)
 assert.match(corePages,/\.\.\.EDITION_MESSAGE_ROWS,/)
 // 第二期摘掉空间名、范围切换器与个人版副标题之后，这五条词条零调用点、随实现一起删（复审 M4；
 // navigation.spaceSwitcher 与 about.edition.personalSingleSpace 全仓 .tsx 也已零引用，UI 定型审计一并删除）。
 for(const removed of ['navigation.spaceFallback','business.scope.switcherAria','edition.personal.subtitle','navigation.spaceSwitcher','about.edition.personalSingleSpace'])assert.ok(!EDITION_MESSAGE_ROWS.some(row=>row[0]===removed),removed)
 const added=['market.industry.load.personalDestination','market.industry.load.newSpace','market.industry.saved.scopeEmpty','market.industry.saved.loadTemplateAria','market.workspace.loadedPersonal','market.industry.load.spaceUnavailable']
 const keys:string[]=EDITION_MESSAGE_ROWS.map(row=>row[0])
 for(const key of added)assert.ok(keys.includes(key),key)
 for(const row of EDITION_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  for(const value of row)assert.ok(String(value).trim(),row[0])
 }
 assert.equal(EDITION_MESSAGE_ROWS.find(row=>row[0]==='market.industry.saved.scopeEmpty')![1],'当前业务还没有添加方案。')
})

test('加载成功后重读本人空间记录：连续加载第二个模板不会撞版本冲突',async()=>{
 // 隔离宿主验收发现的真实缺陷：`industry-loads/create` 对已有空间会把空间版本加一，
 // 而客户端只在启动与卸载 / 升级之后读 `business-spaces/current`。第一次加载之后
 // `businessSpace.version` 就落后了，加载表单提交的 `expectedVersion` 随之过期，
 // 同一次会话里加载第二个模板必然 `teloa/version-conflict`（「目标业务空间版本已变化。」），
 // 新登记的 domain 标签也要等刷新才进范围切换器。加载成功与恢复两条路径都要重读目录。
 const frame=await read('WorkbenchFrame.tsx')
 const 加载路径=frame.slice(frame.indexOf('industryLoads={{api:industryLoadApi'),frame.indexOf('planFromTemplate='))
 assert.ok(加载路径.includes('save:async(input:IndustryLoadCreateInput)'),'没有截到加载接线')
 assert.equal(加载路径.split('loadBusinessDirectory()').length-1,2,'加载成功与恢复两条路径都应重读本人空间与标签目录')
 for(const 片段 of [
  'mergeIndustryLoad(row);void loadBusinessDirectory().catch(()=>{});void loadIndustryLoads().catch(()=>{});enterBusiness(',
 ])assert.equal(加载路径.split(片段).length-1,2,片段)
})
