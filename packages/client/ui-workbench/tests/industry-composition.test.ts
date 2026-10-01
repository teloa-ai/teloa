import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {
 CAPABILITY_ROW_IDS,
 COMPOSITION_APPROVAL_KEY,
 COMPOSITION_EMPTY_KEYS,
 COMPOSITION_EXTENSION_NOTE_KEY,
 COMPOSITION_METHOD_NOTE_KEY,
 COMPOSITION_MODE_KEYS,
 COMPOSITION_ROWS,
 COMPOSITION_STATE_KEYS,
 composeFromManifest,
 composeFromWorkspace,
 compositionSummary,
 compositionTargetScope,
 connectorMode,
 connectorModeLabel,
 type CompositionItemState,
 type CompositionRowId,
} from '../src/client/industry-composition.ts'
import {industryResourceKinds,type IndustryManifest,type IndustryResource} from '../src/client/industry-manifest.ts'
import {projectIndustryWorkspace} from '../src/client/industry-workspace-projection.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {BusinessLedger} from '@teloa/contract'

const {catalogs,translateMessage}=await import('../lib/types/client/i18n/messages.js')

const resource=(id:string,kind:IndustryResource['kind']):IndustryResource=>({id,kind,title:id+'-标题',version:'1.0.0',required:true,source:{kind:'local',path:kind+'/'+id+'.json'}})
const manifest=(resources:IndustryResource[]):IndustryManifest=>({format:'teloa.business-package/v2',id:'bundle-x',title:'方案',version:'1.0.0',domain:'general',scope:'general',description:'说明',resources,relations:[],entrypoints:[]})

const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const plain=(value:number)=>String(value)

const item=(kind:IndustryLoadRecord['items'][number]['kind'],index:number,status:IndustryLoadRecord['items'][number]['status']='active'):IndustryLoadRecord['items'][number]=>
 ({localId:kind+'-'+index,instanceId:`42345678-1234-4234-8234-1234567890${String(index).padStart(2,'0')}`,kind,title:kind+' 标题',version:'1.0.0',required:true,status})
const load=(items:IndustryLoadRecord['items'],scope='general'):IndustryLoadRecord=>({
 id:'12345678-1234-4234-8234-123456789012',ownerId:'self',contentId:'22345678-1234-4234-8234-123456789012',contentHash:'f'.repeat(64),
 templateId:'bundle-x',templateVersion:'1.0.0',templateTitle:'方案',domain:'general',scope,description:'说明',targetVersion:1,
 space:{id:'32345678-1234-4234-8234-123456789012',name:'空间',version:1,scope},
 items,relations:[],entrypoints:[],createdAt:'2026-09-20T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active',
})
const role=(id:string,patch:Partial<PreviewRole>={}):PreviewRole=>({
 id,name:id+' 员工',kind:'employee',scopes:['general'],state:'active',version:1,duty:'职责',dataScope:'范围',executionScope:'范围',
 skills:[],knowledge:[],memories:[],history:[],...patch,
})

test('七行顺序固定，十二种契约资源每种恰好落在一行，三组词条键齐全',()=>{
 assert.deepEqual(COMPOSITION_ROWS.map(row=>row.id),['staff','skill','knowledge','source','board','method','extension'])
 const kinds=COMPOSITION_ROWS.flatMap(row=>[...row.kinds])
 assert.deepEqual([...kinds].sort(),[...industryResourceKinds].sort(),'十二种资源必须不重不漏')
 assert.equal(new Set(kinds).size,kinds.length,'同一种资源不能落在两行')
 for(const row of COMPOSITION_ROWS){
  assert.equal(row.label,'composition.row.'+row.id)
  assert.equal(row.question,'composition.question.'+row.id)
  assert.equal(row.unit,'composition.unit.'+row.id)
 }
})

test('七行的标签、副标、单位、附注、模式、空态与全部状态词都在十列词表里有值',()=>{
 const keys=[
  ...COMPOSITION_ROWS.flatMap(row=>[row.label,row.question,row.unit]),
  COMPOSITION_METHOD_NOTE_KEY,COMPOSITION_EXTENSION_NOTE_KEY,
  ...Object.values(COMPOSITION_EMPTY_KEYS),
  ...Object.values(COMPOSITION_MODE_KEYS),
  COMPOSITION_APPROVAL_KEY,
  ...Object.values(COMPOSITION_STATE_KEYS),
 ]
 for(const key of keys)for(const [locale,catalog] of Object.entries(catalogs)){
  const value=(catalog as Record<string,string>)[key as string]
  assert.ok(value&&value.trim().length>0,locale+' 缺少词条 '+String(key))
 }
 assert.equal(zh('composition.row.method'),'任务模板')
 assert.equal(zh('composition.question.board'),'管哪些东西、怎么看')
 assert.equal(zh('composition.extension.note'),'工作室通用')
 assert.equal(zh('composition.empty.source'),'还没接东西，需要时从市场或「连接」添加')
 assert.equal(zh('composition.empty.board'),'这个业务还没有可看的东西')
})

test('包按七行计数：空行不返回，只含技能的包只出一行',()=>{
 assert.deepEqual(composeFromManifest(manifest([resource('s1','skill')])),[{id:'skill',count:1}])
 assert.deepEqual(composeFromManifest(manifest([])),[])
})

test('插件落第七行「扩展」，接入源三种并成一行且不含插件',()=>{
 const rows=composeFromManifest(manifest([resource('p1','plugin'),resource('m1','mcp'),resource('d1','data-source'),resource('e1','execution-tool')]))
 assert.deepEqual(rows,[{id:'source',count:3},{id:'extension',count:1}])
})

test('看板行数「几类东西 · 几张视图」，任务模板行附注数自动化与动作',()=>{
 const rows=composeFromManifest(manifest([
  resource('o1','object-type'),resource('o2','object-type'),resource('o3','object-type'),
  resource('v1','business-view'),resource('v2','business-view'),
  resource('w1','work-template'),resource('pl1','plan'),resource('a1','business-action'),resource('a2','business-action'),
 ]))
 assert.deepEqual(rows,[
  {id:'board',count:3,detail:{objectTypes:3,views:2}},
  {id:'method',count:1,detail:{automations:1,actions:2}},
 ])
 assert.equal(zh('composition.unit.board',{count:3,views:2}),'3 类东西 · 2 张视图')
 assert.equal(zh('composition.note.method',{automations:1,actions:2}),'其中 1 个设成了自动化 · 2 个动作挂在对象上')
})

test('连接器副标两档加审批标记：数据源读、执行工具写且需审批、MCP 保守判写但不带审批，判不出返回 undefined',()=>{
 assert.deepEqual(connectorMode({kind:'data-source'}),{mode:'read',approval:false})
 assert.deepEqual(connectorMode({kind:'execution-tool'}),{mode:'write',approval:true})
 assert.deepEqual(connectorMode({kind:'mcp'}),{mode:'write',approval:false})
 assert.equal(connectorMode({kind:'role'}),undefined)
 assert.deepEqual(Object.keys(COMPOSITION_MODE_KEYS),['read','write'])
})

test('connectorModeLabel 拼法：无 mode 不说话，读只说读，写且需审批加「 · 需你审批」',()=>{
 assert.equal(connectorModeLabel({},zh),undefined)
 assert.equal(connectorModeLabel({mode:'read',approval:false},zh),'读')
 assert.equal(connectorModeLabel({mode:'write',approval:true},zh),'写 · 需你审批')
})

test('摘要名词计数：段内「 · 」、段间「｜」，单段不带分隔符，全空返回空串',()=>{
 const full=composeFromManifest(manifest([
  resource('r1','role'),resource('r2','role'),resource('s1','skill'),resource('k1','knowledge'),
  resource('m1','mcp'),resource('d1','data-source'),
  resource('o1','object-type'),resource('o2','object-type'),resource('o3','object-type'),resource('v1','business-view'),
  resource('w1','work-template'),resource('w2','work-template'),
  resource('p1','plugin'),
 ]))
 assert.equal(
  compositionSummary(full,zh as never,plain),
  '2 位员工 · 1 项技能 · 1 份资料 ｜ 2 个接入源 ｜ 3 类东西 · 1 张视图 ｜ 2 个任务模板 ｜ 1 个扩展',
 )
 assert.equal(compositionSummary(composeFromManifest(manifest([resource('s1','skill')])),zh as never,plain),'1 项技能')
 assert.equal(compositionSummary([],zh as never,plain),'')
})

test('已加载的业务按七行列出每一项，默认分身如实列出并标默认分身但不计入人数',()=>{
 const rows=composeFromWorkspace({
  scope:'general',
  loads:[],
  roles:[role('worker'),role('twin',{kind:'twin'}),role('other',{scopes:['SOC']})],
 })
 assert.deepEqual(rows.map(row=>row.id),['staff'])
 const staff=rows[0]!
 assert.equal(staff.count.count,1,'分身不计入人数')
 assert.deepEqual(staff.items.map(row=>[row.id,row.state]),[['worker','active'],['twin','default-twin']])
 assert.deepEqual(staff.items[0]!.go,{kind:'team',scope:'general'})
 assert.equal(compositionSummary([staff.count],zh as never,plain),'1 位员工')
})

test('只有默认分身时同事行仍列出来，但摘要里不说「0 位同事」',()=>{
 const rows=composeFromWorkspace({scope:'general',loads:[],roles:[role('twin',{kind:'twin'})]})
 assert.deepEqual(rows.map(row=>row.id),['staff'])
 assert.equal(compositionSummary(rows.map(row=>row.count),zh as never,plain),'')
})

test('业务面板的接入源带模式副标，扩展落第七行并指向市场',()=>{
 const rows=composeFromWorkspace({
  scope:'general',
  loads:[load([item('data-source',1),item('mcp',2),item('execution-tool',3,'pending-adapter'),item('plugin',4,'pending-adapter'),item('skill',5)])],
  roles:[],
 })
 assert.deepEqual(rows.map(row=>row.id),['skill','source','extension'])
 const source=rows.find(row=>row.id==='source')!
 assert.deepEqual(source.items.map(row=>[row.mode,row.state]),[['read','connected'],['write','connected'],['write','disconnected']])
 assert.deepEqual(source.items[0]!.go,{kind:'connectors'})
 const extension=rows.find(row=>row.id==='extension')!
 assert.deepEqual(extension.items.map(row=>row.state),['pending-install'])
 assert.deepEqual(extension.items[0]!.go,{kind:'extension',instanceId:item('plugin',4).instanceId})
 assert.equal(rows.find(row=>row.id==='skill')!.items[0]!.state,'installed')
})

test('业务面板的看板行读真实台账：缺连接、缺字段、有数据、还没进数据逐条如实说',()=>{
 const block=(id:string,patch:Record<string,unknown>)=>({
  objectType:{source:{kind:'builtin'},definition:{id,title:id+' 对象'}},
  objects:0,source:{sourceId:'src',connected:true},coverage:{synced:0,truncated:false},missingFields:[],views:[],...patch,
 })
 const ledger={
  schema:'teloa.business-ledger/v1',scope:'general',computedAt:'2026-09-20T00:00:00.000Z',actions:[],
  blocks:[
   block('alpha',{objects:3,views:[{},{}]}),
   block('beta',{missingFields:['field-a']}),
   block('gamma',{source:{sourceId:'src',connected:false}}),
  ],
 } as unknown as BusinessLedger
 const rows=composeFromWorkspace({scope:'general',loads:[],roles:[],ledger})
 const board=rows.find(row=>row.id==='board')!
 assert.deepEqual(board.items.map(row=>row.state),['has-data','missing-field','missing-connection'])
 assert.deepEqual(board.count,{id:'board',count:3,detail:{objectTypes:3,views:2}})
 assert.deepEqual(board.items[0]!.go,{kind:'business',scope:'general',section:'alpha'})
})

test('未读取真实扩展实例时不推断重启或运行状态',()=>{
 const states=(status:IndustryLoadRecord['items'][number]['status'])=>
  composeFromWorkspace({scope:'general',loads:[load([item('plugin',1,status)])],roles:[]}).find(row=>row.id==='extension')!.items.map(row=>row.state)
 assert.deepEqual(states('active'),['unverified'])
 assert.deepEqual(states('instantiated'),['unverified'],'实例化不能替代安装阶段')
 assert.deepEqual(states('pending-adapter'),['pending-install'],'只登记过的扩展不能看着像重启就能用')
 assert.deepEqual(states('detached'),['pending-install'])
})

test('技能行：装好了已安装，实例化了未授权才说待授权，只登记过或已脱钩说待安装',()=>{
 const states=(status:IndustryLoadRecord['items'][number]['status'])=>
  composeFromWorkspace({scope:'general',loads:[load([item('skill',1,status)])],roles:[]}).find(row=>row.id==='skill')!.items.map(row=>row.state)
 assert.deepEqual(states('active'),['installed'])
 assert.deepEqual(states('instantiated'),['pending-authorization'],'已实例化只差授权，不能说成待安装')
 assert.deepEqual(states('pending-adapter'),['pending-install'],'还没装的技能不能看着像只差授权')
 assert.deepEqual(states('detached'),['pending-install'])
})

test('依据资料行：装好了是已锁定版本而不是可用，没装说待锁定而不是待安装',()=>{
 const states=(status:IndustryLoadRecord['items'][number]['status'])=>
  composeFromWorkspace({scope:'general',loads:[load([item('knowledge',1,status)])],roles:[]}).find(row=>row.id==='knowledge')!.items.map(row=>row.state)
 assert.deepEqual(states('active'),['pinned-version'])
 assert.deepEqual(states('pending-adapter'),['pending-pin'],'资料不是插件，不能借用「待安装」')
 assert.deepEqual(states('instantiated'),['pending-pin'])
 assert.deepEqual(states('detached'),['pending-pin'])
 assert.equal(zh('composition.state.pinnedVersion'),'已锁定版本')
 assert.equal(zh('composition.state.pendingPin'),'待锁定')
})

test('业务面板的任务模板行合并模板、自动化与挂在对象上的动作',()=>{
 const rows=composeFromWorkspace({
  scope:'general',
  loads:[load([item('work-template',1),item('business-action',2)])],
  roles:[],
  plans:[{scope:'general',state:'active',title:'每周整理'},{scope:'SOC',state:'active',title:'别的业务'}],
 })
 const method=rows.find(row=>row.id==='method')!
 assert.deepEqual(method.count,{id:'method',count:1,detail:{automations:1,actions:1}})
 assert.deepEqual(method.items.map(row=>row.state),['available','active','pinned'])
 assert.deepEqual(method.items[1]!.go,{kind:'plans',scope:'general'})
})

test('两种半空的行也进摘要：只有自动化或动作时任务模板行只说附注半句，只有视图时看板行不整行掉队',()=>{
 // 只有挂在对象上的动作、一个任务模板都没有：说动作那半句，不写「0 个任务模板」。
 const actions=composeFromWorkspace({scope:'general',loads:[load([item('business-action',1)])],roles:[]})
 assert.deepEqual(actions.map(row=>row.id),['method'])
 assert.equal(compositionSummary(actions.map(row=>row.count),zh as never,plain),'1 个动作挂在对象上')
 // 只有持续计划（自动化）时同理。
 const automations=composeFromWorkspace({scope:'general',loads:[],roles:[],plans:[{scope:'general',state:'active',title:'每周整理'}]})
 assert.equal(compositionSummary(automations.map(row=>row.count),zh as never,plain),'其中 1 个设成了自动化')
 // 只有视图、没有对象类型：看板行仍然摆出来，视图数照说。
 const board=composeFromWorkspace({scope:'general',loads:[load([item('business-view',1)])],roles:[]})
 assert.deepEqual(board.map(row=>row.id),['board'])
 assert.deepEqual(board.find(row=>row.id==='board')!.count,{id:'board',count:0,detail:{objectTypes:0,views:1}})
 assert.equal(compositionSummary(board.map(row=>row.count),zh as never,plain),'0 类东西 · 1 张视图')
})

test('别的业务范围的加载与岗位不进这个业务的面板',()=>{
 assert.deepEqual(composeFromWorkspace({scope:'general',loads:[load([item('skill',1)],'SOC')],roles:[]}),[])
})

test('共享模块源码不出现任何行业名或对象类型名',async()=>{
 const source=await readFile(new URL('../src/client/industry-composition.ts',import.meta.url),'utf8')
 assert.doesNotMatch(source,/SOC|AppSec|告警|资产|Splunk/)
 const messages=await readFile(new URL('../src/client/i18n/locales/industry-composition.ts',import.meta.url),'utf8')
 assert.doesNotMatch(messages,/SOC|AppSec|告警|资产|Splunk/)
 assert.doesNotMatch(messages,/工作模板/)
})

test('插件加载后落到 extension 落点并带就绪说明，不再无处可见',()=>{
 const rows=projectIndustryWorkspace([load([item('plugin',1,'pending-adapter')])])
 assert.deepEqual(rows.map(row=>[row.kind,row.destination]),[['plugin','extension']])
 assert.ok(rows[0]!.readiness.length>0)
})

test('状态词表覆盖 composeFromWorkspace 可能产出的每一种状态',()=>{
 const states:CompositionItemState[]=['active','paused','retired','default-twin','installed','pending-authorization','pinned','pinned-version','pending-pin','connected','discovered','disconnected','has-data','no-data','available','missing-field','missing-connection','needs-restart','pending-install','unverified','installing','pending-enable','install-failed']
 assert.deepEqual(Object.keys(COMPOSITION_STATE_KEYS).sort(),[...states].sort())
 const ids:CompositionRowId[]=['staff','skill','knowledge','source','board','method','extension']
 assert.deepEqual(COMPOSITION_ROWS.map(row=>row.id),ids)
})

test('CAPABILITY_ROW_IDS 只摆跨业务复用的四行，顺序与 COMPOSITION_ROWS 过滤后一致',()=>{
 assert.deepEqual([...CAPABILITY_ROW_IDS],COMPOSITION_ROWS.filter(row=>(CAPABILITY_ROW_IDS as readonly CompositionRowId[]).includes(row.id)).map(row=>row.id))
 assert.deepEqual([...CAPABILITY_ROW_IDS],['skill','source','method','extension'])
})

test('compositionTargetScope：带业务范围的落点返回 scope，共享落点（技能/接入源/资料/扩展）返回 undefined',()=>{
 assert.equal(compositionTargetScope({kind:'team',scope:'general'}),'general')
 assert.equal(compositionTargetScope({kind:'business',scope:'general',section:'alpha'}),'general')
 assert.equal(compositionTargetScope({kind:'plans',scope:'general'}),'general')
 assert.equal(compositionTargetScope({kind:'capabilities'}),undefined)
 assert.equal(compositionTargetScope({kind:'knowledge'}),undefined)
 assert.equal(compositionTargetScope({kind:'connectors'}),undefined)
 assert.equal(compositionTargetScope({kind:'market',category:'plugin'}),undefined)
})
