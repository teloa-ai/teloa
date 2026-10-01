import {isRecord,type MarketCatalogRoleEntry,type MarketInstallEntry} from '@teloa/contract'

const utcDayOf=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)?value.slice(0,10):undefined
const utcToday=()=>new Date().toISOString().slice(0,10)

/**
 * 市场二期：从官方目录添加成功的回执推出上报条目（规格 2026-09-26 §3 前三行）。
 * 原始日期：内容回执取 receipt.createdAt（待恢复请求重放时回执不变），连接器取记录 createdAt，直接添加的 AI 员工取当日。
 * 连接器与 AI 员工的版本取宿主本地目录快照（entryVersion），不信任客户端载荷；快照里没有该条目则不报。
 * GitHub 导入、本地草案、已存在的岗位与其他端点一律返回 undefined。服务端另按签名索引白名单复核。
 */
export function resourceInstallOf(endpoint:string,payload:unknown,result:unknown,entryVersion:(kind:'connector'|'role',entryId:string)=>string|undefined,today:string):MarketInstallEntry|undefined{
 if(endpoint==='mcp-connections/add'){
  const catalogId=isRecord(result)&&typeof result.catalogId==='string'?result.catalogId:undefined
  const version=catalogId===undefined?undefined:entryVersion('connector',catalogId)
  const day=isRecord(result)?utcDayOf(result.createdAt):undefined
  return catalogId!==undefined&&version!==undefined&&day!==undefined?{id:catalogId,version,kind:'connector',day}:undefined
 }
 if(endpoint!=='market-catalog/add')return undefined
 if(isRecord(payload)&&payload.kind==='role'){
  const version=isRecord(result)&&result.status==='created'&&typeof payload.entryId==='string'?entryVersion('role',payload.entryId):undefined
  return version!==undefined&&typeof payload.entryId==='string'?{id:payload.entryId,version,kind:'role',day:today}:undefined
 }
 const receipt=isRecord(result)&&isRecord(result.receipt)?result.receipt:undefined
 const source=receipt&&isRecord(receipt.source)?receipt.source:undefined
 const contentKind=isRecord(result)&&isRecord(result.content)?result.content.kind:undefined
 const kind=contentKind==='atomic-skill'?'skill' as const:contentKind==='industry-template'?'solution' as const:undefined
 const day=utcDayOf(receipt?.createdAt)
 if(!source||source.kind!=='catalog'||source.catalog!=='teloa-official'||typeof source.entryId!=='string'||typeof source.entryVersion!=='string'||!kind||!day)return undefined
 return {id:source.entryId,version:source.entryVersion,kind,day}
}

/** 包装 market-catalog/add 与 mcp-connections/add：成功返回后按回执上报（上报不阻塞、不抛错）；失败原样抛出，不上报。 */
export function withResourceInstallReport<A extends unknown[],R>(handler:(endpoint:string,payload:unknown,...rest:A)=>Promise<R>,report:(entry:MarketInstallEntry)=>void,entryVersion:(kind:'connector'|'role',entryId:string)=>string|undefined){
 return async(endpoint:string,payload:unknown,...rest:A):Promise<R>=>{
  const result=await handler(endpoint,payload,...rest)
  // 兜底：推导或上报出任何错都不得影响已成功的安装结果
  try{
   const entry=resourceInstallOf(endpoint,payload,result,entryVersion,utcToday())
   if(entry)report(entry)
  }catch{/* 上报失败静默 */}
  return result
 }
}

/**
 * 方案附带的 AI 员工（规格 §3 第 4 行）：industry-roles/instantiate 返回已建岗位后，在后台查证并上报；
 * 查证失败或不是官方条目时静默不报，不影响建岗结果。原始日期取实例 createdAt。
 * enabled() 为假（未开启或排除环境）时直接短路：不查库、不读方案包。
 */
export function withSolutionRoleReport<A extends unknown[],R>(handler:(method:string,payload:unknown,...rest:A)=>Promise<R>,report:(entry:MarketInstallEntry)=>void,resolve:(loadId:string,roleId:string,day:string)=>Promise<MarketInstallEntry|undefined>,enabled:()=>boolean){
 return async(method:string,payload:unknown,...rest:A):Promise<R>=>{
  const result=await handler(method,payload,...rest)
  try{
   if(method==='industry-roles/instantiate'&&isRecord(result)&&isRecord(result.role)&&typeof result.loadId==='string'&&typeof result.itemLocalId==='string'&&enabled()){
    const day=utcDayOf(result.createdAt)
    if(day)void resolve(result.loadId,result.itemLocalId,day).then(entry=>{if(entry)report(entry)}).catch(()=>undefined)
   }
  }catch{/* 上报失败静默 */}
  return result
 }
}

/**
 * 方案岗位 → 目录 role 条目：加载内容的发布者必须是「Teloa 官方目录」（content-store 只允许 catalog 来源使用这个名称），
 * 目录中存在 teloa.role.<roleId>，且其 fromSolution.packageId 等于加载的 templateId。不满足任一条件即不计。
 */
export function createSolutionRoleResolver(ports:{load:(loadId:string)=>Promise<unknown>;content:(contentId:string)=>Promise<unknown>;roleEntry:(entryId:string)=>MarketCatalogRoleEntry|undefined}){
 return async(loadId:string,roleId:string,day:string):Promise<MarketInstallEntry|undefined>=>{
  const load=await ports.load(loadId)
  if(!isRecord(load)||typeof load.contentId!=='string'||typeof load.templateId!=='string')return undefined
  const content=await ports.content(load.contentId)
  if(!isRecord(content)||!isRecord(content.trust)||content.trust.publisher!=='Teloa 官方目录')return undefined
  const entry=ports.roleEntry('teloa.role.'+roleId)
  if(!entry||entry.role.roleId!==roleId||entry.role.fromSolution.packageId!==load.templateId)return undefined
  return {id:entry.id,version:entry.version,kind:'role',day}
 }
}
