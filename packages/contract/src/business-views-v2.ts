import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {businessFieldCapabilities,businessLedgerLimits,readBusinessViewDefinition,type BusinessAggregation,type BusinessFieldType,type BusinessFilterOperator,type BusinessObjectTypeDefinition,type BusinessViewDefinition,type BusinessViewFilter,type BusinessViewMeasure,type BusinessViewResult} from './business-definitions.ts'
import {readBusinessObjectTypeDefinitionVersioned,type BusinessObjectTypeDefinitionV2} from './business-definitions-v2.ts'
import {readBusinessRichFieldValue,type BusinessRichFieldDefinition} from './business-rich-fields.ts'
import {isBusinessRecordId} from './business-records.ts'

export const businessViewFormatV2='teloa.business-view/v2' as const
export type BusinessViewFilterOperatorV2=BusinessFilterOperator|'contains'|'overlaps'
export type BusinessViewFilterV2=Omit<BusinessViewFilter,'op'>&{op:BusinessViewFilterOperatorV2}
export type BusinessViewMeasureV2=Omit<BusinessViewMeasure,'where'>&{currency?:string;where?:BusinessViewFilterV2}
export type BusinessViewDefinitionV2=Omit<BusinessViewDefinition,'format'|'measures'|'filters'>&{format:typeof businessViewFormatV2;measures:BusinessViewMeasureV2[];filters:BusinessViewFilterV2[]}
export type BusinessViewDefinitionVersioned=BusinessViewDefinition|BusinessViewDefinitionV2
export type BusinessViewMoneyValue={type:'money';currency:string;decimal:string}
export type BusinessViewResultMeasureV2=Omit<BusinessViewResult['measures'][number],'fieldType'>&{aggregation:BusinessAggregation;fieldType?:BusinessFieldType|'money';currency?:string;rounding?:{scale:4;mode:'half-even'}}
export type BusinessViewResultV2=Omit<BusinessViewResult,'schema'|'measures'|'rows'>&{
 schema:'teloa.business-view-result/v2';dimensionMode:'records'|'membership'
 measures:BusinessViewResultMeasureV2[]
 rows:Array<{dimension:string;label:string;values:Array<number|null|BusinessViewMoneyValue>}>
}
export type BusinessViewWidgetResultV2={format:'teloa.business-view-widget-result/v2';widgetId:string;definitionHash:string;computedAt:string;view:BusinessViewResultV2;stale:false}

/** 基础字段沿 v1 能力表；富字段只补业务快照域当前具备的两类统计语义。 */
export const businessRichViewFieldCapabilities:Readonly<Record<BusinessRichFieldDefinition['type'],{dimension:boolean;measure:boolean;aggregations:readonly BusinessAggregation[];operators:readonly BusinessViewFilterOperatorV2[]}>>={
 money:{dimension:false,measure:true,aggregations:['sum','avg','min','max'],operators:['eq','ne','gte','lte']},
 'multi-enum':{dimension:true,measure:false,aggregations:[],operators:['contains','overlaps']},
 'multi-reference':{dimension:false,measure:false,aggregations:[],operators:['contains','overlaps']},
}

const bad=(message='业务类型化视图格式或字段引用不合法。')=>new WorkError('teloa/invalid-input',message)
const hostBad=()=>new WorkError('teloa/invalid-host-response','业务类型化视图回包格式或身份不一致。')
const currency=(value:unknown):value is string=>typeof value==='string'&&/^[A-Z]{3}$/.test(value)
const fieldName=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)
const localId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const natural=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!isRecord(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key))||optional.some(key=>Object.hasOwn(value,key)&&value[key]===undefined))throw bad()
 return value
}
function filterShadow(value:unknown):unknown{
 if(!isRecord(value))return value
 return {...value,op:value.op==='contains'?'eq':value.op==='overlaps'?'in':value.op}
}
/** 仅用于 v1 共同结构校验；不能持久化替身，也不能据此执行富字段统计。 */
export function businessViewV2LegacyShape(view:BusinessViewDefinitionV2):BusinessViewDefinition{
 return {...view,format:'teloa.business-view/v1',measures:view.measures.map(({currency:_,where,...measure})=>({...measure,...(where?{where:filterShadow(where) as BusinessViewFilter}:{})})),filters:view.filters.map(filter=>filterShadow(filter) as BusinessViewFilter)}
}
export function readBusinessViewDefinitionV2(value:unknown):BusinessViewDefinitionV2{
 if(!isRecord(value)||value.format!==businessViewFormatV2||!Array.isArray(value.measures)||!Array.isArray(value.filters))throw bad()
 const currencies=new Map<number,string>()
 const measures=value.measures.map((value,index)=>{
  if(!isRecord(value))return value
  const {currency:code,...measure}=value
  if(Object.hasOwn(value,'currency')){
   if(!currency(code)||value.aggregation==='count')throw bad('金额度量的币种必须是大写三字母且不能用于 count。')
   currencies.set(index,code)
  }
  return {...measure,...(Object.hasOwn(measure,'where')?{where:filterShadow(measure.where)}:{})}
 })
 const legacy=readBusinessViewDefinition({...value,format:'teloa.business-view/v1',measures,filters:value.filters.map(filterShadow)})
 const filter=(parsed:BusinessViewFilter,original:unknown):BusinessViewFilterV2=>({...parsed,op:(original as Record<string,unknown>).op as BusinessViewFilterOperatorV2})
 return {...legacy,format:businessViewFormatV2,measures:legacy.measures.map((measure,index)=>({...measure,...(currencies.has(index)?{currency:currencies.get(index)!}:{}),...(measure.where?{where:filter(measure.where,(value.measures as Record<string,unknown>[])[index]!.where)}:{})})),filters:legacy.filters.map((parsed,index)=>filter(parsed,(value.filters as unknown[])[index]))}
}
export function readBusinessViewDefinitionVersioned(value:unknown):BusinessViewDefinitionVersioned{
 if(!isRecord(value))throw bad()
 if(value.format==='teloa.business-view/v1')return readBusinessViewDefinition(value)
 if(value.format===businessViewFormatV2)return readBusinessViewDefinitionV2(value)
 throw bad('业务视图格式版本不支持。')
}

/** 跨声明校验统一读取真实类型，不把 rich 验证影子当 text 使用。 */
export function assertBusinessViewV2References(value:BusinessViewDefinitionVersioned,objectValue:BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2):void{
 const view=readBusinessViewDefinitionVersioned(value),object=readBusinessObjectTypeDefinitionVersioned(objectValue)
 if(view.objectType!==object.id||view.domain!==object.domain)throw bad('视图引用的对象类型或业务范围不一致。')
 const fields=new Map(object.fields.map(field=>[field.name,field]))
 const field=(name:string)=>{
  const found=fields.get(name)
  if(!found||view.format==='teloa.business-view/v1'&&'format' in found)throw bad('视图引用的字段不存在或旧视图不支持富字段。')
  return found
 }
 const capabilities=(definition:ReturnType<typeof field>)=>'format' in definition?businessRichViewFieldCapabilities[definition.type]:businessFieldCapabilities[definition.type]
 if(view.dimension){
  const target=field(view.dimension.field)
  if(!capabilities(target).dimension||view.kind==='trend'&&target.type!=='datetime'||view.kind==='distribution'&&target.type==='datetime')throw bad('字段类型不支持该视图维度。')
 }
 if(view.window&&field(view.window.field).type!=='datetime')throw bad('时间窗只能引用 datetime 字段。')
 const filter=(clause:BusinessViewFilterV2)=>{
  const target=field(clause.field)
  if(!(capabilities(target).operators as readonly string[]).includes(clause.op))throw bad('字段类型不支持该筛选算子。')
  if(target.type==='multi-enum'&&clause.values.some(value=>!target.values.includes(value)))throw bad('多选筛选只能引用声明成员。')
  if(target.type==='multi-reference'&&clause.values.some(value=>!isBusinessRecordId(value)))throw bad('关联筛选必须引用合法记录身份。')
  if(target.type==='money')for(const value of clause.values)readBusinessRichFieldValue(target,value)
 }
 for(const clause of view.filters)filter(clause)
 for(const measure of view.measures){
  if(measure.aggregation!=='count'){
   const target=field(measure.field!)
   if(!capabilities(target).measure||!capabilities(target).aggregations.includes(measure.aggregation))throw bad('字段类型不支持该聚合。')
   const code='currency' in measure?measure.currency:undefined
   if(target.type==='money'?(!currency(code)||!target.currencies.includes(code)):code!==undefined)throw bad('金额度量必须绑定声明币种，基础度量不得声明币种。')
  }
  if(measure.where)filter(measure.where)
 }
}

function host<T>(read:()=>T):T{try{return read()}catch{throw hostBad()}}
const plainText=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
function readMoney(value:unknown,code:string):BusinessViewMoneyValue{
 const row=exact(value,['type','currency','decimal'])
 if(row.type!=='money'||row.currency!==code||typeof row.decimal!=='string'||!/^\-?(?:0|[1-9]\d{0,21})(?:\.\d{1,4})?$/.test(row.decimal)||row.decimal==='-0'||row.decimal.includes('.')&&row.decimal.endsWith('0'))throw bad()
 return {type:'money',currency:code,decimal:row.decimal}
}
function resultMeasure(value:unknown):BusinessViewResultMeasureV2{
 const row=exact(value,['id','label','aggregation'],['localized','fieldType','currency','rounding'])
 const {fieldType,currency:code,rounding,...common}=row
 const parsed=readBusinessViewDefinition({format:'teloa.business-view/v1',id:'result',version:'1.0.0',domain:'result',title:'结果',kind:'board-card',chart:'number',objectType:'result',measures:[{...common,...(row.aggregation==='count'?{}:{field:'value'})}],filters:[],limit:1}).measures[0]!
 if(parsed.aggregation==='count'){
  if(fieldType!==undefined||code!==undefined||rounding!==undefined)throw bad()
 }else{
  const cap=fieldType==='money'?businessRichViewFieldCapabilities.money:businessFieldCapabilities[fieldType as BusinessFieldType]
  if(!cap?.measure||!cap.aggregations.includes(parsed.aggregation))throw bad()
  if(fieldType==='money'){
   if(!currency(code))throw bad()
   if(parsed.aggregation==='avg'){
    const r=exact(rounding,['scale','mode'])
    if(r.scale!==4||r.mode!=='half-even')throw bad()
   }else if(rounding!==undefined)throw bad()
  }else if(code!==undefined||rounding!==undefined)throw bad()
 }
 const {field:_,...measure}=parsed
 return {...measure,...(fieldType===undefined?{}:{fieldType:fieldType as BusinessFieldType|'money'}),...(code===undefined?{}:{currency:code as string}),...(rounding===undefined?{}:{rounding:{scale:4,mode:'half-even'}})}
}
export function readBusinessViewResultV2(value:unknown):BusinessViewResultV2{return host(()=>{
 const row=exact(value,['schema','viewId','viewVersion','definitionHash','origin','kind','chart','title','dimensionMode','scope','objectType','computedAt','measures','rows','dimensionValues','coverage','missingFields'],['localized','dimensionField','objects'])
 if(row.schema!=='teloa.business-view-result/v2'||!hash(row.definitionHash)||!stamp(row.computedAt)||!['local','template'].includes(String(row.origin))||!['records','membership'].includes(String(row.dimensionMode)))throw bad()
 if(!Array.isArray(row.measures)||!row.measures.length||row.measures.length>businessLedgerLimits.measures)throw bad()
 const measures=row.measures.map(resultMeasure)
 const grouped=row.kind==='distribution'||row.kind==='trend'
 if(grouped?!fieldName(row.dimensionField):row.dimensionField!==undefined)throw bad()
 if(row.dimensionMode==='membership'&&row.kind!=='distribution')throw bad()
 const metadata=readBusinessViewDefinition({format:'teloa.business-view/v1',id:row.viewId,version:row.viewVersion,domain:row.scope,title:row.title,...(row.localized?{localized:row.localized}:{}),kind:row.kind,chart:row.chart,objectType:row.objectType,...(grouped?{dimension:{field:row.dimensionField,limit:50,...(row.kind==='trend'?{bucket:'day'}:{})}}:{}),measures:measures.map(({fieldType:_,currency:__,rounding:___,...m})=>({...m,...(m.aggregation==='count'?{}:{field:'value'})})),filters:[],...(row.kind==='board-card'?{}:{sort:{by:'dimension',direction:'asc'}}),limit:row.kind==='board-card'?1:row.kind==='list'?100:50})
 const coverage=exact(row.coverage,['objects','latestReceivedAt','truncated'])
 if(!natural(coverage.objects)||coverage.objects>businessLedgerLimits.scanRows||coverage.latestReceivedAt!==null&&!stamp(coverage.latestReceivedAt)||typeof coverage.truncated!=='boolean')throw bad()
 const maxRows=metadata.kind==='list'?100:metadata.kind==='board-card'?1:50
 if(!Array.isArray(row.rows)||row.rows.length>maxRows||!natural(row.dimensionValues)||row.dimensionValues<row.rows.length||row.dimensionValues>(row.dimensionMode==='membership'?businessLedgerLimits.scanRows*32:businessLedgerLimits.scanRows)||metadata.kind==='board-card'&&(row.dimensionValues!==1||row.rows.length!==1))throw bad()
 const rows=row.rows.map(value=>{
  const r=exact(value,['dimension','label','values'])
  if(!plainText(r.dimension,4000)||!plainText(r.label,4000)||!Array.isArray(r.values)||r.values.length!==measures.length)throw bad()
  const values=r.values.map((value,index)=>{
   const measure=measures[index]!
   if(value===null){if(measure.aggregation==='count')throw bad();return null}
   if(measure.fieldType==='money')return readMoney(value,measure.currency!)
   if(typeof value!=='number'||!Number.isFinite(value)||measure.aggregation==='count'&&(!natural(value)||value>Number(coverage.objects)))throw bad()
   return value
  })
  return {dimension:r.dimension,label:r.label,values}
 })
 if(new Set(rows.map(r=>r.dimension)).size!==rows.length||!Array.isArray(row.missingFields)||row.missingFields.length>50||row.missingFields.some(v=>!fieldName(v))||new Set(row.missingFields).size!==row.missingFields.length)throw bad()
 if(row.objects!==undefined){
  if(metadata.kind!=='list'||!Array.isArray(row.objects)||row.objects.length!==rows.length)throw bad()
  for(const [index,value] of row.objects.entries()){
   const o=exact(value,['id','title','source','observedAt','receivedAt','quality','version','snapshotHash','summary','fields'])
   if(o.id!==rows[index]!.dimension||!plainText(o.id,200)||!plainText(o.title,500)||!plainText(o.source,120)||!plainText(o.summary,4000)||!stamp(o.observedAt)||!stamp(o.receivedAt)||!['complete','missing'].includes(String(o.quality))||!natural(o.version)||o.version<1||!hash(o.snapshotHash)||!Array.isArray(o.fields)||o.fields.length>50)throw bad()
   for(const value of o.fields){const f=exact(value,['label','value']);if(!plainText(f.label,120)||!plainText(f.value,4000))throw bad()}
  }
 }
 return {...row,measures,rows,coverage} as BusinessViewResultV2
})}
export function readBusinessViewWidgetResultV2(value:unknown):BusinessViewWidgetResultV2{return host(()=>{
 const row=exact(value,['format','widgetId','definitionHash','computedAt','view','stale'])
 const view=readBusinessViewResultV2(row.view)
 if(row.format!=='teloa.business-view-widget-result/v2'||!localId(row.widgetId)||!hash(row.definitionHash)||!stamp(row.computedAt)||row.computedAt!==view.computedAt||row.stale!==false)throw bad()
 return {...row,view} as BusinessViewWidgetResultV2
})}
