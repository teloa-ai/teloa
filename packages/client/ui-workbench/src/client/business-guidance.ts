import type { GuidedSetupStep } from './GuidedSetup.js'
import type {TeloaTranslate} from './i18n/index.js'

export type BusinessGuidanceInput={loaded:boolean;objects:number;runs:number;tasks:number;operations:number;verifiedOperations:number}

/** 业务空间只呈现当前页面可见的进展；页面示例不等同于外部系统已接入或动作已执行。 */
export function businessGuideSteps(input:BusinessGuidanceInput,t:TeloaTranslate,number:(value:number)=>string=String):GuidedSetupStep[]{
 const objectReady=input.objects>0,analysisReady=input.runs>0,workReady=input.tasks>0,executionReady=input.verifiedOperations>0
 return [
  {title:t('business.guide.data.title'),description:t('business.guide.data.description'),state:objectReady?'complete':'current',label:objectReady?t(input.loaded?'business.guide.data.demo':'business.guide.data.current',{count:number(input.objects)}):t('business.guide.data.empty')},
  {title:t('business.guide.analysis.title'),description:t('business.guide.analysis.description'),state:analysisReady?'complete':objectReady?'current':'upcoming',label:analysisReady?t(input.loaded?'business.guide.analysis.demo':'business.guide.analysis.current',{count:number(input.runs)}):t('business.guide.analysis.empty')},
  {title:t('business.guide.work.title'),description:t('business.guide.work.description'),state:workReady?'complete':analysisReady?'current':'upcoming',label:workReady?t('business.guide.work.current',{count:number(input.tasks)}):t('business.guide.work.empty')},
  {title:t('business.guide.execution.title'),description:t('business.guide.execution.description'),state:executionReady?'complete':input.operations>0||workReady?'current':'upcoming',label:t(executionReady?'business.guide.execution.verified':'business.guide.execution.current',{count:number(executionReady?input.verifiedOperations:input.operations)})},
 ]
}
