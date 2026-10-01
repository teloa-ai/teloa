import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {isBusinessRecordId} from './business-records.ts'

export const businessRichFieldFormat='teloa.business-rich-field/v2' as const

type Shared={format:typeof businessRichFieldFormat;name:string;label:string;from:string;required:boolean}
export type BusinessRichMoneyFieldDefinition=Shared&{type:'money';currencies:string[]}
export type BusinessRichMultiEnumFieldDefinition=Shared&{type:'multi-enum';values:string[]}
export type BusinessRichMultiReferenceFieldDefinition=Shared&{type:'multi-reference';referenceType:string}
export type BusinessRichFieldDefinition=BusinessRichMoneyFieldDefinition|BusinessRichMultiEnumFieldDefinition|BusinessRichMultiReferenceFieldDefinition
export type BusinessRichFieldParsedValue=
 |{type:'money';currency:string;decimal:string;scaled:bigint;canonical:string}
 |{type:'multi-enum';values:string[];canonical:string}
 |{type:'multi-reference';ids:string[];canonical:string}

const fieldName=/^[a-z0-9][a-z0-9_-]{0,62}$/
const currencyCode=/^[A-Z]{3}$/
const decimalPattern=/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,4})?$/
const bad=()=>new WorkError('teloa/invalid-input','富字段声明或取值不合法。')
const label=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0a-\x1f\x7f]/.test(value)
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>isRecord(value)&&keys.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>keys.includes(key))

/** v2 声明独立于既有七类字段；旧对象定义读取器继续严格拒收新类型。 */
export function readBusinessRichFieldDefinition(value:unknown):BusinessRichFieldDefinition{
 if(!isRecord(value))throw bad()
 const shared=['format','name','label','from','required','type']
 const keys=value.type==='money'?[...shared,'currencies']:value.type==='multi-enum'?[...shared,'values']:value.type==='multi-reference'?[...shared,'referenceType']:[]
 if(!keys.length||!exact(value,keys)||value.format!==businessRichFieldFormat||typeof value.name!=='string'||!fieldName.test(value.name)||!label(value.label,80)||!label(value.from,120)||typeof value.required!=='boolean')throw bad()
 const common={format:businessRichFieldFormat,name:value.name,label:value.label,from:value.from,required:value.required}
 if(value.type==='money'){
  if(!Array.isArray(value.currencies)||value.currencies.length<1||value.currencies.length>16||value.currencies.some(item=>typeof item!=='string'||!currencyCode.test(item))||new Set(value.currencies).size!==value.currencies.length)throw bad()
  return {...common,type:'money',currencies:[...value.currencies]}
 }
 if(value.type==='multi-reference'){
  if(typeof value.referenceType!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value.referenceType))throw bad()
  return {...common,type:'multi-reference',referenceType:value.referenceType}
 }
 if(!Array.isArray(value.values)||value.values.length<2||value.values.length>32||value.values.some(item=>!label(item,80))||new Set(value.values).size!==value.values.length)throw bad()
 return {...common,type:'multi-enum',values:[...value.values]}
}

function scaledDecimal(decimal:string):bigint{
 if(!decimalPattern.test(decimal)||decimal.includes('.')&&decimal.endsWith('0'))throw bad()
 const negative=decimal.startsWith('-'),absolute=negative?decimal.slice(1):decimal,[whole,fraction='']=absolute.split('.')
 const scaled=BigInt(whole!)*10000n+BigInt(fraction.padEnd(4,'0'))
 if(negative&&scaled===0n)throw bad()
 return negative?-scaled:scaled
}

/** 只接规范字符串；不静默改写请求正文或既有快照哈希。 */
export function readBusinessRichFieldValue(definition:BusinessRichFieldDefinition,raw:unknown):BusinessRichFieldParsedValue|undefined{
 const field=readBusinessRichFieldDefinition(definition)
 if(raw===undefined||raw===''){
  if(field.required)throw bad()
  return undefined
 }
 if(typeof raw!=='string'||raw.length>2000)throw bad()
 let value:unknown
 try{value=JSON.parse(raw)}catch{throw bad()}
 if(field.type==='money'){
  if(!exact(value,['currency','decimal'])||typeof value.currency!=='string'||!field.currencies.includes(value.currency)||typeof value.decimal!=='string'||JSON.stringify({currency:value.currency,decimal:value.decimal})!==raw)throw bad()
  return {type:'money',currency:value.currency,decimal:value.decimal,scaled:scaledDecimal(value.decimal),canonical:raw}
 }
 if(field.type==='multi-reference'){
  if(!Array.isArray(value)||value.length<1||value.length>32||value.some(item=>!isBusinessRecordId(item))||new Set(value).size!==value.length||JSON.stringify(value)!==raw)throw bad()
  const ids=[...value as string[]].sort()
  if(ids.some((id,index)=>id!==value[index]))throw bad()
  return {type:'multi-reference',ids,canonical:raw}
 }
 if(!Array.isArray(value)||value.length<1||value.length>32||value.some(item=>typeof item!=='string')||new Set(value).size!==value.length||JSON.stringify(value)!==raw)throw bad()
 const selected=new Set(value),ordered=field.values.filter(item=>selected.has(item))
 if(ordered.length!==value.length||ordered.some((item,index)=>item!==value[index]))throw bad()
 return {type:'multi-enum',values:ordered,canonical:raw}
}

/** 按声明顺序生成规范值；解析器也会复验编码结果。 */
export function encodeBusinessRichFieldValue(definition:BusinessRichFieldDefinition,input:{currency:string;decimal:string}|readonly string[]):string{
 const field=readBusinessRichFieldDefinition(definition)
 if(field.type==='money'){
  if(!exact(input,['currency','decimal'])||typeof input.currency!=='string'||typeof input.decimal!=='string')throw bad()
  const encoded=JSON.stringify({currency:input.currency,decimal:input.decimal})
  readBusinessRichFieldValue(field,encoded)
  return encoded
 }
 if(field.type==='multi-reference'){
  if(!Array.isArray(input)||input.length<1||input.length>32||input.some(item=>!isBusinessRecordId(item))||new Set(input).size!==input.length)throw bad()
  const encoded=JSON.stringify([...input].sort())
  readBusinessRichFieldValue(field,encoded)
  return encoded
 }
 if(!Array.isArray(input)||input.length<1||input.length>32||input.some(item=>typeof item!=='string')||new Set(input).size!==input.length)throw bad()
 const selected=new Set(input),ordered=field.values.filter(item=>selected.has(item))
 if(ordered.length!==input.length)throw bad()
 const encoded=JSON.stringify(ordered)
 readBusinessRichFieldValue(field,encoded)
 return encoded
}
