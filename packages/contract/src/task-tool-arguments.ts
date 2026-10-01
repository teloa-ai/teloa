/**
 * 服务端固定的精确参数组合；不接受通配符或模型提供的授权规则。
 *
 * `anyArguments` 只为「参数不可枚举」的纯工具授权而存在（今天只有委派工具 `subagent_task`：
 * 它的参数是自由文本的任务描述与提示词，平台无从枚举）。带这一位时 `allowed` 必须为空数组，
 * 两者同时给即格式错误——否则「精确参数」和「任意参数」会在同一条规则里各说一半。
 * 哪些工具名允许带这一位由**服务端**的固定集判定（harness `unconstrainedGrantToolNames`），
 * 契约只负责让这种形状可被表达、可被逐字复核。
 */
export type TaskToolArgumentRule={name:string;allowed:Record<string,string|number|boolean|null>[];anyArguments?:true}
function fields(value:unknown):value is Record<string,string|number|boolean|null>{
 return typeof value==='object'&&value!==null&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.values(value).every(v=>v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))
}
function argumentsObject(value:unknown):value is Record<string,unknown>{
 return typeof value==='object'&&value!==null&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
}
export function readTaskToolArgumentRules(rules:unknown):TaskToolArgumentRule[]{
 if(!Array.isArray(rules)||rules.length>128)throw Error('工具参数授权格式不正确。')
 const names=new Set<string>()
 for(const rule of rules){
  if(typeof rule!=='object'||rule===null||Object.keys(rule).some(key=>key!=='name'&&key!=='allowed'&&key!=='anyArguments')||typeof rule.name!=='string'||!rule.name.trim()||names.has(rule.name)||!Array.isArray(rule.allowed)||rule.allowed.length>128||!rule.allowed.every(fields)||'anyArguments'in rule&&(rule.anyArguments!==true||rule.allowed.length>0))throw Error('工具参数授权格式不正确。')
  names.add(rule.name)
 }
 // 缺省时不写出 anyArguments：既有调用方用 JSON.stringify 逐字串比规则，多一个 undefined 键都会不一致。
 return rules.map(rule=>({name:rule.name,allowed:rule.allowed.map((args:Record<string,string|number|boolean|null>)=>Object.fromEntries(Object.keys(args).sort().map(key=>[key,args[key]!]))),...(rule.anyArguments===true?{anyArguments:true as const}:{})}))
}
export function taskToolArgumentsAllowed(rules:unknown,name:string,args:unknown):boolean{
 let parsed:TaskToolArgumentRule[]
 try{parsed=readTaskToolArgumentRules(rules)}catch{return false}
 const rule=parsed.find(rule=>rule.name===name)
 // 任意参数仍要求工具调用的顶层是参数对象；对象内的数组与嵌套 JSON 由工具自身 schema 校验。
 if(rule?.anyArguments===true)return argumentsObject(args)
 if(!fields(args))return false
 return !!rule?.allowed.some((candidate:Record<string,unknown>)=>Object.keys(candidate).length===Object.keys(args).length&&Object.keys(candidate).every(key=>Object.hasOwn(args,key)&&args[key]===candidate[key]))
}
