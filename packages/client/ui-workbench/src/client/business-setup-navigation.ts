import type {BusinessBuilderApi} from './business-builder-api.ts'
import type {BusinessTarget} from './business-preview.ts'
import type {BusinessSetupAction,BusinessSetupApi} from './business-setup.ts'
import {createBusinessSetupApi,type BusinessSetupPorts} from './business-setup-api.ts'

export type BusinessSetupIdentity={status:string;namespace?:string|null;api?:BusinessBuilderApi|null}
export type BusinessSetupOrigin={namespace:string;api:BusinessBuilderApi;title:string;target:BusinessTarget}
const identityMatches=(origin:Pick<BusinessSetupOrigin,'namespace'|'api'>,identity:BusinessSetupIdentity)=>identity.status==='ready'&&identity.namespace===origin.namespace&&identity.api===origin.api
/** 返回目标只存在当前本人内存；精确业务位置包含记录引用与筛选。 */
export function businessSetupOrigin(input:{scope:string;title:string;identity:BusinessSetupIdentity;mainTarget:BusinessTarget;embeddedTarget?:BusinessTarget|null}):BusinessSetupOrigin|null{
 const {identity,scope}=input
 if(identity.status!=='ready'||!identity.namespace||!identity.api)return null
 const target=input.embeddedTarget?.scope===scope?input.embeddedTarget:input.mainTarget.scope===scope?input.mainTarget:{scope,section:'overview' as const}
 return {namespace:identity.namespace,api:identity.api,title:input.title,target:structuredClone(target)}
}
export function businessSetupReturnOrigin(origin:BusinessSetupOrigin|null,input:{identity:BusinessSetupIdentity;view:string}):BusinessSetupOrigin|null{
 return origin&&identityMatches(origin,input.identity)&&['team','resources','market','capabilities','settings'].includes(input.view)?origin:null
}
export function openBusinessSetupDestination(scope:string,action:BusinessSetupAction,ports:{colleagues:(scope:string)=>void;role:(id:string)=>void;resources:()=>void;category:(category:'skill'|'connector')=>void;catalogEntry:(catalogId:string)=>void}):void{
 switch(action.kind){
  case 'colleagues':ports.colleagues(scope);break
  case 'role':ports.role(action.id);break
  case 'resources':ports.resources();break
  case 'skills':ports.category('skill');break
  case 'connections':ports.category('connector');break
  case 'connection':ports.category('connector');ports.catalogEntry(action.catalogId);break
 }
}
export function returnToBusinessSetup(origin:BusinessSetupOrigin|null,identity:BusinessSetupIdentity,ports:{refresh:()=>void;enter:(target:BusinessTarget)=>void}):void{
 if(!origin||!identityMatches(origin,identity))return
 ports.refresh();ports.enter(structuredClone(origin.target))
}
/** 配置实例绑定创建时的代次与本人；旧视图后续调用不能借新连接继续。 */
export function createGenerationGuardedCall(generation:()=>unknown,call:(endpoint:string,payload:unknown)=>Promise<unknown>,isCurrent:()=>boolean=()=>true):(endpoint:string,payload:unknown)=>Promise<unknown>{
 const started=generation()
 const guard=()=>{if(started===undefined||started===null||generation()!==started||!isCurrent())throw Error('业务连接已变化。')}
 return async(endpoint,payload)=>{
  guard()
  const result=await call(endpoint,payload)
  guard()
  return result
 }
}
/** 原目录解析器仍为唯一入口；逐次读前后核验本人和连接，不把 owner 下传为管理权限。 */
export function createBusinessSetupReader(input:{namespace:string;token:BusinessBuilderApi;identity:()=>BusinessSetupIdentity;generation:()=>unknown;ports:Omit<BusinessSetupPorts,'current'|'isCurrent'>}):BusinessSetupApi{
 const started=input.generation()
 const isCurrent=()=>started!==undefined&&started!==null&&input.generation()===started&&identityMatches({namespace:input.namespace,api:input.token},input.identity())
 const guarded=async<T>(read:()=>Promise<T>):Promise<T>=>{if(!isCurrent())throw Error('业务连接已变化。');const value=await read();if(!isCurrent())throw Error('业务连接已变化。');return value}
 const ports=input.ports
 return createBusinessSetupApi({current:{current:(value,signal)=>guarded(()=>input.token.current(value,signal))},responsibility:{read:value=>guarded(()=>ports.responsibility.read(value))},roles:{list:()=>guarded(()=>ports.roles.list())},resources:{directory:()=>guarded(()=>ports.resources.directory()),sources:()=>guarded(()=>ports.resources.sources())},skills:signal=>guarded(()=>ports.skills(signal)),connections:{list:()=>guarded(()=>ports.connections.list())},isCurrent,...(ports.now?{now:ports.now}:{})})
}
