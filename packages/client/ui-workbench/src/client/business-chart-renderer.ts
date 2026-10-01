import {readBusinessChartSpec,type BusinessWidgetCell,type BusinessWidgetColumn} from '@teloa/contract'
import {businessChartLocale,declaredTimeUnit,isPeriodicTimeUnit,periodicAxisFormat,periodicTickInterval,temporalAxisFormat,temporalDistinct,temporalGranularity,temporalTickStep} from './business-chart-locale.ts'

/**
 * 看板图表渲染（规格 §4.3，Spike B 结论）：Vega-Lite → Vega，`renderer:'svg'`、`expr:expressionInterpreter`（AST 解释，不做动态代码生成）。
 * 声明在进渲染前**再过一次**契约白名单（`readBusinessChartSpec`，纵深）：危险键在这里就被拒，图表库根本不加载。
 * 数据只由平台注入 `data.values`，颜色只由平台从 `--teloa-*` 令牌注入 `config`；外部加载器一律拒绝，零网络请求。
 * 图表库不进首屏：只经宿主模块系统的 `require.async` 取回同包分块 `client.chart.js`（见 `business-chart-vega.ts`）。
 * 悬停提示沿用 Vega 默认处理器（写容器的 `title` 属性，纯文本），不装把提示写成标记串的 vega-tooltip。
 * 时间轴由平台按界面语言本地化（规格 §6，见 `business-chart-locale.ts`）：声明里时间轴的 `axis.format` 被覆盖，数值轴的照旧。
 * 点击下钻（二期规格 §4.4）：调用方给了 `onDatum` 才挂 Vega 视图的 click 监听、标记改成手形指针；交出去的数据行由调用方按不可信输入核对。
 * 只收图形项（`item.mark.role==='mark'`），坐标轴刻度与图例的 datum 形如 `{value,label,index}`，不交出去；
 * 折线 / 面积的一整条线只是一个图形项、datum 是该系列第一个点，所以下钻时平台给它加点标记（Vega-Lite `point`），只收点上的点击。
 */

export type BusinessChartTheme={accent:string;good:string;info:string;warn:string;muted:string;text:string;border:string}
export type BusinessChartView={initialize(el:Element):BusinessChartView;runAsync():Promise<unknown>;toSVG():Promise<string>;finalize():void;addEventListener(type:'click',handler:(event:unknown,item:unknown)=>void):unknown}
export type BusinessChartRuntime={
 compile(spec:Record<string,unknown>):{spec:unknown}
 parse(spec:unknown,config:undefined,options:{ast:true}):unknown
 View:new(runtime:unknown,options:Record<string,unknown>)=>BusinessChartView
 expressionInterpreter:unknown
}

/** 宿主模块系统注入客户端工厂的 `require`（`__ModuleLoader__.load({factory:(require)=>…})`）；这里只用它按需取同包分块。 */
declare const require:{async(specifier:'./client.chart.js'):Promise<unknown>}
export const loadBusinessChartRuntime=async():Promise<BusinessChartRuntime>=>await require.async('./client.chart.js') as BusinessChartRuntime

const tokens:Record<keyof BusinessChartTheme,string>={accent:'--teloa-accent',good:'--teloa-good',info:'--teloa-info',warn:'--teloa-warn',muted:'--teloa-muted',text:'--teloa-text',border:'--teloa-border'}
/** 从图表容器读令牌：深浅色由 `body[data-ds-dark-theme]` 切换，容器按继承拿到当前取值。 */
export function businessChartTheme(el:Element):BusinessChartTheme{
 const style=getComputedStyle(el)
 return Object.fromEntries(Object.entries(tokens).map(([key,name])=>[key,style.getPropertyValue(name).trim()])) as BusinessChartTheme
}

/** 外部加载一律拒绝：白名单已不放 url/href/image，这里再兜一层，漏了也不会发请求。 */
const refuse=()=>Promise.reject(Error('看板图表不加载外部资源。'))
const loader={load:refuse,sanitize:refuse,http:refuse,file:refuse}

type ChartOptions={label:string;width:number;locale:string;pointer?:boolean}
/** Vega 运行时按 vega-time 的单位名取时间间隔（`hours`/`minutes`，不是 `hour`/`minute`），取不到时刻度计算会抛错。 */
const tickIntervals={year:'year',month:'month',day:'day',hour:'hours',minute:'minutes'} as const
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)

/**
 * x / y 上 `type:'temporal'` 的编码：
 * - 具体日期型（未写时间单位，或以 `year` / `utcyear` 开头）：`axis.format`/`formatType` 按「语言 × 粒度」覆盖，
 *   刻度按粒度的时间间隔出（`tickCount:{interval,step}`），跨天与步长按数据算；
 * - 周期型（星期几、月份、季度……，年份被 Vega-Lite 折叠）：按周期表换格式、刻度间隔取周期本身（不带步长），不按数据算跨天与步长；
 *   表外组合保持一期行为（只带语言）。
 * 刻度间隔只有时间 / utc 比例尺认；声明成序数类比例尺的时间轴只换格式。
 * utc 时比例尺统一为 utc（未声明或声明成 time 时补齐），刻度与格式同在 utc。
 */
function localizeTemporalAxes(spec:Record<string,unknown>,values:readonly Record<string,unknown>[],size:{x:number;y:number},locale:string):Record<string,unknown>{
 if(!isRecord(spec.encoding))return spec
 const encoding={...spec.encoding}
 for(const key of ['x','y'] as const){
  const channel=encoding[key]
  if(!isRecord(channel)||channel.type!=='temporal'||typeof channel.field!=='string')continue
  // 字段由 timeUnit 变换产出时，数据里的原始取值在变换的来源字段上。
  const from=Array.isArray(spec.transform)?spec.transform.filter(isRecord).find(item=>item.as===channel.field&&typeof item.timeUnit==='string'&&typeof item.field==='string')?.field as string|undefined:undefined
  const column=values.map(row=>row[from??channel.field as string])
  const {unit,utc}=temporalGranularity(spec,channel.field,column)
  const scale=isRecord(channel.scale)?channel.scale:undefined
  const scaleType=scale?.type
  const utcScale=utc&&(scaleType===undefined||scaleType==='time')?{scale:{...scale,type:'utc'}}:{}
  const axis=isRecord(channel.axis)?channel.axis:{}
  // Vega-Lite 的 axis.formatType 只认 number / time（'utc' 会被当作自定义格式丢弃）：utc 时不写，由 utc 比例尺按 utc 格式化。
  const formatType=utc?{}:{formatType:'time'}
  const timeUnit=declaredTimeUnit(spec,channel.field)
  const timeScale=scaleType===undefined||scaleType==='time'||scaleType==='utc'
  if(timeUnit!==undefined&&isPeriodicTimeUnit(timeUnit)){
   const format=periodicAxisFormat(locale,timeUnit),interval=periodicTickInterval(timeUnit)
   encoding[key]={...channel,...utcScale,...(format===undefined?{}:{axis:{...axis,format,...formatType,...(timeScale&&interval?{tickCount:{interval}}:{})}})}
   continue
  }
  encoding[key]={
   ...channel,
   ...utcScale,
   axis:{
    ...axis,
    format:temporalAxisFormat(locale,unit,temporalDistinct(column,'day',utc)>1),
    ...formatType,
    ...(timeScale?{tickCount:{interval:tickIntervals[unit],step:temporalTickStep(temporalDistinct(column,unit,utc),size[key])}}:{}),
   },
  }
 }
 return {...spec,encoding}
}

/** 声明 → 平台补齐后的 Vega-Lite 规范：先过白名单，再注入数据、尺寸、主题与界面语言（声明里这些键一律不得出现）。 */
export function businessChartVegaLiteSpec(chart:unknown,columns:readonly BusinessWidgetColumn[],rows:readonly (readonly BusinessWidgetCell[])[],theme:BusinessChartTheme,options:ChartOptions):Record<string,unknown>{
 const {spec:declared}=readBusinessChartSpec(chart)
 const markType=typeof declared.mark==='string'?declared.mark:isRecord(declared.mark)?declared.mark.type:undefined
 const spec=options.pointer&&(markType==='line'||markType==='area')?{...declared,mark:{...(isRecord(declared.mark)?declared.mark:{type:markType}),point:true}}:declared
 const values=rows.map(row=>Object.fromEntries(columns.map((column,index)=>[column.name,row[index]??null])))
 const width=Math.max(120,Math.floor(options.width)),height=typeof spec.height==='number'?spec.height:220
 return {
  ...localizeTemporalAxes(spec,values,{x:width,y:height},options.locale),
  data:{values},
  width,
  height,
  autosize:{type:'fit',contains:'padding'},
  background:'transparent',
  description:options.label,
  config:{
   locale:businessChartLocale(options.locale),
   range:{category:[theme.accent,theme.good,theme.info,theme.warn,theme.muted],ramp:[theme.border,theme.accent]},
   mark:{color:theme.accent,...(options.pointer?{cursor:'pointer'}:{})},
   axis:{labelColor:theme.muted,titleColor:theme.text,domainColor:theme.border,tickColor:theme.border,gridColor:theme.border},
   legend:{labelColor:theme.muted,titleColor:theme.text},
   title:{color:theme.text},
   view:{stroke:null},
  },
 }
}

/** 白名单通过后才取图表库；返回未挂载的视图（页面里再 `initialize`，测试里可直接 `toSVG`）。 */
export async function businessChartView(chart:unknown,columns:readonly BusinessWidgetColumn[],rows:readonly (readonly BusinessWidgetCell[])[],theme:BusinessChartTheme,options:ChartOptions,runtime:()=>Promise<BusinessChartRuntime>=loadBusinessChartRuntime):Promise<BusinessChartView>{
 const spec=businessChartVegaLiteSpec(chart,columns,rows,theme,options)
 const lib=await runtime()
 return new lib.View(lib.parse(lib.compile(spec).spec,undefined,{ast:true}),{renderer:'svg',expr:lib.expressionInterpreter,loader,hover:true})
}

/**
 * 画进容器：根 svg 带图表名称（`aria-label`），Vega 挂在外层容器上的同名朗读属性拿掉，避免读两遍。
 * 返回释放函数，组件卸载、主题或界面语言切换重画前调用（`finalize` 一并摘掉点击监听）。
 */
export async function renderChart(el:HTMLElement,chart:unknown,columns:readonly BusinessWidgetColumn[],rows:readonly (readonly BusinessWidgetCell[])[],theme:BusinessChartTheme,label:string,options:{locale:string;onDatum?:(datum:Record<string,unknown>)=>void},runtime:()=>Promise<BusinessChartRuntime>=loadBusinessChartRuntime):Promise<()=>void>{
 const {onDatum}=options
 const view=await businessChartView(chart,columns,rows,theme,{label,width:el.clientWidth,locale:options.locale,...(onDatum?{pointer:true}:{})},runtime)
 if(onDatum)view.addEventListener('click',(_event,item)=>{
  if(!isRecord(item)||!isRecord(item.mark)||item.mark.role!=='mark'||item.mark.marktype==='line'||item.mark.marktype==='area')return
  if(isRecord(item.datum))onDatum(item.datum)
 })
 view.initialize(el)
 await view.runAsync()
 for(const name of ['role','aria-roledescription','aria-label'])el.removeAttribute(name)
 const svg=el.querySelector('svg')
 svg?.setAttribute('role','graphics-document')
 svg?.setAttribute('aria-label',label)
 return ()=>view.finalize()
}
