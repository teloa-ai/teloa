import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {
 TELOA_RAIL_KINDS,TELOA_TAB_IDS,TELOA_TAB_KINDS,TELOA_TAB_SECONDARY_VIEWS,
 detailTargetToTab,tabToDetailTarget,teloaTabDefinition,visibleSecondaryViews,
} from '../src/client/sidebar-right-tabs.ts'
import {activeDetailTarget} from '../src/client/workbench-detail-target.ts'

const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
const entry=await readFile(new URL('../src/client/index.ts',import.meta.url),'utf8')
const tokens=await readFile(new URL('../src/client/theme-tokens.module.css',import.meta.url),'utf8')

test('四个页类型的 kind 与实现身份固定，id 全局唯一',()=>{
 assert.deepEqual([...TELOA_TAB_KINDS],['teloa.task','teloa.role','teloa.business','teloa.artifact'])
 assert.deepEqual(Object.values(TELOA_TAB_IDS),['@teloa/client-ui-workbench/task','@teloa/client-ui-workbench/role','@teloa/client-ui-workbench/business','@teloa/client-ui-workbench/artifact'])
 assert.equal(new Set(Object.values(TELOA_TAB_IDS)).size,4)
})

test('页类型不写 patterns、不上引导页，只有成果允许多开',()=>{
 for(const kind of TELOA_TAB_KINDS){
  const definition=teloaTabDefinition(kind,()=>'标题')
  assert.equal(definition.kind,kind)
  assert.equal(definition.id,TELOA_TAB_IDS[kind])
  assert.equal(definition.patterns,undefined,kind+' 不应声明资源 glob')
  assert.equal(definition.guide,undefined,kind+' 不应占引导页胶囊')
  assert.equal(definition.title(''),'标题')
  assert.equal(definition.multiple,kind==='teloa.artifact'?true:undefined)
 }
})

test('详情目标与页签参数双向可逆',()=>{
 assert.deepEqual(detailTargetToTab({kind:'conversation-object',sessionId:'s1',objectKind:'task',id:'t1'}),{kind:'teloa.task',params:{taskId:'t1'}})
 assert.deepEqual(detailTargetToTab({kind:'conversation-object',sessionId:'s1',objectKind:'role',id:'r1'}),{kind:'teloa.role',params:{roleId:'r1'}})
 assert.deepEqual(detailTargetToTab({kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope:'SOC',section:'overview'}}),{kind:'teloa.business',params:{scope:'SOC',section:'overview'}})
 assert.deepEqual(detailTargetToTab({kind:'artifact',source:{kind:'task',id:'t1'},artifactId:'a1',version:2}),{kind:'teloa.artifact',params:{source:'task',id:'t1',artifactId:'a1',version:2}})
 assert.equal(detailTargetToTab(null),null)
 // 目录页详情不进右栏：它不是会话里的对象。
 assert.equal(detailTargetToTab({kind:'directory-object',view:'tasks',id:'t1',source:{kind:'directory'}}),null)
 // 分析、业务对象来源的成果不在页签参数的表达范围内，交回 null 让调用方退回页内详情。
 assert.equal(detailTargetToTab({kind:'artifact',source:{kind:'analysis',id:'a1',scope:'SOC'}}),null)
 assert.deepEqual(tabToDetailTarget('teloa.task',{taskId:'t1'},'s1'),{kind:'conversation-object',sessionId:'s1',objectKind:'task',id:'t1'})
 assert.deepEqual(tabToDetailTarget('teloa.business',{scope:'SOC',section:'overview'},'s1'),{kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope:'SOC',section:'overview'}})
})

test('脏参数一律拒绝，不构造半个详情目标',()=>{
 for(const params of [null,{},{taskId:''},{taskId:1},{taskId:'t1',extra:1}])assert.equal(tabToDetailTarget('teloa.task',params,'s1'),null)
 assert.equal(tabToDetailTarget('teloa.business',{scope:'SOC'},'s1'),null)
})

test('二级页签在 tab 内部：没有依据可核对时不出切换条',()=>{
 assert.deepEqual([...TELOA_TAB_SECONDARY_VIEWS],['report','evidence'])
 assert.deepEqual(visibleSecondaryViews(true),['report','evidence'])
 assert.deepEqual(visibleSecondaryViews(false),['report'])
})

test('本轮已迁入右栏的页类型是 kind 名单的子集',()=>{
 assert.deepEqual([...TELOA_RAIL_KINDS],['teloa.task','teloa.role','teloa.business'])
 for(const kind of TELOA_RAIL_KINDS)assert.ok(TELOA_TAB_KINDS.includes(kind))
})

test('普通会话的右栏占位跟随原生呈现；搭建预览与非会话页面不占位，不看详情目标',()=>{
 assert.doesNotMatch(frame,/closeNativeRightbar/)
 assert.doesNotMatch(frame,/kind==='native'/)
 // 执行真正的占位表达式，既保留普通会话原语义，也覆盖搭建预览新增的排除条件。
 const ast=ts.createSourceFile('WorkbenchFrame.tsx',frame,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let expression:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText()==='railShown')expression=node.initializer;ts.forEachChild(node,visit)}
 visit(ast);assert.ok(expression)
 const shown=new Function('builderVisible','conversationVisible','state','return '+expression.getText()) as (builder:boolean,conversation:boolean,state:{rightbar:{shown:boolean}})=>boolean
 for(const builder of [false,true])for(const conversation of [false,true])for(const rightbar of [false,true]){
  assert.equal(shown(builder,conversation,{rightbar:{shown:rightbar}}),!builder&&conversation&&rightbar,JSON.stringify({builder,conversation,rightbar}))
 }
})

test('刷新恢复只认属于当前会话的详情，A 会话的对象不会开进 B 的右栏',()=>{
 // 落盘的 state.detail 属于 s1；刷新后当前会话是 s2 时，按会话核对过的目标为空，恢复请求也就为空。
 const detail={open:true,target:{kind:'conversation-object',sessionId:'s1',objectKind:'task',id:'t1'} as const}
 assert.equal(detailTargetToTab(activeDetailTarget(detail,'s2')),null)
 assert.deepEqual(detailTargetToTab(activeDetailTarget(detail,'s1')),{kind:'teloa.task',params:{taskId:'t1'}})
 // 恢复处必须用这份核对过的目标，而不是裸的 state.detail。
 assert.match(frame,/const target=detailTarget\n/)
 assert.doesNotMatch(frame,/restoreOnce[\s\S]{0,200}state\.detail\.open\?state\.detail\.target:null/)
})

test('注册三件套齐全：页类型、正文座位、活标题座位，各裹一个 effect',()=>{
 assert.match(entry,/sidebarRightTabs\.register\(/)
 assert.match(entry,/name:'sidebar\.right\.pane\.tab'/)
 assert.match(entry,/name:'sidebar\.right\.pane\.tab\.title'/)
 assert.match(entry,/registerCloseHandler\(/)
 assert.equal((entry.match(/teloa: 右栏页类型/g)??[]).length,1)
})

test('主题令牌投影到 :root，浮动面板脱离 .frame 后仍有 --teloa-* 取值',()=>{
 assert.match(tokens,/:global\(:root\)|:root/)
})

test('右栏业务页签参数认看板栏目与看板标识，未知栏目拒绝',()=>{
 const target={kind:'conversation-object' as const,sessionId:'s1',objectKind:'business' as const,target:{scope:'SOC',section:'dashboards' as const,dashboardId:'soc-ops'}}
 assert.deepEqual(detailTargetToTab(target),{kind:'teloa.business',params:{scope:'SOC',section:'dashboards',dashboardId:'soc-ops'}})
 assert.deepEqual(tabToDetailTarget('teloa.business',{scope:'SOC',section:'dashboards',dashboardId:'soc-ops'},'s1'),target)
 assert.equal(tabToDetailTarget('teloa.business',{scope:'SOC',section:'foo'},'s1'),null)
 assert.equal(tabToDetailTarget('teloa.business',{scope:'SOC',section:'data',dashboardId:'soc-ops'},'s1'),null)
 assert.equal(tabToDetailTarget('teloa.business',{scope:'SOC',section:'dashboards',dashboardId:'soc:ops'},'s1'),null)
})

test('右栏业务页签参数带下钻筛选 match：往返不丢；只在对象清单合法，字段或取值不合规即整条作废',()=>{
 const target={kind:'conversation-object' as const,sessionId:'s1',objectKind:'business' as const,target:{scope:'SOC',section:'data' as const,objectType:'alert-ticket',match:{field:'severity',value:'高'}}}
 const tab=detailTargetToTab(target)
 assert.deepEqual(tab,{kind:'teloa.business',params:{scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:'高'}}})
 assert.deepEqual(tabToDetailTarget('teloa.business',tab!.params,'s1'),target)
 for(const params of [
  {scope:'SOC',section:'dashboards',dashboardId:'soc-ops',match:{field:'severity',value:'高'}},
  {scope:'SOC',section:'data',match:{field:'severity',value:'高'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'Severity',value:'高'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:''}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:'x'.repeat(201)}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:'高',op:'ne'}},
 ])assert.equal(tabToDetailTarget('teloa.business',params,'s1'),null,JSON.stringify(params))
})
