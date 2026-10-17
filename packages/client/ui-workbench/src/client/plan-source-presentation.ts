import type {PlanSource} from './plan-api.js'
type T=(key:string)=>string

export type SavedPlanSourcePresentation=
 |{kind:'manual';label:string;summary:string}
 |{kind:'conversation';label:string;summary:string;sessionId:string}
 |{kind:'market-content';label:string;summary:string;contentId:string;contentHash:string;resourceId:string;resourceVersion:string}
 |{kind:'system-digest';label:string;summary:string}
 |{kind:'method-reuse';label:string;summary:string;artifactId:string;version:number;basisHash:string}

/**
 * Auto Dream 系统计划（来源 `system-digest`）的标题由服务端以中文固定写入且不允许改名；
 * 按来源身份显示当前语言的 dailyLog.title，其余计划原样显示。只用于显示，编辑与回传仍用原标题。
 */
export function planDisplayTitle(title:string,systemDigest:boolean|undefined,t:T):string{
 return systemDigest?t('dailyLog.title'):title
}

/** 只呈现计划服务持久化的来源身份，不从当前页面目录推测模板名称。 */
export function describeSavedPlanSource(source:PlanSource,t:T):SavedPlanSourcePresentation{
 if(source.kind==='method-reuse')return {kind:'method-reuse',label:t('p6.planSource.method.label'),summary:t('p6.planSource.method.summary'),artifactId:source.artifactId,version:source.version,basisHash:source.basisHash}
 if(source.kind==='manual')return source.sessionId?{kind:'conversation',label:t('p6.planSource.conversation.label'),summary:t('p6.planSource.conversation.summary'),sessionId:source.sessionId}:{kind:'manual',label:t('p6.planSource.manual.label'),summary:t('p6.planSource.manual.summary')}
 // system-digest 是 Auto Dream 随同事在岗自建的系统计划；沿用既有 Auto Dream 词条标注，不新增键。
 if(source.kind==='system-digest')return {kind:'system-digest',label:t('autoDream.name'),summary:t('dailyLog.timeHint')}
 return {kind:'market-content',label:t('p6.planSource.market.label'),summary:t('p6.planSource.market.summary'),contentId:source.contentId,contentHash:source.contentHash,resourceId:source.resourceId,resourceVersion:source.resourceVersion}
}
