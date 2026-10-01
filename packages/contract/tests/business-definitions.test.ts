import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import {readBusinessObjectTypeDefinition,readBusinessViewDefinition,readBusinessActionDefinition,businessFieldTypes,businessViewCharts,businessFieldCapabilities,businessLedgerLimits} from '../src/business-definitions.ts'

const root=new URL('../../../tests/fixtures/业务定制层/',import.meta.url)
const load=async(domain:string,folder:string)=>{
 const dir=new URL(domain+'/'+folder+'/',root)
 return Promise.all((await readdir(dir)).sort().map(async name=>JSON.parse(await readFile(new URL(name,dir),'utf8')) as unknown))
}

// 视图十二份：规格 §12 的五份、六类对象各自的目录清单，以及第二期本地优先夹具 `soc-verdict-distribution`。
test('规格 §12 的样例逐字通过校验，字段类型是七种',async()=>{
 assert.deepEqual([...businessFieldTypes],['text','number','enum','datetime','reference','duration','boolean'])
 let types=0,views=0,actions=0
 for(const domain of ['SOC','AppSec']){
  for(const value of await load(domain,'object-types')){types+=1;assert.equal(readBusinessObjectTypeDefinition(value).domain,domain)}
  for(const value of await load(domain,'views')){views+=1;assert.equal(readBusinessViewDefinition(value).domain,domain)}
  for(const value of await load(domain,'actions')){actions+=1;assert.equal(readBusinessActionDefinition(value).domain,domain)}
 }
 assert.deepEqual([types,views,actions],[6,12,3])
})

test('对象类型：白名单键精确匹配、上限、字段去重与类型附加约束',()=>{
 const base={format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警工单',unit:'条',lead:'一句处境说明。',sourceId:'security-alert-http',fields:[{name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','低']}]}
 assert.equal(readBusinessObjectTypeDefinition(base).fields.length,1)
 const cases:unknown[]=[
  {...base,extra:true},                                              // 多键
  {format:base.format,id:base.id},                                   // 缺键
  {...base,id:'alert_ticket'},                                       // 下划线不合法（与清单资源标识同规矩）
  {...base,version:'1.0'},                                           // 非精确三段 semver
  {...base,domain:'general'},                                        // general 一律拒绝
  {...base,unit:'条条条条条条条条条'},                                  // unit 超 8
  {...base,lead:'x'.repeat(501)},                                    // lead 超 500
  {...base,title:'x'.repeat(121)},                                   // title 超 120
  {...base,fields:[]},                                               // 字段不可为空
  {...base,fields:Array.from({length:51},(_,i)=>({name:'f'+i,label:'标签'+i,type:'text',required:false,from:'来源'+i}))},
  {...base,fields:[{...base.fields[0]},{...base.fields[0]}]},        // name 与 from 都重复
  {...base,fields:[{name:'severity',label:'严重度',type:'text',required:true,from:'严重度',values:['高']}]},   // text 不得带 values
  {...base,fields:[{name:'severity',label:'严重度',type:'enum',required:true,from:'严重度'}]},                 // enum 必须带 values
  {...base,fields:[{name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高']}]},   // enum 少于 2 个取值
  {...base,fields:[{name:'r',label:'引用',type:'reference',required:false,from:'引用'}]},                      // reference 必须带 referenceType
  {...base,fields:[{name:'n',label:'数',type:'number',required:false,from:'数',referenceType:'x'}]},           // 非 reference 不得带 referenceType
  {...base,fields:[{name:'BAD',label:'标签',type:'text',required:false,from:'来源'}]},                         // name 不合 ^[a-z0-9][a-z0-9_-]{0,62}$
  {...base,fields:[{name:'x'.repeat(64),label:'标签',type:'text',required:false,from:'来源'}]},                 // name 超 63 字符（PG 标识符截断）
  {...base,lead:'两\n行'},                                            // 声明文本全部单行，禁 \r\n
  {...base,fields:[{name:'b',label:'布尔',type:'boolean',required:false,from:'布尔',values:['是','否']}]},     // boolean 不得带取值列表
  {...base,fields:[{name:'d',label:'时长',type:'interval',required:false,from:'时长'}]},                         // 未知类型（时长只叫 duration）
  {...base,fields:[{name:'d',label:'时长',type:'duration',required:false,from:'时长',referenceType:'x'}]},      // duration 不得带引用目标类型
 ]
 for(const [index,value] of cases.entries())assert.throws(()=>readBusinessObjectTypeDefinition(value),{code:'teloa/invalid-input'},'第 '+index+' 条应被拒绝')
 // 63 字符恰好通过：与 PG 标识符上限（NAMEDATALEN-1）一致。
 assert.equal(readBusinessObjectTypeDefinition({...base,fields:[{...base.fields[0],name:'x'.repeat(63)}]}).fields[0]!.name.length,63)
})

test('对象类型：duration 与 boolean 是合法字段类型，与 text 一样不带附加键',()=>{
 const base={format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警工单',unit:'条',lead:'一句处境说明。',sourceId:'security-alert-http',fields:[
  {name:'handling-duration',label:'处置时长',type:'duration',required:false,from:'处置时长'},
  {name:'false-positive',label:'是否误报',type:'boolean',required:true,from:'是否误报'},
 ]}
 assert.deepEqual(readBusinessObjectTypeDefinition(base).fields.map(field=>field.type),['duration','boolean'])
})

test('缺键/多键文案指出具体字段名，嵌套数组元素文案带上位置前缀',()=>{
 const object={format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警工单',unit:'条',lead:'一句处境说明。',sourceId:'security-alert-http',fields:[{name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','低']}]}
 assert.throws(()=>readBusinessObjectTypeDefinition({format:object.format,id:object.id}),(error:unknown)=>error instanceof Error&&/缺少字段 version、domain、title、unit、lead、sourceId、fields。$/.test(error.message))
 assert.throws(()=>readBusinessObjectTypeDefinition({...object,extra:true}),(error:unknown)=>error instanceof Error&&/不认识的字段 extra。$/.test(error.message))
 assert.throws(()=>readBusinessObjectTypeDefinition({...object,fields:[{name:'severity',label:'严重度',required:true,from:'严重度',values:['高','低']}]}),(error:unknown)=>error instanceof Error&&/^fields\[0\]：业务对象字段定义格式不正确：缺少字段 type。$/.test(error.message))
 const view={format:'teloa.business-view/v1',id:'soc-pending-board',version:'1.0.0',domain:'SOC',title:'待处理告警',kind:'board-card',chart:'number',objectType:'alert-ticket',measures:[{id:'pending',label:'条'}],filters:[],limit:1}
 assert.throws(()=>readBusinessViewDefinition(view),(error:unknown)=>error instanceof Error&&/^measures\[0\]：业务视图度量定义格式不正确：缺少字段 aggregation。$/.test(error.message))
 assert.throws(()=>readBusinessViewDefinition({...view,kind:'nope'}),(error:unknown)=>error instanceof Error&&/当前为「nope」，允许：list \/ distribution \/ trend \/ board-card。$/.test(error.message))
})

test('对象类型进度摘要只能引用声明过的阶段与变化字段',()=>{
 const base={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:'SOC',title:'工单',unit:'件',lead:'一句处境说明。',sourceId:'source-1',fields:[
  {name:'state',label:'状态',type:'enum',required:true,from:'状态',values:['新建','处理中','等确认','已完成']},
  {name:'changed-at',label:'最后变化',type:'datetime',required:true,from:'最后变化'},
 ]}
 const valid={...base,progress:{stageField:'state',unfinished:['新建','处理中','等确认'],waitingForYou:['等确认'],changedAtField:'changed-at'}}
 assert.deepEqual(readBusinessObjectTypeDefinition(valid).progress,valid.progress)
 const cases:unknown[]=[
  {...base,progress:{stageField:'missing',unfinished:['新建'],waitingForYou:['新建']}},
  {...base,progress:{stageField:'changed-at',unfinished:['新建'],waitingForYou:['新建']}},
  {...base,progress:{stageField:'state',unfinished:['不存在'],waitingForYou:['不存在']}},
  {...base,progress:{stageField:'state',unfinished:['新建'],waitingForYou:['等确认']}},
  {...base,progress:{stageField:'state',unfinished:['新建'],waitingForYou:['新建'],changedAtField:'state'}},
 ]
 for(const value of cases)assert.throws(()=>readBusinessObjectTypeDefinition(value),{code:'teloa/invalid-input'})
})

test('视图：kind×chart 组合表、board-card 三条附加约束、window 与 where 的算子约束',()=>{
 const base={format:'teloa.business-view/v1',id:'soc-pending-board',version:'1.0.0',domain:'SOC',title:'待处理告警',kind:'board-card',chart:'number',objectType:'alert-ticket',measures:[{id:'pending',label:'条',aggregation:'count'}],filters:[],limit:1}
 assert.equal(readBusinessViewDefinition(base).limit,1)
 assert.deepEqual(businessViewCharts['list'],['table'])
 assert.deepEqual(businessViewCharts['distribution'],['bar','pie','table'])
 assert.deepEqual(businessViewCharts['trend'],['line','bar'])
 assert.deepEqual(businessViewCharts['board-card'],['number'])
 // §2.5「where 受与 filters 完全相同的算子约束」：契约层不判字段真实类型，count 聚合也能带 gte/lte 的 where，
 // 算子×字段类型的交叉约束留给读取层核对（跨声明，同「动作 inputs 数量对齐工作模板」一样不在本函数内）。
 assert.equal(readBusinessViewDefinition({...base,measures:[{id:'pending',label:'条',aggregation:'count',where:{field:'due-at',op:'gte',values:['2024-01-01T00:00:00.000Z']}}]}).measures[0]?.where?.op,'gte')
 const cases:unknown[]=[
  {...base,chart:'bar'},                                                                   // board-card 只能 number
  {...base,dimension:{field:'severity',limit:1}},                                          // board-card 必须缺省 dimension
  {...base,sort:{by:'dimension',direction:'asc'}},                                         // board-card 必须缺省 sort
  {...base,limit:2},                                                                       // board-card 固定 1
  {...base,measures:[{id:'a',label:'甲',aggregation:'count'},{id:'b',label:'乙',aggregation:'count'}]}, // board-card 恰好一项
  {...base,measures:[{id:'a',label:'甲',aggregation:'count',field:'account-count'}]},       // count 不绑字段
  {...base,measures:[{id:'a',label:'甲',aggregation:'sum'}]},                               // 非 count 必须绑字段
  {...base,kind:'distribution',chart:'bar',sort:{by:'measure',measureId:'nope',direction:'desc'},dimension:{field:'severity',limit:3},limit:3}, // measureId 不指向本视图
  {...base,kind:'trend',chart:'line',limit:30,sort:{by:'dimension',direction:'asc'},dimension:{field:'first-seen-at',limit:30}},                // datetime 维度必须带 bucket
  {...base,kind:'list',chart:'table',sort:{by:'dimension',direction:'asc'},limit:101},      // list 上限 100
  {...base,window:{field:'first-seen-at',relative:'last-3d'}},                              // 时间窗白名单外
  {...base,measures:[{id:'a',label:'甲',aggregation:'count',where:{field:'severity',op:'eq',values:['高','中']}}]}, // 非 in 恰好一个值
  {...base,filters:Array.from({length:9},()=>({field:'severity',op:'eq',values:['高']}))},  // filters 上限 8
  {...base,kind:'distribution',chart:'pie',dimension:{field:'severity',limit:3},sort:{by:'dimension',direction:'asc'},limit:3,
   measures:[{id:'a',label:'甲',aggregation:'count'},{id:'b',label:'乙',aggregation:'count'}]},                          // 饼图恰好一项度量
 ]
 for(const [index,value] of cases.entries())assert.throws(()=>readBusinessViewDefinition(value),{code:'teloa/invalid-input'},'第 '+index+' 条应被拒绝')
})

test('动作：三种输入来源逐字取值，execution-tool 的 targetFrom 不接受字面量',()=>{
 const base={format:'teloa.business-action/v1',id:'assign-alert-review',version:'1.0.0',domain:'SOC',title:'交给同事核对',objectType:'alert-ticket',target:{kind:'work-template',localId:'alert-triage-review'},inputs:[{from:'field',field:'host'},{from:'object',part:'title'},{from:'literal',value:'按告警工单发起。'}]}
 assert.equal(readBusinessActionDefinition(base).inputs.length,3)
 const tool={...base,id:'isolate-endpoint',title:'隔离这台主机',target:{kind:'execution-tool',localId:'soc-endpoint-isolation',tool:'security.endpoint.isolate',workTemplate:'endpoint-isolation-record',targetFrom:{from:'field',field:'host'}},inputs:[{from:'object',part:'summary'}]}
 assert.equal(readBusinessActionDefinition(tool).target.kind,'execution-tool')
 const cases:unknown[]=[
  {...tool,target:{...tool.target,targetFrom:{from:'literal',value:'host-1'}}}, // 目标必须来自对象
  {...tool,target:{...tool.target,params:{}}},                                   // params 不可提供
  {...tool,target:{...tool.target,tool:'security.endpoint.'+'a'.repeat(128)}},   // tool 上限 128（与安全动作提议对齐）
  {...base,inputs:[]},                                                           // 输入不可为空
  {...base,inputs:[{from:'object',part:'goal'}]},                                // object 只有三个部位
  {...base,inputs:[{from:'field'}]},                                             // field 必填
  {...base,inputs:[{from:'literal',value:'x'.repeat(4001)}]},                    // 字面量上限与任务输入一致
  {...base,target:{kind:'skill',localId:'x'}},                                   // 目标种类白名单
 ]
 for(const [index,value] of cases.entries())assert.throws(()=>readBusinessActionDefinition(value),{code:'teloa/invalid-input'},'第 '+index+' 条应被拒绝')
})

test('交叉约束表与资源上限是唯一真源',()=>{
 assert.deepEqual(businessFieldCapabilities.text,{dimension:true,measure:false,aggregations:[],operators:['eq','ne','in']})
 assert.deepEqual(businessFieldCapabilities.enum,{dimension:true,measure:false,aggregations:[],operators:['eq','ne','in']})
 assert.deepEqual(businessFieldCapabilities.number,{dimension:false,measure:true,aggregations:['sum','avg','min','max'],operators:['eq','ne','gte','lte']})
 assert.deepEqual(businessFieldCapabilities.datetime,{dimension:true,measure:true,aggregations:['min','max'],operators:['gte','lte']})
 assert.deepEqual(businessFieldCapabilities.reference,{dimension:true,measure:false,aggregations:[],operators:['eq','in']})
 assert.deepEqual(businessFieldCapabilities.duration,{dimension:false,measure:true,aggregations:['sum','avg','min','max'],operators:['eq','ne','gte','lte']})
 assert.deepEqual(businessFieldCapabilities.boolean,{dimension:true,measure:false,aggregations:[],operators:['eq','ne']})
 assert.deepEqual(Object.keys(businessFieldCapabilities),[...businessFieldTypes],'能力表的键集合与字段类型枚举逐一相等，防漂移')
 assert.deepEqual(businessLedgerLimits,{scanRows:5000,objectTypes:16,viewsPerType:8,measures:4,filters:8,dimensionValues:50,listRows:100})
})

test('业务声明本地化元数据必须逐字绑定稳定原文，枚举翻译必须逐项对齐',()=>{
 const metadata=(original:string,en:string)=>({original,defaultLocale:'en',locales:{'zh-CN':original,en}})
 const object={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:'SOC',title:'工单',unit:'条',lead:'业务说明',sourceId:'source',localized:{title:metadata('工单','Tickets'),unit:metadata('条','tickets'),lead:metadata('业务说明','Business context')},fields:[{name:'state',label:'状态',type:'enum',required:true,from:'状态',values:['新建','完成'],localized:{label:metadata('状态','Status'),values:[metadata('新建','New'),metadata('完成','Completed')]}}]}
 assert.equal(readBusinessObjectTypeDefinition(object).localized?.title?.locales.en,'Tickets')
 assert.throws(()=>readBusinessObjectTypeDefinition({...object,localized:{...object.localized,title:metadata('另一原文','Tickets')}}),{code:'teloa/invalid-input'})
 assert.throws(()=>readBusinessObjectTypeDefinition({...object,fields:[{...object.fields[0],localized:{...object.fields[0]!.localized,values:[metadata('新建','New')]}}]}),{code:'teloa/invalid-input'})
 const view={format:'teloa.business-view/v1',id:'ticket-state',version:'1.0.0',domain:'SOC',title:'状态分布',localized:{title:metadata('状态分布','Status distribution')},kind:'distribution',chart:'bar',objectType:'ticket',dimension:{field:'state',limit:2},measures:[{id:'total',label:'数量',localized:{label:metadata('数量','Tickets')},aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:2}
 assert.equal(readBusinessViewDefinition(view).measures[0]?.localized?.label?.locales.en,'Tickets')
 const action={format:'teloa.business-action/v1',id:'open-ticket',version:'1.0.0',domain:'SOC',title:'创建工单',localized:{title:metadata('创建工单','Create ticket')},objectType:'ticket',target:{kind:'work-template',localId:'ticket-work'},inputs:[{from:'object',part:'title'}]}
 assert.equal(readBusinessActionDefinition(action).localized?.title?.locales.en,'Create ticket')
})
