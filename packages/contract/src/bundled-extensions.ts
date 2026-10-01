import {WorkError} from './work-error.ts'

/**
 * 随 Teloa 发行、默认不进组合的官方扩展。条目只来自这份编译期常量：
 * 不从在线目录或 npm 读取，第三方无法以同名条目出现。
 */
export const bundledExtensions=[{id:'im-gateway',packageName:'@teloa/im-gateway'},{id:'local-embedding',packageName:'@teloa/local-embedding'}] as const
export type BundledExtensionId=(typeof bundledExtensions)[number]['id']
export const bundledExtensionEndpoints=['bundled-extensions/list','bundled-extensions/set'] as const
/**
 * available：未启用；enable-pending：已写入组合，重启后加载；active：本进程已加载；
 * failed：本进程启动时已在组合里却没挂接成功；disable-pending：已移出组合，重启后卸下。
 */
export const bundledExtensionStates=['available','enable-pending','active','failed','disable-pending'] as const
export type BundledExtensionState=(typeof bundledExtensionStates)[number]
/** memoryRisk：只在本地中文检索一行出现——宿主物理内存 ≤ 8 GiB 且默认变体为 fp32 时为 true，界面据此提示内存风险。 */
export type BundledExtensionView={id:BundledExtensionId;packageName:string;version:string;state:BundledExtensionState;configuredChannels:number;memoryRisk?:boolean}

const bad=()=>new WorkError('teloa/invalid-input','官方扩展请求格式不正确或包含未知字段。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(typeof value!=='object'||value===null||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw bad()
 return value as Record<string,unknown>
}
export function isBundledExtensionId(value:unknown):value is BundledExtensionId{return bundledExtensions.some(row=>row.id===value)}
/**
 * `@teloa/` 作用域只属于随应用发行的官方包：市场 npm 安装与原生扩展管理一律拒收。
 * 不区分大小写：macOS/Windows 默认文件系统下 `node_modules/@Teloa/…` 与官方目录是同一处。
 */
export function isReservedOfficialPackage(name:string):boolean{return /^@teloa\//i.test(name)}
export function readBundledExtensionSetInput(value:unknown):{extensionId:BundledExtensionId;enabled:boolean}{
 const row=exact(value,['extensionId','enabled'])
 if(!isBundledExtensionId(row.extensionId)||typeof row.enabled!=='boolean')throw bad()
 return {extensionId:row.extensionId,enabled:row.enabled}
}
export function readBundledExtensionView(value:unknown):BundledExtensionView{
 const keys=['id','packageName','version','state','configuredChannels']
 const row=exact(value,isRecordWith(value,'memoryRisk')?[...keys,'memoryRisk']:keys)
 if(row.memoryRisk!==undefined&&(row.id!=='local-embedding'||typeof row.memoryRisk!=='boolean'))throw bad()
 const known=bundledExtensions.find(item=>item.id===row.id)
 if(!known||row.packageName!==known.packageName||typeof row.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(row.version))throw bad()
 if(!(bundledExtensionStates as readonly unknown[]).includes(row.state)||!Number.isInteger(row.configuredChannels)||(row.configuredChannels as number)<0)throw bad()
 return {id:known.id,packageName:known.packageName,version:row.version,state:row.state as BundledExtensionState,configuredChannels:row.configuredChannels as number,...(row.memoryRisk===undefined?{}:{memoryRisk:row.memoryRisk as boolean})}
}
const isRecordWith=(value:unknown,key:string)=>typeof value==='object'&&value!==null&&Object.hasOwn(value,key)
