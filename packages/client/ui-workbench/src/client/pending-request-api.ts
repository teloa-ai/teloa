export type PendingRequest={requestId:string;endpoint:string;createdAt:string;updatedAt:string;lastErrorCode?:string;summary?:string}
export type PendingRequestPreview=PendingRequest&{payload:Record<string,unknown>}
export type PendingRecoveryResult={value:unknown;acknowledged:boolean}
type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))

function item(value:unknown):PendingRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('待核对请求目录格式不正确。')
 const row=value as Record<string,unknown>,keys=Object.keys(row)
 if(keys.some(key=>!['requestId','endpoint','createdAt','updatedAt','lastErrorCode','summary'].includes(key))||!uuid(row.requestId)||typeof row.endpoint!=='string'||!row.endpoint||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.lastErrorCode!==undefined&&typeof row.lastErrorCode!=='string'||row.summary!==undefined&&(typeof row.summary!=='string'||Array.from(row.summary).length>120))throw Error('待核对请求目录格式不正确。')
 return {requestId:row.requestId.toLowerCase(),endpoint:row.endpoint,createdAt:row.createdAt,updatedAt:row.updatedAt,...(typeof row.lastErrorCode==='string'?{lastErrorCode:row.lastErrorCode}:{}),...(typeof row.summary==='string'?{summary:row.summary}:{})}
}

function preview(value:unknown,requestId:string):PendingRequestPreview{
 try{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error()
  const {payload,...metadata}=value as Record<string,unknown>,row=item(metadata)
  if(row.requestId!==requestId||!payload||typeof payload!=='object'||Array.isArray(payload)||(payload as Record<string,unknown>).requestId!==requestId||JSON.stringify(payload).length>100_000)throw Error()
  const visit=(value:unknown,depth=0):void=>{
   if(depth>32)throw Error()
   if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return}
   if(value&&typeof value==='object'){for(const [key,item]of Object.entries(value)){if(/password|secret|token|credential|authorization|api[_-]?key|private[_-]?key/i.test(key))throw Error();visit(item,depth+1)}return}
   if(value!==null&&typeof value!=='string'&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isFinite(value)))throw Error()
  }
  visit(payload)
  return {...row,payload:payload as Record<string,unknown>}
 }catch{throw Error('待核对请求预览格式不正确。')}
}

/** 目录返回元数据与脱敏摘要；预览只读副本，重放只提交 requestId，由宿主读取原始固定载荷。 */
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
  async preview(requestId:string,signal?:AbortSignal):Promise<PendingRequestPreview>{
   if(!uuid(requestId))throw Error('待核对请求预览身份不正确。')
   signal?.throwIfAborted()
   const normalized=requestId.toLowerCase(),value=await call('requests/pending/preview',{requestId:normalized},signal)
   signal?.throwIfAborted()
   return preview(value,normalized)
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
