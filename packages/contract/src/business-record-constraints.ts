import type {BusinessFieldValue} from './business-data.ts'
import {WorkError} from './work-error.ts'
import {readBusinessObjectTypeDefinitionVersioned} from './business-definitions-v2.ts'
import {readBusinessRichFieldValue} from './business-rich-fields.ts'
import {parseBooleanValue,parseDurationSeconds} from './business-field-parse.ts'
import {isBusinessRecordId} from './business-records.ts'
export type BusinessRecordUniqueKey={field:string;key:string}

/** 唯一占用只由真实字段值计算；调用方负责在同一事务锁内核当前活跃记录及全部批次后态。 */
export function businessRecordUniqueKeys(definitionValue:unknown,values:readonly {label:string;value:BusinessFieldValue}[]):BusinessRecordUniqueKey[]{
 const definition=readBusinessObjectTypeDefinitionVersioned(definitionValue)
 if(!('constraints' in definition)||!definition.constraints)return []
 if(!Array.isArray(values)||values.some(row=>typeof row?.label!=='string'||!['string','boolean','number'].includes(typeof row.value))||new Set(values.map(row=>row.label)).size!==values.length)throw new WorkError('teloa/invalid-input','唯一字段的记录值不合法。')
 const supplied=new Map(values.map(row=>[row.label,row.value])),keys:BusinessRecordUniqueKey[]=[]
 for(const name of definition.constraints.uniqueFields){
  const field=definition.fields.find(field=>field.name===name)!,raw=supplied.get(field.from)
  if(raw===undefined||raw==='')continue
  const invalid=()=>new WorkError('teloa/invalid-input','字段「'+field.label+'」的唯一值不符合声明。',{field:name})
  const add=(value:unknown)=>keys.push({field:name,key:JSON.stringify(value)})
  if('format' in field){
   if(typeof raw!=='string')throw invalid()
   const parsed=readBusinessRichFieldValue(field,raw)
   if(parsed?.type==='money')add(['money',parsed.currency,parsed.scaled.toString()])
   else if(parsed?.type==='multi-reference')for(const id of parsed.ids)add(['reference',id])
   else throw invalid()
   continue
  }
  if(typeof raw!=='string'&&!(field.type==='number'&&typeof raw==='number'||field.type==='boolean'&&typeof raw==='boolean'))throw invalid()
  const text=String(raw)
  if(text!==text.trim()||text.length>2000)throw invalid()
  switch(field.type){
   case 'number':{const value=Number(raw);if(!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)||!Number.isFinite(value)||Math.abs(value)>1e15)throw invalid();add(['number',String(value)]);break}
   case 'boolean':{const value=parseBooleanValue(typeof raw==='boolean'?raw:text);if(value===undefined)throw invalid();add(['boolean',value]);break}
   case 'duration':{const value=parseDurationSeconds(text);if(value===undefined)throw invalid();add(['duration',String(value)]);break}
   case 'reference':if(!isBusinessRecordId(text))throw invalid();add(['reference',raw]);break
   case 'enum':if(!field.values?.includes(text))throw invalid();add(['enum',raw]);break
   case 'datetime':if(!Number.isFinite(Date.parse(text))||new Date(text).toISOString()!==text)throw invalid();add(['datetime',raw]);break
   case 'text':add(['text',raw]);break
  }
 }
 return keys
}
