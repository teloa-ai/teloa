import test from 'node:test'
import assert from 'node:assert/strict'
import {compile} from 'vega-lite'
import {parse,View} from 'vega'
import {expressionInterpreter} from 'vega-interpreter'
import {readFile} from 'node:fs/promises'
import {businessChartView,businessChartVegaLiteSpec,renderChart,type BusinessChartRuntime} from '../src/client/business-chart-renderer.ts'

const theme={accent:'#a34529',good:'#2f6c51',info:'#44617e',warn:'#9a6b16',muted:'#6f7768',text:'#1d2119',border:'#d9ddd2'}
const columns=[{name:'severity',type:'text' as const},{name:'n',type:'number' as const}]
const rows=[['high',3],['low',5]]
const chart={engine:'vega-lite',spec:{mark:'bar',encoding:{x:{field:'severity',type:'nominal'},y:{field:'n',type:'quantitative'}}}}
const runtime:BusinessChartRuntime={compile,parse,View,expressionInterpreter} as unknown as BusinessChartRuntime

test('危险键在渲染前被契约白名单再拦一次，不触达图表库',async()=>{
 let loaded=0
 const spy=async()=>{loaded++;return runtime}
 const el={querySelector:()=>null,removeAttribute:()=>{}} as unknown as HTMLElement
 for(const spec of [
  {...chart.spec,data:{url:'https://example.com/a.json'}},
  {...chart.spec,encoding:{...chart.spec.encoding,href:{field:'severity'}}},
  {...chart.spec,params:[{name:'p',expr:'1'}]},
  {...chart.spec,mark:'image'},
 ]){
  await assert.rejects(renderChart(el,{engine:'vega-lite',spec},columns,rows,theme,'告警 图表',{locale:'zh-CN'},spy),(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input')
  assert.throws(()=>businessChartVegaLiteSpec({engine:'vega-lite',spec},columns,rows,theme,{label:'x',width:300,locale:'zh-CN'}))
 }
 assert.equal(loaded,0)
})

test('平台注入数据、主题与自适应宽度；声明里不出现的键由平台补齐',()=>{
 const spec=businessChartVegaLiteSpec(chart,columns,rows,theme,{label:'告警 图表',width:320,locale:'zh-CN'})
 assert.deepEqual(spec.data,{values:[{severity:'high',n:3},{severity:'low',n:5}]})
 assert.equal(spec.width,320)
 assert.equal(spec.background,'transparent')
 assert.deepEqual((spec.config as {range:{category:string[]}}).range.category,[theme.accent,theme.good,theme.info,theme.warn,theme.muted])
 assert.equal((spec.config as {mark:{color:string}}).mark.color,theme.accent)
})

test('合法规范在解释器模式下渲染成 SVG，根节点是 svg',async()=>{
 const view=await businessChartView(chart,columns,rows,theme,{label:'告警 图表',width:300,locale:'zh-CN'},async()=>runtime)
 const svg=await view.toSVG()
 assert.match(svg,/^<svg[\s>]/)
 assert.match(svg,/aria-label="severity: high; n: 3"/)
 view.finalize()
})

test('挂到页面时根 svg 带图表名称，外层容器不重复朗读',async()=>{
 const attributes=new Map<string,string>(),container=new Map<string,string>([['role','graphics-document'],['aria-label','x']])
 const svg={setAttribute:(key:string,value:string)=>attributes.set(key,value)}
 const el={querySelector:(selector:string)=>selector==='svg'?svg:null,removeAttribute:(key:string)=>container.delete(key),clientWidth:300} as unknown as HTMLElement
 class FakeView{initialize(){return this}async runAsync(){return this}finalize(){}}
 const fake={compile,parse,View:FakeView,expressionInterpreter} as unknown as BusinessChartRuntime
 const dispose=await renderChart(el,chart,columns,rows,theme,'告警 图表',{locale:'zh-CN'},async()=>fake)
 assert.equal(attributes.get('aria-label'),'告警 图表')
 assert.equal(attributes.get('role'),'graphics-document')
 assert.equal(container.has('role'),false)
 assert.equal(container.has('aria-label'),false)
 dispose()
})

test('点击下钻：给了 onDatum 才挂点击监听、标记改成手形指针；点到图形把数据行交出去，点到空白不交',async()=>{
 const el={querySelector:()=>null,removeAttribute:()=>{},clientWidth:300} as unknown as HTMLElement
 const listeners:Array<[string,(event:unknown,item:unknown)=>void]>=[]
 let compiled:{config?:{mark?:{cursor?:string}}}|undefined
 class FakeView{initialize(){return this}async runAsync(){return this}finalize(){}addEventListener(type:string,handler:(event:unknown,item:unknown)=>void){listeners.push([type,handler]);return this}}
 const fake={compile:(spec:Record<string,unknown>)=>{const out=compile(spec as never);compiled=out.spec as never;return out},parse,View:FakeView,expressionInterpreter} as unknown as BusinessChartRuntime
 const seen:unknown[]=[]
 await renderChart(el,chart,columns,rows,theme,'告警 图表',{locale:'zh-CN',onDatum:datum=>seen.push(datum)},async()=>fake)
 assert.equal(compiled?.config?.mark?.cursor,'pointer','编译后的 Vega 规范带手形指针')
 assert.deepEqual(listeners.map(([type])=>type),['click'])
 listeners[0]![1]({},{mark:{role:'mark',marktype:'rect'},datum:{severity:'high',n:3}})
 listeners[0]![1]({},null)
 listeners[0]![1]({},{mark:{role:'mark',marktype:'rect'},datum:'x'})
 // 坐标轴刻度与图例项的 datum 形如 {value,label,index}：不是图形，不交出去。
 listeners[0]![1]({},{mark:{role:'axis-label',marktype:'text'},datum:{value:'high',label:'high',index:0}})
 listeners[0]![1]({},{mark:{role:'legend-symbol',marktype:'symbol'},datum:{value:'high',label:'high',index:0}})
 listeners[0]![1]({},{datum:{severity:'low',n:5}})
 assert.deepEqual(seen,[{severity:'high',n:3}])
 listeners.length=0
 await renderChart(el,chart,columns,rows,theme,'告警 图表',{locale:'zh-CN'},async()=>fake)
 assert.equal(listeners.length,0)
 assert.equal(compiled?.config?.mark?.cursor,undefined)
 assert.equal((businessChartVegaLiteSpec(chart,columns,rows,theme,{label:'x',width:300,locale:'zh-CN'}).config as {mark:Record<string,unknown>}).mark.cursor,undefined)
})

/** 真实 Vega 视图（不挂 DOM）：跑完数据流后从场景图里取出真实图形项，交给挂上的点击监听。 */
async function clickProbe(spec:Record<string,unknown>,columnsIn:readonly {name:string;type:'text'|'number'}[],rowsIn:unknown[][]){
 const listeners:Array<(event:unknown,item:unknown)=>void>=[]
 let compiled:Record<string,unknown>|undefined
 let probe:InstanceType<typeof View>|undefined
 class ProbeView extends View{
  constructor(runtime:never,options:never){super(runtime,options);probe=this}
  override initialize(){return this}
  override addEventListener(type:string,handler:Parameters<View['addEventListener']>[1]){if(type==='click')listeners.push(handler as never);return this}
 }
 const real={compile:(input:Record<string,unknown>)=>{const out=compile(input as never);compiled=out.spec as never;return out},parse,View:ProbeView,expressionInterpreter} as unknown as BusinessChartRuntime
 const el={querySelector:()=>null,removeAttribute:()=>{},clientWidth:300} as unknown as HTMLElement
 const seen:Record<string,unknown>[]=[]
 await renderChart(el,{engine:'vega-lite',spec},columnsIn,rowsIn as never,theme,'图表',{locale:'zh-CN',onDatum:datum=>seen.push(datum)},async()=>real)
 type Scene={marktype?:string;role?:string;items?:Scene[];mark?:Scene;datum?:unknown}
 const items:Scene[]=[]
 const walk=(node:Scene)=>{for(const child of node.items??[]){if(child.mark)items.push(child);walk(child)}}
 walk((probe as unknown as {scenegraph():{root:Scene}}).scenegraph().root)
 for(const item of items)for(const listener of listeners)listener({},item)
 return {seen,items,compiled:compiled!}
}
const hostColumns=[{name:'host',type:'text' as const},{name:'n',type:'number' as const}]
const hostRows=[['web-1',3],['web-2',5],['db-1',2]]

test('点击下钻只收图形项：点坐标轴刻度与图例不交数据行（真实场景图）',async()=>{
 const {seen,items}=await clickProbe({mark:'bar',encoding:{x:{field:'host',type:'nominal'},y:{field:'n',type:'quantitative'},color:{field:'host',type:'nominal'}}},hostColumns,hostRows)
 assert.ok(items.some(item=>item.mark?.role==='axis-label'),'场景图里有坐标轴刻度')
 assert.ok(items.some(item=>item.mark?.role==='legend-label'),'场景图里有图例')
 assert.deepEqual(seen.map(row=>row.host).sort(),['db-1','web-1','web-2'],'只有三根柱子被交出')
})

test('折线 / 面积图声明了下钻：平台加点标记，只收点上的点击，跳到被点的那个类别',async()=>{
 for(const mark of ['line',{type:'area'},{type:'line',point:false}] as const){
  const spec={mark,encoding:{x:{field:'host',type:'nominal'},y:{field:'n',type:'quantitative'}}}
  const vegaLite=businessChartVegaLiteSpec({engine:'vega-lite',spec},hostColumns,hostRows as never,theme,{label:'x',width:300,locale:'zh-CN',pointer:true})
  assert.equal((vegaLite.mark as {point?:unknown}).point,true,JSON.stringify(mark)+' 加点标记')
  const {seen,items}=await clickProbe(spec,hostColumns,hostRows)
  assert.ok(items.some(item=>item.mark?.marktype==='symbol'&&item.mark.role==='mark'),'场景图里有点标记')
  assert.ok(items.some(item=>item.mark?.marktype==='line'||item.mark?.marktype==='area'),'线 / 面本身也在场景图里')
  assert.deepEqual(seen.map(row=>row.host).sort(),['db-1','web-1','web-2'],JSON.stringify(mark)+'：每个点交出自己的类别，线 / 面本身不交')
 }
 // 没声明下钻（不给 onDatum）：声明原样，不加点。
 const plain=businessChartVegaLiteSpec({engine:'vega-lite',spec:{mark:'line',encoding:{x:{field:'host',type:'nominal'},y:{field:'n',type:'quantitative'}}}},hostColumns,hostRows as never,theme,{label:'x',width:300,locale:'zh-CN'})
 assert.equal(plain.mark,'line')
 // 柱状图不加点。
 const bar=businessChartVegaLiteSpec(chart,columns,rows,theme,{label:'x',width:300,locale:'zh-CN',pointer:true})
 assert.equal(bar.mark,'bar')
})

test('图表库只在分块里：渲染器对图表库只有类型引用，运行时经宿主按需取回',async()=>{
 const source=await readFile(new URL('../src/client/business-chart-renderer.ts',import.meta.url),'utf8')
 assert.doesNotMatch(source,/^import\s+(?!type\b)[^;]*from\s+'vega/m)
 assert.match(source,/require\.async\('\.\/client\.chart\.js'\)/)
 assert.doesNotMatch(source,/innerHTML|DOMParser|new Function|\beval\(/)
})

/** 一期验收「按严重度趋势折线图」的写法：日粒度、模型自带时间轴 `axis.format:'%m-%d'`、数值轴 `',.0f'`。 */
const trend={engine:'vega-lite',spec:{mark:{type:'line',point:true},encoding:{
 x:{field:'day',type:'temporal',timeUnit:'yearmonthdate',title:'日期',axis:{format:'%m-%d'}},
 y:{field:'n',type:'quantitative',aggregate:'sum',title:'告警数',axis:{format:',.0f'}},
 color:{field:'severity',type:'nominal'},
}}}
const trendColumns=[{name:'day',type:'datetime' as const},{name:'severity',type:'text' as const},{name:'n',type:'number' as const}]
const trendRows=Array.from({length:14},(_,day)=>['high','low'].map((severity,index)=>[new Date(2026,8,1+day).toISOString(),severity,day+index])).flat()
type VegaAxis={scale:string;grid?:boolean;format?:string;formatType?:string;tickCount?:unknown}
const axes=(locale:string,chart:unknown=trend,columnsIn=trendColumns,rowsIn:unknown[][]=trendRows,width=300)=>{
 const compiled=compile(businessChartVegaLiteSpec(chart,columnsIn,rowsIn as never,theme,{label:'告警 图表',width,locale}) as never).spec as {config:{locale:{time:{months:string[]}}};axes:VegaAxis[]}
 return {compiled,x:compiled.axes.find(axis=>axis.scale==='x'&&!axis.grid)!,y:compiled.axes.find(axis=>axis.scale==='y'&&!axis.grid)!}
}

const xLabels=(svg:string)=>{
 const group=svg.match(/<g[^>]*aria-roledescription="axis" aria-label="X-axis[\s\S]*?role-axis-label[\s\S]*?<\/g>/)
 assert.ok(group,'找到 x 轴标签组')
 // 只取可见标签：labelOverlap 藏起来的标签在 SVG 里是 opacity="0"。
 return [...group[0].matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].filter(match=>!/opacity="0"/.test(match[1]!)).map(match=>match[2]!)
}

test('时间轴按界面语言：编译后的 Vega 规范带 locale，日粒度格式覆盖声明里的 %m-%d，刻度按天；数值轴格式照旧',()=>{
 const {compiled,x,y}=axes('zh-CN')
 assert.match(compiled.config.locale.time.months[0]!,/1.*月/)
 assert.equal(x.format,'%-m月%-d日')
 assert.equal(x.formatType,'time')
 assert.deepEqual(x.tickCount,{interval:'day',step:4})
 assert.equal(y.format,',.0f')
 assert.equal((y.tickCount as {interval?:string}).interval,undefined)
 assert.equal(axes('en').x.format,'%b %-d')
 assert.equal(axes('de').x.format,'%-d. %b')
 // 声明原件不被改写（平台补齐的是副本）。
 assert.equal(trend.spec.encoding.x.axis.format,'%m-%d')
})

test('utc 粒度用 utc 比例尺格式化与出刻度；时间轴声明成序数比例尺时不设按时间间隔的刻度',async()=>{
 const utc={engine:'vega-lite',spec:{mark:'line',encoding:{x:{field:'day',type:'temporal',timeUnit:'utcyearmonth'},y:{field:'n',type:'quantitative'}}}}
 const monthly=[['2026-07-01T00:00:00Z','high',1],['2026-08-01T00:00:00Z','high',2],['2026-09-01T00:00:00Z','high',3]]
 const {compiled,x}=axes('ja',utc,trendColumns,monthly,120)
 assert.equal(x.format,'%Y年%-m月')
 assert.equal(x.formatType,undefined)
 assert.equal((compiled as unknown as {scales:{name:string;type:string}[]}).scales.find(scale=>scale.name==='x')?.type,'utc')
 assert.deepEqual(x.tickCount,{interval:'month',step:2})
 const view=await businessChartView(utc,trendColumns,monthly,theme,{label:'告警 图表',width:120,locale:'ja'},async()=>runtime)
 const svg=await view.toSVG()
 view.finalize()
 assert.deepEqual(xLabels(svg),['2026年7月','2026年9月'])
 const ordinal={engine:'vega-lite',spec:{...trend.spec,encoding:{...trend.spec.encoding,x:{field:'day',type:'temporal',timeUnit:'yearmonthdate',scale:{type:'ordinal'}}}}}
 assert.equal(axes('ko',ordinal).x.format,'%-m월 %-d일')
 assert.equal((axes('ko',ordinal).x.tickCount as {interval?:string}).interval,undefined)
 const ordinalView=await businessChartView(ordinal,trendColumns,trendRows,theme,{label:'告警 图表',width:300,locale:'ko'},async()=>runtime)
 const ordinalLabels=xLabels(await ordinalView.toSVG())
 ordinalView.finalize()
 assert.equal(ordinalLabels[0],'9월 1일')
})

test('重复刻度回归：跨 2 天、每小时一行、按天聚合 → x 轴每天一个刻度，不重复；英文不出现 AM/PM',async()=>{
 const hourly=Array.from({length:48},(_,hour)=>[new Date(2026,8,1,hour).toISOString(),'high',hour%5])
 const chart={engine:'vega-lite',spec:{...trend.spec,encoding:{...trend.spec.encoding,color:undefined}}}
 delete (chart.spec.encoding as Record<string,unknown>).color
 for(const [locale,expected] of [['en',['Sep 1','Sep 2']],['zh-CN',['9月1日','9月2日']],['ja',['9月1日','9月2日']],['de',['1. Sep','2. Sep']]] as const){
  const view=await businessChartView(chart,trendColumns,hourly,theme,{label:'告警 图表',width:300,locale},async()=>runtime)
  const svg=await view.toSVG()
  view.finalize()
  const labels=xLabels(svg)
  assert.deepEqual(labels,expected,locale)
  assert.equal(new Set(labels).size,labels.length,locale)
  assert.doesNotMatch(svg,/\b(AM|PM)\b/,locale)
 }
})

test('小时粒度跨两天：刻度带月-日，不出现重复的 00:00；同一天内只写时:分',async()=>{
 const chart={engine:'vega-lite',spec:{mark:'line',encoding:{x:{field:'day',type:'temporal'},y:{field:'n',type:'quantitative'}}}}
 const hourly=Array.from({length:48},(_,hour)=>[new Date(2026,8,1,hour).toISOString(),'high',hour%5])
 // 刻度为 9/1 00:00、12:00、9/2 00:00、12:00 四个；宽 300 时带日期的标签较长，labelOverlap 藏掉两个，可见的是下面两个。
 for(const [locale,expected] of [['en',['Sep 1 00:00','Sep 2 12:00']],['zh-CN',['9月1日 00:00','9月2日 12:00']]] as const){
  assert.equal(axes(locale,chart,trendColumns,hourly).x.format,locale==='en'?'%b %-d %H:%M':'%-m月%-d日 %H:%M')
  assert.deepEqual(axes(locale,chart,trendColumns,hourly).x.tickCount,{interval:'hours',step:12})
  const view=await businessChartView(chart,trendColumns,hourly,theme,{label:'告警 图表',width:300,locale},async()=>runtime)
  const labels=xLabels(await view.toSVG())
  view.finalize()
  assert.deepEqual(labels,expected,locale)
  assert.equal(new Set(labels).size,labels.length,locale)
  assert.equal(labels.filter(label=>label==='00:00').length,0,locale)
 }
 const sameDay=hourly.slice(0,24)
 assert.equal(axes('en',chart,trendColumns,sameDay).x.format,'%H:%M')
 const view=await businessChartView(chart,trendColumns,sameDay,theme,{label:'告警 图表',width:300,locale:'en'},async()=>runtime)
 const labels=xLabels(await view.toSVG())
 view.finalize()
 assert.ok(labels.every(label=>/^\d\d:\d\d$/.test(label)),labels.join(','))
 assert.equal(new Set(labels).size,labels.length)
 // 分粒度同样走 vega-time 的单位名（minutes），能渲染出刻度。
 const minutes={engine:'vega-lite',spec:{mark:'line',encoding:{x:{field:'day',type:'temporal',timeUnit:'yearmonthdatehoursminutes'},y:{field:'n',type:'quantitative'}}}}
 const minuteView=await businessChartView(minutes,trendColumns,Array.from({length:30},(_,minute)=>[new Date(2026,8,1,9,minute).toISOString(),'high',minute]),theme,{label:'告警 图表',width:300,locale:'en'},async()=>runtime)
 const minuteLabels=xLabels(await minuteView.toSVG())
 minuteView.finalize()
 assert.equal(minuteLabels[0],'09:00')
})

test('周期型时间单位（年份被折叠）按周期表出标签，不套具体日期：星期几 / 月 / 季度 / 每月第几日 / 时',async()=>{
 const columnsIn=[{name:'t',type:'datetime' as const},{name:'n',type:'number' as const}]
 const data:Record<string,unknown[][]>={
  day:Array.from({length:14},(_,index)=>[new Date(2026,8,6+index).toISOString(),index]),
  month:Array.from({length:12},(_,index)=>[new Date(2026,index,1).toISOString(),index]),
  quarter:Array.from({length:12},(_,index)=>[new Date(2026,index,1).toISOString(),index]),
  date:Array.from({length:31},(_,index)=>[new Date(2026,0,1+index).toISOString(),index]),
  // 21 天逐小时：按「时」折叠后只有 24 个取值，不能按原始数据算成跨天、算步长。
  hours:Array.from({length:21*24},(_,index)=>[new Date(2026,8,1,index).toISOString(),index%7]),
 }
 const expected:Record<string,Record<string,string[]>>={
  // 期望为宽 300 时的可见标签：刻度按周期逐个出（星期 7 个、月 12 个……），放不下时由 labelOverlap 隔一个藏一个。
  day:{'zh-CN':['周日','周一','周二','周三','周四','周五','周六'],en:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],fr:['dim.','mar.','jeu.','sam.']},
  month:{'zh-CN':['1月','3月','5月','7月','9月','11月'],en:['Jan','Mar','May','Jul','Sep','Nov'],fr:['janv.','mai','sept.']},
  quarter:{'zh-CN':['第1季度','第2季度','第3季度','第4季度'],en:['Q1','Q2','Q3','Q4'],fr:['T1','T2','T3','T4']},
  date:{'zh-CN':['1日','5日','9日','13日','17日','21日','25日','29日'],en:['1','5','9','13','17','21','25','29'],fr:['1','5','9','13','17','21','25','29']},
  hours:{'zh-CN':['00:00','08:00','16:00'],en:['00:00','08:00','16:00'],fr:['00:00','08:00','16:00']},
 }
 for(const [unit,rowsIn] of Object.entries(data))for(const locale of ['zh-CN','en','fr']){
  const chart={engine:'vega-lite',spec:{mark:'line',encoding:{x:{field:'t',type:'temporal',timeUnit:unit,axis:{format:'%m-%d'}},y:{field:'n',type:'quantitative',aggregate:'sum'}}}}
  const view=await businessChartView(chart,columnsIn,rowsIn as never,theme,{label:'告警 图表',width:300,locale},async()=>runtime)
  const svg=await view.toSVG()
  view.finalize()
  const labels=xLabels(svg)
  assert.deepEqual(labels,expected[unit]![locale],unit+' '+locale)
  // 含被藏起来的：每个刻度的文本都不重复（一期「星期几」会按 12 小时出刻度：周日、周日、周一……）。
  const all=[...svg.match(/aria-label="X-axis[\s\S]*?role-axis-label[\s\S]*?<\/g>/)![0].matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(match=>match[1])
  assert.equal(new Set(all).size,all.length,unit+' '+locale)
 }
})

test('utc 时间单位统一用 utc 比例尺：声明里显式写 time 也改成 utc',()=>{
 const chart={engine:'vega-lite',spec:{mark:'line',encoding:{x:{field:'day',type:'temporal',timeUnit:'utcyearmonthdate',scale:{type:'time'}},y:{field:'n',type:'quantitative'}}}}
 const {compiled,x}=axes('en',chart)
 assert.equal((compiled as unknown as {scales:{name:string;type:string}[]}).scales.find(scale=>scale.name==='x')?.type,'utc')
 assert.equal(x.formatType,undefined)
 const periodic={engine:'vega-lite',spec:{mark:'line',encoding:{x:{field:'day',type:'temporal',timeUnit:'utcmonth',scale:{type:'time'}},y:{field:'n',type:'quantitative'}}}}
 assert.equal((axes('en',periodic).compiled as unknown as {scales:{name:string;type:string}[]}).scales.find(scale=>scale.name==='x')?.type,'utc')
})
