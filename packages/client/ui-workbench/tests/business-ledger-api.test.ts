import test from 'node:test'
import assert from 'node:assert/strict'
import {
 businessLedgerBlockUpdated,businessLedgerCacheKey,businessLedgerCacheKeys,businessLedgerFailureKey,
 createBusinessLedgerApi,ledgerListTruncation,readBusinessLedger,
} from '../src/client/business-ledger-api.ts'
import {block,computedAt,ledger,ledgerObject,listView,otherLedger,seedHash,viewResult} from './business-ledger-fixtures.ts'

const sample=()=>ledger({blocks:[block({views:[listView('SOC','alert-ticket',[ledgerObject('SOC','alert-ticket','a-1'),ledgerObject('SOC','alert-ticket','a-2')])]})]})

test('来源名词可选，提供时必须是十二字以内的单行名称',async()=>{
 const value=sample()
 Object.assign(value.blocks[0]!.source,{sourceNoun:'告警源'})
 assert.equal((await readBusinessLedger(value,'SOC')).blocks[0]!.source.sourceNoun,'告警源')
 assert.equal(Object.hasOwn((await readBusinessLedger(sample(),'SOC')).blocks[0]!.source,'sourceNoun'),false)
 for(const noun of [null,undefined,'','字'.repeat(13),'告警\n来源','告警\r来源','告警\t来源','告警\u0000来源']){
  Object.assign(value.blocks[0]!.source,{sourceNoun:noun})
  await assert.rejects(readBusinessLedger(value,'SOC'))
 }
})

test('回包逐条核对，坏摘要与不同序的 objects 一律拒收',async()=>{
 await assert.doesNotReject(readBusinessLedger(sample(),'SOC'))
 await assert.rejects(readBusinessLedger({...sample(),scope:'AppSec'},'SOC'))
 const swapped=structuredClone(sample());swapped.blocks[0]!.views[0]!.objects!.reverse()
 await assert.rejects(readBusinessLedger(swapped,'SOC'))
 const rewritten=structuredClone(sample());rewritten.blocks[0]!.views[0]!.objects![0]!.summary='改过了'
 await assert.rejects(readBusinessLedger(rewritten,'SOC'),/固定快照/)
})

test('块的来源、范围与声明身份对不上就整条拒收，不以空台账替代',async()=>{
 const foreign=structuredClone(sample());foreign.blocks[0]!.source.sourceId='另一个来源'
 await assert.rejects(readBusinessLedger(foreign,'SOC'))
 const mismatched=structuredClone(sample());mismatched.blocks[0]!.objectType.source.localId='别的声明'
 await assert.rejects(readBusinessLedger(mismatched,'SOC'))
 const late=structuredClone(sample());late.blocks[0]!.views[0]!.computedAt='2026-09-15T03:00:00.000Z'
 await assert.rejects(readBusinessLedger(late,'SOC'),'同一次台账里的视图必须来自同一次计算批次')
 const extra=structuredClone(sample()) as Record<string,unknown>;extra.note='多一个键'
 await assert.rejects(readBusinessLedger(extra,'SOC'))
})

test('声明来源与视图的 origin 缺位或不是 template/local 两值之一，一律拒收',async()=>{
 const missing=structuredClone(sample()) as any;delete missing.blocks[0].objectType.source.origin
 await assert.rejects(readBusinessLedger(missing,'SOC'))
 const bogus=structuredClone(sample()) as any;bogus.blocks[0].views[0].origin='draft'
 await assert.rejects(readBusinessLedger(bogus,'SOC'))
})

test('缓存键含 definitionHash：声明版本一变整条作废',()=>{
 const a=businessLedgerCacheKey('SOC',undefined,{viewId:'v',definitionHash:'a'.repeat(64)})
 const b=businessLedgerCacheKey('SOC',undefined,{viewId:'v',definitionHash:'b'.repeat(64)})
 assert.notEqual(a,b)
 assert.equal(a,businessLedgerCacheKey('SOC',undefined,{viewId:'v',definitionHash:'a'.repeat(64)}))
 assert.notEqual(a,businessLedgerCacheKey('AppSec',undefined,{viewId:'v',definitionHash:'a'.repeat(64)}))
})

test('声明换过版本的块才标「声明已更新」，第一次读不标',async()=>{
 const current=await readBusinessLedger(ledger(),'SOC')
 assert.equal(businessLedgerBlockUpdated(new Map(),'SOC',current.blocks[0]!),false,'没有上一次的键就没有可比的基准')
 const keys=businessLedgerCacheKeys(current)
 assert.equal(businessLedgerBlockUpdated(keys,'SOC',current.blocks[0]!),false,'同一份声明重算不算更新')
 const stale=new Map(keys)
 for(const [identity] of stale)stale.set(identity,businessLedgerCacheKey('SOC','alert-ticket',{viewId:'risk-distribution',definitionHash:'0'.repeat(64)}))
 assert.equal(businessLedgerBlockUpdated(stale,'SOC',current.blocks[0]!),true)
})

test('形态与图表逐字来自回包，kind×chart 不是允许组合即拒收',async()=>{
 const rows=[{dimension:'2026-09-14T00:00:00.000Z',label:'09-14',values:[3]},{dimension:'2026-09-15T00:00:00.000Z',label:'09-15',values:[5]}]
 const read=await readBusinessLedger(ledger({blocks:[block({views:[
  listView('SOC','alert-ticket',[ledgerObject('SOC','alert-ticket','a-1')]),
  viewResult('SOC','alert-ticket','pending-board',[{dimension:'',label:'待处理告警',values:[4]}],{kind:'board-card',chart:'number',title:'待处理告警',dimensionValues:1}),
  viewResult('SOC','alert-ticket','alert-trend',rows,{kind:'trend',chart:'line',title:'告警趋势'}),
  viewResult('SOC','alert-ticket','risk-distribution',[{dimension:'高',label:'高',values:[7]}]),
 ]})]}),'SOC')
 assert.deepEqual(read.blocks[0]!.views.map(view=>[view.kind,view.chart]),[['list','table'],['board-card','number'],['trend','line'],['distribution','bar']])
 assert.deepEqual(read.blocks[0]!.views.map(view=>view.title),['对象清单','待处理告警','告警趋势','风险分布'])
 const badCombo=structuredClone(ledger());badCombo.blocks[0]!.views[0]!.chart='number'
 await assert.rejects(readBusinessLedger(badCombo,'SOC'),'distribution 不支持 number')
 const badKind=structuredClone(ledger());(badKind.blocks[0]!.views[0] as {kind:string}).kind='heatmap'
 await assert.rejects(readBusinessLedger(badKind,'SOC'))
 // 只有清单视图带 objects 段：形态位与这条编码必须互相印证。
 const strayObjects=structuredClone(ledger());strayObjects.blocks[0]!.views[0]!.objects=[]
 await assert.rejects(readBusinessLedger(strayObjects,'SOC'))
})

test('截断前的组数不得少于画出来的行数；度量字段类型必须在契约白名单里',async()=>{
 const short=structuredClone(ledger());short.blocks[0]!.views[0]!.dimensionValues=1
 await assert.rejects(readBusinessLedger(short,'SOC'))
 const wide=structuredClone(ledger());wide.blocks[0]!.views[0]!.dimensionValues=9
 const read=await readBusinessLedger(wide,'SOC')
 assert.equal(read.blocks[0]!.views[0]!.dimensionValues,9,'比行数多就是真被截断了，如实留着')
 const badType=structuredClone(ledger());(badType.blocks[0]!.views[0]!.measures[0] as {fieldType?:string}).fieldType='timestamp'
 await assert.rejects(readBusinessLedger(badType,'SOC'))
 const typed=structuredClone(ledger());(typed.blocks[0]!.views[0]!.measures[0] as {fieldType?:string}).fieldType='datetime'
 assert.equal((await readBusinessLedger(typed,'SOC')).blocks[0]!.views[0]!.measures[0]!.fieldType,'datetime')
})

test('块级覆盖面与缺失披露：与块的对象数、与每张视图那份都必须对得上',async()=>{
 const read=await readBusinessLedger(ledger({blocks:[block({missingFields:['severity']})]}),'SOC')
 assert.deepEqual(read.blocks[0]!.coverage,{objects:12,latestReceivedAt:'2026-09-15T01:05:00.000Z',truncated:false})
 assert.deepEqual(read.blocks[0]!.missingFields,['severity'])
 const mismatched=structuredClone(ledger());mismatched.blocks[0]!.coverage.objects=11
 await assert.rejects(readBusinessLedger(mismatched,'SOC'),'块的对象数与覆盖面对不上')
 // 夹具让块与视图共用同一份覆盖面对象，所以这里整块换掉而不是改字段——改字段会连块级那份一起改。
 const drifted=structuredClone(ledger());drifted.blocks[0]!.views[0]!.coverage={...drifted.blocks[0]!.coverage,truncated:true}
 await assert.rejects(readBusinessLedger(drifted,'SOC'),'同一个块里视图与块的覆盖面必须同源')
 const undeclared=structuredClone(ledger());undeclared.blocks[0]!.missingFields=['not-declared']
 await assert.rejects(readBusinessLedger(undeclared,'SOC'),'缺失字段名必须真在声明里')
})

test('对象类型声明进度摘要时，回包必须给出同一份可核验的阶段统计',async()=>{
 const definition={
  fields:[
   {name:'state',label:'状态',type:'enum',required:true,from:'状态',values:['新建','等确认','完成']},
   {name:'changed-at',label:'最近变化',type:'datetime',required:true,from:'最近变化'},
  ],
  progress:{stageField:'state',unfinished:['新建','等确认'],waitingForYou:['等确认'],changedAtField:'changed-at'},
 }
 const value=ledger({blocks:[block({definition,progress:{unfinished:8,waitingForYou:2,latestChangedAt:'2026-09-15T01:00:00.000Z'}})]})
 const parsed=await readBusinessLedger(value,'SOC')
 assert.deepEqual(parsed.blocks[0]!.progress,{unfinished:8,waitingForYou:2,latestChangedAt:'2026-09-15T01:00:00.000Z'})
 const missing=structuredClone(value);delete missing.blocks[0]!.progress
 await assert.rejects(()=>readBusinessLedger(missing,'SOC'))
 const invalid=structuredClone(value) as unknown as {blocks:Array<{progress?:{waitingForYou:number}}>}
 invalid.blocks[0]!.progress!.waitingForYou=9
 await assert.rejects(()=>readBusinessLedger(invalid,'SOC'))
})

test('读取失败按错误码选固定文案，认不出来的退回通用那句，不碰 details',()=>{
 assert.equal(businessLedgerFailureKey(Object.assign(Error('x'),{code:'teloa/forbidden',details:{secret:1}})),'business.ledger.readFailed.forbidden')
 assert.equal(businessLedgerFailureKey(Object.assign(Error('x'),{code:'teloa/storage-corrupt'})),'business.ledger.readFailed.corrupt')
 assert.equal(businessLedgerFailureKey(Object.assign(Error('x'),{code:'teloa/source-unavailable'})),'business.ledger.readFailed')
 assert.equal(businessLedgerFailureKey(Error('形状对不上')),'business.ledger.readFailed')
})

test('只提交契约白名单字段，端点与入参逐字固定',async()=>{
 const calls:unknown[][]=[]
 const api=createBusinessLedgerApi(async(method,payload)=>{calls.push([method,payload]);return ledger()})
 await api.read({scope:'SOC'})
 await api.read({scope:'SOC',objectType:'alert-ticket'})
 assert.deepEqual(calls,[['business-definitions/ledger',{scope:'SOC'}],['business-definitions/ledger',{scope:'SOC',objectType:'alert-ticket'}]])
 await assert.rejects(api.read({scope:'general'}),/范围/)
 await assert.rejects(api.read({scope:'SOC',objectType:'不是标识'}),/对象类型/)
})

test('下钻筛选 match 原样提交；缺对象类型、字段或取值不合规在客户端就拒，不发请求',async()=>{
 const calls:unknown[][]=[]
 const api=createBusinessLedgerApi(async(method,payload)=>{calls.push([method,payload]);return ledger()})
 await api.read({scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'}})
 await api.read({scope:'SOC',objectType:'alert-ticket',match:{field:'_id',value:'soc-alert-7'}})
 assert.deepEqual(calls,[
  ['business-definitions/ledger',{scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'}}],
  ['business-definitions/ledger',{scope:'SOC',objectType:'alert-ticket',match:{field:'_id',value:'soc-alert-7'}}],
 ])
 for(const request of [
  {scope:'SOC',match:{field:'severity',value:'高'}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'Severity',value:'高'}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:''}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'x'.repeat(201)}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高\n'}},
 ])await assert.rejects(api.read(request),/筛选/,JSON.stringify(request))
 assert.equal(calls.length,2)
 // 多出来的键不往宿主递：只取 field / value 两项。
 await api.read({scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高',op:'ne'} as never})
 assert.deepEqual(calls.at(-1),['business-definitions/ledger',{scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'}}])
})

test('换一个 domain 的声明走同一条读取路径，范围与身份逐字跟着换',async()=>{
 const read=await readBusinessLedger(otherLedger(),'AppSec')
 assert.equal(read.scope,'AppSec')
 assert.equal(read.blocks[0]!.objectType.definition.title,'漏洞')
 assert.equal(read.blocks[0]!.defaultAction,undefined)
 assert.equal(read.computedAt,computedAt)
 await assert.rejects(readBusinessLedger(otherLedger(),'SOC'))
})

test('视图的行与度量长度必须逐条对齐，摘要位必须是六十四位十六进制',async()=>{
 const ragged=structuredClone(ledger());ragged.blocks[0]!.views[0]!.rows[0]!.values=[1,2]
 await assert.rejects(readBusinessLedger(ragged,'SOC'))
 const shortHash=structuredClone(ledger());shortHash.blocks[0]!.views[0]!.definitionHash=seedHash('x').slice(0,10)
 await assert.rejects(readBusinessLedger(shortHash,'SOC'))
})

test('对象目录截断与筛选差额分开判定，互不冒充（复审 N-2）',()=>{
 // 服务端截断了（9 组只给 2 行），完整性筛选没生效（全量 2 行都在显示）。
 assert.deepEqual(ledgerListTruncation({dimensionValues:9,rows:[1,2]},2),{serverTruncated:true,filtered:false})
 // 服务端没有截断（2 组给了 2 行），完整性筛选把可见行数压到 1。
 assert.deepEqual(ledgerListTruncation({dimensionValues:2,rows:[1,2]},1),{serverTruncated:false,filtered:true})
 // 服务端截断且筛选同时生效：两句各自成立，互不覆盖。
 assert.deepEqual(ledgerListTruncation({dimensionValues:9,rows:[1,2]},1),{serverTruncated:true,filtered:true})
 // 都没有：两句都不该出现。
 assert.deepEqual(ledgerListTruncation({dimensionValues:2,rows:[1,2]},2),{serverTruncated:false,filtered:false})
})
