import {WorkError,parseBooleanValue,parseDurationSeconds,readBusinessRichFieldValue,businessRecordUniqueKeys,type BusinessObjectFieldDefinition,type BusinessRichFieldDefinition,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2} from '@teloa/contract'
export type BusinessRecordConstraintState={id:string;fields:readonly {label:string;value:string}[];deletedAt?:string}
/** 当前记录或完整批次后态共用；每个字段独立占用，多关联每位成员分别占用。 */
export function assertBusinessRecordUniqueState(definition:BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2,records:readonly BusinessRecordConstraintState[]):void{
 const occupied=new Map<string,string>()
 for(const record of records){
  if(record.deletedAt!==undefined)continue
  let keys:ReturnType<typeof businessRecordUniqueKeys>
  try{
   if('constraints' in definition&&definition.constraints)for(const name of definition.constraints.uniqueFields){
    const field=definition.fields.find(value=>value.name===name)!
    assertBusinessRecordFieldValue(field,record.fields.find(value=>value.label===field.from)?.value)
   }
   keys=businessRecordUniqueKeys(definition,record.fields)
  }catch{throw new WorkError('teloa/storage-corrupt','现存记录的唯一字段值损坏，已停止检查。')}
  for(const {field,key} of keys){
   const identity=JSON.stringify([field,key]),previous=occupied.get(identity)
   if(previous!==undefined&&previous!==record.id){
    const label=definition.fields.find(value=>value.name===field)!.label
    throw new WorkError('teloa/conflict','字段「'+label+'」的值已被另一条未归档记录使用。',{reason:'unique-field',field})
   }
   occupied.set(identity,record.id)
  }
 }
}
/** 保留快照原始字符串；只验证，不做投影转换或关系解析。 */
export function assertBusinessRecordFieldValue(field:BusinessObjectFieldDefinition|BusinessRichFieldDefinition,value:string|undefined):void{
 const invalid=()=>new WorkError('teloa/invalid-input','字段「'+field.label+'」的值不符合声明。',{field:field.name})
 if('format' in field){
  try{readBusinessRichFieldValue(field,value)}catch(error){if(error instanceof WorkError&&error.code==='teloa/invalid-input')throw invalid();throw error}
  return
 }
 if(value===undefined||value===''){if(field.required)throw invalid();return}
 if(typeof value!=='string'||value!==value.trim()||value.length>2000)throw invalid()
 switch(field.type){
  case 'text':case 'reference':return
  case 'number':if(!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)||!Number.isFinite(Number(value))||Math.abs(Number(value))>1e15)throw invalid();return
  case 'enum':if(!field.values?.includes(value))throw invalid();return
  case 'datetime':if(!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw invalid();return
  case 'duration':if(parseDurationSeconds(value)===undefined)throw invalid();return
  case 'boolean':if(parseBooleanValue(value)===undefined)throw invalid();return
 }
}
