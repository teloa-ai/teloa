import {readBusinessObjectTypeDefinition,readBusinessObjectTypeDefinitionV2,readBusinessRichFieldValue,readBusinessRecordCreate,readBusinessRecordEdit,readBusinessRecordArchive,readBusinessRecordGet,taskInput,parseBooleanValue,parseDurationSeconds,type BusinessRichFieldDefinition,type BusinessRichMoneyFieldDefinition,type BusinessObjectSnapshot,type BusinessObjectTypeDefinition as BusinessObjectTypeV1,type BusinessObjectTypeDefinitionV2,type BusinessRecordCreate,type BusinessRecordEdit,type BusinessRecordArchive} from '@teloa/contract'
import type {BusinessRecordApi} from './business-record-api.js'
type BusinessObjectTypeDefinition=BusinessObjectTypeV1|BusinessObjectTypeDefinitionV2
export type BusinessRecordJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
export type BusinessRecordCapabilities={create:boolean;edit:boolean;archive:boolean}
export type BusinessRecordForm={kind:'create'|'edit'|'archive';title:string;summary:string;values:Record<string,string>;schema:string;definition:BusinessObjectTypeDefinition;base?:Pick<BusinessObjectSnapshot,'id'|'version'>}
type Mutation={kind:'create';input:BusinessRecordCreate}|{kind:'edit';input:BusinessRecordEdit}|{kind:'archive';input:BusinessRecordArchive}
export type BusinessRecordPhase='idle'|'saving'|'unknown'|'retryable'|'conflict'|'schema-changed'|'error'|'saved'|'recovery-error'
export type BusinessRecordState={phase:BusinessRecordPhase;form?:BusinessRecordForm|undefined;pending?:Mutation|undefined;errors:Record<string,string>;errorCode?:string|undefined;comparison?:BusinessObjectSnapshot|undefined;comparing:boolean;result?:BusinessObjectSnapshot|undefined}
const code=(error:unknown)=>error&&typeof error==='object'&&'code' in error?String(error.code):'teloa/transport-unknown'
const schema=(d:BusinessObjectTypeDefinition)=>d.format==='teloa.business-object-type/v1'?JSON.stringify([d.domain,d.id,d.sourceId,d.fields.map(f=>[f.name,f.from,f.type,f.required,f.values??null,f.referenceType??null])]):JSON.stringify([d.format,d.domain,d.id,d.sourceId,d.fields.map(f=>'format'in f?[f.format,f.name,f.from,f.type,f.required,f.type==='money'?f.currencies:f.type==='multi-reference'?f.referenceType:f.values]:[f.name,f.from,f.type,f.required,f.values??null,f.referenceType??null]),...(d.constraints?[d.constraints.uniqueFields]:[])])
const journalFormat=(d:BusinessObjectTypeDefinition)=>d.format==='teloa.business-object-type/v1'?'teloa.business-record-request/v1':'teloa.business-record-request/v2'
const locked=(s:BusinessRecordState)=>s.phase==='saving'||s.phase==='unknown'||s.phase==='retryable'||s.phase==='recovery-error'
export function businessRecordValues(definition:BusinessObjectTypeDefinition,snapshot:BusinessObjectSnapshot):Record<string,string>{
 return Object.fromEntries(definition.fields.map(field=>[field.name,snapshot.fields.find(item=>item.label===field.from)?.value??'']))
}
export function businessRecordErrors(definition:BusinessObjectTypeDefinition,form:BusinessRecordForm):Record<string,string>{
 const errors:Record<string,string>={}
 if(!form.title.trim())errors.$title='required'
 else if(form.title.trim().length>240)errors.$title='invalid'
 if(form.summary.trim().length>4000)errors.$summary='invalid'
 for(const field of definition.fields){
  if('format'in field){
   const raw=form.values[field.name]??''
   try{readBusinessRichFieldValue(field,raw)}catch{errors[field.name]=raw===''&&field.required?'required':'invalid'}
   continue
  }
  const value=(form.values[field.name]??'').trim()
  if(!value){if(field.required)errors[field.name]='required';continue}
  if(value.length>2000){errors[field.name]='invalid';continue}
  switch(field.type){
   case 'reference':try{readBusinessRecordGet({scope:definition.domain,type:field.referenceType,id:value})}catch{errors[field.name]='invalid'};break
   case 'enum':if(!field.values?.includes(value))errors[field.name]='invalid';break
   case 'boolean':if(parseBooleanValue(value)===undefined)errors[field.name]='invalid';break
   case 'duration':if(parseDurationSeconds(value)===undefined)errors[field.name]='invalid';break
   case 'number':if(!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)||!Number.isFinite(Number(value))||Math.abs(Number(value))>1e15)errors[field.name]='invalid';break
   case 'datetime':if(!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)errors[field.name]='invalid';break
  }
 }
 return errors
}
/** 每个本人 API 生命周期持有一个 flow；按业务/对象类型保留未知请求和未完成编辑。 */
export class BusinessRecordFlow{
 readonly api:BusinessRecordApi
 private readonly id:()=>string
 private readonly journal:((scope:string,type:string)=>BusinessRecordJournal)|undefined
 private readonly sessions=new Map<string,BusinessRecordSession>()
 constructor(api:BusinessRecordApi,id:()=>string=()=>crypto.randomUUID(),journal?:(scope:string,type:string)=>BusinessRecordJournal){this.api=api;this.id=id;this.journal=journal}
 forTarget(scope:string,type:string):BusinessRecordSession{
  const key=JSON.stringify([scope,type]);let session=this.sessions.get(key)
  if(!session){session=new BusinessRecordSession(this.api,this.id,scope,type,this.journal?.(scope,type));this.sessions.set(key,session)}
  return session
 }
}
export class BusinessRecordSession{
 readonly scope:string;readonly type:string
 private readonly api:BusinessRecordApi;private readonly id:()=>string
 private readonly journal:BusinessRecordJournal|undefined
 private definition?:BusinessObjectTypeDefinition
 private capabilities:BusinessRecordCapabilities={create:false,edit:false,archive:false}
 private state:BusinessRecordState={phase:'idle',errors:{},comparing:false}
 private readonly listeners=new Set<()=>void>()
 constructor(api:BusinessRecordApi,id:()=>string,scope:string,type:string,journal?:BusinessRecordJournal){
  this.api=api;this.id=id;this.scope=scope;this.type=type;this.journal=journal
  try{
   if(!journal)return
   const raw=journal.read();if(raw===null)return
   if(raw.length>150000)throw Error()
   const row=taskInput(JSON.parse(raw),['format','schema','definition','mutation'])
   if(!['teloa.business-record-request/v1','teloa.business-record-request/v2'].includes(String(row.format))||typeof row.schema!=='string'||row.schema.length>50000)throw Error()
   const definition=row.format==='teloa.business-record-request/v2'?readBusinessObjectTypeDefinitionV2(row.definition):readBusinessObjectTypeDefinition(row.definition)
   if(schema(definition)!==row.schema||definition.domain!==scope||definition.id!==type)throw Error()
   const value=taskInput(row.mutation,['kind','input'])
   const pending:Mutation=value.kind==='create'?{kind:'create',input:readBusinessRecordCreate(value.input)}:value.kind==='edit'?{kind:'edit',input:readBusinessRecordEdit(value.input)}:value.kind==='archive'?{kind:'archive',input:readBusinessRecordArchive(value.input)}:(()=>{throw Error()})()
   if(pending.input.scope!==scope||pending.input.type!==type)throw Error()
   const form:BusinessRecordForm={kind:pending.kind,title:'title'in pending.input?pending.input.title??'':'',summary:'summary'in pending.input?pending.input.summary??'':'',definition,values:'fields'in pending.input?Object.fromEntries(pending.input.fields.map(f=>[f.name,f.value])):{},schema:row.schema,...(pending.kind==='create'?{}:{base:{id:pending.input.id,version:pending.input.expectedVersion}})}
   this.state={...this.state,phase:'unknown',pending,form}
  }catch{this.state={...this.state,phase:'recovery-error',errorCode:'teloa/recovery-storage-unavailable'}}
 }
 getSnapshot=()=>this.state
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}}
 private update(patch:Partial<BusinessRecordState>){this.state={...this.state,...patch};for(const listener of this.listeners)listener()}
 configure(definition:BusinessObjectTypeDefinition,capabilities:BusinessRecordCapabilities){
  if(definition.domain!==this.scope||definition.id!==this.type)throw Error('记录页面范围不一致。')
  this.definition=definition;this.capabilities=capabilities
  if(this.state.form&&this.state.form.schema!==schema(definition)&&!locked(this.state)&&this.state.phase!=='schema-changed')this.update({phase:'schema-changed'})
 }
 private allowed(kind:BusinessRecordForm['kind']){
  if(!this.definition||!this.capabilities[kind])throw Error('记录只读或没有此操作权限。')
  return this.definition
 }
 private start(kind:BusinessRecordForm['kind'],base?:BusinessObjectSnapshot){
  if(this.state.phase==='recovery-error')throw Error('恢复存储不可用，请保留原页。')
  if(locked(this.state))throw Error('操作在途或结果未知，请先核对。')
  const d=this.allowed(kind)
  if(base&&(base.scope!==this.scope||base.type!==this.type||base.deletedAt))throw Error('该记录不允许修改。')
  this.update({form:{kind,title:base?.title??'',summary:base?.summary??'',values:base?businessRecordValues(d,base):{},schema:schema(d),definition:d,...(base?{base}:{})},phase:'idle',errors:{},errorCode:undefined,pending:undefined,comparison:undefined,result:undefined})
 }
 create(){this.start('create')}
 edit(base:BusinessObjectSnapshot){this.start('edit',base)}
 archive(base:BusinessObjectSnapshot){this.start('archive',base)}
 change(field:string,value:string){
  if(locked(this.state))throw Error('操作在途或结果未知，不能修改原请求。')
  if(this.state.phase==='conflict'||this.state.phase==='schema-changed')throw Error('请先核对版本或重新打开表单，原稿已冻结。')
  const form=this.state.form;if(!form)return
  this.update({form:field==='title'||field==='summary'?{...form,[field]:value}:{...form,values:{...form.values,[field]:value}},errors:{...this.state.errors,[field==='title'||field==='summary'?'$'+field:field]:''}})
 }
 changeField(field:string,value:string){
  if(locked(this.state))throw Error('操作在途或结果未知，不能修改原请求。')
  if(this.state.phase==='conflict'||this.state.phase==='schema-changed')throw Error('请先核对版本或重新打开表单，原稿已冻结。')
  const form=this.state.form;if(!form)return
  this.update({form:{...form,values:{...form.values,[field]:value}},errors:{...this.state.errors,[field]:''}})
 }
 cancel(){if(locked(this.state))throw Error('操作在途或结果未知，请先核对。');this.update({form:undefined,pending:undefined,phase:'idle',errors:{},comparison:undefined,errorCode:undefined})}
 async save(){
  if(this.state.phase==='recovery-error'||locked(this.state)||this.state.phase==='conflict'||this.state.phase==='schema-changed'||!this.state.form)return
  const form=this.state.form
  let d:BusinessObjectTypeDefinition
  try{d=this.allowed(form.kind)}catch{this.update({phase:'error',errorCode:'teloa/forbidden'});return}
  if(form.schema!==schema(d)){this.update({phase:'schema-changed'});return}
  const errors=form.kind==='archive'?{}:businessRecordErrors(d,form)
  if(Object.keys(errors).length){this.update({errors});return}
  const requestId=this.id(),target={scope:this.scope,type:this.type,requestId}
  const fields=d.fields.map(f=>({name:f.name,value:'format'in f?(form.values[f.name]??''):(form.values[f.name]??'').trim()}))
  const mutation:Mutation=form.kind==='create'?{kind:'create',input:{...target,title:form.title.trim(),summary:form.summary.trim(),fields}}:form.kind==='edit'?{kind:'edit',input:{...target,id:form.base!.id,expectedVersion:form.base!.version,title:form.title.trim(),summary:form.summary.trim(),fields}}:{kind:'archive',input:{...target,id:form.base!.id,expectedVersion:form.base!.version}}
  await this.send(mutation)
 }
 private complete(mutation:Mutation,result:BusinessObjectSnapshot){
  if(result.scope!==this.scope||result.type!==this.type||(mutation.kind!=='create'&&(result.id!==mutation.input.id||result.version!==mutation.input.expectedVersion+1))||(mutation.kind==='create'&&result.version!==1)||(mutation.kind==='archive'?!result.deletedAt:!!result.deletedAt))throw Object.assign(Error('回执与原操作不一致。'),{code:'teloa/invalid-host-response'})
  if(mutation.kind!=='archive'){
   const input=mutation.input,definition=this.state.form?.definition
   const supplied=new Map(input.fields.map(field=>[field.name,field.value]))
   // 与后端一致：保留原字符串，按原定义的 from 存储，空选填值不生成字段。
   const expected=definition?.fields.flatMap(field=>{const value=supplied.get(field.name);return value===undefined||value===''?[]:[{label:field.from,value}]})
   if(!definition||input.fields.some(field=>!definition.fields.some(defined=>defined.name===field.name))||
    (input.title!==undefined&&result.title!==input.title)||(input.summary!==undefined&&result.summary!==input.summary)||
    !expected||expected.length!==result.fields.length||expected.some(field=>result.fields.filter(actual=>actual.label===field.label&&actual.value===field.value).length!==1))
    throw Object.assign(Error('回执正文与原操作不一致。'),{code:'teloa/invalid-host-response'})
  }
  this.journal?.clear()
  this.update({phase:'saved',result,form:undefined,pending:undefined,errorCode:undefined,errors:{},comparison:undefined})
 }
 private async send(mutation:Mutation){
  try{this.journal?.write(JSON.stringify({format:journalFormat(this.state.form!.definition),schema:this.state.form!.schema,definition:this.state.form!.definition,mutation}))}
  catch{this.update({phase:'recovery-error',pending:mutation,errorCode:'teloa/recovery-storage-unavailable'});return}
  this.update({phase:'saving',pending:mutation,errorCode:undefined})
  try{
   const result=mutation.kind==='create'?await this.api.create(mutation.input):mutation.kind==='edit'?await this.api.edit(mutation.input):await this.api.archive(mutation.input)
   this.complete(mutation,result)
  }catch(error){
   const errorCode=code(error)
   const details=error&&typeof error==='object'&&'details'in error?error.details as {field?:unknown;reason?:unknown}:undefined
   if(errorCode==='teloa/version-conflict'){
    try{this.journal?.clear()}catch{this.update({phase:'unknown',errorCode:'teloa/recovery-storage-unavailable'});return}
    this.update({phase:'conflict',pending:undefined,errorCode});return}
   if(['teloa/invalid-input','teloa/forbidden','teloa/not-found'].includes(errorCode)||errorCode==='teloa/conflict'&&details?.reason==='unique-field'){
    try{this.journal?.clear()}catch{this.update({phase:'unknown',errorCode:'teloa/recovery-storage-unavailable'});return}
    const field=details?.field
    this.update({phase:'error',pending:undefined,errorCode,errors:typeof field==='string'?{[field]:details?.reason==='unique-field'?'unique':'invalid'}:{}});return
   }
   this.update({phase:'unknown',errorCode})
  }
 }
 async recover(){
  const pending=this.state.pending;if(!pending||this.state.phase==='saving')return
  if(this.state.phase==='recovery-error'){
   try{this.journal?.write(JSON.stringify({format:journalFormat(this.state.form!.definition),schema:this.state.form!.schema,definition:this.state.form!.definition,mutation:pending}))}catch{return}
  }
  this.update({phase:'saving',errorCode:undefined})
  try{
   const receipt=await this.api.receipt({requestId:pending.input.requestId})
   if(receipt)this.complete(pending,receipt)
   else this.update({phase:'retryable'})
  }catch(error){this.update({phase:'unknown',errorCode:code(error)})}
 }
 async retry(){
  if(this.state.phase!=='retryable')return
  const pending=this.state.pending!
  await this.recover()
  if(this.state.phase!=='retryable')return
  try{
   const d=this.allowed(pending.kind)
   if(!this.state.form||this.state.form.schema!==schema(d)){this.update({errorCode:'teloa/schema-changed'});return}
  }catch{this.update({errorCode:'teloa/forbidden'});return}
  await this.send(pending)
 }
 async compare(){
  const form=this.state.form;if(!form?.base||this.state.comparing||locked(this.state))return
  this.update({comparing:true,errorCode:undefined})
  try{
   const comparison=await this.api.get({scope:this.scope,type:this.type,id:form.base.id})
   if(this.state.form===form)this.update({comparison})
  }catch(error){this.update({errorCode:code(error)})}
  finally{this.update({comparing:false})}
 }
 useComparedVersion(){
  const {form,comparison}=this.state
  if(!form||!comparison||comparison.deletedAt||locked(this.state))return
  if(!this.definition||form.schema!==schema(this.definition)){this.update({phase:'schema-changed'});return}
  this.update({form:{...form,base:comparison},phase:'idle',comparison:undefined,errorCode:undefined})
 }
}

/** 编辑输入使用十进制字符串；只移除无意义的小数零，不经 Number。 */
export function businessMoneyValue(field:BusinessRichMoneyFieldDefinition,currency:string,amount:string):string{
 if(amount==='')return ''
 let decimal=amount
 if(/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,4})?$/.test(amount)){
  if(decimal.includes('.'))decimal=decimal.replace(/0+$/,'').replace(/\.$/,'')
  if(decimal==='-0')decimal='0'
 }
 return JSON.stringify({currency,decimal})
}
export function businessMoneyInput(field:BusinessRichMoneyFieldDefinition,raw:string):{currency:string;amount:string;raw?:string}{
 const blank={currency:field.currencies[0]!,amount:''}
 if(raw==='')return blank
 try{const value=readBusinessRichFieldValue(field,raw);if(value?.type==='money')return {currency:value.currency,amount:value.decimal}}catch{}
 return {...blank,raw}
}
/** 仅解析经过契约认可的值用于展示；非法历史值保持原文供用户核对。 */
export function businessRichRecordDisplay(field:BusinessRichFieldDefinition,raw:string,separator='、'):string{
 if(field.type==='multi-reference')return '—'
 try{const value=readBusinessRichFieldValue(field,raw);return value?.type==='money'?value.currency+' '+value.decimal:value?.type==='multi-enum'?value.values.join(separator):'—'}catch{return raw}
}

export type BusinessDurationUnit='second'|'minute'|'hour'|'day'
const durationUnits:Record<BusinessDurationUnit,bigint>={second:1n,minute:60n,hour:3600n,day:86400n}
function decimalParts(value:string):[bigint,bigint]{
 const [whole,fraction='']=value.split('.');return [BigInt(whole!+fraction),10n**BigInt(fraction.length)]
}
/** 十进制展示换算用整数分子/分母；不将用户原文先转 float 再截断。 */
function decimalText(numerator:bigint,denominator:bigint,maxDigits=24):string|undefined{
 const whole=numerator/denominator;let remainder=numerator%denominator,fraction=''
 for(let i=0;remainder&&i<maxDigits;i++){remainder*=10n;fraction+=String(remainder/denominator);remainder%=denominator}
 if(remainder)return undefined
 return String(whole)+(fraction?'.'+fraction:'')
}
export function businessDurationValue(amount:string,unit:BusinessDurationUnit):string{
 if(amount==='')return ''
 if(!/^\d+(?:\.\d+)?$/.test(amount)||amount.length>2000)return amount
 const [value,scale]=decimalParts(amount)
 return decimalText(value*durationUnits[unit],scale,amount.length+6)??amount
}
export function businessDurationInput(raw:string):{amount:string;unit:BusinessDurationUnit;raw?:string}{
 if(!raw)return {amount:'',unit:'second'}
 const parsed=parseDurationSeconds(raw),preserved={amount:'',unit:'second' as const,raw}
 if(parsed===undefined)return preserved
 // 只在共享解析器认可后提取数值；此处负责展示换算，不另立时长语法。
 const parts=/^\d+(?:\.\d+)?$/.test(raw)?[[raw,1n] as const]:[...raw.matchAll(/(\d+(?:\.\d+)?)([WDHMS])/g)].map(match=>[match[1]!,({W:604800n,D:86400n,H:3600n,M:60n,S:1n} as Record<string,bigint>)[match[2]!]!] as const)
 let numerator=0n,scale=1n
 for(const [amount,factor] of parts){const [value,denominator]=decimalParts(amount);const next=denominator>scale?denominator:scale;numerator=numerator*(next/scale)+value*factor*(next/denominator);scale=next}
 const seconds=decimalText(numerator,scale)
 if(seconds===undefined||String(parsed)!==seconds)return preserved
 for(const unit of ['day','hour','minute','second'] as const){
  const denominator=scale*durationUnits[unit]
  if(numerator<denominator&&unit!=='second')continue
  const amount=decimalText(numerator,denominator)
  if(amount!==undefined)return {amount,unit}
 }
 return preserved
}
