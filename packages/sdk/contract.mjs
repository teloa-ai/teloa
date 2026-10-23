/** 对外 v1 契约独立于内部 RPC；服务端、SDK、OpenAPI 和 MCP 共用请求定义。 */
export const employeeApiVersion='1'
export const employeeApiStates=Object.freeze(['queued','running','waiting','succeeded','failed','cancel_requested','cancelled'])
export const employeeApiPermissions=Object.freeze(['read','execute','cancel'])
/** 与宿主原生预设同名；缺少或配置不匹配时宿主明确拒绝，不静默换档。 */
export const employeeApiPermissionModes=Object.freeze(['danger-full-access','workspace-write','read-only'])
export const employeeApiScopes=Object.freeze({read:'Read employees and work created by this integration',execute:'Start and continue employee work',cancel:'Request cancellation of this integration’s work'})
export class EmployeeApiError extends Error{
 constructor(code,message,status=400,requestId){super(message);this.name='EmployeeApiError';this.code=code;this.status=status;this.requestId=requestId}
}
export const uuidPattern='^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$'
const uuidSchema={type:'string',pattern:uuidPattern},textSchema={type:'string',minLength:1,maxLength:6000}
const token=(max)=>({type:'string',minLength:1,maxLength:max,pattern:'^[^\\s\\x00-\\x1f\\x7f]+$'})
/** 只接受平台已配置 provider 的引用；密钥、地址与协议适配继续由宿主配置管理。 */
const modelSchema={type:'object',additionalProperties:false,properties:{provider:token(128),model:token(256),reasoningEffort:token(128)},required:['provider','model']}
const permissionModeSchema={type:'string',enum:employeeApiPermissionModes}
const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required})
export const employeeApiSchemas=Object.freeze({
 StartWork:object({employeeId:uuidSchema,input:textSchema,title:{type:'string',minLength:1,maxLength:120},permissionMode:permissionModeSchema,model:modelSchema},['employeeId','input']),
 ContinueWork:object({expectedVersion:{type:'integer',minimum:1},input:textSchema,permissionMode:permissionModeSchema,model:modelSchema},['expectedVersion','input']),
 CancelWork:object({expectedVersion:{type:'integer',minimum:1}}),
 Work:object({id:uuidSchema,employeeId:uuidSchema,employeeVersion:{type:'integer',minimum:1},version:{type:'integer',minimum:1},round:{type:'integer',minimum:1},state:{type:'string',enum:employeeApiStates},title:{type:'string'},createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'},resultVersion:{type:['integer','null'],minimum:1},error:{type:['string','null']},permissionMode:{type:'string',enum:employeeApiPermissionModes},model:{...modelSchema,type:['object','null']},links:object({self:{type:'string'},result:{type:'string'},events:{type:'string'}})}),
 Employee:object({id:uuidSchema,version:{type:'integer',minimum:1},name:{type:'string'},description:{type:'string'},scope:{type:'string'},state:{type:'string',enum:['active','unavailable']}}),
 Result:object({workId:uuidSchema,version:{type:'integer',minimum:1},round:{type:'integer',minimum:1},text:{type:'string'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},createdAt:{type:'string',format:'date-time'},review:{type:'string',enum:['accepted','unreviewed']}}),
 Error:object({error:object({code:{type:'string'},message:{type:'string'},requestId:uuidSchema})}),
})
export const employeeApiOperations=Object.freeze([
 {id:'listEmployees',method:'get',path:'/api/v1/employees',permission:'read',response:'Employee',list:true},
 {id:'startWork',method:'post',path:'/api/v1/works',permission:'execute',body:'StartWork',response:'Work',idempotent:true,status:202},
 {id:'getWork',method:'get',path:'/api/v1/works/{workId}',permission:'read',response:'Work'},
 {id:'continueWork',method:'post',path:'/api/v1/works/{workId}/inputs',permission:'execute',body:'ContinueWork',response:'Work',idempotent:true,status:202},
 {id:'cancelWork',method:'post',path:'/api/v1/works/{workId}/cancel',permission:'cancel',body:'CancelWork',response:'Work',idempotent:true,status:202},
 {id:'getResult',method:'get',path:'/api/v1/works/{workId}/result',permission:'read',response:'Result',resultVersion:true},
 {id:'listEvents',method:'get',path:'/api/v1/works/{workId}/events',permission:'read',events:true},
])
export function employeeApiId(value){
 if(typeof value!=='string'||!new RegExp(uuidPattern).test(value))throw new EmployeeApiError('invalid_request','A valid UUID is required.')
 return value.toLowerCase()
}
function validate(schema,value){
 if(schema.enum!==undefined&&!schema.enum.includes(value))return false
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(schema.properties,key))||schema.required.some(key=>!Object.hasOwn(value,key)))return false
  return Object.entries(value).every(([key,item])=>validate(schema.properties[key],item))
 }
 if(schema.type==='string')return typeof value==='string'&&!!value.trim()&&value.length<=(schema.maxLength??Infinity)&&value.length>=(schema.minLength??0)&&(!schema.pattern||new RegExp(schema.pattern).test(value))&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
 if(schema.type==='integer')return Number.isSafeInteger(value)&&value>=(schema.minimum??-Infinity)
 return false
}
/** 只做枚举核对；调用方继续使用 employeeApiSchemas 共享同一份值。 */
export function readEmployeeApiPermissionMode(value){
 if(!employeeApiPermissionModes.includes(value))throw new EmployeeApiError('invalid_request','permissionMode must be danger-full-access, workspace-write or read-only.')
 return value
}
/** 归一化请求级模型引用；不接受密钥、地址或额外字段。 */
export function readEmployeeApiModel(value){
 if(!validate(modelSchema,value))throw new EmployeeApiError('invalid_request','model must contain provider and model, with an optional reasoningEffort.')
 return {provider:value.provider,model:value.model,...(value.reasoningEffort===undefined?{}:{reasoningEffort:value.reasoningEffort})}
}
export function readEmployeeApiRequest(kind,value){
 if(!['StartWork','ContinueWork','CancelWork'].includes(kind)||!validate(employeeApiSchemas[kind],value))throw new EmployeeApiError('invalid_request','Request does not match the employee API schema.')
 return {...value,...kind==='StartWork'?{employeeId:employeeApiId(value.employeeId)}:{},...(value.permissionMode===undefined?{}:{permissionMode:readEmployeeApiPermissionMode(value.permissionMode)}),...(value.model===undefined?{}:{model:readEmployeeApiModel(value.model)})}
}
export function employeeApiEndpoint(value){
 let url
 try{url=new URL(value)}catch{throw new EmployeeApiError('invalid_request','An absolute service URL is required.')}
 if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new EmployeeApiError('invalid_request','Use HTTPS, or HTTP on loopback, without credentials, query or fragment.')
 return url.href
}
