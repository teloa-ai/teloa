import type {WorkErrorCode} from '@teloa/contract'

export type BusinessDashboardErrorKey=
 |'business.dashboards.widget.failed'|'business.dashboards.error.timeout'|'business.dashboards.error.queue'|'business.dashboards.error.rows'
 |'business.dashboards.error.resultBytes'|'business.dashboards.error.rowBytes'|'business.dashboards.error.sql'|'business.dashboards.error.source'|'business.dashboards.error.credentials'
 |'business.dashboards.error.forbidden'|'business.dashboards.error.corrupt'|'business.dashboards.error.conflict'|'business.dashboards.error.notComputed'
 |'business.custom.conflict'

/**
 * 组件、看板与草案试算的失败 → 固定词条（计划「错误码映射」）：同一错误码按服务端 reason 原文分开说。
 * 只有「SQL 不符合规则」把 reason 当参数带上（截到 200 字，说清是哪一项），其余一律只给固定句，
 * 认不出的一律回落通用那句——原始 message 不直接上屏。看板不存在与无权同一句，防枚举。
 */
export function businessDashboardErrorKey(error:{code:WorkErrorCode;reason:string}):{key:BusinessDashboardErrorKey;params?:{reason:string}}{
 const reason=error.reason
 switch(error.code){
  case 'teloa/dependency-unavailable':
   if(reason.includes('排队'))return {key:'business.dashboards.error.queue'}
   if(/秒已中止|临时文件/.test(reason))return {key:'business.dashboards.error.timeout'}
   break
  case 'teloa/invalid-input':
   if(/^结果超过 .+ 行$/.test(reason))return {key:'business.dashboards.error.rows'}
   if(reason.startsWith('单行超过'))return {key:'business.dashboards.error.rowBytes'}
   if(/^结果超过 .+ MB$/.test(reason))return {key:'business.dashboards.error.resultBytes'}
   if(reason.startsWith('结果超过'))break
   return reason?{key:'business.dashboards.error.sql',params:{reason:reason.slice(0,200)}}:{key:'business.dashboards.widget.failed'}
  case 'teloa/source-unavailable':return {key:reason.includes('凭据')?'business.dashboards.error.credentials':'business.dashboards.error.source'}
  case 'teloa/forbidden':return {key:'business.dashboards.error.forbidden'}
  case 'teloa/not-found':return {key:reason==='尚未计算'?'business.dashboards.error.notComputed':'business.dashboards.error.forbidden'}
  case 'teloa/storage-corrupt':return {key:'business.dashboards.error.corrupt'}
  case 'teloa/conflict':return {key:'business.dashboards.error.conflict'}
  case 'teloa/version-conflict':return {key:'business.custom.conflict'}
 }
 return {key:'business.dashboards.widget.failed'}
}
