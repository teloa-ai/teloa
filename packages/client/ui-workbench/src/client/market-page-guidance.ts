import type {GuidedSetupStep} from './GuidedSetup.js'

type MarketGuideFacts={
 items:readonly {source:{kind:string};contentStorage?:{loaded:boolean}}[]
 intents:readonly {status:string}[]
 industryLoadCount:number
 contentPending:boolean
 skillInstallPending:boolean
}

export function marketPageGuidance(facts:MarketGuideFacts):GuidedSetupStep[]{
 const discovered=facts.items.filter(item=>item.source.kind!=='builtin').length
 const fixed=facts.items.filter(item=>item.contentStorage).length
 const verified=facts.items.filter(item=>item.contentStorage?.loaded).length
 const activeDrafts=facts.intents.filter(intent=>intent.status==='draft').length
 const found=discovered>0||facts.contentPending||facts.industryLoadCount>0
 const sourceReady=verified>0||facts.industryLoadCount>0
 const loaded=facts.industryLoadCount>0
 const foundLabel=discovered>0?`本人来源 ${discovered} 项`:loaded?'已有真实加载来源':'来源导入待核对'
 const sourceLabel=facts.contentPending?'导入待核对':verified>0?`详情已核对 ${verified} 项`:fixed>0?`固定 ${fixed} 项，详情待核对`:loaded?'真实加载来源已固定':'等待选择来源'
 const loadDescription=loaded
  ?`${facts.industryLoadCount} 个行业加载已保存；${facts.skillInstallPending?'另有技能安装待核对。':'技能的真实状态仍以安装与维护为准。'}`
  :facts.skillInstallPending?'存在未完成技能安装，先核对原请求，不能重复发起。':'行业模板进入目标空间，技能进入安装流程；此处不推断宿主可用性。'
 return [
  {title:'发现资源',state:found?'complete':'current',label:found?foundLabel:'从目录开始',description:found?'已选择真实来源；公共与内置示例仍需分别核对。':'浏览公共、行业和本人目录；示例只用于了解结构。'},
  {title:'核对来源与版本',state:sourceReady?'complete':found?'current':'upcoming',label:sourceLabel,description:sourceReady?(verified>0?'固定内容详情已从本人记录读取；许可与依赖仍按资源核对。':'已有真实加载记录可追溯固定来源；当前目录详情仍按读取状态核对。'):facts.contentPending?'原导入结果尚未核清，继续使用同一请求。':fixed?'版本摘要已固定，仍需读取详情后核对来源内容。':'选择资源后固定版本并核对实际内容。'},
  {title:'安装 / 加载到工作空间',state:loaded?'complete':sourceReady?'current':'upcoming',label:loaded?`行业加载 ${facts.industryLoadCount} 项`:facts.skillInstallPending?'技能安装待核对':sourceReady?'需分别安装或加载':'等待来源核对',description:loadDescription},
  {title:'配置对象并核验可用',state:loaded?'current':'upcoming',label:activeDrafts?`待应用方案 ${activeDrafts} 份`:'尚未形成真实配置',description:activeDrafts?`${activeDrafts} 份方案已保存，尚未安装、绑定或启用；到目标对象继续配置并核验实际可用性。`:'安装或加载后，在员工、群、业务或任务中配置，并核验真实可用性。'},
 ]
}
