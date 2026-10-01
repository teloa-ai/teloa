export type FeedbackResource={entryId:string;version:string}
export type FeedbackPayload={requestId:string;category:'bug'|'idea'|'other';message:string;email:string;appVersion?:string;resource?:FeedbackResource}
export type FeedbackReceipt={stored:true;receiptId:string;notification:'sent'|'pending'|'failed'}
export type FeedbackError='network'|'invalid'|'rateLimited'|'conflict'|'unavailable'
export type FeedbackResult={ok:true;receipt:FeedbackReceipt}|{ok:false;error:FeedbackError}
type FeedbackDraft=Omit<FeedbackPayload,'requestId'|'appVersion'|'resource'>
/** 与 feedback-worker validation.mjs 同一文法；不合法的版本串（如开发构建）不发送。 */
const appVersionPattern=/^(?=.{5,32}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
/** 市场资源标识与版本：与 feedback-worker validation.mjs 逐字同一文法（即契约的条目标识与 semver 文法）。 */
const resourceEntryIdPattern=/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,4}$/
const resourceVersionPattern=/^(?=.{1,80}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** 文法合法时返回只含两键的新对象，否则 undefined；官网读地址参数与产品构造模型共用。 */
export function feedbackResource(value:unknown):FeedbackResource|undefined{
  if(!value||typeof value!=='object')return undefined
  const {entryId,version}=value as Record<string,unknown>
  return typeof entryId==='string'&&resourceEntryIdPattern.test(entryId)&&typeof version==='string'&&resourceVersionPattern.test(version)?{entryId,version}:undefined
}
type FeedbackSnapshot=Readonly<{draft:FeedbackDraft;requestId:string;pending:boolean;receipt:FeedbackReceipt|null;error:FeedbackError|null}>
function validDraft(draft:FeedbackDraft):boolean{
  const message=draft.message.trim(),email=draft.email.trim()
  return ['bug','idea','other'].includes(draft.category)&&message.length>=3&&message.length<=4000&&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)&&
    (!email||(email.length<=254&&/^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(email)))
}
export async function sendTeloaFeedback(payload:FeedbackPayload,fetcher:typeof fetch=fetch):Promise<FeedbackResult>{
  if(!validDraft(payload))return {ok:false,error:'invalid'}
  const resource=feedbackResource(payload.resource)
  try{
    const response=await fetcher('https://feedback.teloa.ai/v1/feedback',{
      method:'POST',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',mode:'cors',
      headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),
      body:JSON.stringify({requestId:payload.requestId,category:payload.category,message:payload.message.trim(),email:payload.email.trim(),
        ...(typeof payload.appVersion==='string'&&appVersionPattern.test(payload.appVersion)?{appVersion:payload.appVersion}:{}),
        ...(resource?{resource}:{})}),
    })
    if(!response.ok)return {ok:false,error:response.status===429?'rateLimited':response.status===409?'conflict':response.status===400?'invalid':'unavailable'}
    const value:unknown=await response.json()
    if(!value||typeof value!=='object')return {ok:false,error:'unavailable'}
    const row=value as Record<string,unknown>
    if(row.stored!==true||typeof row.receiptId!=='string'||!/^TF-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.receiptId)||
      !['sent','pending','failed'].includes(String(row.notification)))return {ok:false,error:'unavailable'}
    return {ok:true,receipt:{stored:true,receiptId:row.receiptId,notification:row.notification as FeedbackReceipt['notification']}}
  }catch{return {ok:false,error:'network'}}
}

/**
 * 草稿只保留在当前产品进程内；重试沿用编号，编辑内容才换请求身份。appVersion 由产品构建常量给出，官网不传。
 * resource 是反馈针对的市场资源，构造后不可改，reset 也保留；文法不合法时视同未给。
 */
export class TeloaFeedbackModel {
  private state:FeedbackSnapshot=this.empty()
  private listeners=new Set<()=>void>()
  private send:(payload:FeedbackPayload)=>Promise<FeedbackResult>
  private appVersion:string|undefined
  readonly resource:FeedbackResource|undefined
  constructor(send:(payload:FeedbackPayload)=>Promise<FeedbackResult>=sendTeloaFeedback,appVersion?:string,resource?:FeedbackResource){this.send=send;this.appVersion=appVersion;this.resource=feedbackResource(resource)}
  private empty():FeedbackSnapshot{return {draft:{category:'bug',message:'',email:''},requestId:crypto.randomUUID(),pending:false,receipt:null,error:null}}
  getSnapshot=():FeedbackSnapshot=>this.state
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}}
  private publish(value:FeedbackSnapshot){this.state=value;for(const listener of this.listeners)listener()}
  edit(value:Partial<FeedbackDraft>){
    if(this.state.pending||this.state.receipt)return
    const draft={...this.state.draft,...value}
    if(JSON.stringify(draft)===JSON.stringify(this.state.draft))return
    this.publish({...this.state,draft,requestId:crypto.randomUUID(),error:null})
  }
  reset(){if(!this.state.pending)this.publish(this.empty())}
  async submit(){
    if(this.state.pending||this.state.receipt)return
    if(!validDraft(this.state.draft)){this.publish({...this.state,error:'invalid'});return}
    this.publish({...this.state,pending:true,error:null})
    let result:FeedbackResult
    try{result=await this.send({...this.state.draft,requestId:this.state.requestId,...(this.appVersion===undefined?{}:{appVersion:this.appVersion}),...(this.resource?{resource:this.resource}:{})})}catch{result={ok:false,error:'network'}}
    this.publish({...this.state,pending:false,receipt:result.ok?result.receipt:null,error:result.ok?null:result.error})
  }
}
