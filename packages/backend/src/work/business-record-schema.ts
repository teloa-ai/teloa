import {createHash} from 'node:crypto'
import {businessDefinitionCanonicalBody,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2} from '@teloa/contract'

type Definition=BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2
export type {BusinessRecordBatchDefinitionGuard} from '@teloa/contract'
const fingerprint=(value:unknown)=>createHash('sha256').update(businessDefinitionCanonicalBody(value)).digest('hex')

/** 完整版本化正文作为预览守卫；显示和版本变更也要求重新预览。 */
export function businessRecordSchemaFingerprint(definition:Definition):string{return fingerprint(definition)}

/** 只固定写入语义；字段排序稳定，枚举和币种声明数组仍保序。 */
export function businessRecordImportWriteSchemaFingerprint(definition:Definition):string{
 const fields=[...definition.fields].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(field=>({
  ...('format' in field?{format:field.format}:{}),name:field.name,from:field.from,type:field.type,required:field.required,
  ...('values' in field?{values:field.values}:{}),...('currencies' in field?{currencies:field.currencies}:{}),...('referenceType' in field?{referenceType:field.referenceType}:{})
 }))
 const uniqueFields='constraints' in definition?[...(definition.constraints?.uniqueFields??[])].sort():[]
 return fingerprint(['teloa.business-import-write-schema/v1',{format:definition.format,id:definition.id,domain:definition.domain,sourceId:definition.sourceId,fields,uniqueFields}])
}
