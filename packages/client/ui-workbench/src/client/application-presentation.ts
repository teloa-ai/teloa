export type ApplicationPresentation=Readonly<{schema:'teloa.application-presentation/v1';product:'Free'|'Pro'|'Enterprise';account:Readonly<{displayName:string;email:string}>|null}>
export type ApplicationBridge={presentation:()=>Promise<unknown>;openAccount:()=>Promise<unknown>}
declare global{interface Window{teloaApplication?:ApplicationBridge}}

const free:ApplicationPresentation=Object.freeze({schema:'teloa.application-presentation/v1',product:'Free',account:null})
const invalid=()=>Error('应用身份信息不可用。')
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)

// 仅为宿主展示身份；版本名称不能授予业务权益或执行许可。
export function readApplicationPresentation(value:unknown):ApplicationPresentation{
 if(!exact(value,['schema','product','account'])||value.schema!==free.schema||typeof value.product!=='string'||!['Free','Pro','Enterprise'].includes(value.product))throw invalid()
 if(value.product==='Free'){if(value.account!==null)throw invalid();return free}
 if(!exact(value.account,['displayName','email'])||!text(value.account.displayName,320)||!text(value.account.email,320))throw invalid()
 return Object.freeze({schema:free.schema,product:value.product as ApplicationPresentation['product'],account:Object.freeze({displayName:value.account.displayName,email:value.account.email})})
}

export function createApplicationPresentationStore(){
 let snapshot=free,bridge:ApplicationBridge|undefined,generation=0
 const listeners=new Set<()=>void>(),publish=()=>{for(const listener of listeners)listener()}
 return {
  getSnapshot:()=>snapshot,
  subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener)}},
  async configure(candidate?:ApplicationBridge){
   const owner=++generation
   bridge=undefined;snapshot=free;publish()
   if(candidate!==undefined&&(!candidate||typeof candidate.presentation!=='function'||typeof candidate.openAccount!=='function'))throw invalid()
   const next=candidate?readApplicationPresentation(await candidate.presentation()):free
   if(generation!==owner)throw invalid()
   bridge=candidate;snapshot=next;publish()
   return ()=>{if(generation!==owner)return;generation++;bridge=undefined;snapshot=free;publish()}
  },
  async openAccount(){if(!bridge||!snapshot.account)throw invalid();await bridge.openAccount()},
 }
}
export const applicationPresentation=createApplicationPresentationStore()
