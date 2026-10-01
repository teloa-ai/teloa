import type {PoolClient} from 'pg'
import {
 WorkError,assertBusinessViewV2References,readBusinessObjectTypeDefinitionVersioned,readBusinessViewDefinitionVersioned,readBusinessViewResultV2,readBusinessRichFieldValue,
 type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2,type BusinessObjectSnapshot,type BusinessRichFieldParsedValue,
 type BusinessViewDefinition,type BusinessViewDefinitionV2,type BusinessViewFilterV2,type BusinessViewMeasureV2,type BusinessViewResultV2,type BusinessDefinitionSource,
} from '@teloa/contract'
import {businessObjectSnapshotHash,readBusinessObjectSnapshot} from './business-data.ts'
import {loadBusinessViewSnapshots,parseBusinessBasicField,compareBusinessBasicField,businessViewWindowRange,businessViewBucketStart,businessViewBucketFormat,type BusinessBasicFieldValue,type BusinessLedgerActor} from './business-view-compute.ts'
import type {BusinessObjectTypeRecordVersioned,BusinessViewRecordVersioned} from './business-definition-source.ts'

type ObjectType=BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2
type View=BusinessViewDefinition|BusinessViewDefinitionV2
type Field=ObjectType['fields'][number]
type Value=BusinessBasicFieldValue|BusinessRichFieldParsedValue
type ParsedObject={snapshot:BusinessObjectSnapshot;values:Map<string,Value>}
type ResultValue=BusinessViewResultV2['rows'][number]['values'][number]
export type BusinessViewV2ComputeInput={objectType:ObjectType;view:View;snapshots:BusinessObjectSnapshot[];truncated:boolean;computedAt:string;scope:string;definitionHash:string;origin:BusinessDefinitionSource['origin'];known?:Map<string,Set<string>>}
const corrupt=()=>new WorkError('teloa/storage-corrupt','类型化业务统计的固定快照或身份不一致，已停止计算。')
const bad=()=>new WorkError('teloa/invalid-input','类型化业务统计的声明或引用不正确。')

/** 金额只按万分之一整数计算；输出去掉末尾零，并把正负零统一为 0。 */
function decimal(scaled:bigint):string{
 const negative=scaled<0n,absolute=negative?-scaled:scaled
 const whole=absolute/10000n,fraction=String(absolute%10000n).padStart(4,'0').replace(/0+$/,'')
 return (negative?'-':'')+whole+(fraction?'.'+fraction:'')
}
/** 对负值先取绝对值舍入，再还原符号；正负 tie 使用同一条 half-even 规则。 */
function average(sum:bigint,count:number):bigint{
 const negative=sum<0n,absolute=negative?-sum:sum,divisor=BigInt(count)
 let quotient=absolute/divisor
 const remainder=absolute%divisor
 if(remainder*2n>divisor||remainder*2n===divisor&&quotient%2n!==0n)quotient++
 return negative?-quotient:quotient
}
function parse(field:Field,raw:string|undefined,known:Map<string,Set<string>>):Value|undefined{
 if(!('format' in field))return parseBusinessBasicField(field,raw,known)
 try{
  const value=readBusinessRichFieldValue(field,raw)
  if(value?.type==='multi-reference'&&field.type==='multi-reference'&&!value.ids.every(id=>known.get(field.referenceType)?.has(id)))return undefined
  return value
 }catch{return undefined}
}
function matches(filter:BusinessViewFilterV2,fields:Map<string,Field>,values:Map<string,Value>):boolean{
 const field=fields.get(filter.field),value=values.get(filter.field)
 if(!field||value===undefined)return false
 if('format' in field){
  if(typeof value!=='object')return false
  if(value.type==='multi-enum')return filter.op==='contains'?value.values.includes(filter.values[0]!):filter.op==='overlaps'&&filter.values.some(member=>value.values.includes(member))
  if(value.type==='multi-reference')return filter.op==='contains'?value.ids.includes(filter.values[0]!):filter.op==='overlaps'&&filter.values.some(member=>value.ids.includes(member))
  let bound:BusinessRichFieldParsedValue|undefined
  try{bound=readBusinessRichFieldValue(field,filter.values[0])}catch{return false}
  if(bound?.type!=='money'||bound.currency!==value.currency)return false
  const order=value.scaled===bound.scaled?0:value.scaled<bound.scaled?-1:1
  return filter.op==='eq'?order===0:filter.op==='ne'?order!==0:filter.op==='gte'?order>=0:filter.op==='lte'&&order<=0
 }
 if(typeof value==='object')return false
 if(filter.op==='in')return filter.values.some(literal=>compareBusinessBasicField(field,value,literal)===0)
 const order=compareBusinessBasicField(field,value,filter.values[0]!)
 return order===undefined?false:filter.op==='eq'?order===0:filter.op==='ne'?order!==0:filter.op==='gte'?order>=0:filter.op==='lte'&&order<=0
}
function aggregate(measure:BusinessViewMeasureV2,fields:Map<string,Field>,group:ParsedObject[]):ResultValue{
 const subset=measure.where?group.filter(object=>matches(measure.where!,fields,object.values)):group
 if(measure.aggregation==='count')return subset.length
 const field=fields.get(measure.field!)
 if(!field)return null
 if(field.type==='money'){
  const amounts=subset.flatMap(object=>{const value=object.values.get(field.name);return typeof value==='object'&&value.type==='money'&&value.currency===measure.currency?[value.scaled]:[]})
  if(!amounts.length)return null
  const sum=amounts.reduce((total,value)=>total+value,0n)
  const scaled=measure.aggregation==='sum'?sum:measure.aggregation==='avg'?average(sum,amounts.length):amounts.reduce((current,value)=>measure.aggregation==='min'?(value<current?value:current):(value>current?value:current))
  return {type:'money',currency:measure.currency!,decimal:decimal(scaled)}
 }
 const numbers=subset.flatMap(object=>{const value=object.values.get(measure.field!);return value===undefined||typeof value==='object'?[]:[field.type==='datetime'?Date.parse(value as string):value as number]})
 if(!numbers.length)return null
 return measure.aggregation==='sum'?numbers.reduce((total,value)=>total+value,0):measure.aggregation==='avg'?numbers.reduce((total,value)=>total+value,0)/numbers.length:measure.aggregation==='min'?Math.min(...numbers):Math.max(...numbers)
}
function valueOrder(left:Exclude<ResultValue,null>,right:Exclude<ResultValue,null>):number{
 if(typeof left==='number'&&typeof right==='number')return left===right?0:left<right?-1:1
 if(typeof left!=='object'||typeof right!=='object'||left.currency!==right.currency)throw corrupt()
 const scaled=(value:string)=>{const negative=value.startsWith('-'),[whole,fraction='']=(negative?value.slice(1):value).split('.');const result=BigInt(whole!)*10000n+BigInt(fraction.padEnd(4,'0'));return negative?-result:result}
 const a=scaled(left.decimal),b=scaled(right.decimal)
 return a===b?0:a<b?-1:1
}

/** 纯计算仍校验真实定义与快照摘要，绝不把 rich 字段伪装为 v1 的 text。 */
export function computeBusinessViewV2(input:BusinessViewV2ComputeInput):BusinessViewResultV2{
 const objectType=readBusinessObjectTypeDefinitionVersioned(input.objectType),view=readBusinessViewDefinitionVersioned(input.view)
 assertBusinessViewV2References(view,objectType)
 if(input.scope!==objectType.domain||input.scope!==view.domain||!Number.isFinite(Date.parse(input.computedAt))||new Date(input.computedAt).toISOString()!==input.computedAt)throw bad()
 const fields=new Map<string,Field>(objectType.fields.map(field=>[field.name,field])),known=input.known??new Map<string,Set<string>>()
 const objects:ParsedObject[]=input.snapshots.flatMap(snapshot=>{
  const {snapshotHash,...raw}=snapshot
  let stored:Omit<BusinessObjectSnapshot,'snapshotHash'>
  try{stored=readBusinessObjectSnapshot(raw,input.scope)}catch{throw corrupt()}
  // source 是显示名称（本地记录），真实归属 source_id 已由共同快照扫描核对。
  if(stored.type!==objectType.id||businessObjectSnapshotHash(stored)!==snapshotHash)throw corrupt()
  if(stored.deletedAt!==undefined)return []
  const byLabel=new Map(stored.fields.map(field=>[field.label,field.value])),values=new Map<string,Value>()
  for(const field of objectType.fields){const value=parse(field,byLabel.get(field.from),known);if(value!==undefined)values.set(field.name,value)}
  return [{snapshot:{...stored,snapshotHash},values}]
 })
 const range=view.window?businessViewWindowRange(view.window.relative,Date.parse(input.computedAt)):undefined
 const eligible=objects.filter(object=>{
  if(view.window&&range){const value=object.values.get(view.window.field);if(typeof value!=='string')return false;const at=Date.parse(value);if(at<range.from||(range.inclusive?at>range.to:at>=range.to))return false}
  return view.filters.every(filter=>matches(filter,fields,object.values))
 })
 const groups=new Map<string,ParsedObject[]>()
 if(view.kind==='board-card')groups.set('',eligible)
 else if(view.kind==='list')for(const object of eligible)groups.set(object.snapshot.id,[object])
 else for(const object of eligible){
  const value=object.values.get(view.dimension!.field)
  if(value===undefined)continue
  const keys=typeof value==='object'?(value.type==='multi-enum'?value.values:[]):[view.dimension!.bucket?businessViewBucketStart(value as string,view.dimension!.bucket):String(value)]
  for(const key of keys){const group=groups.get(key);if(group)group.push(object);else groups.set(key,[object])}
 }
 const format=view.dimension?.bucket?new Intl.DateTimeFormat('zh-CN',businessViewBucketFormat[view.dimension.bucket]):undefined
 let rows=[...groups].map(([dimension,group])=>({dimension,label:view.kind==='board-card'?view.title:view.kind==='list'?group[0]!.snapshot.title:format?format.format(new Date(dimension)):dimension,values:view.measures.map(measure=>aggregate(measure,fields,group))}))
 if(view.sort){
  const direction=view.sort.direction==='asc'?1:-1,index=view.sort.by==='measure'?view.measures.findIndex(measure=>measure.id===view.sort!.measureId):-1
  rows=rows.sort((left,right)=>{
   if(index<0)return left.dimension===right.dimension?0:left.dimension<right.dimension?-direction:direction
   const a=left.values[index],b=right.values[index]
   if(a===null||a===undefined)return b===null||b===undefined?0:1
   if(b===null||b===undefined)return -1
   return direction*valueOrder(a,b)
  })
 }
 const dimensionValues=rows.length,limit=view.dimension?Math.min(view.limit,view.dimension.limit):view.limit
 if(view.kind!=='board-card')rows=rows.slice(0,limit)
 const used=new Set([...(view.dimension?[view.dimension.field]:[]),...(view.window?[view.window.field]:[]),...view.filters.map(filter=>filter.field),...view.measures.flatMap(measure=>[...(measure.field?[measure.field]:[]),...(measure.where?[measure.where.field]:[])])])
 const result:BusinessViewResultV2={
  schema:'teloa.business-view-result/v2',viewId:view.id,viewVersion:view.version,definitionHash:input.definitionHash,origin:input.origin,
  kind:view.kind,chart:view.chart,title:view.title,...(view.localized?{localized:view.localized}:{}),...(view.dimension?{dimensionField:view.dimension.field}:{}),
  scope:input.scope,objectType:objectType.id,computedAt:input.computedAt,dimensionMode:view.dimension&&fields.get(view.dimension.field)?.type==='multi-enum'?'membership':'records',
  measures:view.measures.map(measure=>{const field=measure.field?fields.get(measure.field):undefined;return {id:measure.id,label:measure.label,aggregation:measure.aggregation,...(measure.localized?{localized:measure.localized}:{}),...(field&&field.type!=='multi-enum'&&field.type!=='multi-reference'?{fieldType:field.type}:{}),...(field?.type==='money'?{currency:(measure as BusinessViewMeasureV2).currency!,...(measure.aggregation==='avg'?{rounding:{scale:4 as const,mode:'half-even' as const}}:{})}:{})}}),
  rows,dimensionValues,coverage:{objects:objects.length,latestReceivedAt:objects.length?objects.reduce((latest,object)=>object.snapshot.receivedAt>latest?object.snapshot.receivedAt:latest,objects[0]!.snapshot.receivedAt):null,truncated:input.truncated},
  missingFields:objectType.fields.filter(field=>used.has(field.name)&&objects.some(object=>object.values.get(field.name)===undefined)).map(field=>field.name),
  ...(view.kind==='list'?{objects:rows.map(row=>{const snapshot=groups.get(row.dimension)![0]!.snapshot;const {scope:_,type:__,deletedAt:___,...object}=snapshot;return object})}:{}),
 }
 return readBusinessViewResultV2(result)
}

export type BusinessViewV2TransactionInput={scope:string;objectType:BusinessObjectTypeRecordVersioned;view:BusinessViewRecordVersioned;objectTypes?:BusinessObjectTypeRecordVersioned[]}
/** 调用方持有同一只读可重复读事务；本层只读固定快照，不拉来源、不保存计算结果。 */
export class BusinessViewV2Computer{
 private readonly identity:{now:()=>string}
 constructor(identity:{now:()=>string}){this.identity=identity}
 async computeInTransaction(db:PoolClient,actor:BusinessLedgerActor,input:BusinessViewV2TransactionInput,signal?:AbortSignal):Promise<BusinessViewResultV2>{
  if(typeof actor?.ownerId!=='string'||!actor.ownerId.trim()||actor.ownerId!==actor.ownerId.trim()||actor.ownerId.length>128||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||!actor.scopeIds.includes(input.scope))throw new WorkError('teloa/forbidden','当前主体未获准读取此业务范围。')
  for(const record of [input.objectType,input.view])if(record.source.scope!==input.scope||record.definition.domain!==input.scope||record.source.localId!==record.definition.id||record.source.version!==record.definition.version||! /^[a-f0-9]{64}$/.test(record.source.definitionHash))throw corrupt()
  assertBusinessViewV2References(input.view.definition,input.objectType.definition)
  signal?.throwIfAborted()
  const snapshots=await loadBusinessViewSnapshots(db,actor.ownerId,input.scope,input.objectType.definition.id,input.objectType.definition.sourceId)
  signal?.throwIfAborted()
  const known=new Map<string,Set<string>>()
  for(const field of input.objectType.definition.fields){
   if(field.type!=='reference'&&field.type!=='multi-reference'||!field.referenceType||known.has(field.referenceType))continue
   const target=input.objectTypes?.find(type=>type.definition.id===field.referenceType)
   if(!target)throw new WorkError('teloa/source-unavailable','业务引用的对象类型不在同一业务范围内。')
   const rows=await loadBusinessViewSnapshots(db,actor.ownerId,input.scope,target.definition.id,target.definition.sourceId)
   if(rows.truncated)throw new WorkError('teloa/source-unavailable','业务引用目标超过统计扫描上限，不能截断核对。')
   known.set(field.referenceType,new Set(rows.filter(row=>row.snapshot.deletedAt===undefined).map(row=>row.snapshot.id)))
   signal?.throwIfAborted()
  }
  return computeBusinessViewV2({objectType:input.objectType.definition,view:input.view.definition,snapshots:snapshots.map(row=>row.snapshot),truncated:snapshots.truncated,computedAt:this.identity.now(),scope:input.scope,definitionHash:input.view.source.definitionHash,origin:input.view.source.origin,known})
 }
}
