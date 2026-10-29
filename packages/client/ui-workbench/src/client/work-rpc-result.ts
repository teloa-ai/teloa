type RpcResult<T>={ok:true;value:T}|{ok:false;error:{code:string;message:string;details?:object}}

/** RPC JSON 可来自另一个插件执行域；只复制普通对象自身的数据字段，不接收类实例或访问器。 */
function plainDetails(value:unknown):Record<string,unknown>|undefined{
 if(value===null||typeof value!=='object')return undefined
 try{
  const prototype=Object.getPrototypeOf(value),constructor=prototype&&Object.getOwnPropertyDescriptor(prototype,'constructor')?.value
  if(prototype!==null&&(Object.getPrototypeOf(prototype)!==null||typeof constructor!=='function'||Function.prototype.toString.call(constructor)!==Function.prototype.toString.call(Object)))return undefined
  const properties=Object.getOwnPropertyDescriptors(value)
  if(Object.values(properties).some(property=>!Object.hasOwn(property,'value')))return undefined
  return Object.fromEntries(Object.entries(properties).filter(([,property])=>property.enumerable).map(([key,property])=>[key,property.value]))
 }catch{return undefined}
}

/** 保留稳定错误码与宿主结构化事实供界面本地化；错误码本身不证明写入没有发生。 */
export function unwrapWorkRpcResult<T>(result:RpcResult<T>,rejected?:true):T{
 if(!result.ok){
  const {code}=result.error,details=plainDetails(result.error.details)
  throw Object.assign(Error(result.error.message),{code,...(details?{details}:{}),...(rejected?{rejected:true}:{})})
 }
 return result.value
}

/** 市场调用沿用原来的明确拒绝标记；传输抛错和未知结果不被改写为确定拒绝。 */
export function createRejectedWorkRpcCall(call:(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<RpcResult<unknown>>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal)=>unwrapWorkRpcResult(await call(endpoint,payload,signal),true)
}
