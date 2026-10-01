import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '../src/work-error.ts'
import {businessSourceMappingLimits,evaluateJsonPath,isValidJsonPath,readBusinessSourceMappingDefinition,readBusinessSyncRun,readBusinessSyncStatus,readBusinessSyncRuleState,readBusinessSyncRuleView} from '../src/business-source-mapping.ts'

const invalid=(run:()=>unknown,message?:string)=>assert.throws(run,(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input',message)
const hostInvalid=(run:()=>unknown,message?:string)=>assert.throws(run,(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-host-response',message)

/** SOC 告警映射（规格 §4.1 示例）。 */
const soc={
 format:'teloa.business-source-mapping/v1',id:'soc-alert-sync',version:'1.0.0',domain:'soc',title:'SOC 告警同步',
 objectType:'soc-alert',
 source:{kind:'business-data-port',sourceId:'security-alert-http'},
 mapping:[{path:'$.alert_id',field:'id'},{path:'$.severity_level',field:'severity'},{path:'$.created_at',field:'alerted_at'},{path:'$.title',field:'title'},{path:'$.updated_at',field:'observedAt'}],
 primaryKey:['id'],
 incrementalCursor:{path:'$.updated_at',kind:'timestamp'},
 deletionSemantics:'compare',
 schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false,
}

test('持续规则回包必须固定范围、映射、声明摘要与启停修订；可见行带真实周期',()=>{
 const state={scope:'soc',mappingId:'soc-alert-sync',definitionHash:'a'.repeat(64),enabled:false,revision:0}
 assert.deepEqual(readBusinessSyncRuleState(state,'soc'),state)
 assert.deepEqual(readBusinessSyncRuleView({...state,title:'SOC 告警同步',schedule:{kind:'every',seconds:300},running:false},'soc'),{...state,title:'SOC 告警同步',schedule:{kind:'every',seconds:300},running:false})
 hostInvalid(()=>readBusinessSyncRuleState({...state,scope:'other'},'soc'))
 hostInvalid(()=>readBusinessSyncRuleState({...state,definitionHash:'bad'},'soc'))
 hostInvalid(()=>readBusinessSyncRuleState({...state,enabled:true,revision:-1},'soc'))
 hostInvalid(()=>readBusinessSyncRuleView({...state,title:'SOC 告警同步',schedule:{kind:'every',seconds:300},running:true},'soc'))
 hostInvalid(()=>readBusinessSyncRuleView({...state,title:'SOC 告警同步',schedule:{kind:'every',seconds:0},running:false},'soc'))
})

test('JSONPath 子集：求值与合法性判定',()=>{
 assert.equal(evaluateJsonPath({a:{b:[{c:1}]}},'$.a.b[0].c'),1)
 assert.deepEqual(evaluateJsonPath({a:{b:[{c:1}]}},"$.a['b'][0]"),{c:1})
 assert.deepEqual(evaluateJsonPath({a:{b:[{c:1}]}},'$'),{a:{b:[{c:1}]}})
 assert.deepEqual(evaluateJsonPath({a:{'we ird':2}},"$.a['we ird']"),2)
 assert.deepEqual(evaluateJsonPath({a:{"it's":3}},"$.a['it\\'s']"),3)
 assert.deepEqual(evaluateJsonPath({items:[1,2]},'$.items[*]'),[1,2])
 assert.equal(evaluateJsonPath({items:{}},'$.items[*]'),undefined,'末段 [*] 只对数组有值')
 assert.equal(evaluateJsonPath({a:{b:[{c:1}]}},'$.a.x.y'),undefined,'路径不存在返回 undefined')
 assert.equal(evaluateJsonPath({a:{b:[{c:1}]}},'$.a.b[3]'),undefined)
 assert.equal(evaluateJsonPath({a:'text'},'$.a.length'),undefined,'非对象上不取属性')
 assert.equal(evaluateJsonPath({},'$.constructor'),undefined,'不沿原型链取值')
 assert.equal(evaluateJsonPath({},'$.__proto__'),undefined)
 assert.equal(evaluateJsonPath(null,'$.a'),undefined)
 for(const path of ['$..c','$.a[?(@.c)]','a.b','','$.','$.a.','$a','$.a.0','$[a]','$["a"]','$.a[-1]','$.a[01]','$.a[*].b','$.a[*][*]','$ .a','$.a b','$.a[0]x',"$.a['b'",'$.a[ 0 ]','$.a[1.5]','$.a[]'])
  assert.equal(isValidJsonPath(path),false,JSON.stringify(path)+' 应不合法')
 for(const path of ['$','$.a','$.a_b-c','$.a.b[0].c',"$.a['b'][0]","$['a']",'$[0]','$[0][1]','$.items[*]',"$['items'][*]"])
  assert.equal(isValidJsonPath(path),true,JSON.stringify(path)+' 应合法')
 assert.equal(isValidJsonPath('$.'+'a'.repeat(254)),true,'恰好 256 字合法')
 assert.equal(isValidJsonPath('$.'+'a'.repeat(255)),false,'257 字拒绝')
 invalid(()=>evaluateJsonPath({},'$..c'),'求值时路径不合法应抛错')
 assert.equal(businessSourceMappingLimits.pathLength,256)
})

test('合法映射声明原样返回，无 undefined 键',()=>{
 const definition=readBusinessSourceMappingDefinition(soc)
 assert.deepEqual(definition,soc)
 assert.equal(Object.values(definition).some(value=>value===undefined),false)
 assert.equal('retentionDays' in definition,false)
 assert.equal('pageSize' in definition,false)
 assert.equal('deletedAtPath' in definition,false)
 const full=readBusinessSourceMappingDefinition({...soc,localized:{title:{original:'SOC 告警同步',defaultLocale:'zh-CN',locales:{'zh-CN':'SOC 告警同步',en:'SOC alert sync'}}},deletionSemantics:'tombstone',deletedAtPath:'$.deleted_at',retentionDays:30,pageSize:100,primaryKey:['id','severity']})
 assert.equal(full.deletionSemantics,'tombstone')
 assert.equal(full.deletedAtPath,'$.deleted_at')
 assert.equal(full.retentionDays,30)
 assert.equal(full.pageSize,100)
 assert.deepEqual(full.primaryKey,['id','severity'])
 assert.equal(full.localized?.title?.locales.en,'SOC alert sync')
 // 输入被复制，不与返回值共享数组。
 assert.notEqual(definition.mapping,soc.mapping)
})

test('主键、删除语义、来源与数量约束',()=>{
 invalid(()=>readBusinessSourceMappingDefinition({...soc,primaryKey:['alert_id']}),'主键引用的字段不在 mapping 里')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,primaryKey:[]}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,primaryKey:['id','id']}),'主键不得重复')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,mapping:[...soc.mapping,{path:'$.a',field:'a'},{path:'$.b',field:'b'}],primaryKey:['id','severity','a','b']}),'主键超过 3 个')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,deletionSemantics:'tombstone'}),'tombstone 缺 deletedAtPath')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,deletedAtPath:'$.deleted_at'}),'compare 不得带 deletedAtPath')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,deletionSemantics:'soft'}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{filter:{stage:'won'}},itemsPath:'$.deals[*]'}}),'mcp-tool arguments 含对象值')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{tags:['a']},itemsPath:'$.deals[*]'}}),'mcp-tool arguments 含数组值')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{n:null},itemsPath:'$.deals[*]'}}),'mcp-tool arguments 含 null')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{},itemsPath:'$..deals'}}),'itemsPath 不合法')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{}}}),'mcp-tool 缺 itemsPath')
 const mcp=readBusinessSourceMappingDefinition({...soc,source:{kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{stage:'won',limit:50,archived:false},itemsPath:'$.deals[*]'}})
 assert.deepEqual(mcp.source,{kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{stage:'won',limit:50,archived:false},itemsPath:'$.deals[*]'})
 assert.deepEqual(readBusinessSourceMappingDefinition({...soc,source:{kind:'role-result'}}).source,{kind:'role-result'})
 assert.deepEqual(readBusinessSourceMappingDefinition({...soc,source:{kind:'role-result',roleId:'role-1'}}).source,{kind:'role-result',roleId:'role-1'})
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'role-result',roleId:''}}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'webhook',url:'https://x'}}),'来源种类不在白名单')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'business-data-port'}}),'缺 sourceId')
 const many=Array.from({length:65},(_,index)=>({path:'$.f'+index,field:'f'+index}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,mapping:many,primaryKey:['f0']}),'mapping 65 条')
 assert.equal(readBusinessSourceMappingDefinition({...soc,mapping:many.slice(0,64),primaryKey:['f0']}).mapping.length,64)
 // 空映射只给业务数据端口（原样落库：端口回包已是快照形状）；主键固定 ['id']、删除语义只有 compare。
 const raw={...soc,mapping:[]}
 delete (raw as Record<string,unknown>).incrementalCursor
 assert.deepEqual(readBusinessSourceMappingDefinition(raw).mapping,[])
 invalid(()=>readBusinessSourceMappingDefinition({...raw,source:{kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{},itemsPath:'$.deals[*]'}}),'mcp-tool 不得空映射')
 invalid(()=>readBusinessSourceMappingDefinition({...raw,source:{kind:'role-result'}}),'role-result 不得空映射')
 invalid(()=>readBusinessSourceMappingDefinition({...raw,primaryKey:['alert_id']}),'原样落库主键固定 id')
 invalid(()=>readBusinessSourceMappingDefinition({...raw,deletionSemantics:'tombstone',deletedAtPath:'$.deletedAt'}),'原样落库只支持 compare')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,mapping:[{path:'$.a',field:'id'},{path:'$.b',field:'id'}]}),'目标字段重复')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,mapping:[{path:'$.items[*]',field:'id'}]}),'mapping 路径不得带 [*]')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,mapping:[{path:'$.a',field:'Severity'}]}),'目标字段名不合法')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,mapping:[...soc.mapping,{path:'$.a',field:'x'.repeat(64)}]}),'目标字段名超 63 字符（PG 标识符截断）')
 assert.equal(readBusinessSourceMappingDefinition({...soc,mapping:[...soc.mapping,{path:'$.a',field:'x'.repeat(63)}]}).mapping.at(-1)!.field.length,63)
 invalid(()=>readBusinessSourceMappingDefinition({...soc,mapping:[{path:'a.b',field:'id'}]}),'路径不合法')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,mapping:[{path:'$.a',field:'id',extra:1}]}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,incrementalCursor:{path:'$.updated_at',kind:'time'}}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,incrementalCursor:{path:'$.items[*]',kind:'sequence'}}))
 assert.deepEqual(readBusinessSourceMappingDefinition({...soc,incrementalCursor:{path:'$.seq',kind:'sequence'}}).incrementalCursor,{path:'$.seq',kind:'sequence'})
})

test('mcp-tool 声明式分页：键名、路径与水位参数不撞名',()=>{
 const tool={kind:'mcp-tool',serverName:'crm',tool:'list_deals',arguments:{stage:'won'},itemsPath:'$.deals[*]'}
 const full={...soc}
 delete (full as Record<string,unknown>).incrementalCursor
 const paged=readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'page',nextCursorPath:"$.meta['next']"}}})
 assert.deepEqual(paged.source,{...tool,pagination:{cursorArgument:'page',nextCursorPath:"$.meta['next']"}})
 // 不带水位时续页参数可以叫 cursor（此时不透传水位，不会撞名）。
 assert.deepEqual(readBusinessSourceMappingDefinition({...full,source:{...tool,pagination:{cursorArgument:'cursor',nextCursorPath:'$.next'}}}).source,{...tool,pagination:{cursorArgument:'cursor',nextCursorPath:'$.next'}})
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'stage',nextCursorPath:'$.next'}}}),'cursorArgument 与 arguments 键重名')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:' page',nextCursorPath:'$.next'}}}),'cursorArgument 首尾空白')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'p'.repeat(65),nextCursorPath:'$.next'}}}),'cursorArgument 超 64 字')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'a\nb',nextCursorPath:'$.next'}}}),'cursorArgument 含控制字符')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:1,nextCursorPath:'$.next'}}}),'cursorArgument 非字符串')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'page',nextCursorPath:'$.pages[*]'}}}),'nextCursorPath 带 [*]')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'page',nextCursorPath:'$..next'}}}),'nextCursorPath 不合法')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'page',nextCursorPath:'$.next',limit:5}}}),'pagination 多键')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'page'}}}),'pagination 缺键')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:null}}),'pagination 非对象')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,source:{kind:'business-data-port',sourceId:'security-alert-http',pagination:{cursorArgument:'page',nextCursorPath:'$.next'}}}),'业务数据端口来源不收 pagination')
 assert.throws(()=>readBusinessSourceMappingDefinition({...soc,source:{...tool,pagination:{cursorArgument:'cursor',nextCursorPath:'$.next'}}}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&error.message.includes('incrementalCursor')&&error.message.includes('pagination.cursorArgument'),'带水位时续页参数不得叫 cursor，文案点名两字段')
 // 一期声明（无 pagination）读出逐字不变。
 const legacy={...soc,source:tool}
 assert.deepEqual(readBusinessSourceMappingDefinition(legacy),legacy)
 assert.equal('pagination' in readBusinessSourceMappingDefinition(legacy).source,false)
})

test('格式、身份、周期与上限',()=>{
 invalid(()=>readBusinessSourceMappingDefinition({...soc,format:'teloa.business-source-mapping/v2'}),'format 不符')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,extra:true}),'多余键')
 invalid(()=>readBusinessSourceMappingDefinition((({title:_,...rest})=>rest)(soc)),'缺键')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,id:'soc_alert'}),'标识不接受下划线')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,version:'1.0'}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,domain:'general'}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,title:'多行\n标题'}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,objectType:'soc alert'}))
 invalid(()=>readBusinessSourceMappingDefinition({...soc,schedule:{kind:'every',seconds:30}}),'30 秒未确认')
 assert.equal(readBusinessSourceMappingDefinition({...soc,schedule:{kind:'every',seconds:30},acknowledgeShortInterval:true}).acknowledgeShortInterval,true)
 invalid(()=>readBusinessSourceMappingDefinition({...soc,schedule:{kind:'every',seconds:30,acknowledgeShortInterval:true}}),'确认位不得写进 schedule 里')
 invalid(()=>readBusinessSourceMappingDefinition((({acknowledgeShortInterval:_,...rest})=>rest)(soc)),'acknowledgeShortInterval 必填')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,acknowledgeShortInterval:'false'}))
 assert.deepEqual(readBusinessSourceMappingDefinition({...soc,schedule:{kind:'cron',expression:'0 9 * * 1-5',timezone:'Asia/Shanghai'}}).schedule,{kind:'cron',expression:'0 9 * * 1-5',timezone:'Asia/Shanghai'})
 for(const retentionDays of [0,366,1.5,'30'])invalid(()=>readBusinessSourceMappingDefinition({...soc,retentionDays}),'retentionDays '+String(retentionDays))
 for(const pageSize of [0,101,1.5,'50'])invalid(()=>readBusinessSourceMappingDefinition({...soc,pageSize}),'pageSize '+String(pageSize))
 assert.equal(readBusinessSourceMappingDefinition({...soc,retentionDays:365,pageSize:1}).retentionDays,365)
 invalid(()=>readBusinessSourceMappingDefinition({...soc,localized:{title:{original:'别的标题',defaultLocale:'zh-CN',locales:{'zh-CN':'别的标题'}}}}),'本地化原文必须等于 title')
 invalid(()=>readBusinessSourceMappingDefinition({...soc,localized:{}}))
 assert.deepEqual(businessSourceMappingLimits,{mappings:64,primaryKeys:3,pathLength:256,mappingsPerScope:32})
})

const run={id:'run-1',mappingId:'soc-alert-sync',scope:'soc',startedAt:'2026-09-25T02:00:00.000Z',finishedAt:'2026-09-25T02:00:01.250Z',status:'ok',upserted:12,tombstoned:1,fetched:13,durationMs:1250,nextCursor:'2026-09-25T01:59:00.000Z',trigger:'schedule'}

test('同步记录：状态、错误码与范围严格',()=>{
 assert.deepEqual(readBusinessSyncRun(run,'soc'),run)
 const failed={...run,status:'failed',error:{code:'teloa/source-unavailable',reason:'上游 503。'}}
 assert.deepEqual(readBusinessSyncRun(failed,'soc'),failed)
 assert.equal(readBusinessSyncRun({...run,status:'throttled'},'soc').status,'throttled')
 hostInvalid(()=>readBusinessSyncRun({...run,status:'running'},'soc'),'running 不是终态')
 hostInvalid(()=>readBusinessSyncRun({...failed,error:{code:'teloa/oops',reason:'x'}},'soc'),'错误码不在 workErrorCodes')
 hostInvalid(()=>readBusinessSyncRun({...run,status:'failed'},'soc'),'failed 必须带 error')
 hostInvalid(()=>readBusinessSyncRun({...run,error:{code:'teloa/conflict',reason:'x'}},'soc'),'ok 不得带 error')
 hostInvalid(()=>readBusinessSyncRun(run,'crm'),'范围不符')
 hostInvalid(()=>readBusinessSyncRun({...run,finishedAt:'2026-09-25T01:59:59.000Z'},'soc'),'结束不得早于开始')
 hostInvalid(()=>readBusinessSyncRun({...run,upserted:-1},'soc'))
 hostInvalid(()=>readBusinessSyncRun({...run,trigger:'cron'},'soc'))
 hostInvalid(()=>readBusinessSyncRun({...run,extra:1},'soc'))
 hostInvalid(()=>readBusinessSyncRun({...run,startedAt:'2026-09-25T02:00:00Z'},'soc'),'时间戳必须带毫秒的规范 UTC')
 const status={mappingId:'soc-alert-sync',lastRun:run,nextRunAt:'2026-09-25T02:05:00.000Z',consecutiveFailures:0,quota:{rows:120,limit:50000}}
 assert.deepEqual(readBusinessSyncStatus(status,'soc'),status)
 assert.deepEqual(readBusinessSyncStatus({mappingId:'soc-alert-sync',consecutiveFailures:0,quota:{rows:0,limit:50000}},'soc'),{mappingId:'soc-alert-sync',consecutiveFailures:0,quota:{rows:0,limit:50000}})
 assert.equal(readBusinessSyncStatus({...status,consecutiveFailures:3,backoffUntil:'2026-09-25T02:30:00.000Z'},'soc').backoffUntil,'2026-09-25T02:30:00.000Z')
 hostInvalid(()=>readBusinessSyncStatus({...status,lastRun:{...run,mappingId:'other'}},'soc'),'lastRun 必须属于同一映射')
 hostInvalid(()=>readBusinessSyncStatus(status,'crm'))
 hostInvalid(()=>readBusinessSyncStatus({...status,consecutiveFailures:-1},'soc'))
 hostInvalid(()=>readBusinessSyncStatus({...status,quota:{rows:1}},'soc'))
 hostInvalid(()=>readBusinessSyncStatus({...status,quota:{rows:1,limit:0}},'soc'))
 hostInvalid(()=>readBusinessSyncStatus({...status,nextRunAt:'soon'},'soc'))
})
