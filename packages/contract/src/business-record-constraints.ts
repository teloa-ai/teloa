import {WorkError} from './work-error.ts'
import {readBusinessObjectTypeDefinitionVersioned} from './business-definitions-v2.ts'
import {readBusinessRichFieldValue} from './business-rich-fields.ts'
import {parseBooleanValue,parseDurationSeconds} from './business-field-parse.ts'
import {isBusinessRecordId} from './business-records.ts'
export type BusinessRecordUniqueKey={field:string;key:string}

/** 唯一占用只由真实字段值计算；调用方负责在同一事务锁内核当前活跃记录及全部批次后态。 */
export function businessRecordUniqueKeys(definitionValue:unknown,values:readonly {label:string;value:string}[]):BusinessRecordUniqueKey[]{
 const definition=readBusinessObjectTypeDefinitionVersioned(definitionValue)
 if(!('constraints' in definition)||!definition.constraints)return []
 if(!Array.isArray(values)||values.some(row=>typeof row?.label!=='string'||typeof row.value!=='string')||new Set(values.map(row=>row.label)).size!==values.length)throw new WorkError('teloa/invalid-input','唯一字段的记录值不合法。')
 const supplied=new Map(values.map(row=>[row.label,row.value])),keys:BusinessRecordUniqueKey[]=[]
 for(const name of definition.constraints.uniqueFields){
  const field=definition.fields.find(field=>field.name===name)!,raw=supplied.get(field.from)
  if(raw===undefined||raw==='')continue
  const invalid=()=>new WorkError('teloa/invalid-input','字段「'+field.label+'」的唯一值不符合声明。',{field:name})
  const add=(value:unknown)=>keys.push({field:name,key:JSON.stringify(value)})
  if('format' in field){
   const parsed=readBusinessRichFieldValue(field,raw)
   if(parsed?.type==='money')add(['money',parsed.currency,parsed.scaled.toString()])
   else if(parsed?.type==='multi-reference')for(const id of parsed.ids)add(['reference',id])
   else throw invalid()
   continue
  }
  if(raw!==raw.trim()||raw.length>2000)throw invalid()
  switch(field.type){
   case 'number':{const value=Number(raw);if(!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)||!Number.isFinite(value)||Math.abs(value)>1e15)throw invalid();add(['number',String(value)]);break}
   case 'boolean':{const value=parseBooleanValue(raw);if(value===undefined)throw invalid();add(['boolean',value]);break}
   case 'duration':{const value=parseDurationSeconds(raw);if(value===undefined)throw invalid();add(['duration',String(value)]);break}
   case 'reference':if(!isBusinessRecordId(raw))throw invalid();add(['reference',raw]);break
   case 'enum':if(!field.values?.includes(raw))throw invalid();add(['enum',raw]);break
   case 'datetime':if(!Number.isFinite(Date.parse(raw))||new Date(raw).toISOString()!==raw)throw invalid();add(['datetime',raw]);break
   case 'text':add(['text',raw]);break
  }
 }
 return keys
}
