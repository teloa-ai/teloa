export type PendingRequest={requestId:string;endpoint:string;createdAt:string;updatedAt:string;lastErrorCode?:string}
export type PendingRecoveryResult={value:unknown;acknowledged:boolean}
type Call=(endpoint:string,payload:unknown)=>Promise<unknown>

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))

function item(value:unknown):PendingRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('待核对请求目录格式不正确。')
 const row=value as Record<string,unknown>,keys=Object.keys(row)
 if(keys.some(key=>!['requestId','endpoint','createdAt','updatedAt','lastErrorCode'].includes(key))||!uuid(row.requestId)||typeof row.endpoint!=='string'||!row.endpoint||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.lastErrorCode!==undefined&&typeof row.lastErrorCode!=='string')throw Error('待核对请求目录格式不正确。')
 return {requestId:row.requestId.toLowerCase(),endpoint:row.endpoint,createdAt:row.createdAt,updatedAt:row.updatedAt,...(typeof row.lastErrorCode==='string'?{lastErrorCode:row.lastErrorCode}:{})}
}

/** 服务端只返回目录元数据；重放时只提交 requestId，由宿主读取原始固定载荷。 */
export function createPendingRequestApi(call:Call){
 const listeners=new Set<()=>void>()
 return {
  subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener)}},
  notify(){for(const listener of listeners)listener()},
  async list():Promise<PendingRequest[]>{
   const value=await call('requests/pending/list',{})
   if(!Array.isArray(value)||value.length>1000)throw Error('待核对请求目录格式不正确。')
   const items=value.map(item)
   if(new Set(items.map(row=>row.requestId)).size!==items.length)throw Error('待核对请求目录包含重复身份。')
   return items
  },
  async recover(requestId:string):Promise<PendingRecoveryResult>{
   if(!uuid(requestId))throw Error('待核对请求身份不正确。')
   const normalized=requestId.toLowerCase(),value=await call('requests/pending/recover',{requestId:normalized})
   // 业务结果与收讫确认是两个阶段。确认回包丢失不能抹掉已经收到的业务结果。
   try{
    const receipt=await call('requests/pending/ack',{requestId:normalized})
    if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||Object.keys(receipt).length!==1||(receipt as Record<string,unknown>).requestId!==normalized)return {value,acknowledged:false}
    return {value,acknowledged:true}
   }catch{return {value,acknowledged:false}}
  },
 }
}

export type PendingRequestApi=ReturnType<typeof createPendingRequestApi>
