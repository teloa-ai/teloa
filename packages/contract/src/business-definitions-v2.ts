import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {readBusinessObjectTypeDefinition,type BusinessObjectFieldDefinition,type BusinessObjectTypeDefinition} from './business-definitions.ts'
import {businessRichFieldFormat,readBusinessRichFieldDefinition,type BusinessRichFieldDefinition} from './business-rich-fields.ts'

export const businessObjectTypeFormatV2='teloa.business-object-type/v2' as const
export type BusinessObjectTypeDefinitionV2=Omit<BusinessObjectTypeDefinition,'format'|'fields'>&{
 format:typeof businessObjectTypeFormatV2
 fields:Array<BusinessObjectFieldDefinition|BusinessRichFieldDefinition>
 constraints?:{uniqueFields:string[]}
}

const bad=()=>new WorkError('teloa/invalid-input','业务对象类型格式版本不支持。')
const isRich=(value:unknown):value is Record<string,unknown>=>isRecord(value)&&value.format===businessRichFieldFormat

/** 仅供旧版的共同字段、进度与身份校验；不持久化该替身定义。 */
export function businessObjectTypeV2LegacyShape(definition:BusinessObjectTypeDefinitionV2):BusinessObjectTypeDefinition{
 const {constraints:_,...common}=definition
 return {...common,format:'teloa.business-object-type/v1',fields:definition.fields.map(field=>{
  if(!('format' in field))return field
  return {name:field.name,label:field.label,type:'text',required:field.required,from:field.from}
 })}
}

/** v2 复用 v1 的共同结构和交叉约束，但旧入口仍只接受 v1。 */
export function readBusinessObjectTypeDefinitionV2(value:unknown):BusinessObjectTypeDefinitionV2{
 if(!isRecord(value)||value.format!==businessObjectTypeFormatV2||!Array.isArray(value.fields))throw bad()
 const rich=new Map<number,BusinessRichFieldDefinition>()
 const validationFields=value.fields.map((field,index)=>{
  if(!isRich(field))return field
  const parsed=readBusinessRichFieldDefinition(field)
  rich.set(index,parsed)
  return {name:parsed.name,label:parsed.label,type:'text',required:parsed.required,from:parsed.from}
 })
 const {constraints:rawConstraints,...common}=value
 const legacy=readBusinessObjectTypeDefinition({...common,format:'teloa.business-object-type/v1',fields:validationFields})
 const fields=legacy.fields.map((field,index)=>rich.get(index)??field)
 let constraints:BusinessObjectTypeDefinitionV2['constraints']
 if(Object.hasOwn(value,'constraints')){
  if(!isRecord(rawConstraints)||Object.keys(rawConstraints).length!==1||!Array.isArray(rawConstraints.uniqueFields)||rawConstraints.uniqueFields.length<1||rawConstraints.uniqueFields.length>50||new Set(rawConstraints.uniqueFields).size!==rawConstraints.uniqueFields.length||rawConstraints.uniqueFields.some(name=>typeof name!=='string'||!fields.some(field=>field.name===name&&field.type!=='multi-enum')))throw bad()
  constraints={uniqueFields:[...rawConstraints.uniqueFields]}
 }
 return {...legacy,format:businessObjectTypeFormatV2,fields,...(constraints?{constraints}:{})}
}

export function readBusinessObjectTypeDefinitionVersioned(value:unknown):BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2{
 if(!isRecord(value))throw bad()
 if(value.format==='teloa.business-object-type/v1')return readBusinessObjectTypeDefinition(value)
 if(value.format===businessObjectTypeFormatV2)return readBusinessObjectTypeDefinitionV2(value)
 throw bad()
}
