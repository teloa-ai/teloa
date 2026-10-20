import {EmployeeApiError,employeeApiEndpoint,employeeApiId,readEmployeeApiRequest} from './contract.mjs'
export {EmployeeApiError} from './contract.mjs'

/** 无全局状态、不读取环境凭据；重试沿用调用方保存的 requestId。 */
export class TeloaClient{
 #base;#token;#fetch;#timeout
 constructor({baseUrl,apiKey,fetch:fetcher=globalThis.fetch,timeoutMs=30_000}){
  const url=new URL(employeeApiEndpoint(baseUrl))
  if(url.pathname!=='/'||typeof apiKey!=='string'||!/^teloa_api_[A-Za-z0-9_-]{43}$/.test(apiKey)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000)throw new EmployeeApiError('invalid_request','Invalid base URL, API key or timeout.')
  this.#base=url.origin;this.#token=apiKey;this.#fetch=fetcher;this.#timeout=timeoutMs
 }
 async #request(path,{method='GET',body,requestId,signal}={}){
  if(requestId!==undefined)employeeApiId(requestId)
  const response=await this.#fetch(this.#base+path,{method,headers:{authorization:'Bearer '+this.#token,accept:'application/json',...(body?{'content-type':'application/json'}:{}),...(requestId?{'idempotency-key':requestId}:{})},...(body?{body:JSON.stringify(body)}:{}),credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.#timeout)]):AbortSignal.timeout(this.#timeout)})
  let value
  try{value=await response.json()}catch{throw new EmployeeApiError('invalid_response','The service did not return JSON.',response.status)}
  if(!response.ok)throw new EmployeeApiError(value?.error?.code??'request_failed',value?.error?.message??'The request failed.',response.status,value?.error?.requestId)
  return value
 }
 async listEmployees(options){return this.#request('/api/v1/employees',options)}
 async startWork(input,{requestId,...options}={}){return this.#request('/api/v1/works',{...options,method:'POST',body:readEmployeeApiRequest('StartWork',input),requestId:employeeApiId(requestId)})}
 async getWork(id,options){return this.#request('/api/v1/works/'+employeeApiId(id),options)}
 async continueWork(id,input,{requestId,...options}={}){return this.#request('/api/v1/works/'+employeeApiId(id)+'/inputs',{...options,method:'POST',body:readEmployeeApiRequest('ContinueWork',input),requestId:employeeApiId(requestId)})}
 async cancelWork(id,input,{requestId,...options}={}){return this.#request('/api/v1/works/'+employeeApiId(id)+'/cancel',{...options,method:'POST',body:readEmployeeApiRequest('CancelWork',input),requestId:employeeApiId(requestId)})}
 async getResult(id,{version,...options}={}){if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw new EmployeeApiError('invalid_request','Invalid result version.');return this.#request('/api/v1/works/'+employeeApiId(id)+'/result'+(version===undefined?'':'?version='+version),options)}
 async listEvents(id,{after=0,...options}={}){if(!Number.isSafeInteger(after)||after<0)throw new EmployeeApiError('invalid_request','Invalid event cursor.');return this.#request('/api/v1/works/'+employeeApiId(id)+'/events?after='+after,options)}
}

/** 验证原始正文，解析 JSON 之前调用；签名不等于去重，调用方仍保存事件 id。 */
export async function verifyWebhook({body,secret,timestamp,signature,now=Date.now(),toleranceMs=300_000}){
 if(typeof body!=='string'||typeof secret!=='string'||!/^\d{10}$/.test(String(timestamp))||!/^v1=[a-f0-9]{64}$/.test(String(signature))||!Number.isFinite(now)||!Number.isFinite(toleranceMs)||toleranceMs<0||Math.abs(now-Number(timestamp)*1000)>toleranceMs)return false
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify'])
 return crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.slice(3).match(/../g),x=>parseInt(x,16)),new TextEncoder().encode(timestamp+'.'+body))
}
