/**
 * 飞书官方 SDK 的受管安装配方与加载。SDK 不进任何 package.json（评审 M7）：用户保存飞书或 Lark 渠道凭据时（两者共用同一配方、同一安装目录），
 * 宿主经 teloaWork.packages.install(feishuSdkRecipe) 按钉住的版本与 integrity 安装到运行目录，本模块从该目录加载。
 */
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {WorkError} from '@teloa/contract'

export const feishuSdkRecipe={package:'@larksuiteoapi/node-sdk',version:'1.74.0',integrity:'sha512-K2WoGy6x97u2kPPSFsu0v9X8CY+0q4OwO3rhXiOSRXYjGS7ovydFpEH07AS5VYcBnbQCoc5sGezo0IEGVViuoA=='} as const

/** SDK 响应外形：code 为 0 表示成功（HTTP 非 2xx 时 SDK 抛 axios 错误）。 */
export type FeishuResponse<T>={code?:number;msg?:string;data?:T}
export type FeishuLogger={error(...msg:unknown[]):void;warn(...msg:unknown[]):void;info(...msg:unknown[]):void;debug(...msg:unknown[]):void;trace(...msg:unknown[]):void}
export type FeishuClient={
 im:{message:{
  create(payload:{params:{receive_id_type:'chat_id'};data:{receive_id:string;msg_type:string;content:string}}):Promise<FeishuResponse<{message_id?:string}>>
  reply(payload:{path:{message_id:string};data:{msg_type:string;content:string;reply_in_thread?:boolean}}):Promise<FeishuResponse<{message_id?:string}>>
  patch(payload:{path:{message_id:string};data:{content:string}}):Promise<FeishuResponse<unknown>>
 }}
 request(payload:{url:string;method:'GET'}):Promise<FeishuResponse<unknown>&{bot?:{open_id?:string;app_name?:string}}>
}
export type FeishuEventDispatcher={register(handles:Record<string,(data:unknown)=>Promise<unknown>>):FeishuEventDispatcher}
export type FeishuWsClient={start(params:{eventDispatcher:FeishuEventDispatcher}):Promise<void>;close(params?:{force?:boolean}):void}
/** SDK 的 Cache 接口（types/index.d.ts）：expiredTime 为绝对毫秒时间戳。 */
export type FeishuCache={
 get(key:string|symbol,options?:{namespace?:string}):Promise<unknown>
 set(key:string|symbol,value:unknown,expiredTime?:number,options?:{namespace?:string}):Promise<boolean>
}
/** SDK 的数值枚举 Domain（lib/index.js formatDomain：Feishu → https://open.feishu.cn，Lark → https://open.larksuite.com）。 */
export type FeishuDomain={readonly Feishu:0;readonly Lark:1}
/** 1.74.0 CJS 入口 lib/index.js 顶层导出中本适配器用到的部分（已对照该版本类型声明核实）。 */
export type FeishuSdk={
 Domain:FeishuDomain
 Client:new(opts:{appId:string;appSecret:string;domain:FeishuDomain[keyof FeishuDomain];cache:FeishuCache;logger?:FeishuLogger})=>FeishuClient
 EventDispatcher:new(opts:{encryptKey?:string;logger?:FeishuLogger})=>FeishuEventDispatcher
 WSClient:new(opts:{
  appId:string;appSecret:string;domain:FeishuDomain[keyof FeishuDomain];logger?:FeishuLogger;autoReconnect?:boolean;handshakeTimeoutMs?:number
  onReady?:()=>void;onError?:(err:Error)=>void;onReconnecting?:()=>void;onReconnected?:()=>void
 })=>FeishuWsClient
}

export async function loadFeishuSdk(installDir:string):Promise<FeishuSdk>{
 let sdk:Partial<FeishuSdk>
 try{
  sdk=createRequire(resolve(installDir,'package.json'))(feishuSdkRecipe.package) as Partial<FeishuSdk>
 }catch{
  throw new WorkError('teloa/dependency-unavailable','飞书 SDK 未安装，请重新保存渠道密钥。')
 }
 // Domain 必须恰是官方两值：适配器只会把这两个常量交给 SDK，SDK 再映射为固定官方地址。
 if(typeof sdk.Client!=='function'||typeof sdk.EventDispatcher!=='function'||typeof sdk.WSClient!=='function'||sdk.Domain?.Feishu!==0||sdk.Domain.Lark!==1){
  throw new WorkError('teloa/dependency-unavailable','飞书 SDK 已损坏，请重新保存渠道密钥。')
 }
 return sdk as FeishuSdk
}
