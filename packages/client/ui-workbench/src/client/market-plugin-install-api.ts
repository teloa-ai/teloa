import {
  readMarketPluginInstallFailure,
  readMarketPluginInstallObservation,
  readMarketPluginInstallPreview,
  readMarketPluginInstallReceipt,
  readMarketPluginInstallSpec,
  readMarketPluginInstallationState,
  readMarketPluginRegistrySource,
  sameMarketPluginPermissions,
  type MarketPluginInstallFailure,
  type MarketPluginInstallObservation,
  type MarketPluginInstallPreview,
  type MarketPluginInstallReceipt,
  type MarketPluginInstallSpec,
  type MarketPluginInstallationState,
  type MarketPluginRegistrySource,
} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(method:string,payload:unknown)=>Promise<unknown>
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}

export type MarketPluginInstallation=Readonly<{
  id:string
  ownerId:string
  preview:MarketPluginInstallPreview
  state:MarketPluginInstallationState
  attempt:number
  receipt?:MarketPluginInstallReceipt
  observation?:MarketPluginInstallObservation
  failure?:MarketPluginInstallFailure
  createdAt:string
  updatedAt:string
}>

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw Error('DSH 扩展安装响应格式不正确。')
  return value as Record<string,unknown>
}

function installation(value:unknown):MarketPluginInstallation{
  try{
    const raw=value as Record<string,unknown>
    const optional=['receipt','observation','failure'].filter(key=>raw?.[key]!==undefined)
    const row=exact(value,['id','ownerId','preview','state','attempt','createdAt','updatedAt',...optional])
    if(!uuid(row.id)||typeof row.ownerId!=='string'||!row.ownerId.trim()||row.ownerId.length>128||typeof row.attempt!=='number'||!Number.isSafeInteger(row.attempt)||row.attempt<0||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw Error()
    const preview=readMarketPluginInstallPreview(row.preview),state=readMarketPluginInstallationState(row.state)
    const receipt=row.receipt===undefined?undefined:readMarketPluginInstallReceipt(row.receipt)
    const observation=row.observation===undefined?undefined:readMarketPluginInstallObservation(row.observation)
    const failure=row.failure===undefined?undefined:readMarketPluginInstallFailure(row.failure)
    if((state==='failed'||state==='unknown')!==!!failure||(state==='preparing'&&failure!==undefined)||(state.startsWith('installed-')&&(failure!==undefined||observation===undefined)))throw Error()
    if(observation&&(observation.status==='active'||observation.status==='restart-required')&&(observation.source.packageName!==preview.source.packageName||observation.source.version!==preview.source.version||observation.bundleHash!==preview.bundleHash||!sameMarketPluginPermissions(observation.permissionSummary,preview.permissionSummary)))throw Error()
    return {id:row.id.toLowerCase(),ownerId:row.ownerId,preview,state,attempt:row.attempt,...(receipt?{receipt}:{}),...(observation?{observation}:{}),...(failure?{failure}:{}),createdAt:row.createdAt,updatedAt:row.updatedAt}
  }catch{throw Error('DSH 扩展安装响应格式不正确。')}
}

export type MarketPluginInstallApi=ReturnType<typeof createMarketPluginInstallApi>

/** 以固定预览提交；任何未确定的写入都只能沿用原 requestId 继续核对。 */
export function createMarketPluginInstallApi(call:Call,journal?:Journal){
  let pending:MarketPluginInstallSpec|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false,unknownInstallationId:string|undefined
  try{
    const raw=journal?.read()
    if(raw){
      if(raw.length>12_000)throw Error()
      const row=exact(JSON.parse(raw),['schema','request'])
      if(row.schema!=='teloa.market-plugin-install/v1')throw Error()
      pending=readMarketPluginInstallSpec(row.request)
    }
  }catch{recoveryError=recoveryStorageError()}
  const send=async()=>{
    if(recoveryError)throw recoveryError
    if(!pending)throw Error('没有待核对的 DSH 扩展安装请求。')
    if(busy)throw Error('DSH 扩展安装正在核对。')
    busy=true
    try{
      journal?.write(JSON.stringify({schema:'teloa.market-plugin-install/v1',request:pending}))
      const saved=installation(await call('market-plugins/install',pending))
      if(saved.preview.bundleHash!==pending.preview.bundleHash||saved.preview.source.packageName!==pending.preview.source.packageName||saved.preview.source.version!==pending.preview.source.version)throw Error('DSH 扩展安装响应与原请求不一致。')
      journal?.clear()
      pending=undefined
      if(saved.state==='unknown')unknownInstallationId=saved.id
      return saved
    }catch(error){
      if(error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&['teloa/invalid-input','teloa/forbidden','teloa/source-unavailable','teloa/conflict'].includes(String(error.code))){journal?.clear();pending=undefined}
      throw error
    }finally{busy=false}
  }
  return {
    pending:()=>pending?structuredClone(pending):undefined,
    recoveryMessage:()=>recoveryError,
    // 丢弃只清本地记录，不通知服务端：requestId 一丢就没有可靠的撤销面了（规格 §二 D4）。
    discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
    preview:async(source:MarketPluginRegistrySource)=>{
      const fixed=readMarketPluginRegistrySource(source)
      const result=readMarketPluginInstallPreview(await call('market-plugins/preview',{source:fixed}))
      if(result.source.packageName!==fixed.packageName||result.source.version!==fixed.version)throw Error('DSH 扩展安装预览与请求来源不一致。')
      return result
    },
    install:async(value:MarketPluginInstallSpec)=>{
      const next=readMarketPluginInstallSpec(value)
      if(unknownInstallationId)throw Error('此 DSH 扩展安装结果尚未确认，请先核对原安装记录。')
      if(pending&&JSON.stringify(pending)!==JSON.stringify(next))throw Error('请先核对原 DSH 扩展安装请求。')
      pending??=next
      return send()
    },
    recover:send,
    reconcile:async(id:string)=>{
      const installationId=uuid(id)?id.toLowerCase():(()=>{throw Error('DSH 扩展安装记录身份不正确。')})()
      const saved=installation(await call('market-plugins/reconcile',{installationId}))
      if(saved.id!==installationId)throw Error('DSH 扩展安装核对响应身份不一致。')
      unknownInstallationId=saved.state==='unknown'?saved.id:undefined
      return saved
    },
    get:async(id:string)=>{
      const installationId=uuid(id)?id.toLowerCase():(()=>{throw Error('DSH 扩展安装记录身份不正确。')})()
      const saved=installation(await call('market-plugins/get',{installationId}))
      if(saved.id!==installationId)throw Error('DSH 扩展安装记录身份不一致。')
      return saved
    },
    list:async()=>{
      const row=exact(await call('market-plugins/list',{}),['items'])
      if(!Array.isArray(row.items))throw Error('DSH 扩展安装目录格式不正确。')
      const items=row.items.map(installation)
      if(new Set(items.map(item=>item.id)).size!==items.length||new Set(items.map(item=>item.ownerId)).size>1)throw Error('DSH 扩展安装目录身份不一致。')
      return {items}
    },
  }
}
