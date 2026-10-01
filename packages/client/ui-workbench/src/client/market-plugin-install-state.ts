import {readMarketPluginInstallSpec, type MarketPluginInstallSpec} from '@teloa/contract'
import type {MarketPluginInstallation} from './market-plugin-install-api.js'

export type MarketPluginInstallStatus={key:'preparing'|'pending-enable'|'pending-enable-interrupted'|'active'|'restart-required'|'failed'|'unknown';canInstall:boolean;canReconcile:boolean}

export function marketPluginInstallStatus(record:MarketPluginInstallation):MarketPluginInstallStatus{
  switch(record.state){
    case 'preparing':return {key:'preparing',canInstall:false,canReconcile:true}
    case 'installed-pending-enable':return marketPluginInstallInterrupted(record)?{key:'pending-enable-interrupted',canInstall:true,canReconcile:true}:{key:'pending-enable',canInstall:false,canReconcile:true}
    case 'installed-active':return {key:'active',canInstall:false,canReconcile:true}
    case 'installed-restart-required':return {key:'restart-required',canInstall:false,canReconcile:true}
    case 'failed':return {key:'failed',canInstall:true,canReconcile:true}
    case 'unknown':return {key:'unknown',canInstall:false,canReconcile:true}
  }
}

export function marketPluginInstallAction(record:MarketPluginInstallation):'install'|'reconcile'{
  return marketPluginInstallStatus(record).canInstall?'install':'reconcile'
}

/**
 * 中断态的判据是 state + receipt 的组合，不是一个新的契约状态：
 * 被中断的安装 reconcile 之后落在 installed-pending-enable，但回执从未写下，
 * 而服务端 enable() 本来就要求 receipt.outcome==='succeeded'（plugin-installations.ts:264）。
 * 出路是重装，不是启用，所以 canInstall 必须为真。
 */
export function marketPluginInstallInterrupted(record:MarketPluginInstallation):boolean{
  return record.state==='installed-pending-enable'&&record.receipt?.outcome!=='succeeded'
}

/** 只有"已安装 · 待启用"且回执确认成功才谈得上启用；中断态的回执从未写下，出路是重装而非启用。 */
export function marketPluginCanEnable(record:MarketPluginInstallation):boolean{
  return record.state==='installed-pending-enable'&&record.receipt?.outcome==='succeeded'
}

/** 启用请求只提交契约白名单字段：固定预览原样带回，schema 与 requestId 走既有校验，不新增字段。 */
export function marketPluginEnableSpec(record:MarketPluginInstallation,requestId:string):MarketPluginInstallSpec{
  return readMarketPluginInstallSpec({schema:'teloa.market-plugin-install-spec/v1',requestId,preview:record.preview,action:'enable'})
}

/** 尝试次数是服务端写入序列；迟到回包只能补充，不能回退已确认状态。 */
export function mergeMarketPluginInstallation(current:MarketPluginInstallation|undefined,incoming:MarketPluginInstallation|undefined):MarketPluginInstallation|undefined{
  if(!incoming)return current
  if(!current||current.id!==incoming.id)return incoming
  if(incoming.attempt>current.attempt)return incoming
  if(incoming.attempt<current.attempt)return current
  const score=(value:MarketPluginInstallation['state'])=>value==='installed-active'||value==='installed-restart-required'||value==='installed-pending-enable'?3:value==='unknown'?2:value==='failed'?1:0
  return score(incoming.state)>=score(current.state)?incoming:current
}
