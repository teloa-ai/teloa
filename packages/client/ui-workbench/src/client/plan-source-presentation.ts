import type {PlanSource} from './plan-api.js'
type T=(key:string)=>string

export type SavedPlanSourcePresentation=
 |{kind:'manual';label:string;summary:string}
 |{kind:'market-content';label:string;summary:string;contentId:string;contentHash:string;resourceId:string;resourceVersion:string}
 |{kind:'system-digest';label:string;summary:string}

/** 只呈现计划服务持久化的来源身份，不从当前页面目录推测模板名称。 */
export function describeSavedPlanSource(source:PlanSource,t:T):SavedPlanSourcePresentation{
 if(source.kind==='manual')return {kind:'manual',label:t('p6.planSource.manual.label'),summary:t('p6.planSource.manual.summary')}
 // system-digest 是 Auto Dream 随同事在岗自建的系统计划；沿用既有 Auto Dream 词条标注，不新增键。
 if(source.kind==='system-digest')return {kind:'system-digest',label:t('autoDream.name'),summary:t('dailyLog.timeHint')}
 return {kind:'market-content',label:t('p6.planSource.market.label'),summary:t('p6.planSource.market.summary'),contentId:source.contentId,contentHash:source.contentHash,resourceId:source.resourceId,resourceVersion:source.resourceVersion}
}
