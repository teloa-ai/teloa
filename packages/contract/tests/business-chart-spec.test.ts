import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessChartSpec,businessChartSpecKeys,businessChartSpecLimits} from '../src/business-chart-spec.ts'

const bar={mark:'bar',encoding:{x:{field:'severity',type:'nominal'},y:{field:'n',type:'quantitative'}}}
const rejects=(spec:unknown,pattern:RegExp)=>assert.throws(()=>readBusinessChartSpec({engine:'vega-lite',spec}),(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'&&pattern.test((error as Error).message))

test('允许集内的柱图原样通过，返回的是副本',()=>{
 const input={engine:'vega-lite',spec:bar}
 const result=readBusinessChartSpec(input)
 assert.deepEqual(result,input)
 assert.notEqual(result.spec,bar)
})

test('五种图的允许写法都通过：折线带点、饼图 theta、面积 color、散点 size、tooltip 数组与聚合变换',()=>{
 for(const spec of [
  {mark:{type:'line',point:true},encoding:{x:{field:'day',type:'temporal',timeUnit:'yearmonthdate',axis:{format:'%m-%d'}},y:{field:'n',type:'quantitative',aggregate:'sum'}}},
  {mark:{type:'arc',innerRadius:40,tooltip:true},encoding:{theta:{field:'n',type:'quantitative'},color:{field:'severity',type:'nominal',sort:['high','medium','low']}}},
  {mark:'area',encoding:{x:{field:'day',type:'temporal'},y:{field:'n',type:'quantitative'},color:{field:'kind',type:'nominal',scale:{type:'ordinal'}}},width:320,height:200,title:'趋势'},
  {mark:'point',encoding:{x:{field:'a',type:'quantitative'},y:{field:'b',type:'quantitative'},size:{field:'c',type:'quantitative'},tooltip:[{field:'a',type:'quantitative'},{field:'b',type:'quantitative',title:'乙'}]}},
  {mark:'bar',transform:[{aggregate:[{op:'count',as:'n'}],groupby:['severity']},{window:[{op:'rank',as:'r'}],sort:[{field:'n',order:'descending'}]}],encoding:{x:{field:'severity',type:'nominal',sort:'-y'},y:{field:'n',type:'quantitative'}}},
 ])assert.deepEqual(readBusinessChartSpec({engine:'vega-lite',spec}).spec,spec)
})

test('外部数据与禁止键在任意深度被拒，reason 写明完整路径',()=>{
 rejects({...bar,data:{url:'https://evil.example/x.json'}},/spec\.data\.url/)
 rejects({...bar,encoding:{...bar.encoding,tooltip:{content:'data'}}},/spec\.encoding\.tooltip\.content/)
 rejects({...bar,usermeta:{a:1}},/spec\.usermeta/)
 rejects({...bar,transform:[{calculate:'datum.x*2',as:'y'}]},/spec\.transform\[0\]\.calculate/)
 rejects({...bar,encoding:{x:{field:'a',type:'nominal',axis:{labelExpr:'datum.label'}}}},/spec\.encoding\.x\.axis\.labelExpr/)
 rejects({...bar,encoding:{...bar.encoding,href:{field:'link',type:'nominal'}}},/spec\.encoding\.href/)
 rejects({...bar,encoding:{x:{field:'a',type:'nominal',scale:{type:'linear',values:[1]}}}},/spec\.encoding\.x\.scale\.values/)
 rejects({...bar,datasets:{a:[]}},/spec\.datasets/)
 rejects({...bar,config:{background:'red'}},/spec\.config/)
})

test('形如函数的字符串值一律拒绝',()=>{
 rejects({...bar,title:'datum => datum.x'},/spec\.title/)
 rejects({...bar,title:'function(){}'},/spec\.title/)
 rejects({...bar,encoding:{x:{field:'(a,b)=>a',type:'nominal'}}},/spec\.encoding\.x\.field/)
})

test('不在白名单内的键、类型与取值被拒',()=>{
 rejects({...bar,mark:'image'},/spec\.mark/)
 rejects({...bar,mark:{type:'text'}},/spec\.mark\.type/)
 rejects({...bar,encoding:{...bar.encoding,opacity:{value:0.5}}},/spec\.encoding\.opacity/)
 rejects({...bar,encoding:{x:{field:'a',type:'nominal',stack:true}}},/spec\.encoding\.x\.stack/)
 rejects({...bar,transform:[{groupby:['a']}]},/spec\.transform\[0\]/)
 rejects({encoding:bar.encoding},/mark/)
 assert.throws(()=>readBusinessChartSpec({engine:'echarts',spec:bar}),/teloa\/invalid-input|engine|vega-lite/)
 assert.throws(()=>readBusinessChartSpec({engine:'vega-lite',spec:bar,extra:1}),/extra/)
})

test('深度 ≤ 8、节点 ≤ 400、序列化 ≤ 16 KiB',()=>{
 let deep:unknown='x'
 for(let index=0;index<8;index++)deep={title:deep}
 rejects({...bar,title:deep},/深度/)
 const wide=Array.from({length:businessChartSpecLimits.nodes},(_,index)=>({field:'f'+index,type:'nominal'}))
 rejects({...bar,encoding:{...bar.encoding,tooltip:wide}},/节点/)
 rejects({...bar,title:'长'.repeat(6000)},/16 KiB|字节/)
 assert.deepEqual(businessChartSpecLimits,{depth:8,nodes:400,bytes:16384})
})

test('白名单键集逐字来自 Spike B 结论',()=>{
 assert.deepEqual([...businessChartSpecKeys.allowedTopLevel],['mark','encoding','transform','width','height','title'])
 assert.deepEqual([...businessChartSpecKeys.allowedMarkTypes],['bar','line','arc','area','point'])
 assert.deepEqual([...businessChartSpecKeys.allowedEncodingChannels],['x','y','color','theta','size','tooltip'])
 assert.deepEqual([...businessChartSpecKeys.allowedEncodingKeys],['field','type','timeUnit','aggregate','title','sort','scale','axis'])
 assert.deepEqual([...businessChartSpecKeys.allowedTransforms],['aggregate','timeUnit','fold','window','stack'])
 for(const key of ['data','url','values','datasets','content','usermeta','params','calculate','filter','expr','signal','labelExpr','config'])assert.ok((businessChartSpecKeys.forbiddenAnywhere as readonly string[]).includes(key),key)
})

test('聚合、时间单位、比例尺种类只认 Vega-Lite 合法枚举，轴格式只认 d3 数值或时间格式',()=>{
 const x=(extra:Record<string,unknown>)=>({...bar,encoding:{...bar.encoding,x:{field:'a',type:'temporal',...extra}}})
 for(const spec of [
  x({timeUnit:'yearmonth'}),x({timeUnit:'utcyearmonthdate'}),x({aggregate:'median'}),x({scale:{type:'symlog'}}),x({scale:{type:'utc'}}),
  x({axis:{format:',.2f'}}),x({axis:{format:'.0%'}}),x({axis:{format:'$,d'}}),x({axis:{format:'%Y-%m-%d'}}),x({axis:{format:'%H:%M'}}),x({axis:{format:'%%'}}),
 ])assert.deepEqual(readBusinessChartSpec({engine:'vega-lite',spec}).spec,spec)
 rejects(x({timeUnit:'fortnight'}),/spec\.encoding\.x\.timeUnit/)
 rejects(x({aggregate:'evil'}),/spec\.encoding\.x\.aggregate/)
 rejects(x({scale:{type:'quantize'}}),/spec\.encoding\.x\.scale\.type/)
 for(const format of ['"),alert(1),("  %%%','"),alert(1),("','%%%','<script>',' '.repeat(3)+'%Y'+'-'.repeat(40),'%Q%'])rejects(x({axis:{format}}),/spec\.encoding\.x\.axis\.format/)
})

test('先解析副本再校验：取值器与 toJSON 不能让校验与返回值不一致；spec 缺失给出准确原因',()=>{
 let reads=0
 const tricky={mark:'bar',get title(){return reads++?'datum => datum.x':'正常标题'}}
 const result=readBusinessChartSpec({engine:'vega-lite',spec:tricky})
 assert.equal(reads,1,'只读一次原对象')
 assert.equal(result.spec.title,'正常标题')
 const swapped={mark:'bar',toJSON:()=>({mark:'bar',data:{url:'https://evil.example/x.json'}})}
 rejects(swapped,/spec\.data\.url/)
 assert.throws(()=>readBusinessChartSpec({engine:'vega-lite',spec:undefined}),(error:unknown)=>/spec 必须是对象/.test((error as Error).message)&&!/16 KiB/.test((error as Error).message))
})
