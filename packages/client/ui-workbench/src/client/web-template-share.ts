import {readTemplateShareSubmission,type TemplateShareIntent,type TemplateSharePolicy,type TemplateShareReceipt} from '@teloa/contract'
import type {ShareBridge} from './EmployeeTemplateShare.js'
import {readSharePackage,sharePackageDigest,type SharePackage} from './share-package-plan.ts'

export const templateShareSiteOrigin='https://market.teloa.ai'
export const templateShareApiOrigin='https://share-api.teloa.ai'
const accountApiOrigin='https://api.market.teloa.ai'
const format='teloa.template-share-channel/v1'
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const hash=/^[a-f0-9]{64}$/
const invalid=()=>Object.assign(Error('Invalid template sharing response.'),{code:'invalid-host-response'})
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
type Method='publish'|'list'|'revoke'|'submit'|'withdraw'
type Pending={id:string;method:Method;body:unknown;sent:boolean;authorized:boolean;account?:string;resolve:(value:unknown)=>void;reject:(reason:unknown)=>void;timer:number}
type PublisherStorage={getItem:(key:string)=>string|null;setItem:(key:string,value:string)=>void}

export function readWebTemplateShareLink(input:string):TemplateShareIntent{
 let url:URL
 try{url=new URL(input.trim())}catch{throw invalid()}
 const shareId=url.searchParams.get('id')
 if(url.origin!==templateShareSiteOrigin||url.username||url.password||url.hash||!/^\/(?:en\/|zh-TW\/)?share\/$/.test(url.pathname)||[...url.searchParams].length!==1||!shareId||!uuid.test(shareId))throw invalid()
 return {shareId:shareId.toLowerCase()}
}

function receipt(value:unknown):TemplateShareReceipt{
 if(!record(value)||Object.keys(value).some(key=>!['shareId','version','sha256','shareUrl','downloadUrl','publishedAt','revoked','submission'].includes(key))||typeof value.shareId!=='string'||!uuid.test(value.shareId)||typeof value.version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value.version)||typeof value.sha256!=='string'||!hash.test(value.sha256)||typeof value.publishedAt!=='string'||!Number.isFinite(Date.parse(value.publishedAt))||typeof value.revoked!=='boolean'||value.shareUrl!==templateShareSiteOrigin+'/share/?id='+value.shareId||value.downloadUrl!==templateShareApiOrigin+'/v1/shares/'+value.shareId+'/package')throw invalid()
 if(value.submission!==undefined){const submission=readTemplateShareSubmission(value.submission);if(submission.shareId!==value.shareId||submission.sha256!==value.sha256)throw invalid()}
 return value as unknown as TemplateShareReceipt
}

/** 公开内容读取有字节上限；不携带 Cookie、令牌或本机身份。 */
async function readJson(fetcher:typeof fetch,url:string,maxBytes:number){
 const response=await fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)})
 if(!response.ok)throw Object.assign(Error('Template sharing is unavailable.'),{status:response.status})
 if(!response.body)throw invalid()
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw invalid()}chunks.push(next.value)}}finally{reader.releaseLock()}
 const result=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result)) as unknown}catch{throw invalid()}
}

/** 官方页面持有本人 Cookie；本地工作台只收固定回执，认证完成不会自动发布。 */
export function createWebTemplateShareBridge(host:Window=window,fetcher:typeof fetch=fetch,storage?:PublisherStorage):ShareBridge&{dispose:()=>void;receiveLink:(input:string)=>void}{
 let popup:Window|null=null,nonce='',ready=false,disposed=false,poll:number|undefined,pending:Pending|undefined
 let intent:TemplateShareIntent|null=null
 const initial=new URL(host.location.href).searchParams.get('template-share')
 if(initial&&uuid.test(initial))intent={shareId:initial.toLowerCase()}
 const listeners=new Set<(value:TemplateShareIntent|null)=>void>()
 const fail=(code:string)=>Object.assign(Error('Template sharing was not completed.'),{code})
 const cancelCurrent=(type:'cancel'|'context-rejected'='cancel')=>{if(pending&&popup&&!popup.closed)popup.postMessage({format,nonce,type,id:pending.id,method:pending.method},templateShareSiteOrigin)}
 const settle=(error:unknown,value?:unknown)=>{const current=pending;if(!current)return;pending=undefined;host.clearTimeout(current.timer)
  // 每项操作使用新的确认窗口和握手，避免已完成页面的旧 ready 状态让下一项请求一直等待。
  ready=false;popup=null;nonce='';if(poll!==undefined){host.clearInterval(poll);poll=undefined}
  error?current.reject(error):current.resolve(value)
 }
 const send=()=>{if(!ready||!popup||!pending||pending.sent)return;pending.sent=true;popup.postMessage({format,nonce,type:'request',id:pending.id,method:pending.method,body:pending.body},templateShareSiteOrigin)}
 const message=(event:MessageEvent)=>{
  if(disposed||event.origin!==templateShareSiteOrigin||event.source!==popup||!record(event.data)||event.data.format!==format||event.data.nonce!==nonce)return
  const data=event.data
  if(exact(data,['format','nonce','type'])&&data.type==='ready'){ready=true;send();return}
  if(!pending||data.id!==pending.id||data.method!==pending.method)return
  if(exact(data,['format','nonce','type','id','method','account'])&&data.type==='identity'&&typeof data.account==='string'&&uuid.test(data.account)){
   const current=pending,key=current.method==='publish'&&record(current.body)&&typeof current.body.requestId==='string'?'teloa.template-publisher/v1/'+current.body.requestId:undefined
   try{
    const pinned=key?storage?.getItem(key):undefined
    if(current.account!==undefined&&current.account!==data.account||pinned&&pinned!==data.account)throw fail('context-changed')
    if(key)storage?.setItem(key,data.account)
    current.account=data.account;current.authorized=true
    popup?.postMessage({format,nonce,type:'identity-accepted',id:current.id,method:current.method,account:data.account},templateShareSiteOrigin)
   }catch{cancelCurrent('context-rejected');settle(fail('context-changed'))}
   return
  }
  if(exact(data,['format','nonce','type','id','method','value'])&&data.type==='result'&&pending.authorized)settle(undefined,data.value)
  else if(exact(data,['format','nonce','type','id','method','error'])&&data.type==='error'&&typeof data.error==='string'&&['cancelled','unauthorized','forbidden','not_found','revoked','conflict','invalid_input','invalid_package','service_unavailable','context-changed'].includes(data.error))settle(fail(data.error))
 }
 host.addEventListener('message',message)
 const call=(method:Method,body:unknown)=>new Promise<unknown>((resolve,reject)=>{
  if(disposed){reject(fail('context-changed'));return}
  if(pending){reject(fail('conflict'));return}
  if(!popup||popup.closed){
   ready=false;nonce=Array.from(host.crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('')
   const fragment=new URLSearchParams({nonce,origin:host.location.origin})
   popup=host.open(templateShareSiteOrigin+'/share/manage/#'+fragment.toString(),'','popup,width=760,height=820')
   if(!popup){reject(fail('popup-blocked'));return}
  }
  const id=host.crypto.randomUUID(),timer=host.setTimeout(()=>{cancelCurrent();settle(fail('service_unavailable'))},10*60*1000)
  pending={id,method,body,sent:false,authorized:false,resolve,reject,timer}
  if(poll===undefined)poll=host.setInterval(()=>{if(popup?.closed){ready=false;nonce='';popup=null;settle(fail('cancelled'));if(poll!==undefined)host.clearInterval(poll);poll=undefined}},250)
  popup.focus();send()
 })
 return {
  async policy():Promise<TemplateSharePolicy>{
   try{const status=await readJson(fetcher,accountApiOrigin+'/v1/template-shares/status',2048)
    if(!exact(status,['format','available','apiOrigin','siteOrigin'])||status.format!=='teloa.template-share-service/v1'||status.available!==true||status.apiOrigin!==templateShareApiOrigin||status.siteOrigin!==templateShareSiteOrigin)throw invalid()
    return {receiveMode:'personal-role',canPublish:true}
   }catch{return {receiveMode:'personal-role',canPublish:false,reason:'service-unavailable'}}
  },
  async publish(input){
   if(!uuid.test(input.requestId))throw invalid()
   const pkg=readSharePackage(input.package),digest=await sharePackageDigest(pkg)
   const result=receipt(await call('publish',{requestId:input.requestId,package:pkg,sha256:digest}))
   if(result.sha256!==digest||result.version!==pkg.version)throw invalid()
   return result
  },
  async list(){const result=await call('list',{});if(!exact(result,['items'])||!Array.isArray(result.items)||result.items.length>1000)throw invalid();const items=result.items.map(receipt);if(new Set(items.map(value=>value.shareId)).size!==items.length)throw invalid();return items},
  async revoke(input){if(!uuid.test(input.shareId))throw invalid();const result=await call('revoke',input);if(!exact(result,['shareId','revoked'])||result.shareId!==input.shareId||result.revoked!==true)throw invalid();return result},
  async submit(input){if(!uuid.test(input.shareId)||input.licenseAttestation!==true)throw invalid();const result=readTemplateShareSubmission(await call('submit',input));if(result.shareId!==input.shareId)throw invalid();return result},
  async withdraw(input){if(!uuid.test(input.shareId))throw invalid();const result=readTemplateShareSubmission(await call('withdraw',input));if(result.shareId!==input.shareId||result.state!=='withdrawn')throw invalid();return result},
  async read(input){
   if(!uuid.test(input.shareId))throw invalid()
   const preview=await readJson(fetcher,templateShareApiOrigin+'/v1/shares/'+input.shareId,1024*1024)
   if(!record(preview)||preview.shareId!==input.shareId||typeof preview.sha256!=='string'||!hash.test(preview.sha256)||preview.downloadUrl!==templateShareApiOrigin+'/v1/shares/'+input.shareId+'/package')throw invalid()
   const pkg=readSharePackage(await readJson(fetcher,preview.downloadUrl,8*1024*1024)),digest=await sharePackageDigest(pkg)
   if(digest!==preview.sha256||pkg.version!==preview.version)throw invalid()
   return {shareId:input.shareId,package:pkg as SharePackage,sha256:digest}
  },
  pending:()=>intent,
  subscribe(callback){listeners.add(callback);return()=>{listeners.delete(callback)}},
  async dismiss(input){if(intent?.shareId===input.shareId){intent=null;for(const listener of listeners)listener(null)}},
  receiveLink(input){intent=readWebTemplateShareLink(input);for(const listener of listeners)listener(intent)},
  dispose(){disposed=true;cancelCurrent();host.removeEventListener('message',message);settle(fail('context-changed'));if(poll!==undefined)host.clearInterval(poll);listeners.clear();popup=null;nonce=''},
 }
}
