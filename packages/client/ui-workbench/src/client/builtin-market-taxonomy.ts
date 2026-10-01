import type {MarketFunctionKey} from '@teloa/contract'

/**
 * Teloa 自带内容的功能分类（市场分类定案：9 类 + 其他）。
 * 这些内容的清单是已存库、参与内容校验值的固定文件，不为补分类改字节；分类作为 Teloa 自己的元数据放在这里，
 * 按条目编号（内置示例）或方案清单编号 + 包内资源编号（内置行业模板与本机示例包）查。
 * 用户自建或导入、这里查不到的内容不猜分类，归「未分类」。
 */
type Fn=readonly MarketFunctionKey[]

/** 内置示例条目（`market-preview.ts` 的 marketExamples），按条目编号。 */
export const builtinItemFunctions:Readonly<Record<string,Fn>>={
 'template-weekly':['office-docs','communication'],
 'template-research':['data-research'],
 'template-meeting':['communication'],
 'template-code':['security','dev-tools'],
 'template-brief':['content-design'],
 'bundle-general':['data-research','office-docs','communication'],
 'bundle-security':['security'],
 'bundle-design':['content-design'],
 'role-research':['data-research'],
 'role-investigator':['security'],
 'skill-report':['office-docs'],
 'skill-audit':['security','dev-tools'],
 'resource-mcp':['automation'],
 'resource-knowledge':['office-docs'],
 'resource-edr':['security'],
}

/** 内置行业模板与仓内示例包（`examples/industry/**`），按清单编号，含包内各资源。 */
export const builtinPackageFunctions:Readonly<Record<string,{functions:Fn;resources:Readonly<Record<string,Fn>>}>>={
 'bundle-general':{functions:['data-research','office-docs','communication'],resources:{
  'general-research-role':['data-research'],'general-team-knowledge':['office-docs'],'general-report-skill':['office-docs'],'general-research-mcp':['data-research'],
  'general-source-data':['data-research'],'general-publish-tool':['communication'],'general-research-template':['data-research'],'general-review-plan':['data-research'],
 }},
 'bundle-security':{functions:['security'],resources:{
  'security-investigator-role':['security'],'security-investigator-knowledge':['security'],'security-investigation-skill':['security'],'security-report-skill':['office-docs'],
  'security-alert-mcp':['security'],'security-alert-data':['security'],'security-remediation-tool':['security'],'security-investigation-template':['security'],'security-investigation-plan':['security'],
  'security-appsec-auditor-role':['security','dev-tools'],'security-appsec-knowledge':['security','dev-tools'],'security-code-audit-skill':['security','dev-tools'],'security-code-mcp':['dev-tools'],
  'security-code-data':['dev-tools'],'security-code-remediation-tool':['security','dev-tools'],'security-code-audit-template':['security','dev-tools'],'security-code-audit-plan':['security','dev-tools'],
 }},
 'bundle-design':{functions:['content-design'],resources:{
  'design-review-role':['content-design'],'design-brand-knowledge':['content-design'],'design-brief-skill':['content-design'],'design-asset-mcp':['content-design'],
  'design-asset-data':['content-design'],'design-delivery-tool':['content-design'],'design-review-template':['content-design'],'design-review-plan':['content-design'],
 }},
 'security-operations':{functions:['security'],resources:{
  'security-analyst':['security'],'security-triage':['security'],'alert-triage':['security'],'alert-data':['security'],'alert-mcp':['security'],'alert-reference-list':['security'],
  'isolate-tool':['security'],'alert-triage-review':['security'],'endpoint-isolation-record':['security'],'daily-alert-triage':['security'],
 }},
 'application-security':{functions:['security','dev-tools'],resources:{
  'finding-data':['security','dev-tools'],'vulnerability-fix':['security','dev-tools'],
 }},
 'general-research':{functions:['data-research','office-docs'],resources:{
  'research-analyst':['data-research'],'research-methods':['data-research'],'research-brief':['data-research','office-docs'],'research-review':['data-research'],'daily-review':['data-research'],
 }},
}
