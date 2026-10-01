type RpcResult<T>={ok:true;value:T}|{ok:false;error:{code:string;message:string}}

/** 保留稳定错误码供界面本地化；错误码本身不证明写入没有发生。 */
export function unwrapWorkRpcResult<T>(result:RpcResult<T>):T{
 if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code})
 return result.value
}
