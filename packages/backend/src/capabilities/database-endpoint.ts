import type {PoolConfig} from 'pg'

/** 由受管宿主在加载 profile 前固定；不从工作区环境或客户端请求取得。 */
export type ResourceDatabaseEndpoint=Readonly<{
 hostname:string;port:number;database:string;username:string
 tls:Readonly<{ca?:string;negotiation?:'direct'}>|false
}>
const invalid=()=>Error('资料数据库目标未通过宿主核验。')

export class ResourceDatabaseEndpointPolicy{
 private endpoint:ResourceDatabaseEndpoint|undefined
 install(endpoint:ResourceDatabaseEndpoint):void{
  if(this.endpoint||!endpoint||Object.keys(endpoint).sort().join(',')!=='database,hostname,port,tls,username')throw invalid()
  if(typeof endpoint.hostname!=='string'||!endpoint.hostname||/[\s\/@?#%\\\0]/.test(endpoint.hostname)||
   !Number.isSafeInteger(endpoint.port)||endpoint.port<1||endpoint.port>65535||
   typeof endpoint.database!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(endpoint.database)||
   typeof endpoint.username!=='string'||!/^[a-z][a-z0-9_]{0,62}(?:\.[a-z0-9]{1,63})?$/.test(endpoint.username))throw invalid()
  if(endpoint.tls===false){
   // 明文仅用于回环或既有 Compose 内网；外置服务必须校验证书。
   if(!['127.0.0.1','localhost','db'].includes(endpoint.hostname))throw invalid()
  }else if(!endpoint.tls||typeof endpoint.tls!=='object'||Array.isArray(endpoint.tls)||Object.keys(endpoint.tls).some(name=>!['ca','negotiation'].includes(name))||
   endpoint.tls.ca!==undefined&&(typeof endpoint.tls.ca!=='string'||!endpoint.tls.ca.trim())||
   endpoint.tls.negotiation!==undefined&&endpoint.tls.negotiation!=='direct')throw invalid()
  this.endpoint=Object.freeze({...endpoint,tls:endpoint.tls===false?false:Object.freeze({...endpoint.tls})})
 }
 connectionOptions(connectionString:string):PoolConfig|undefined{
  const endpoint=this.endpoint
  if(!endpoint)return undefined
  let url:URL
  try{url=new URL(connectionString)}catch{throw invalid()}
  // URL 参数可覆盖 pg 的 TLS/主机设置，受管连接一律不接收参数和片段。
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==endpoint.hostname||Number(url.port||5432)!==endpoint.port||
   url.search||url.hash||url.pathname!=='/'+endpoint.database||url.username!==endpoint.username||!url.password)throw invalid()
  // 协商方式属于 pg 连接参数，不传给 tls.connect；证书校验始终开启。
  return {connectionString,ssl:endpoint.tls===false?false:{rejectUnauthorized:true,...(endpoint.tls.ca===undefined?{}:{ca:endpoint.tls.ca})},
   ...(endpoint.tls!==false&&endpoint.tls.negotiation==='direct'?{sslnegotiation:'direct' as const}:{})}
 }
}

export const resourceDatabaseEndpointPolicy=new ResourceDatabaseEndpointPolicy()
