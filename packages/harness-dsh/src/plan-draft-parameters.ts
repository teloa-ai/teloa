import {parameterSchemaSpecToJsonSchema,validateJsonSchemaValue,type JsonSchemaNode} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,readPageCreatePlanDraft,scheduleTimezones,workEventKinds,type PageCreatePlanDraft} from '@teloa/contract'

// DSH 只支持类型、字面值和 oneOf；长度、正数范围及跨字段约束仍由原严格 reader 核对。
const text={type:'string',required:true} as const
const positive={type:'integer',required:true,description:'正整数，至少为 1；不能写成字符串或 0。'} as const
const resourceLimit={oneOf:[{type:'integer'},{type:'null'}],required:true,description:'正安全整数；只有本人明确选择不限时填 null，不能省略。'} as const
const retries={type:'integer',required:true,description:'非负整数；0 表示不重试，不能写成字符串。'} as const
const uuid={type:'string',required:true,description:'从正式回执取得的 UUID，不自行编造，也不要求本人填写。'} as const
const nullableId={oneOf:[{type:'string',description:'正式回执中的 UUID。'},{type:'null'}]} as const
const completion={oneOf:[
 {type:'object',additionalProperties:false,properties:{kind:{type:'string',const:'manual',required:true}}},
 {type:'object',additionalProperties:false,properties:{kind:{type:'string',const:'verified',required:true},verifier:{type:'string',enum:['system-digest','material-version-summary'],required:true},verifierVersion:positive,authorizationVersion:positive}},
]} as const
const schedule={type:'object',additionalProperties:false,properties:{
 kind:{type:'string',const:'schedule',required:true},cadence:{type:'string',enum:['daily','weekly'],required:true},
 weekday:{type:'integer',enum:[1,2,3,4,5,6,7],required:true,description:'星期一至日为 1 至 7；daily 也必须提供，沿既有定义保留。'},
 time:{type:'string',required:true,description:'24 小时制 HH:mm，例如 09:30。'},timezone:{type:'string',enum:scheduleTimezones,required:true},
}} as const
const coalesce={type:'string',enum:['latest','none'],required:true} as const
const triggers={type:'array',required:true,description:'1 至 16 项，不重复，最多一个日程项；必须为数组。',items:{oneOf:[
 {type:'object',additionalProperties:false,properties:{kind:{type:'string',const:'schedule',required:true},schedule:{...schedule,required:true}}},
 {type:'object',additionalProperties:false,properties:{kind:{type:'string',const:'local-event',required:true},eventKind:{type:'string',enum:workEventKinds,required:true},sourceId:uuid,coalesce}},
 {type:'object',additionalProperties:false,properties:{kind:{type:'string',const:'local-event',required:true},eventKind:{type:'string',const:'business-object-version',required:true},sourceRef:{type:'object',additionalProperties:false,required:true,properties:{kind:{type:'string',const:'business-object',required:true},scope:text,type:text,id:text}},coalesce}},
 {type:'object',additionalProperties:false,properties:{kind:{type:'string',const:'local-event',required:true},eventKind:{type:'string',const:'business-sync-result',required:true},sourceRef:{type:'object',additionalProperties:false,required:true,properties:{kind:{type:'string',const:'business-sync',required:true},scope:text,mappingId:text}},coalesce}},
]}} as const
const money={oneOf:[{type:'null'},{type:'object',additionalProperties:false,properties:{currency:{type:'string',required:true,description:'三个大写字母的币种代码。'},maxMinorUnits:positive}}]} as const
const budget={type:'object',additionalProperties:false,required:true,description:'完整的本人已批准工作额度；数值用整数，不将示例当作授权。',properties:{
 maxGoalRounds:resourceLimit,maxTokens:resourceLimit,maxElapsedMs:resourceLimit,maxConcurrent:resourceLimit,maxRetries:retries,stagnationRounds:positive,
 money:{...money,required:true},
}} as const
const work={type:'object',additionalProperties:false,required:true,properties:{completion:{...completion,required:true},triggers,budget,overlap:{type:'string',enum:['forbid','independent'],required:true},missed:{type:'string',const:'coalesce',required:true},safeRecovery:{type:'boolean',required:true,description:'JSON 布尔值 true 或 false，不能使用字符串。'}}} as const
const newWork={...work,properties:{...work.properties,budget:{...budget,properties:{...budget.properties,money:{...money,description:'新建时没有金额上限可省略，由宿主补为 null；若提供必须为原生 null 或完整费用对象，不接受字符串或空对象。'}}}}} as const
const ownerWork={...newWork,properties:{...newWork.properties,triggers:{...triggers,description:'本人计划必须恰好一个与 definition.trigger 完全一致的日程，不接受员工、群或业务事件授权。',items:triggers.items.oneOf[0]}}} as const
const fields={title:{...text,description:'名称，最多 120 字。'},goal:{...text,description:'工作目标，最多 8000 字。'},dataScope:{...text,description:'已授权资料范围，最多 8000 字；不扩展原权限。'},delivery:{...text,description:'交付要求，最多 8000 字。'}} as const
const commonDefinition={...fields,trigger:{...schedule,required:true},notificationPolicy:{type:'string',enum:['always','attention','failure','silent'],required:true},completionPolicy:completion} as const
const ownerDefinition={type:'object',additionalProperties:false,required:true,properties:{...commonDefinition,executor:{type:'object',additionalProperties:false,required:true,properties:{kind:{type:'string',const:'owner',required:true}}},roleId:{type:'null',description:'本人计划可省略，由宿主补为 null；不能填员工身份或字符串。'},scope:{type:'string',const:'general',required:true},groupId:{type:'null'}}} as const
const roleDefinition={type:'object',additionalProperties:false,required:true,properties:{...commonDefinition,roleId:uuid,expectedRoleVersion:positive,scope:{...text,description:'正式员工支持的业务范围键；不能用显示名称代替。'},groupId:nullableId}} as const
const source={type:'object',additionalProperties:false,required:true,properties:{artifactId:uuid,version:positive,basisHash:{type:'string',required:true,description:'逐字取 teloa_method_source 回执的 64 位摘要。'},taskId:{type:'string',description:'只在正式成果来源回执包含 taskId 时原样传入。'}}} as const
const intent={type:'string',enum:['save-paused','create-and-enable'],description:'默认 save-paused；明确启用仍须本人在原稿确认，不由参数自行授权。'} as const

/** 与 readPageCreatePlanDraft 的本人、员工及原计划配置三种正文对应，不接收 JSON 字符串。 */
export const planDraftParameters={description:'计划草稿对象，按本人新计划、员工新计划或已有计划配置选择一种明确结构；数组、整数和布尔值保持 JSON 原生类型。新建本人计划可省略 roleId，新建无金额上限可省略 budget.money；已有计划配置必须完整保留 money。',oneOf:[
 {type:'object',additionalProperties:false,properties:{definition:ownerDefinition,work:ownerWork,intent,source}},
 {type:'object',additionalProperties:false,properties:{definition:roleDefinition,work:newWork,intent,source}},
 {type:'object',additionalProperties:false,properties:{kind:{type:'string',const:'configure-work',required:true},planId:uuid,expectedVersion:positive,expectedConfigVersion:positive,work,fields:{type:'object',additionalProperties:false,properties:{...fields,groupId:nullableId}},intent}},
]} as const

// 仅方法采用的新建草稿允许整体省略技术额度，宿主在严格reader前补入当前本人真实策略。
const {required:_methodBudgetRequired,...methodBudget}=newWork.properties.budget
export const methodPlanDraftParameters={...planDraftParameters,description:planDraftParameters.description+' 新建方法计划可整体省略 work.budget，宿主会提供当前本人工作额度供确认；显式提供或已有配置不会被默认值覆盖。',oneOf:[
 {...planDraftParameters.oneOf[0],properties:{...planDraftParameters.oneOf[0].properties,work:{...ownerWork,properties:{...ownerWork.properties,budget:methodBudget}}}},
 {...planDraftParameters.oneOf[1],properties:{...planDraftParameters.oneOf[1].properties,work:{...newWork,properties:{...newWork.properties,budget:methodBudget}}}},
 planDraftParameters.oneOf[2],
]} as const

const wire=parameterSchemaSpecToJsonSchema({plan:planDraftParameters}).properties.plan!
/** 展开原 SDK oneOf 的具体叶错误；仅解释失败，不改参数或放行任何 reader。 */
function errors(node:JsonSchemaNode,value:unknown,path:string):string[]{
 const invalid=validateJsonSchemaValue(node,value,path)
 if(!invalid.length)return []
 if(node.oneOf){
   const branches=node.oneOf.map(branch=>errors(branch,value,path)),matching=branches.filter(branch=>branch.length===0)
  if(matching.length!==0)return invalid
   const type=value===null?'null':Array.isArray(value)?'array':typeof value==='number'&&Number.isInteger(value)?'integer':typeof value
   const sameType=branches.filter((_errors,index)=>node.oneOf![index]!.type===type||type==='integer'&&node.oneOf![index]!.type==='number')
   const best=(sameType.length?sameType:branches).reduce((a,b)=>a.length<=b.length?a:b)
  return [...invalid,...best]
 }
 const nested:string[]=[]
 if(node.type==='object'&&isRecord(value))for(const [key,child]of Object.entries(node.properties??{}))if(Object.hasOwn(value,key))nested.push(...errors(child,value[key],path+'.'+key))
 if(node.type==='array'&&Array.isArray(value)&&node.items)value.forEach((item,index)=>nested.push(...errors(node.items!,item,`${path}[${index}]`)))
 return [...new Set([...invalid,...nested])]
}
export function planDraftArgumentErrors(value:unknown,path='plan'):string[]{
 const branches=wire.oneOf!
 const index=isRecord(value)&&value.kind==='configure-work'?2:isRecord(value)&&isRecord(value.definition)&&Object.hasOwn(value.definition,'executor')?0:1
 const issues=errors(branches[index]!,value,path)
 if(issues.length||!isRecord(value)||!isRecord(value.work)||!isRecord(value.work.budget))return issues
  // SDK只核integer形状；不补额度或转换数值，零重试保留为零。
  for(const [key,spec]of Object.entries(budget.properties)){
   if(spec!==positive&&spec!==retries&&spec!==resourceLimit)continue
   if(spec===resourceLimit&&value.work.budget[key]===null)continue
   const minimum=spec===retries?0:1
   if(!Number.isSafeInteger(value.work.budget[key])||Number(value.work.budget[key])<minimum)issues.push(`${path}.work.budget.${key} must be a safe integer with minimum ${minimum}`)
  }
 return issues
}
/** 只给新建时缺省的技术空值补标准值；返回原严格 reader 的正文，不把漏字段的原对象断言成完整类型。 */
export function planDraftBody(value:unknown):PageCreatePlanDraft{
 const issues=planDraftArgumentErrors(value)
 if(issues.length)throw new WorkError('teloa/invalid-input','计划草稿参数不正确：'+issues.join('; '))
 if(isRecord(value)&&value.kind!=='configure-work'){
  const definition=isRecord(value.definition)&&isRecord(value.definition.executor)&&value.definition.executor.kind==='owner'&&!Object.hasOwn(value.definition,'roleId')?{...value.definition,roleId:null}:value.definition
  const work=isRecord(value.work)&&isRecord(value.work.budget)&&!Object.hasOwn(value.work.budget,'money')?{...value.work,budget:{...value.work.budget,money:null}}:value.work
  return readPageCreatePlanDraft({...value,definition,work})
 }
 return readPageCreatePlanDraft(value)
}
