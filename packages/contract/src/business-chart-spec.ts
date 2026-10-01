import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'

/**
 * 组件图表规范（规格 §4.3）：Vega-Lite 子集，由平台在 vega-interpreter（AST 解释、无 `Function`）下渲染，
 * 数据由平台注入 `data.values`，颜色由平台令牌注入 `config`，声明里一律不得出现。
 * 键集逐字来自 Spike B 结论（`design specification` §3.1/§3.2）。
 */
export type BusinessChartSpec={engine:'vega-lite';spec:Record<string,unknown>}

/**
 * 白名单语义：不在允许集内的键一律拒绝；`forbiddenAnywhere` 是在任意深度额外做的显式拦截（`axis.format` 除外）。
 * `allowedMarkKeys` / `allowedTransformKeys` 是结论 §3.1 里 mark 对象与 transform 项的允许键，一并导出供客户端对照。
 */
export const businessChartSpecKeys={
 allowedTopLevel:['mark','encoding','transform','width','height','title'],
 allowedMarkTypes:['bar','line','arc','area','point'],
 allowedMarkKeys:['type','point','interpolate','tooltip','innerRadius'],
 allowedEncodingChannels:['x','y','color','theta','size','tooltip'],
 allowedEncodingKeys:['field','type','timeUnit','aggregate','title','sort','scale','axis'],
 allowedTransforms:['aggregate','timeUnit','fold','window','stack'],
 allowedTransformKeys:['aggregate','groupby','timeUnit','field','as','fold','window','stack','sort','offset'],
 forbiddenAnywhere:[
  'data','url','values','datasets','content','usermeta','params','selection','calculate','filter','loader',
  'href','description','expr','signal','format','layer','repeat','facet','concat','hconcat','vconcat','spec','resolve',
  'config','autosize','padding','background','projection','lookup','loess','regression','density','quantile','sample','impute','bin',
  'joinaggregate','flatten','pivot','extent','condition','test','labelExpr',
 ],
} as const satisfies Record<string,readonly string[]>
export const businessChartSpecLimits={depth:8,nodes:400,bytes:16384} as const

/** 结论 §3.1 未逐项列出、但允许键的值对象必需的下一层键：`scale.type`、`axis.format`、聚合/窗口算子项、排序项。 */
const scaleKeys=['type'],axisKeys=['format'],operationKeys=['op','field','as'],sortKeys=['field','order']
const encodingTypes=['quantitative','ordinal','nominal','temporal']
const functionLike=/^\s*(function\b|\(?[\w$,\s]*\)?\s*=>)/
const token=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/
/** Vega-Lite 合法枚举：编码通道的聚合算子（不含返回数组的 `values` 与对象形态的 argmin/argmax）、时间单位（含 utc 前缀）、比例尺种类。 */
const aggregateOps=['count','valid','missing','distinct','sum','product','mean','average','variance','variancep','stdev','stdevp','stderr','median','q1','q3','ci0','ci1','min','max']
const localTimeUnits=[
 'year','quarter','month','week','day','dayofyear','date','hours','minutes','seconds','milliseconds',
 'yearquarter','yearquartermonth','yearmonth','yearmonthdate','yearmonthdatehours','yearmonthdatehoursminutes','yearmonthdatehoursminutesseconds',
 'yearweek','yearweekday','yearweekdayhours','yearweekdayhoursminutes','yearweekdayhoursminutesseconds','yeardayofyear',
 'quartermonth','monthdate','monthdatehours','monthdatehoursminutes','monthdatehoursminutesseconds',
 'weekday','weekdayhours','weekdayhoursminutes','weekdayhoursminutesseconds',
 'dayhours','dayhoursminutes','dayhoursminutesseconds','hoursminutes','hoursminutesseconds','minutesseconds','secondsmilliseconds',
]
const timeUnits=[...localTimeUnits,...localTimeUnits.map(unit=>'utc'+unit)]
const scaleTypes=['linear','log','sqrt','pow','symlog','time','utc','band','point','ordinal']
/**
 * `axis.format` 是任意深度禁止键 `format` 的唯一例外，因此只放行两种格式串（≤ 32 字）：
 * d3-format 数值格式，或 d3-time-format 时间格式（`%` 指令与日期常用分隔符交替，`%%` 为字面百分号，悬空的 `%` 不收）。
 * 时间轴（`type:'temporal'` 的 x / y）上的 `axis.format` 在客户端渲染时由平台按界面语言与数据粒度覆盖（规格 2026-09-28 §6），
 * 数值轴的照旧生效；这里仍照上面两种格式校验并放行——改成拒收会让已生效的声明读不出来。
 */
const numberFormat=/^(?:(.)?([<>=^]))?([+\-( ])?([$#])?(0)?(\d+)?(,)?(\.\d+)?(~)?([a-z%])?$/
const timeFormat=/^(?:%[-_0]?[aAbBcdefgGHIjLmMpqQsSuUVwWxXyYZ%]|[A-Za-z0-9 :\/.,\-])+$/
const axisFormat=(value:unknown):boolean=>typeof value==='string'&&value.length>=1&&value.length<=32&&(numberFormat.test(value)||timeFormat.test(value))

const reject=(path:string,message:string)=>new WorkError('teloa/invalid-input','图表规范 '+path+' '+message)
const text=(value:unknown):value is string=>typeof value==='string'&&value.length<=200&&!/[\x00-\x08\x0a-\x1f\x7f]/.test(value)
const strings=(value:unknown,item:(value:unknown)=>boolean=text):value is string[]=>Array.isArray(value)&&value.length>=1&&value.length<=32&&value.every(item)

function keysIn(value:unknown,allowed:readonly string[],path:string):Record<string,unknown>{
 if(!isRecord(value))throw reject(path,'必须是对象。')
 for(const key of Object.keys(value))if(!allowed.includes(key))throw reject(path+'.'+key,'不在允许键内，允许：'+allowed.join(' / ')+'。')
 return value
}
function stringAt(value:unknown,path:string,pattern?:RegExp):void{
 if(!text(value)||(pattern&&!pattern.test(value)))throw reject(path,'取值不合法。')
}
function enumAt(value:unknown,path:string,allowed:readonly string[]):void{
 if(typeof value!=='string'||!allowed.includes(value))throw reject(path,'取值不在 Vega-Lite 允许的取值内。')
}

/** 第一遍：规模上限，与任意深度的禁止键和形如函数的字符串；禁止键按子先于父报告，路径写到最深那一层。 */
function scan(value:unknown,path:string,depth:number,state:{nodes:number}):void{
 if(++state.nodes>businessChartSpecLimits.nodes)throw reject('spec','节点数超过 '+businessChartSpecLimits.nodes+'。')
 if(typeof value==='string'){if(functionLike.test(value))throw reject(path,'取值形如函数，不允许。');return}
 if(value===null||typeof value==='boolean')return
 if(typeof value==='number'){if(!Number.isFinite(value))throw reject(path,'取值必须是有限数字。');return}
 if(!Array.isArray(value)&&!isRecord(value))throw reject(path,'取值类型不允许。')
 if(depth>businessChartSpecLimits.depth)throw reject(path,'嵌套深度超过 '+businessChartSpecLimits.depth+'。')
 if(Array.isArray(value)){value.forEach((item,index)=>scan(item,path+'['+index+']',depth+1,state));return}
 for(const [key,item] of Object.entries(value)){
  const child=path+'.'+key
  scan(item,child,depth+1,state)
  if((businessChartSpecKeys.forbiddenAnywhere as readonly string[]).includes(key)&&!(key==='format'&&path.endsWith('.axis')))throw reject(child,'是禁止键。')
 }
}

function mark(value:unknown,path:string):void{
 if(typeof value==='string'){if(!(businessChartSpecKeys.allowedMarkTypes as readonly string[]).includes(value))throw reject(path,'图形种类不允许，允许：'+businessChartSpecKeys.allowedMarkTypes.join(' / ')+'。');return}
 const row=keysIn(value,businessChartSpecKeys.allowedMarkKeys,path)
 if(!(businessChartSpecKeys.allowedMarkTypes as readonly string[]).includes(row.type as string))throw reject(path+'.type','图形种类不允许，允许：'+businessChartSpecKeys.allowedMarkTypes.join(' / ')+'。')
 if(row.point!==undefined&&typeof row.point!=='boolean')throw reject(path+'.point','必须是布尔值。')
 if(row.tooltip!==undefined&&typeof row.tooltip!=='boolean')throw reject(path+'.tooltip','必须是布尔值。')
 if(row.interpolate!==undefined)stringAt(row.interpolate,path+'.interpolate',token)
 if(row.innerRadius!==undefined&&!(typeof row.innerRadius==='number'&&row.innerRadius>=0))throw reject(path+'.innerRadius','必须是非负数。')
}
function channel(value:unknown,path:string):void{
 const row=keysIn(value,businessChartSpecKeys.allowedEncodingKeys,path)
 if(row.field!==undefined)stringAt(row.field,path+'.field')
 if(row.type!==undefined&&!encodingTypes.includes(row.type as string))throw reject(path+'.type','取值不允许，允许：'+encodingTypes.join(' / ')+'。')
 if(row.timeUnit!==undefined)enumAt(row.timeUnit,path+'.timeUnit',timeUnits)
 if(row.aggregate!==undefined)enumAt(row.aggregate,path+'.aggregate',aggregateOps)
 if(row.title!==undefined)stringAt(row.title,path+'.title')
 if(row.sort!==undefined&&!text(row.sort)&&!strings(row.sort))throw reject(path+'.sort','只允许字符串或字符串数组。')
 if(row.scale!==undefined){const scale=keysIn(row.scale,scaleKeys,path+'.scale');if(scale.type!==undefined)enumAt(scale.type,path+'.scale.type',scaleTypes)}
 if(row.axis!==undefined){const axis=keysIn(row.axis,axisKeys,path+'.axis');if(axis.format!==undefined&&!axisFormat(axis.format))throw reject(path+'.axis.format','只允许 32 字以内的 d3 数值格式或时间格式。')}
}
function encoding(value:unknown,path:string):void{
 const row=keysIn(value,businessChartSpecKeys.allowedEncodingChannels,path)
 for(const [key,item] of Object.entries(row)){
  if(key==='tooltip'&&Array.isArray(item)){item.forEach((entry,index)=>channel(entry,path+'.tooltip['+index+']'));continue}
  channel(item,path+'.'+key)
 }
}
function operations(value:unknown,path:string):void{
 if(!Array.isArray(value)||!value.length||value.length>16)throw reject(path,'必须是 1–16 项算子。')
 value.forEach((item,index)=>{
  const row=keysIn(item,operationKeys,path+'['+index+']')
  stringAt(row.op,path+'['+index+'].op',token)
  if(row.field!==undefined)stringAt(row.field,path+'['+index+'].field')
  stringAt(row.as,path+'['+index+'].as')
 })
}
function transform(value:unknown,path:string):void{
 if(!Array.isArray(value)||value.length>8)throw reject(path,'必须是不超过 8 项的数组。')
 value.forEach((item,index)=>{
  const at=path+'['+index+']',row=keysIn(item,businessChartSpecKeys.allowedTransformKeys,at)
  if(!businessChartSpecKeys.allowedTransforms.some(key=>key in row))throw reject(at,'必须含 '+businessChartSpecKeys.allowedTransforms.join(' / ')+' 之一。')
  if(row.aggregate!==undefined)operations(row.aggregate,at+'.aggregate')
  if(row.window!==undefined)operations(row.window,at+'.window')
  for(const key of ['groupby','fold'] as const)if(row[key]!==undefined&&!strings(row[key]))throw reject(at+'.'+key,'必须是 1–32 个字符串。')
  for(const key of ['timeUnit','stack','offset'] as const)if(row[key]!==undefined)stringAt(row[key],at+'.'+key,key==='stack'?undefined:token)
  if(row.field!==undefined)stringAt(row.field,at+'.field')
  if(row.as!==undefined&&!text(row.as)&&!strings(row.as))throw reject(at+'.as','只允许字符串或字符串数组。')
  if(row.sort!==undefined){
   if(!Array.isArray(row.sort)||!row.sort.length||row.sort.length>8)throw reject(at+'.sort','必须是 1–8 项排序。')
   row.sort.forEach((entry,position)=>{
    const sort=keysIn(entry,sortKeys,at+'.sort['+position+']')
    stringAt(sort.field,at+'.sort['+position+'].field')
    if(sort.order!==undefined&&sort.order!=='ascending'&&sort.order!=='descending')throw reject(at+'.sort['+position+'].order','只允许 ascending / descending。')
   })
  }
 })
}

/**
 * 深度遍历：任何键不在白名单、任何字符串值形如函数、任何禁止键（含 `url`/`values`/`datasets`）→ `teloa/invalid-input`，
 * reason 写明路径（如 `spec.encoding.tooltip.content`）。序列化 ≤ 16 KiB、深度 ≤ 8、节点 ≤ 400。
 * 先序列化出副本、只在副本上校验并返回副本：原对象上的取值器与 `toJSON` 因此只被读一次，校验的与返回的是同一份字节。
 */
export function readBusinessChartSpec(value:unknown):BusinessChartSpec{
 if(!isRecord(value))throw new WorkError('teloa/invalid-input','图表规范格式不正确。')
 const extra=Object.keys(value).filter(key=>key!=='engine'&&key!=='spec'),missing=['engine','spec'].filter(key=>!(key in value))
 if(extra.length||missing.length)throw new WorkError('teloa/invalid-input','图表规范格式不正确：'+[...(missing.length?['缺少字段 '+missing.join('、')]:[]),...(extra.length?['不认识的字段 '+extra.join('、')]:[])].join('；')+'。')
 if(value.engine!=='vega-lite')throw new WorkError('teloa/invalid-input','图表规范引擎不合法，当前为「'+String(value.engine)+'」，允许：vega-lite。')
 let serialized:string|undefined
 try{serialized=JSON.stringify(value.spec)}catch{throw reject('spec','无法序列化。')}
 // undefined / 函数序列化得到的不是字符串：那是「不是对象」，不是「超过 16 KiB」。
 if(typeof serialized!=='string')throw reject('spec','必须是对象。')
 if(new TextEncoder().encode(serialized).byteLength>businessChartSpecLimits.bytes)throw reject('spec','序列化后超过 16 KiB（'+businessChartSpecLimits.bytes+' 字节）。')
 const copy:unknown=JSON.parse(serialized)
 if(!isRecord(copy))throw reject('spec','必须是对象。')
 scan(copy,'spec',1,{nodes:0})
 const spec=keysIn(copy,businessChartSpecKeys.allowedTopLevel,'spec')
 if(spec.mark===undefined)throw reject('spec.mark','缺失，mark 必填。')
 mark(spec.mark,'spec.mark')
 if(spec.encoding!==undefined)encoding(spec.encoding,'spec.encoding')
 if(spec.transform!==undefined)transform(spec.transform,'spec.transform')
 for(const key of ['width','height'] as const)if(spec[key]!==undefined&&!(typeof spec[key]==='number'&&spec[key]>0&&spec[key]<=4096))throw reject('spec.'+key,'必须是 1–4096 的数字。')
 if(spec.title!==undefined)stringAt(spec.title,'spec.title')
 return {engine:'vega-lite',spec:copy}
}
