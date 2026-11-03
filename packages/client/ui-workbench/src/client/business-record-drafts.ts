import {isRecord,readBusinessObjectTypeDefinition,readBusinessObjectTypeDefinitionV2,readBusinessRecordGet,taskInput} from '@teloa/contract'
import type {BusinessRecordForm} from './business-record-flow.ts'

type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>&Partial<Pick<globalThis.Storage,'length'|'key'>>
type Target=Pick<BusinessRecordForm,'kind'|'base'>
const identity=(scope:string,type:string,form:Target)=>JSON.stringify([scope,type,form.kind,form.base?.id??null])
const plain=(form:BusinessRecordForm):BusinessRecordForm=>({...structuredClone(form),...(form.base?{base:{id:form.base.id,version:form.base.version}}:{})})
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max

const numericSchema=(field:BusinessRecordForm['definition']['fields'][number])=>!('format'in field)&&(field.integer||field.minimum!==undefined||field.decimalScale!==undefined)?[field.integer??null,field.minimum??null,...(field.decimalScale===undefined?[]:[field.decimalScale])]:[]
export const businessRecordSchema=(d:BusinessRecordForm['definition'])=>d.format==='teloa.business-object-type/v1'?JSON.stringify([d.domain,d.id,d.sourceId,d.fields.map(f=>[f.name,f.from,f.type,f.required,f.values??null,f.referenceType??null,...numericSchema(f)])]):JSON.stringify([d.format,d.domain,d.id,d.sourceId,d.fields.map(f=>'format'in f?[f.format,f.name,f.from,f.type,f.required,f.type==='money'?f.currencies:f.type==='multi-reference'?f.referenceType:f.values]:[f.name,f.from,f.type,f.required,f.values??null,f.referenceType??null,...numericSchema(f)]),...(d.constraints?[d.constraints.uniqueFields]:[])])

export class BusinessRecordDraftConflict extends Error{
 readonly forms:BusinessRecordForm[]
 constructor(forms:BusinessRecordForm[]){super('另一页也有此记录的草稿，请明确核对。');this.forms=structuredClone(forms)}
}
type Revision={raw:string;writer:string;revision:number;seen:Record<string,number>;form:BusinessRecordForm}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value)

/** 每个编辑器只写自己的分支；成功仅标记精确修订，不对共享键执行比较后删除。 */
export function createBusinessRecordDrafts(input?:{namespace:string;storage:Storage}){
 const rows=new Map<string,string>(),memory=new Map<string,string>(),blocked=new Set<string>(),frontiers=new Map<string,Record<string,number>>()
 const storage:Storage=input?.storage??{get length(){return rows.size},key:index=>[...rows.keys()][index]??null,getItem:key=>rows.get(key)??null,setItem:(key,value)=>{rows.set(key,value)},removeItem:key=>{rows.delete(key)}}
 const writer=crypto.randomUUID();let revision=0
 const key=(scope:string,type:string,form:Target)=>(input?.namespace??'memory')+'/record-drafts/v2/'+encodeURIComponent(identity(scope,type,form))
 function decode(raw:string,scope:string,type:string,target:Target):Revision{
  if(raw.length>150000)throw Error('草稿过大。')
  const row=taskInput(JSON.parse(raw),['format','namespace','scope','type','writer','revision','seen','form'])
  if(row.format!=='teloa.business-record-draft/v2'||row.namespace!==(input?.namespace??'memory')||row.scope!==scope||row.type!==type||!uuid(row.writer)||!Number.isSafeInteger(row.revision)||Number(row.revision)<1||!isRecord(row.seen)||Object.entries(row.seen).some(([id,v])=>!uuid(id)||!Number.isSafeInteger(v)||Number(v)<1))throw Error('草稿归属不一致。')
  const form=taskInput(row.form,['kind','title','summary','values','schema','definition','base','originalValues'])
  if(form.kind!==target.kind||!text(form.title,240)||!text(form.summary,4000)||!text(form.schema,50000)||!isRecord(form.values)||Object.values(form.values).some(value=>!text(value,60000)))throw Error('草稿内容不可读。')
  const definition=isRecord(form.definition)&&form.definition.format==='teloa.business-object-type/v2'?readBusinessObjectTypeDefinitionV2(form.definition):readBusinessObjectTypeDefinition(form.definition)
  if(businessRecordSchema(definition)!==form.schema||definition.domain!==scope||definition.id!==type||Object.keys(form.values).some(name=>!definition.fields.some(field=>field.name===name)))throw Error('草稿定义不一致。')
  if(form.kind==='create'){if(form.base!==undefined||target.base!==undefined)throw Error('新建草稿不能带原记录。')}
  else{const base=taskInput(form.base,['id','version']);readBusinessRecordGet({scope,type,id:base.id,version:base.version});if(base.id!==target.base?.id)throw Error('草稿不属于该记录。')}
  if(form.originalValues!==undefined&&(!isRecord(form.originalValues)||Object.entries(form.originalValues).some(([name,value])=>!definition.fields.some(field=>field.name===name)||!(typeof value==='string'&&value.length<=60000||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)))))throw Error('草稿原值不可读。')
  return {raw,writer:row.writer,revision:Number(row.revision),seen:row.seen as Record<string,number>,form:structuredClone({...form,definition}) as BusinessRecordForm}
 }
 function scan(scope:string,type:string,target:Target){
  const name=key(scope,type,target),prefix=name+'/writers/'
  if(typeof storage.key!=='function'||typeof storage.length!=='number')throw Error('此存储不支持草稿分支读取。')
  const values=new Map<string,string>()
  for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k?.startsWith(prefix)){const raw=storage.getItem(k);if(raw!==null)values.set(k,raw)}}
  for(const [k,raw] of memory)if(k.startsWith(prefix))values.set(k,raw)
  const all=[...values].map(([k,raw])=>{const row=decode(raw,scope,type,target);if(k!==prefix+row.writer)throw Error('草稿分支身份不一致。');return row})
  const heads=all.filter(row=>storage.getItem(name+'/saved/'+row.writer+'/'+row.revision)!=='1'&&!all.some(other=>other.writer!==row.writer&&(other.seen[row.writer]??0)>=row.revision))
  return {name,all,heads}
 }
 const observed=(all:Revision[])=>{const seen:Record<string,number>={};for(const row of all){for(const [id,n] of Object.entries(row.seen))seen[id]=Math.max(seen[id]??0,n);seen[row.writer]=Math.max(seen[row.writer]??0,row.revision)}return seen}
 const store={
  read(scope:string,type:string,target:Target):BusinessRecordForm|undefined{
   const name=key(scope,type,target)
   try{const {all,heads}=scan(scope,type,target);if(heads.length>1)throw new BusinessRecordDraftConflict(heads.map(row=>row.form));frontiers.set(name,observed(all));return heads[0]?.form}
   catch(error){if(!(error instanceof BusinessRecordDraftConflict))blocked.add(name);throw error}
  },
  write(scope:string,type:string,form:BusinessRecordForm):string{
   const name=key(scope,type,form),seen=frontiers.get(name)??{},n=++revision,raw=JSON.stringify({format:'teloa.business-record-draft/v2',namespace:input?.namespace??'memory',scope,type,writer,revision:n,seen,form:plain(form)}),slot=name+'/writers/'+writer
   if(raw.length>150000)throw Error('草稿过大。')
   memory.set(slot,raw)
   if(blocked.has(name))throw Error('草稿恢复存储不可用。')
   storage.setItem(slot,raw);if(storage.getItem(slot)!==raw)throw Error('草稿未可靠保存。')
   memory.delete(slot);frontiers.set(name,{...seen,[writer]:n})
   const {heads}=scan(scope,type,form)
   if(heads.length!==1||heads[0]?.raw!==raw)throw new BusinessRecordDraftConflict([form,...heads.filter(row=>row.raw!==raw).map(row=>row.form)])
   return raw
  },
  resolve(scope:string,type:string,form:BusinessRecordForm):string{
   const {name,all}=scan(scope,type,form)
   // 本人明确选用前保留两份原文，字段删除/换型也不丢失旧输入。
   for(const row of all)storage.setItem(name+'/preserved/'+row.writer+'/'+row.revision,row.raw)
   frontiers.set(name,observed(all));return store.write(scope,type,form)
  },
  clearMatching(scope:string,type:string,form:Target,expected:string|undefined){
   if(expected===undefined)return
   const row=decode(expected,scope,type,form),marker=key(scope,type,form)+'/saved/'+row.writer+'/'+row.revision
   storage.setItem(marker,'1');if(storage.getItem(marker)!=='1')throw Error('草稿未能结清。')
  },
 }
 return store
}
export type BusinessRecordDrafts=ReturnType<typeof createBusinessRecordDrafts>
