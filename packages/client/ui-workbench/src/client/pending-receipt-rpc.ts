type RpcCall<T>=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<T>
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

/** 确认的是网络收讫，不代表领域校验通过；value 和各 API 的本机 journal 均不在此改写。 */
export function createPendingReceiptRpc<T>(call:RpcCall<T>,changed:()=>void,timeoutMs=3000):RpcCall<T>{
 return async(endpoint,payload,signal)=>{
  const reply=await call(endpoint,payload,signal)
  if(!record(reply)||reply.ok!==true)return reply
  // DSH 的传输信封只保留 ok/value；恢复写命令清单由前后端共享，不能依赖自加的顶层字段。
  const receipt=reply.receipt!==undefined?reply.receipt:(isPendingRequestEndpoint(endpoint)&&record(payload)?{requestId:payload.requestId}:undefined)
  if(receipt===undefined)return reply
  if(!record(receipt)||Object.keys(receipt).length!==1||!uuid(receipt.requestId)||!record(payload)||!uuid(payload.requestId)||receipt.requestId.toLowerCase()!==payload.requestId.toLowerCase()){
   changed()
   return reply
  }
  const requestId=receipt.requestId.toLowerCase(),controller=new AbortController()
  let timeout:ReturnType<typeof setTimeout>|undefined
  try{
   // 即使底层传输未响应 AbortSignal，确认也不能无限阻塞已收到的业务结果。
   await Promise.race([
    call('requests/pending/ack',{requestId},controller.signal),
    new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(Error('Acknowledgement timed out.'))},timeoutMs)}),
   ])
  }catch{
   // 保留原业务回包；调用者刷新服务端待核对目录，不能把确认未知说成业务失败。
  }finally{
   if(timeout!==undefined)clearTimeout(timeout)
   changed()
  }
  return reply
 }
}
import {isPendingRequestEndpoint} from '@teloa/contract'
