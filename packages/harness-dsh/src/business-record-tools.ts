import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {createUserMessage,type ContextFormed} from '@deepseek-ai/dsh-llm'
import {defineTool,type ToolExecution,type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,readBusinessRecordBatch,readBusinessRecordGet,readBusinessRecordList,readBusinessRecordReceipt,readBusinessRecordSnapshot,readBusinessRecordPage,readBusinessObjectTypeDefinitionVersioned,readBusinessRichFieldValue,businessObjectReference,type BusinessRecordBatch,type BusinessRecordBatchResult,type BusinessObjectSnapshot,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2} from '@teloa/contract'
import {assertBusinessRecordFieldValue,type BusinessDefinitionBundleVersioned,type BusinessRecordService} from '@teloa/backend'
import {authorizeBusinessConversation,type BusinessConversationAuthorizationPorts} from './business-conversation-authorization.ts'
import {readConversationInstructionIdentity,type ConversationInstructionIdentity} from './conversation-instruction-identity.ts'

export const businessRecordToolNames=['teloa_business_records_read','teloa_business_records_write'] as const
type Actor={ownerId:string;scopeIds:string[]}
export type BusinessRecordToolsPorts=BusinessConversationAuthorizationPorts&{
 /** 只读当前已采用来源；生产装配在自己的只读事务中调用 forScopeVersioned。 */
 definitions:(actor:Actor,scope:string)=>Promise<BusinessDefinitionBundleVersioned[]>
 records:Pick<BusinessRecordService,'list'|'get'|'batch'|'batchReceipt'|'recentBatches'>
}
const source='plugin:teloa.business-records' as const
declare module '@deepseek-ai/dsh-llm' {interface MessageSourceMap {'plugin:teloa.business-records':{kind:typeof source}&ContextFormed}}
const names=new Set<string>(businessRecordToolNames),requestBytes=131072,responseBytes=262144
const invalid=()=>new WorkError('teloa/invalid-input','本地记录工具参数或完整字段值不正确。')
const bad=()=>new WorkError('teloa/invalid-host-response','记录回执与原业务、请求或版本不一致，请核对原请求。')
function json(value:unknown,max=responseBytes){const result=JSON.stringify(value);if(Buffer.byteLength(result,'utf8')>max)throw new WorkError('teloa/invalid-input','本地记录内容超过大小上限，请缩小批次或分页、精确读取。');return result}
const cursor=(value:unknown):string|undefined=>{if(value===undefined)return undefined;if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>2048)throw invalid();return value}
function readQuery(value:unknown,scope:string){
 const row=taskInput(value,['mode','type','id','version','requestId','cursor','limit']),mode=row.mode??'directory'
 switch(mode){
  case 'directory':{taskInput(value,['mode','cursor']);if(row.cursor!==undefined&&(!Number.isSafeInteger(row.cursor)||Number(row.cursor)<0))throw invalid();return {mode:'directory',cursor:row.cursor===undefined?0:Number(row.cursor)} as const}
  case 'type':{taskInput(value,['mode','type']);const input=readBusinessRecordList({scope,type:row.type,limit:1});return {mode:'type',type:input.type} as const}
  case 'list':{taskInput(value,['mode','type','cursor','limit']);return {mode:'list',input:readBusinessRecordList({scope,type:row.type,limit:row.limit??20,...(row.cursor===undefined?{}:{cursor:row.cursor})})} as const}
  case 'get':{taskInput(value,['mode','type','id','version']);return {mode:'get',input:readBusinessRecordGet({scope,type:row.type,id:row.id,...(row.version===undefined?{}:{version:row.version})})} as const}
  case 'receipt':{taskInput(value,['mode','requestId']);return {mode:'receipt',input:readBusinessRecordReceipt({requestId:row.requestId})} as const}
  case 'recent-writes':{taskInput(value,['mode','cursor']);return {mode:'recent-writes',cursor:cursor(row.cursor)} as const}
  default:throw invalid()
 }
}
/** 固定操作域不含 toolCallId、参数哈希或轮次重试次数；同本人指令只能提交一批意图。 */
function requestId(owner:string,source:ConversationInstructionIdentity){const h=createHash('sha256').update(JSON.stringify(['teloa.business-record-write/v1',owner,source.sessionId,source.messageId,source.seq])).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
function writeInput(args:unknown,scope:string,id:string){const row=taskInput(args,['operations']),value=readBusinessRecordBatch({scope,requestId:id,operations:row.operations});json(value,requestBytes);return value}
function reference(item:BusinessObjectSnapshot){return businessObjectReference({scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash})}
function receipt(value:BusinessRecordBatchResult,scope:string,id:string,input?:BusinessRecordBatch){
 if(!value||Object.keys(value).some(key=>!['requestId','scope','items'].includes(key))||value.scope!==scope||value.requestId!==id||!Array.isArray(value.items)||value.items.length<1||value.items.length>50||input&&input.operations.length!==value.items.length)throw bad()
 const items=value.items.map((raw,index)=>{
  const item=readBusinessRecordSnapshot(raw,scope),op=input?.operations[index]
  if(op&&(item.type!==op.type||item.version!==(op.operation==='create'?1:op.expectedVersion+1)||op.operation!=='create'&&item.id!==op.id||(op.operation==='archive'?!item.deletedAt:!!item.deletedAt)))throw bad()
  return {...(op?{operation:op.operation}:{}),...reference(item)}
 })
 if(new Set(items.map(item=>JSON.stringify([item.type,item.id]))).size!==items.length)throw bad()
 return {requestId:id,scope,items}
}
const recentNotice='这里只发现当前会话已提交的批次；空结果不能证明没有在途、取消或失败请求，不得据此用新指令身份重复写入。'
/** 只说明实际声明的富字段，示例沿真实币种和选项；基础字段回包保持原样。 */
function richValueRules(definitions:readonly (BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2)[]):string{
 const fields=definitions.flatMap(definition=>definition.format==='teloa.business-object-type/v2'?definition.fields.filter(field=>'format' in field):[])
 if(!fields.length)return ''
 const money=fields.find(field=>field.type==='money'),multi=fields.find(field=>field.type==='multi-enum'),rules:string[]=[]
 if(money)rules.push('money 的 fields[].value 必须是规范 JSON 字符串（JSON.stringify 的结果，无额外空格），键顺序为 currency、decimal。currency 使用声明 currencies 中的三字母大写 ISO 币种代码；decimal 是十进制字符串，最多18位整数和4位小数，无多余尾零、科学计数法或负零，不能转为浮点数。编码示例：'+JSON.stringify({currency:money.currencies[0],decimal:'123.45'})+'。')
 if(multi)rules.push('multi-enum 的 fields[].value 必须是规范 JSON 字符串（JSON.stringify 的结果，无额外空格），内容为按 values 声明顺序排列、无重复的非空选项数组；编码示例：'+JSON.stringify(multi.values.slice(0,2))+'。')
 return rules.join('')+'可选字段新增时可省略以表示缺值；编辑 fields 仍须完整提供，用空字符串明确清空，不得用 [] 或空金额对象表示缺值。required 字段不得省略或清空。'
}
function referenceValueRules(definitions:readonly (BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2)[]):string{
 const fields=definitions.flatMap(definition=>definition.fields),rules:string[]=[]
 if(fields.some(field=>field.type==='reference'))rules.push('reference 是同业务本地记录单选关联，fields[].value 只保存目标原始 ID 字符串，不能保存标题或 JSON。')
 if(fields.some(field=>field.type==='multi-reference'))rules.push('multi-reference 是同业务本地记录多选关联，声明 referenceType；fields[].value 为 JSON.stringify 编码的规范 JSON 字符串，内容是按 ID 字典序排列、无重复的 1–32 个真实目标原始 ID 数组，编码总长不超过2000字符，不保存标题、不截断。')
 if(!rules.length)return ''
 return rules.join('')+'先按字段 referenceType 用 list/get 读取每个真实目标标题与状态。目标须属于当前本人、当前业务与已采用本地类型，且存在、未归档；编辑提交的所有非空关联都会逐目标重查，失效旧值须清空或改绑，不能保留失效成员。可选关联用空字符串清空，required 不得省略或清空；[] 不是缺值。跨业务关联尚未支持。'
}
function uniqueValueRules(definitions:readonly (BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2)[]):string{
 return definitions.some(definition=>definition.format==='teloa.business-object-type/v2'&&definition.constraints)?'constraints.uniqueFields 声明字段在同业务同类型活跃记录中独立唯一，不是组合唯一。可选空值不占用；文本、枚举、单关联精确匹配，数字按数值，布尔、时长按既有解析，金额按币种及精确金额；multi-reference 每个成员不能被另一活跃源记录占用，归档源释放占用。唯一性由后端事务按全部操作后态重新核验，允许合法交换；list 预查不能保证唯一或避免并发冲突，真实成功回执才表示保存。':''
}
/** 复用官方 exec 冻结参数与确认生命周期；WeakMap 只保存本次审批的身份和只读核验摘要。 */
export function registerBusinessRecordTools(ctx:Context,ports:BusinessRecordToolsPorts){
 const authorizeScope=(exec:Pick<ToolExecution,'agent'|'signal'>)=>authorizeBusinessConversation(ports,exec,'本地业务记录')
 const authorize=async(exec:Pick<ToolExecution,'agent'|'signal'>)=>({...await authorizeScope(exec),instruction:readConversationInstructionIdentity(exec.agent!)})
 type Authorized=Awaited<ReturnType<typeof authorize>>
 const types=async(current:Pick<Authorized,'actor'|'scope'>)=>{
  const bundles=await ports.definitions(current.actor,current.scope)
  const rows=bundles.flatMap(bundle=>{
   if(bundle.scope!==current.scope||bundle.domain!==current.scope||bundle.origin.kind==='configuration-preview')throw bad()
   return bundle.objectTypes.map(row=>{
    const definition=readBusinessObjectTypeDefinitionVersioned(row.definition)
    if(definition.domain!==current.scope||row.source.scope!==current.scope||row.source.localId!==definition.id)throw bad()
    const local=bundle.origin.kind==='local-configuration'&&bundle.sources.has(definition.sourceId)
    return {definition,local,writable:local,origin:bundle.origin,source:row.source}
   })
  })
  if(new Set(rows.map(row=>row.definition.id)).size!==rows.length)throw bad()
  return rows.map(row=>({...row,writable:row.local&&row.definition.fields.every(field=>field.type!=='reference'&&field.type!=='multi-reference'||rows.some(target=>target.definition.id===field.referenceType&&target.local))}))
 }
 type TypeRow=Awaited<ReturnType<typeof types>>[number]
 const target=(rows:TypeRow[],type:string)=>{const found=rows.find(row=>row.definition.id===type);if(!found||!found.local)throw new WorkError('teloa/invalid-input','当前类型不支持本地记录，请先读取真实类型目录。');return found}
 const values=(row:TypeRow,snapshot:BusinessObjectSnapshot)=>row.definition.fields.map(field=>({name:field.name,value:snapshot.fields.find(value=>value.label===field.from)?.value??''}))
 const readSnapshotResult=(current:Authorized,targetInput:ReturnType<typeof readBusinessRecordGet>,value:unknown)=>{
  const result=readBusinessRecordSnapshot(value,current.scope)
  if(result.type!==targetInput.type||result.id!==targetInput.id||targetInput.version!==undefined&&result.version!==targetInput.version)throw bad()
  return result
 }
 const get=async(current:Authorized,input:Parameters<BusinessRecordService['get']>[1])=>{
  const targetInput=readBusinessRecordGet(input)
  return readSnapshotResult(current,targetInput,await ports.records.get(current.actor,targetInput))
 }
 const prepare=async(current:Authorized,input:BusinessRecordBatch)=>{
  const prior=await ports.records.batchReceipt(current.actor,{requestId:input.requestId})
  // 旧回执先于当前字段/版本预检查；真正重放仍由 batch 核原哈希及可信 source，不能用 receipt 冒充成功。
  if(prior!==undefined&&prior!==null){receipt(prior,current.scope,input.requestId);return {replay:true,fingerprint:'',summary:{requestId:input.requestId,note:'发现已提交回执；只核对原请求及来源，不新增变更。',operations:input.operations}}}
  const rows=await types(current),checks:unknown[]=[],operations:unknown[]=[]
  // 只保留最多32项目标摘要，避免最大批次把全部目标快照留在内存；执行阶段重新准备。
  type Relation={id:string;title?:string;status:'已归档'|'可用'|'不存在';reference?:ReturnType<typeof reference>}
  const targets=new Map<string,Relation>()
  const relation=async(type:string,id:string,requireActive:boolean)=>{
   const targetInput=readBusinessRecordGet({scope:current.scope,type,id})
   target(rows,type)
   const key=JSON.stringify([type,id])
   if(!targets.has(key)){
    let value:unknown,missing=false
    // 参数、范围和本地类型已在 catch 外核定；真实服务无 head/历史时仍沿公开 invalid-input 契约。
    try{value=await ports.records.get(current.actor,targetInput)}catch(error){if(!requireActive&&error instanceof WorkError&&['teloa/not-found','teloa/invalid-input'].includes(error.code))missing=true;else throw error}
    // 坏快照的解析或身份错误不能冒充目标不存在。
    const snapshot=missing?undefined:readSnapshotResult(current,targetInput,value)
    if(targets.size>=32)targets.clear()
    targets.set(key,snapshot?{id,title:snapshot.title,status:snapshot.deletedAt?'已归档':'可用',reference:reference(snapshot)}:{id,status:'不存在'})
   }
   const summary=targets.get(key)!
   if(requireActive&&summary.status!=='可用')throw new WorkError('teloa/invalid-input','关联目标不存在或已归档，请重新选择当前有效记录。')
   return summary
  }
  for(const op of input.operations){
   const row=target(rows,op.type),definition=row.definition
   if(op.operation!=='archive'&&!row.writable)throw new WorkError('teloa/invalid-input','关联目标类型未在当前业务的本地配置中就绪，请先读取真实类型目录。')
   let before:BusinessObjectSnapshot|undefined
   if(op.operation!=='create'){before=await get(current,{scope:current.scope,type:op.type,id:op.id});if(before.deletedAt||before.version!==op.expectedVersion)throw new WorkError('teloa/version-conflict','原记录版本已变化，请重新完整读取。')}
   if(op.operation!=='archive'){
    if(op.fields.some(field=>!definition.fields.some(defined=>defined.name===field.name)))throw invalid()
    if(op.operation==='edit'&&(op.fields.length!==definition.fields.length||definition.fields.some(field=>!op.fields.some(value=>value.name===field.name))))throw new WorkError('teloa/invalid-input','编辑 fields 是完整替换：请读取记录并保留所有未改字段，清空字段须显式传空字符串。')
    const supplied=new Map(op.fields.map(field=>[field.name,field.value]));for(const field of definition.fields)assertBusinessRecordFieldValue(field,supplied.get(field.name))
   }
   const relations=new Map<string,{before?:Relation|Relation[];value?:Relation|Relation[]}>()
   if(op.operation!=='archive')for(const field of definition.fields){
    if(field.type!=='reference'&&field.type!=='multi-reference')continue
    const value=op.fields.find(value=>value.name===field.name)?.value??'',previous=before?.fields.find(value=>value.label===field.from)?.value??''
    if(field.type==='reference')relations.set(field.name,{...(previous?{before:await relation(field.referenceType!,previous,false)}:{}),...(value?{value:await relation(field.referenceType!,value,true)}:{})})
    else{
     if(!('format' in field))throw invalid()
     const readRelations=async(raw:string,requireActive:boolean)=>{
      const parsed=readBusinessRichFieldValue(field,raw)
      if(!parsed||parsed.type!=='multi-reference')throw invalid()
      const resolved:Relation[]=[]
      for(const id of parsed.ids)resolved.push(await relation(field.referenceType,id,requireActive))
      return resolved
     }
     relations.set(field.name,{...(previous?{before:await readRelations(previous,false)}:{}),...(value?{value:await readRelations(value,true)}:{})})
    }
   }
   checks.push({definition:row,before:before?reference(before):null,...(relations.size?{relations:[...relations],targetDefinitions:definition.fields.flatMap(field=>field.type==='reference'||field.type==='multi-reference'?[target(rows,field.referenceType!)]:[])}:{})})
   operations.push({operation:op.operation,type:op.type,typeTitle:definition.title,...('id'in op?{id:op.id,expectedVersion:op.expectedVersion}:{}),...('title'in op?{title:op.title}:{}),...('summary'in op?{summary:op.summary}:{}),...(before?{beforeTitle:before.title,beforeSummary:before.summary}:{}),...(op.operation==='archive'?{}:{fields:definition.fields.map(field=>{const value=op.fields.find(value=>value.name===field.name)?.value??'';return {name:field.name,label:field.label,...(relations.has(field.name)?{relations:relations.get(field.name)}:{}),...(before?{before:before.fields.find(value=>value.label===field.from)?.value??''}:{}),value,action:value===''?'清空':'保存'}})})})
  }
  return {replay:false,fingerprint:JSON.stringify(checks),summary:{operations}}
 }
 const authorized=new WeakMap<ToolExecution,{current:Authorized;prepared?:Awaited<ReturnType<typeof prepare>>}>()
 const query=async(current:Authorized,args:unknown)=>{
  const input=readQuery(args,current.scope)
  if(input.mode==='receipt'){const result=await ports.records.batchReceipt(current.actor,input.input);return json(result===undefined||result===null?{requestId:input.input.requestId,scope:current.scope,result:null,note:recentNotice}:receipt(result,current.scope,input.input.requestId))}
  if(input.mode==='recent-writes'){
   const result=await ports.records.recentBatches(current.actor,{scope:current.scope,sessionId:current.instruction.sessionId,limit:4,...(input.cursor===undefined?{}:{cursor:input.cursor})})
   if(!result||Object.keys(result).some(key=>!['items','nextCursor'].includes(key))||!Array.isArray(result.items)||result.items.length>4)throw bad()
   const items=result.items.map(item=>{
    const id=readBusinessRecordReceipt({requestId:item.requestId}).requestId,source=item.source
    if(item.scope!==current.scope||!source||Object.keys(source).sort().join(',')!=='messageId,seq,sessionId'||source.sessionId!==current.instruction.sessionId||typeof source.messageId!=='string'||!source.messageId.trim()||source.messageId.length>200||!Number.isSafeInteger(source.seq)||source.seq<1||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))||new Date(item.createdAt).toISOString()!==item.createdAt||!Array.isArray(item.operations)||!item.operations.length||item.operations.length>50)throw bad()
    const operations=item.operations.map(op=>{const child=readBusinessRecordReceipt({requestId:op.requestId}),ref=businessObjectReference(op.reference);if(ref.scope!==current.scope||!['create','edit','archive'].includes(op.operation))throw bad();return {...child,operation:op.operation,reference:ref}})
    return {requestId:id,scope:item.scope,source,createdAt:item.createdAt,operations}
   })
   const nextCursor=cursor(result.nextCursor);return json({scope:current.scope,items,...(nextCursor===undefined?{}:{nextCursor}),note:recentNotice})
  }
  const rows=await types(current)
  if(input.mode==='directory')return json({scope:current.scope,title:current.title,types:rows.slice(input.cursor,input.cursor+32).map(row=>({type:row.definition.id,title:row.definition.title,readable:row.local,writable:row.writable,archivable:row.local,...(!row.local?{reason:'外部受管来源，请使用对应来源的读取工具。'}:!row.writable?{reason:'关联目标类型不在当前业务已采用的本地配置中；可读取或归档现有本地记录。'}:{})})),...(input.cursor+32<rows.length?{nextCursor:input.cursor+32}:{}),rules:'新增/编辑只作用于当前业务的本地记录。编辑fields完整替换，get.values给出全部当前字段；保留未改值，空字符串显式清空。一条本人指令只确认提交一批1–50项，最多128KiB。结果未知先receipt或recent-writes核对，不能用新轮次重复写入。'+referenceValueRules(rows.slice(input.cursor,input.cursor+32).filter(row=>row.local).map(row=>row.definition))+richValueRules(rows.slice(input.cursor,input.cursor+32).filter(row=>row.local).map(row=>row.definition))+uniqueValueRules(rows.slice(input.cursor,input.cursor+32).filter(row=>row.local).map(row=>row.definition))})
  const row=target(rows,input.mode==='type'?input.type:input.input.type)
  if(input.mode==='type'){const rules=referenceValueRules([row.definition])+richValueRules([row.definition])+uniqueValueRules([row.definition]);return json({scope:current.scope,definition:row.definition,writable:row.writable,archivable:true,origin:row.origin,...(rules?{rules}:{})})}
  if(input.mode==='get'){const snapshot=await get(current,input.input);return json({snapshot,values:values(row,snapshot)})}
  const page=readBusinessRecordPage(await ports.records.list(current.actor,input.input),current.scope)
  if(page.items.some(item=>item.type!==input.input.type)||page.items.length>input.input.limit)throw bad()
  return json(page)
 }
 const definitions:ReadonlyArray<{name:typeof businessRecordToolNames[number];description:string;parameters:ParameterSchemaSpec}>=[
  {name:read,description:'读取当前本人业务的本地记录。mode互斥：directory（默认，cursor整数，每页32类型）；type+type读字段、关联与uniqueFields规则；list+type+limit(默认20，最多100)+cursor；get+type+id+可选version读完整snapshot和按字段name映射的values；reference 值为原ID，multi-reference 值为规范原ID数组字符串，每个目标名称与状态须按声明 referenceType 另行 list/get 读取；receipt+requestId读原批次回执；recent-writes+可选cursor发现当前会话已提交的原批次，不接受owner/scope/sessionId。list预查不能保证唯一；空结果不证明没有在途或失败，不得自动用新轮身份重写。',parameters:{mode:{type:'string',enum:['directory','type','list','get','receipt','recent-writes']},type:{type:'string'},id:{type:'string'},version:{type:'integer'},requestId:{type:'string'},cursor:{oneOf:[{type:'string'},{type:'integer'}]},limit:{type:'integer'}}},
  {name:write,description:'一次原生确认后原子保存当前业务1–50个本地记录操作，最多128KiB。仅operations:[{operation:create|edit|archive,type,...}]，不接受requestId/scope。create需title/summary/fields；edit需id/expectedVersion及包含全部字段的fields，title/summary可选；archive需id/expectedVersion。fields=[{name,value}]为完整替换，先get完整记录，保留未改字段，空字符串明确清空。reference 单选保存真实原始目标ID；v2 multi-reference 保存按ID字典序的1–32个真实原ID规范JSON数组字符串，≤2000字符。先按 referenceType list/get 读取每个真实目标标题和状态，仅支持当前本人同业务有效本地目标，失效成员须移除、清空或改绑。constraints.uniqueFields逐字段独立唯一，多关联每个成员独占；后端事务最终核验，list预查不能保证唯一。跨业务及外部来源写入尚不支持。一次本人指令只对应一个固定批次；回包未知先read receipt或recent-writes。真实回执才表示保存，不会派任务或修改外部来源。',parameters:{operations:{type:'array',required:true,items:{type:'object',additionalProperties:true}}}},
 ]
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  try{
   const fixed=authorized.get(exec),current=await authorize(exec)
   if(!fixed||fixed.current.fingerprint!==current.fingerprint||JSON.stringify(fixed.current.instruction)!==JSON.stringify(current.instruction))throw new WorkError('teloa/conflict','确认期间本人指令或业务归属已变化，请重新读取。')
   if(definition.name===read)return query(current,args)
   const input=writeInput(args,current.scope,requestId(ports.owner,current.instruction)),prepared=await prepare(current,input)
   if(!fixed.prepared||!prepared.replay&&fixed.prepared.fingerprint!==prepared.fingerprint)throw new WorkError('teloa/conflict','确认期间记录或类型已变化，请重新读取。')
   const latest=await authorize(exec)
   if(latest.fingerprint!==fixed.current.fingerprint||JSON.stringify(latest.instruction)!==JSON.stringify(fixed.current.instruction))throw new WorkError('teloa/conflict','执行前本人指令或业务归属已变化，请重新读取。')
   exec.signal.throwIfAborted()
   const result=await ports.records.batch(current.actor,input,current.instruction)
   return json(receipt(result,current.scope,input.requestId,input))
  }catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','本地记录结果暂不可确认，请使用原回执或当前会话recent-writes核对，不要换指令重复写入。')}
 }}))
 const removeGuard=ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!names.has(exec.name))return next()
  let fixed:{current:Authorized;prepared?:Awaited<ReturnType<typeof prepare>>}
  try{const current=await authorize(exec);if(exec.name===read){readQuery(exec.arguments,current.scope);fixed={current}}else{const input=writeInput(exec.arguments,current.scope,requestId(ports.owner,current.instruction));fixed={current,prepared:await prepare(current,input)}}authorized.set(exec,fixed)}catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'无法核对当前本人业务记录。'}}
  const decision=await next()
  if(decision.kind==='deny'||decision.kind==='cancel'||!fixed.prepared)return decision
  const reason=(decision.kind==='ask'&&decision.reason?decision.reason+'\n':'')+'确认保存业务“'+fixed.current.title+'”的整批本地记录？以下内容完整展示，不会操作外部来源：'+JSON.stringify(fixed.prepared.summary)
  // 原字段值和下游策略理由不计入模型请求大小，确认全文仍须单独限额，不能截断后批准。
  if(Buffer.byteLength(reason,'utf8')>requestBytes)return {kind:'deny' as const,reason:'确认内容超过 128 KiB，请缩小批次后重试；尚未保存任何变更。'}
  return {kind:'ask' as const,reason}
 })
 const removeContext=ctx.on('agent/pre-step',async({agent,signal},next)=>{
  const decision=await next()
  if(decision.kind==='reject'||!decision.messages.some(message=>message.source.kind==='user'))return decision
  let current:Awaited<ReturnType<typeof authorizeScope>>
  try{current=await authorizeScope({agent,signal})}catch(error){if(error instanceof WorkError&&['teloa/not-bound','teloa/not-found','teloa/forbidden'].includes(error.code))return decision;throw error}
  if(!(await types(current)).some(row=>row.local))return decision
  const notice=createUserMessage({source:{kind:source,form:'notice',summary:'当前业务本地记录'},content:[{type:'text',text:'当前本人业务为“'+current.title+'”。需要维护本地记录时，先用 teloa_business_records_read 读取已采用类型和完整记录；本工具不代表所有类型都支持写入。新增、修改、归档先整理完整批次，再用 teloa_business_records_write 经本人一次确认保存。fields 是完整替换，保留未改字段，空值须明确清空。reference 保存真实原ID，v2 multi-reference 保存按ID字典序的规范原ID数组字符串；先按声明 referenceType list/get 读取每个目标名称和状态，仅支持本人同业务有效本地目标，失效成员须移除、清空或改绑。constraints.uniqueFields逐字段独立唯一，由后端事务最终核验，list预查不能保证唯一。一条本人指令只对应一个写入意图；结果未知先查原 receipt 或 recent-writes，空结果不能证明未提交，不要用新指令身份重复写入。外部数据继续使用该来源的读取能力；自然语言回答不表示记录已保存。'}]})
  return {...decision,messages:[...decision.messages,notice]}
 })
 return ()=>{removeGuard();removeContext()}
}
const [read,write]=businessRecordToolNames
