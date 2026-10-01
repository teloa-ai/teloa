/**
 * 随附官方扩展的即时启停：宿主不开 hmr 文件监听（`patchReload` 钉不变），只在本人点「启用/停用」时
 * 显式调一次官方 `reconcileProfilePatches`，调用前后用装配期同一套函数复验。
 *
 * 可热套用的只有一种变化：新补丁代与当前生效代相比，**只多出或少掉**该扩展 bundle 自带的那一行
 * （`{id,name}`，不带 config/inject/isolate）。其它任何差别（本人改过 profile 补丁文件、第三方 bundle 变化等）
 * 都不在这里生效，退回「重启后生效」，由下次启动的完整核对处理。
 */
import {prepareProfilePatches,readProfilePatches,reconcileProfilePatches} from '@deepseek-ai/dsh-app-boot'
import {WorkError} from '@teloa/contract'

/** 一代补丁在 Loader 根 Include 里的形态：`prepareProfilePatches` 输出的单个 insert 行列表。 */
export type PatchGeneration=readonly unknown[]

export type BundledHotApplyPorts={
 /** 根 Include 当前生效的补丁代与解析基址；不是受管 profile 宿主或形态不符时 undefined（退回重启生效）。 */
 current():{patches:PatchGeneration;parentURL:string}|undefined
 /** 按磁盘上的 profile 重新读一代补丁（官方 readProfilePatches）。 */
 read():unknown[]
 /** 官方 prepareProfilePatches：兼容性预检后折成 `[{insert:rows}]`。 */
 prepare(patches:unknown[],parentURL:string):PatchGeneration
 /** 官方 reconcileProfilePatches：套用整代补丁并等待 Loader 激活结果；requiredIds 的激活失败同样抛出。 */
 reconcile(patches:PatchGeneration,requiredIds:readonly string[]):Promise<void>
 /** 装配期同一套复验：来源核对、链接核对、生效组合安全钉（含 hmr 服务事实）与待启用清单；任一不符即抛出。 */
 verify():Promise<void>
 /** 该扩展此刻是否已在本进程加载（IM 通道：已挂接；本地检索：teloaEmbedding 已提供）。 */
 loaded(packageName:string):boolean
 /** 热套用期间调用：IM 通道的挂接窗口只在这段时间内开放。 */
 window?<T>(packageName:string,enabled:boolean,operation:()=>Promise<T>):Promise<T>
 warn(message:string):void
}

export type BundledHotApplyResult='applied'|'restart-required'

const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)

/** 对象键序无关、数组保序的规范化文本；`!!js` 表达式节点按其字段一并参与比较。 */
function canonical(value:unknown):string{
 const visit=(node:unknown):unknown=>Array.isArray(node)?node.map(visit):record(node)?Object.fromEntries(Object.keys(node).sort().map(key=>[key,visit(node[key])])):node
 return JSON.stringify(visit(value))
}

/** `[{insert:rows}]` → rows；形态不符返回 undefined。空组合是 `[]`。 */
function generationRows(patches:PatchGeneration):unknown[]|undefined{
 if(patches.length===0)return []
 if(patches.length!==1||!record(patches[0])||Object.keys(patches[0]).length!==1||!Array.isArray(patches[0].insert))return undefined
 return patches[0].insert
}

const mentions=(row:unknown,packageName:string):boolean=>record(row)&&(row.name===packageName)

/**
 * 两代之间是否只差该扩展那一行：去掉挂着该包的行后逐行（含顺序）一致；
 * 新一代里该包的行在启用时必须恰好是 `{id:rowId,name:packageName}`，停用时必须不存在。
 */
export function onlyExtensionRowDiffers(current:PatchGeneration,next:PatchGeneration,change:{packageName:string;rowId:string;enabled:boolean}):boolean{
 const before=generationRows(current),after=generationRows(next)
 if(!before||!after)return false
 const rest=(rows:unknown[])=>canonical(rows.filter(row=>!mentions(row,change.packageName)))
 if(rest(before)!==rest(after))return false
 const target=after.filter(row=>mentions(row,change.packageName))
 return change.enabled?target.length===1&&canonical(target[0])===canonical({id:change.rowId,name:change.packageName}):target.length===0
}

/** refused：安全核对不符（RPC 上为 teloa/forbidden）；failed：读取、加载或卸下失败。rolledBack：运行中组合已恢复到调用前那一代。 */
/** 官方 reconcileProfilePatches 找不到根 Include（此时尚未改动任何东西）：本宿主不支持热套用，退回重启生效。 */
export class BundledHotApplyUnsupported extends Error{}
const rootIncludeMissing=/profile reload requires the root Include entry/

export class BundledHotApplyError extends Error{
 readonly kind:'refused'|'failed'
 readonly rolledBack:boolean
 constructor(message:string,kind:'refused'|'failed',rolledBack:boolean,options?:{cause?:unknown}){super(message,options);this.kind=kind;this.rolledBack=rolledBack}
}

/**
 * 调用方必须已持有 profile 锁并已把 bundles 写成目标状态（启用前已核对来源）。
 * - 热套用成功：返回 `applied`。
 * - 本宿主不支持热套用、或新一代补丁除本扩展外还有其它变化：不动运行中组合，返回 `restart-required`。
 * - 预检、套用或事后复验失败：把运行中组合恢复到调用前那一代，抛 BundledHotApplyError；调用方据此恢复 bundles。
 */
export async function hotApplyBundledExtension(ports:BundledHotApplyPorts,change:{packageName:string;rowId:string;enabled:boolean}):Promise<BundledHotApplyResult>{
 const current=ports.current()
 if(!current)return 'restart-required'
 // 预检：调用前的运行中组合与磁盘来源必须仍符合装配期判据，否则不在这台宿主上动任何东西。
 try{await ports.verify()}
 catch(error){throw new BundledHotApplyError('Teloa 当前的运行配置没有通过安全检查，已拒绝即时'+(change.enabled?'启用':'停用')+'。','refused',true,{cause:error})}
 let next:PatchGeneration
 try{next=ports.prepare(ports.read(),current.parentURL)}
 catch(error){throw new BundledHotApplyError('读取扩展配置失败，官方扩展状态未改变。','failed',true,{cause:error})}
 if(!onlyExtensionRowDiffers(current.patches,next,change))return 'restart-required'
 const previous=structuredClone(current.patches) as PatchGeneration
 const rollback=async(reason:string,kind:'refused'|'failed',cause:unknown):Promise<never>=>{
  let restored=true
  // 前一代含 IM 行时（停用失败回滚），IM 要重新挂接：窗口按「启用」打开。
  const restore=()=>ports.reconcile(previous,[])
  try{await (ports.window?ports.window(change.packageName,!change.enabled,restore):restore());await ports.verify()}
  catch(error){restored=false;ports.warn('官方扩展热套用回滚未完成：'+(error instanceof Error?error.message:String(error)))}
  throw new BundledHotApplyError(reason,kind,restored,{cause})
 }
 const apply=()=>ports.reconcile(next,change.enabled?[change.rowId]:[])
 try{await (ports.window?ports.window(change.packageName,change.enabled,apply):apply())}
 catch(error){
  if(error instanceof BundledHotApplyUnsupported)return 'restart-required'
  return rollback(change.enabled?'扩展加载失败，已恢复为未启用。':'扩展卸下失败，已恢复为启用。','failed',error)
 }
 // 事后复验：同一套判据再核一遍，并确认目标确实已加载 / 已卸下。
 try{await ports.verify()}
 catch(error){return rollback((change.enabled?'启用':'停用')+'后的运行配置没有通过安全检查，已恢复为调用前的状态。','refused',error)}
 // 实际生效的必须就是比对过的那一代（兼容性预检等不得在套用时另行改动）。
 const applied=ports.current()
 if(!applied||canonical(applied.patches)!==canonical(next))return rollback((change.enabled?'启用':'停用')+'后的运行配置没有通过安全检查，已恢复为调用前的状态。','refused',undefined)
 if(ports.loaded(change.packageName)!==change.enabled)return rollback(change.enabled?'扩展没有加载成功，已恢复为未启用。':'扩展没有卸下，已恢复为启用。','failed',undefined)
 return 'applied'
}

/**
 * 热套用失败在 RPC 上的错误：安全核对不符为 forbidden，其余为暂不可用；消息为白话，不含路径。
 * details.reason 让界面与「来源未登记」（同为 forbidden）区分开，按语种给固定文案。
 */
export function bundledHotApplyWorkError(error:BundledHotApplyError):WorkError{
 const suffix=error.rolledBack?'':'运行中的状态可能与设置不一致，重启 Teloa 后以设置为准。'
 return error.kind==='refused'
  ?new WorkError('teloa/forbidden',error.message+suffix,{reason:'safety-check',rolledBack:error.rolledBack})
  :new WorkError('teloa/dependency-unavailable',error.message+suffix,{reason:'load-failed',rolledBack:error.rolledBack})
}

type LoaderEntry={id?:unknown;disabled?:unknown;options?:Record<string,unknown>;parent?:{tree?:{ctx?:{baseUrl?:unknown}}}}
/**
 * 真实宿主上的端口：根 Include 取自 Loader（根层条目 id 为 `include`、模块为 `cordis:include`），
 * profile 上下文取自根上下文的 `profileContext`（官方 dsh 启动器提供）。任一取不到即视为不支持热套用。
 */
export function hostBundledHotApplyPorts(ctx:unknown,ports:Pick<BundledHotApplyPorts,'verify'|'loaded'|'window'|'warn'>):BundledHotApplyPorts{
 const root=record(ctx)||typeof ctx==='object'?Reflect.get(ctx as object,'root') as unknown:undefined
 const get=(name:string):unknown=>{try{const fn=record(root)?Reflect.get(root,'get'):undefined;return typeof fn==='function'?fn.call(root,name):undefined}catch{return undefined}}
 const rootInclude=():LoaderEntry|undefined=>{
  try{
   const loader=record(root)?Reflect.get(root,'loader'):undefined
   if(!record(loader)||typeof loader.entries!=='function')return undefined
   const matches=[...(loader.entries as ()=>Iterable<LoaderEntry>)()].filter(entry=>entry.id==='include'&&entry.options?.id==='include'&&entry.options?.name==='cordis:include')
   return matches.length===1?matches[0]:undefined
  }catch{return undefined}
 }
 return {
  ...ports,
  current(){
   const entry=rootInclude(),profile=get('profileContext')
   const config=entry?.options?.config,base=entry?.parent?.tree?.ctx?.baseUrl
   if(!entry||!record(profile)||!record(config)||typeof config.path!=='string'||typeof base!=='string')return undefined
   const patches=config.patches===undefined?[]:config.patches
   if(!Array.isArray(patches))return undefined
   return {patches,parentURL:new URL('.',new URL(config.path,base)).href}
  },
  read:()=>readProfilePatches('dsh',get('profileContext') as Parameters<typeof readProfilePatches>[1]),
  prepare:(patches,parentURL)=>prepareProfilePatches(root as Parameters<typeof prepareProfilePatches>[0],patches as Parameters<typeof prepareProfilePatches>[1],parentURL,'dsh'),
  reconcile:async(patches,requiredIds)=>{
   let warnings:string[]
   try{warnings=await reconcileProfilePatches(root as Parameters<typeof reconcileProfilePatches>[0],structuredClone([...patches]) as Parameters<typeof reconcileProfilePatches>[1],'dsh',requiredIds)}
   catch(error){if(error instanceof Error&&rootIncludeMissing.test(error.message))throw new BundledHotApplyUnsupported(error.message,{cause:error});throw error}
   for(const warning of warnings)ports.warn(warning)
  },
 }
}
