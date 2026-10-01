import test from 'node:test'
import assert from 'node:assert/strict'
import type {BusinessWidgetResult} from '@teloa/contract'
import {boardColumns,metricTone,pipelineStages,viewRefProjection,widgetCells,widgetFailure} from '../src/client/business-widget-presentation.ts'
import {durationText} from '../src/client/business-definition-localization.ts'

const result=(columns:BusinessWidgetResult['columns'],rows:BusinessWidgetResult['rows']):BusinessWidgetResult=>({widgetId:'w',definitionHash:'a'.repeat(64),computedAt:'2026-09-25T02:00:00.000Z',status:'ok',columns,rows,rowCount:rows.length,truncated:false,bytes:1,stale:false})

test('指标阈值：命中的第一条定色调，都不命中则无色调',()=>{
 assert.equal(metricTone(12,[{op:'gte',value:10,tone:'warn'}]),'warn')
 assert.equal(metricTone(9,[{op:'gte',value:10,tone:'warn'}]),undefined)
 assert.equal(metricTone(3,[{op:'lte',value:5,tone:'good'},{op:'lte',value:3,tone:'bad'}]),'good')
 assert.equal(metricTone(null,[{op:'gte',value:0,tone:'bad'}]),undefined)
})

test('卡片看板按声明状态分列，声明外的状态归「其他」列，没有才不出这一列',()=>{
 const cards=[{id:'1',title:'a',status:'open'},{id:'2',title:'b',status:'wip'},{id:'3',title:'c',status:'closed'}]
 const columns=boardColumns(cards,['open','closed'])
 assert.deepEqual(columns.map(column=>[column.status,column.cards.map(card=>card.id)]),[['open',['1']],['closed',['3']],[null,['2']]])
 assert.deepEqual(boardColumns(cards.slice(0,1),['open','closed']).map(column=>column.status),['open','closed'])
})

test('流水线按声明阶段归一：缺的阶段数量补 0、时长为空，顺序照声明',()=>{
 const stages=pipelineStages([{stage:'review',count:4,duration:3600},{stage:'intake',count:2,duration:null}],['intake','triage','review'])
 assert.deepEqual(stages,[{stage:'intake',count:2,duration:null},{stage:'triage',count:0,duration:null},{stage:'review',count:4,duration:3600}])
})

test('组件结果按列名取值：布尔人话、时刻本地化、空值写破折号',()=>{
 const cells=widgetCells(result([{name:'ok',type:'boolean'},{name:'at',type:'datetime'},{name:'n',type:'number'},{name:'x',type:'null'}],[[true,'2026-09-25T02:00:00.000Z',1234.5,null]]),{yes:'是',no:'否',number:value=>'#'+value,dateTime:value=>'@'+value.toISOString()})
 assert.deepEqual(cells,[['是','@2026-09-25T02:00:00.000Z','#1234.5','—']])
})

test('失败原因映射到固定词条：同码不同原因分开说，未知一律回落通用句',()=>{
 assert.deepEqual(widgetFailure({code:'teloa/dependency-unavailable',reason:'查询超过 5 秒已中止'}),{key:'business.dashboards.error.timeout'})
 assert.deepEqual(widgetFailure({code:'teloa/dependency-unavailable',reason:'查询临时文件超限'}),{key:'business.dashboards.error.timeout'})
 assert.deepEqual(widgetFailure({code:'teloa/dependency-unavailable',reason:'查询排队超时'}),{key:'business.dashboards.error.queue'})
 assert.deepEqual(widgetFailure({code:'teloa/invalid-input',reason:'结果超过 10 000 行'}),{key:'business.dashboards.error.rows'})
 assert.deepEqual(widgetFailure({code:'teloa/invalid-input',reason:'单行超过 1 MB'}),{key:'business.dashboards.error.rowBytes'})
 assert.deepEqual(widgetFailure({code:'teloa/invalid-input',reason:'不允许的函数 pg_sleep'}),{key:'business.dashboards.error.sql',params:{reason:'不允许的函数 pg_sleep'}})
 assert.deepEqual(widgetFailure({code:'teloa/source-unavailable',reason:'数据源待配置凭据'}),{key:'business.dashboards.error.credentials'})
 assert.deepEqual(widgetFailure({code:'teloa/source-unavailable',reason:'数据源暂不可读。'}),{key:'business.dashboards.error.source'})
 assert.deepEqual(widgetFailure({code:'teloa/forbidden',reason:'当前主体未获准读取此业务范围。'}),{key:'business.dashboards.error.forbidden'})
 assert.deepEqual(widgetFailure({code:'teloa/not-found',reason:'尚未计算'}),{key:'business.dashboards.error.notComputed'})
 assert.deepEqual(widgetFailure({code:'teloa/not-found',reason:'看板不存在。'}),{key:'business.dashboards.error.forbidden'})
 assert.deepEqual(widgetFailure({code:'teloa/storage-corrupt',reason:'固定业务对象快照格式不正确。'}),{key:'business.dashboards.error.corrupt'})
 assert.deepEqual(widgetFailure({code:'teloa/conflict',reason:'看板正在刷新'}),{key:'business.dashboards.error.conflict'})
 assert.deepEqual(widgetFailure({code:'teloa/dependency-unavailable',reason:'数据库暂不可用'}),{key:'business.dashboards.widget.failed'})
 assert.deepEqual(widgetFailure(Object.assign(Error('看板不存在。'),{code:'teloa/not-found'})),{key:'business.dashboards.error.forbidden'})
 assert.deepEqual(widgetFailure(Error('boom')),{key:'business.dashboards.widget.failed'})
})

test('视图引用组件：快照行投影回视图结果，画法与度量标签取台账那份视图，没有就回落表格',()=>{
 const snapshot=result([{name:'dimension',type:'text'},{name:'label',type:'text'},{name:'count',type:'number'}],[['high','高',3],['low','低',null]])
 const bare=viewRefProjection(snapshot,'风险分布')
 assert.equal(bare.chart,'table')
 assert.deepEqual(bare.measures.map(measure=>measure.label),['count'])
 assert.deepEqual(bare.rows,[{dimension:'high',label:'高',values:[3]},{dimension:'low',label:'低',values:[null]}])
 const shaped=viewRefProjection(snapshot,'风险分布',{kind:'distribution',chart:'bar',measures:[{id:'count',label:'数量'}]})
 assert.equal(shaped.chart,'bar')
 assert.deepEqual(shaped.measures.map(measure=>measure.label),['数量'])
})

test('时长度量按最大整单位写：秒、分、时、天',()=>{
 const number=(value:number,options?:Intl.NumberFormatOptions)=>new Intl.NumberFormat('en',options).format(value)
 assert.equal(durationText(45,number),'45 seconds')
 assert.equal(durationText(90,number),'1.5 minutes')
 assert.equal(durationText(3600,number),'1 hour')
 assert.equal(durationText(3*86400,number),'3 days')
})
