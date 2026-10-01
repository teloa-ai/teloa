import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'

const scope='business_0123456789abcdef0123456789abcdef',now='2026-09-30T12:00:00.000Z'
const type={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户统计',sourceId:'records',fields:[
 {name:'state',label:'阶段',type:'enum',required:false,from:'阶段',values:['新建','完成']},
 {name:'changed',label:'更新',type:'datetime',required:false,from:'更新'},
 {format:'teloa.business-rich-field/v2',name:'amount',label:'金额',from:'金额',required:false,type:'money',currencies:['CNY','USD']},
 {format:'teloa.business-rich-field/v2',name:'tags',label:'标签',from:'标签',required:false,type:'multi-enum',values:['重要','回访','续约']},
]}
const view={format:'teloa.business-view/v2',id:'total',version:'1.0.0',domain:scope,title:'客户统计',kind:'board-card',chart:'number',objectType:'customer',measures:[{id:'sum',label:'合计',aggregation:'sum',field:'amount',currency:'CNY'}],filters:[],limit:1}
function snapshot(id:string,fields:Array<[string,string]>,extra:Record<string,unknown>={}){
 const body={scope,type:'customer',id,version:1,title:id,source:'records',observedAt:now,receivedAt:now,quality:'complete',summary:'',fields:fields.map(([label,value])=>({label,value})),...extra}
 return {...body,snapshotHash:businessObjectSnapshotHash(body as never)}
}
const money=(decimal:string,currency='CNY')=>JSON.stringify({currency,decimal})
function compute(snapshots:ReturnType<typeof snapshot>[],override:Record<string,unknown>={}){
 assert.equal(typeof api.computeBusinessViewV2,'function','须提供真实类型化快照计算器')
 return api.computeBusinessViewV2({objectType:type,view:{...view,...override},snapshots,truncated:false,computedAt:now,scope,definitionHash:'a'.repeat(64),origin:'local'} as never)
}

test('金额大于安全整数的抵消和币种分离保持准确，真实零不等于缺值',()=>{
 const snapshots=[snapshot('a',[['金额',money('9007199254740993.0001')]]),snapshot('b',[['金额',money('-9007199254740993')]]),snapshot('c',[['金额',money('99','USD')]])]
 const result=compute(snapshots)
 assert.deepEqual(result.rows[0]?.values,[{type:'money',currency:'CNY',decimal:'0.0001'}])
 assert.deepEqual(compute(snapshots,{measures:[{id:'usd',label:'美元',aggregation:'sum',field:'amount',currency:'USD'}]}).rows[0]?.values,[{type:'money',currency:'USD',decimal:'99'}])
 assert.equal(result.coverage.objects,3)
 assert.deepEqual(result.missingFields,[])
 assert.deepEqual(compute([snapshot('zero',[['金额',money('0')]])]).rows[0]?.values,[{type:'money',currency:'CNY',decimal:'0'}])
 assert.deepEqual(compute([snapshot('missing',[])]).rows[0]?.values,[null])
 assert.deepEqual(compute([]).rows[0]?.values,[null])
})
test('金额均值四位半偶舍入，负数与上下 tie 对称',()=>{
 for(const [values,want] of [[['0','0.0001'],'0'],[['0.0001','0.0002'],'0.0002'],[['0','-0.0001'],'0'],[['-0.0001','-0.0002'],'-0.0002'],[['1','2'],'1.5']] as const){
  const result=compute(values.map((value,i)=>snapshot(String(i),[['金额',money(value)]])),{measures:[{...view.measures[0],aggregation:'avg'}]})
  assert.deepEqual(result.rows[0]?.values,[{type:'money',currency:'CNY',decimal:want}])
  assert.deepEqual(result.measures[0]?.rounding,{scale:4,mode:'half-even'})
 }
})
test('金额最小最大为有符号精确整数排序，不受字符串字典序或浮点影响',()=>{
 const snapshots=['-10','-2','9007199254740993.0001','9007199254740993.0002'].map((v,i)=>snapshot(String(i),[['金额',money(v)]]))
 assert.deepEqual(compute(snapshots,{measures:[{...view.measures[0],aggregation:'min'}]}).rows[0]?.values,[{type:'money',currency:'CNY',decimal:'-10'}])
 assert.deepEqual(compute(snapshots,{measures:[{...view.measures[0],aggregation:'max'}]}).rows[0]?.values,[{type:'money',currency:'CNY',decimal:'9007199254740993.0002'}])
})
test('多选按成员展开，coverage 始终按独立记录；无效选项与缺值披露而不落其他桶',()=>{
 const result=compute([snapshot('a',[['标签','["重要","续约"]']]),snapshot('b',[['标签','["重要"]']]),snapshot('bad',[['标签','["不存在"]']]),snapshot('missing',[])],{kind:'distribution',chart:'bar',dimension:{field:'tags',limit:10},measures:[{id:'count',label:'客户数',aggregation:'count'}],sort:{by:'dimension',direction:'asc'},limit:10})
 assert.deepEqual(result.rows.map(r=>[r.dimension,r.values[0]]),[['续约',1],['重要',2]])
 assert.equal(result.dimensionMode,'membership')
 assert.equal(result.coverage.objects,4)
 assert.deepEqual(result.missingFields,['tags'])
})
test('contains / overlaps 与度量 where 在真实多选成员上取交集',()=>{
 const records=[snapshot('a',[['标签','["重要","续约"]'],['金额',money('5')]]),snapshot('b',[['标签','["回访"]'],['金额',money('8')]]),snapshot('c',[['标签','["续约"]'],['金额',money('3')]])]
 const result=compute(records,{filters:[{field:'tags',op:'overlaps',values:['重要','回访']}],measures:[{...view.measures[0],where:{field:'tags',op:'contains',values:['重要']}}]})
 assert.deepEqual(result.rows[0]?.values,[{type:'money',currency:'CNY',decimal:'5'}])
})
test('基础时间窗和金额排序复用真实字段，不影响扫描覆盖与缺值披露',()=>{
 const result=compute([snapshot('a',[['阶段','新建'],['更新','2026-09-30T11:00:00.000Z'],['金额',money('9007199254740993.0001')]]),snapshot('b',[['阶段','完成'],['更新','2026-09-30T11:00:00.000Z'],['金额',money('9007199254740993.0002')]]),snapshot('old',[['阶段','完成'],['更新','2026-09-01T00:00:00.000Z'],['金额',money('999999999999999999')]])],{kind:'distribution',chart:'table',dimension:{field:'state',limit:10},window:{field:'changed',relative:'last-24h'},sort:{by:'measure',measureId:'sum',direction:'desc'},limit:10})
 assert.deepEqual(result.rows.map(r=>r.dimension),['完成','新建'])
 assert.equal(result.coverage.objects,3)
 assert.equal(result.dimensionMode,'records')
})
test('损坏 snapshot hash、scope、正文source、type 与 v1 富字段引用不能继续计算',()=>{
 const good=snapshot('a',[['金额',money('1')]])
 for(const damaged of [{...good,snapshotHash:'b'.repeat(64)},snapshot('a',[],{scope:'SOC'}),{...good,source:'other'},snapshot('a',[],{type:'other'})])assert.throws(()=>compute([damaged]),{code:'teloa/storage-corrupt'})
 assert.throws(()=>compute([good],{format:'teloa.business-view/v1',measures:[{id:'sum',label:'合计',aggregation:'sum',field:'amount'}]}),{code:'teloa/invalid-input'})
})
test('5000 个最大单条金额的汇总支持22位整数，无浮点溢出和假零',()=>{
 const records=Array.from({length:5000},(_,i)=>snapshot(String(i),[['金额',money('999999999999999999.9999')]]))
 assert.deepEqual(compute(records).rows[0]?.values,[{type:'money',currency:'CNY',decimal:'4999999999999999999999.5'}])
})
test('金额筛选比较精确值与显式币种，不将美元误当人民币',()=>{
 const records=[snapshot('a',[['金额',money('9007199254740993.0001')]]),snapshot('b',[['金额',money('9007199254740993.0002')]]),snapshot('c',[['金额',money('999999999999999999','USD')]])]
 const result=compute(records,{filters:[{field:'amount',op:'gte',values:[money('9007199254740993.0002')]}]})
 assert.deepEqual(result.rows[0]?.values,[{type:'money',currency:'CNY',decimal:'9007199254740993.0002'}])
})
test('旧v1视图直接在真实v2对象的基础字段计算，时间桶和overdue保持旧口径',()=>{
 const records=[snapshot('a',[['更新','2026-09-30T11:00:00.000Z']]),snapshot('b',[['更新',now]]),snapshot('missing',[])]
 const result=compute(records,{format:'teloa.business-view/v1',kind:'trend',chart:'line',dimension:{field:'changed',bucket:'hour',limit:10},window:{field:'changed',relative:'overdue'},measures:[{id:'count',label:'客户数',aggregation:'count'}],sort:{by:'dimension',direction:'asc'},limit:10})
 assert.deepEqual(result.rows.map(row=>[row.dimension,row.values[0]]),[['2026-09-30T11:00:00.000Z',1]])
 assert.deepEqual(result.missingFields,['changed'])
 assert.equal(result.coverage.objects,3)
})
test('多关联 contains / overlaps 可筛选与用于 count 条件，不能作为原ID分布图',()=>{
 const relation={format:'teloa.business-rich-field/v2',name:'customers',label:'客户',from:'原客户',required:false,type:'multi-reference',referenceType:'customer'}
 const records=[snapshot('a',[['原客户','["c1","c2"]']]),snapshot('b',[['原客户','["c2","c3"]']]),snapshot('c',[['原客户','["c4"]']])]
 const computeRelations=(override:Record<string,unknown>)=>api.computeBusinessViewV2({objectType:{...type,fields:[...type.fields,relation]},view:{...view,measures:[{id:'count',label:'数量',aggregation:'count'}],...override},snapshots:records,truncated:false,computedAt:now,scope,definitionHash:'a'.repeat(64),origin:'local',known:new Map([['customer',new Set(['c1','c2','c3','c4'])]])} as never)
 assert.deepEqual(computeRelations({filters:[{field:'customers',op:'overlaps',values:['c1','c4']}]}).rows[0]?.values,[2])
 assert.deepEqual(computeRelations({measures:[{id:'count',label:'数量',aggregation:'count',where:{field:'customers',op:'contains',values:['c2']}}]}).rows[0]?.values,[2])
 assert.throws(()=>computeRelations({kind:'distribution',chart:'bar',dimension:{field:'customers',limit:10},limit:10}),{code:'teloa/invalid-input'})
})
test('多关联统计不将缺失目标当有效成员，缺失披露保留',()=>{
 const relation={format:'teloa.business-rich-field/v2',name:'customers',label:'客户',from:'原客户',required:false,type:'multi-reference',referenceType:'customer'}
 const result=api.computeBusinessViewV2({objectType:{...type,fields:[...type.fields,relation]},view:{...view,measures:[{id:'count',label:'数量',aggregation:'count',where:{field:'customers',op:'contains',values:['c1']}}]},snapshots:[snapshot('a',[['原客户','["c1","missing"]']])],truncated:false,computedAt:now,scope,definitionHash:'a'.repeat(64),origin:'local',known:new Map([['customer',new Set(['c1'])]])} as never)
 assert.deepEqual(result.rows[0]?.values,[0]);assert.deepEqual(result.missingFields,['customers'])
})
