import { validateIndustryManifest, type IndustryManifest, type IndustryRelation, type IndustryResourceKind } from './industry-manifest.ts'

type ResourceDefinition = readonly [string, IndustryResourceKind, string, boolean, string?, string?]

const english:Record<string,{title:string;description:string;resources:Record<string,string>}>= {
  'bundle-general': {
    title:'General collaboration template',
    description:'Combine research, writing, meeting collaboration, and recurring reviews.',
    resources:{
      'general-research-role':'Research and collaboration role',
      'general-team-knowledge':'Team knowledge connection',
      'general-report-skill':'Shared report-writing Skill',
      'general-research-mcp':'Research tool connection',
      'general-source-data':'Research data sources',
      'general-publish-tool':'Reviewed publishing tool',
      'general-research-template':'Research and reporting',
      'general-review-plan':'Recurring research review',
    },
  },
  'bundle-security': {
    title:'Security industry template',
    description:'Combine employees, task templates, data, and execution requirements for security operations and application security.',
    resources:{
      'security-investigator-role':'SOC investigator',
      'security-investigator-knowledge':'SOC investigation evidence and response knowledge',
      'security-investigation-skill':'Alert investigation Skill',
      'security-report-skill':'Shared report-writing Skill',
      'security-alert-mcp':'Alert and response connection',
      'security-alert-data':'Alert data source',
      'security-remediation-tool':'Security response execution tool',
      'security-investigation-template':'Alert investigation task template',
      'security-investigation-plan':'Recurring alert investigation',
      'security-appsec-auditor-role':'AppSec auditor',
      'security-appsec-knowledge':'AppSec evidence and remediation knowledge',
      'security-code-audit-skill':'Code audit Skill',
      'security-code-mcp':'Code audit connection',
      'security-code-data':'Code and dependency data source',
      'security-code-remediation-tool':'Remediation recommendation tool',
      'security-code-audit-template':'Code audit task template',
      'security-code-audit-plan':'Recurring code audit',
    },
  },
  'bundle-design': {
    title:'Design industry template',
    description:'Combine briefs, asset guidelines, version reviews, and delivery workflows.',
    resources:{
      'design-review-role':'Design reviewer',
      'design-brand-knowledge':'Brand and asset guidelines',
      'design-brief-skill':'Design brief Skill',
      'design-asset-mcp':'Design asset connection',
      'design-asset-data':'Design asset data source',
      'design-delivery-tool':'Design delivery tool',
      'design-review-template':'Design review and delivery',
      'design-review-plan':'Version review plan',
    },
  },
}
const bilingual=(original:string,en:string)=>({original,defaultLocale:'en',locales:{'zh-CN':original,en}})

function builtinManifest(
  id: string,
  title: string,
  domain: string,
  description: string,
  resources: readonly ResourceDefinition[],
  explicitRelations?: readonly IndustryRelation[],
  scope = domain,
): IndustryManifest {
  const translation=english[id]!
  const role = resources.find(resource => resource[1] === 'role')![0]
  const byKind = (kind: IndustryResourceKind) => resources.filter(resource => resource[1] === kind).map(resource => resource[0])
  return validateIndustryManifest({
    format: 'teloa.business-package/v2', id, title, version: '0.1.0', domain, scope, description,
    localized:{title:bilingual(title,translation.title),description:bilingual(description,translation.description)},
    resources: resources.map(([resourceId, kind, resourceTitle, required, publicId, publicVersion]) => ({
      id: resourceId, kind, title: resourceTitle, version: publicVersion ?? '0.1.0', required,
      localized:{title:bilingual(resourceTitle,translation.resources[resourceId]!)},
      source: { kind: 'public', id: publicId ?? resourceId, version: publicVersion ?? '0.1.0' },
    })),
    relations: explicitRelations ?? [
      ...byKind('knowledge').map(to => ({ kind: 'role-knowledge' as const, from: role, to })),
      ...byKind('skill').map(to => ({ kind: 'role-skill' as const, from: role, to })),
      ...(['mcp', 'data-source', 'execution-tool'] as const).flatMap(kind => byKind(kind).map(to => ({ kind: 'role-connection' as const, from: role, to }))),
      ...(['work-template', 'plan'] as const).flatMap(kind => byKind(kind).map(to => ({ kind: 'role-work' as const, from: role, to }))),
    ],
    entrypoints: [...byKind('skill'), ...byKind('work-template')],
  })
}

export const builtinIndustryManifests = {
  'bundle-general': builtinManifest('bundle-general', '通用协作模板', 'general', '组合研究、写作、会议协作与定期检查。', [
    ['general-research-role', 'role', '研究与协作岗位', true],
    ['general-team-knowledge', 'knowledge', '团队知识连接', false],
    ['general-report-skill', 'skill', '公共报告撰写技能', true, 'skill-report'],
    ['general-research-mcp', 'mcp', '研究工具连接', false, 'resource-mcp'],
    ['general-source-data', 'data-source', '研究资料来源', false],
    ['general-publish-tool', 'execution-tool', '审阅后发布工具', false],
    ['general-research-template', 'work-template', '资料研究与报告', true],
    ['general-review-plan', 'plan', '定期研究检查', false],
  ]),
  'bundle-security': builtinManifest('bundle-security', '安全行业模板', 'security', '以安全运营和应用安全为首批场景，组合员工、任务模板、数据和执行要求。', [
    ['security-investigator-role', 'role', 'SOC 调查岗', true],
    ['security-investigator-knowledge', 'knowledge', 'SOC 调查证据与处置知识', true],
    ['security-investigation-skill', 'skill', '告警调查技能', true],
    ['security-report-skill', 'skill', '公共报告撰写技能', true, 'skill-report'],
    ['security-alert-mcp', 'mcp', '告警与处置连接', true, 'resource-mcp'],
    ['security-alert-data', 'data-source', '告警数据来源', true],
    ['security-remediation-tool', 'execution-tool', '安全处置执行工具', true],
    ['security-investigation-template', 'work-template', '告警调查任务模板', true],
    ['security-investigation-plan', 'plan', '持续告警调查计划', true],
    ['security-appsec-auditor-role', 'role', 'AppSec 审计岗', true],
    ['security-appsec-knowledge', 'knowledge', 'AppSec 审计证据与修复知识', true],
    ['security-code-audit-skill', 'skill', '代码审计技能', true],
    ['security-code-mcp', 'mcp', '代码审计连接', true, 'resource-mcp'],
    ['security-code-data', 'data-source', '代码与依赖数据源', true],
    ['security-code-remediation-tool', 'execution-tool', '修复建议执行工具', true],
    ['security-code-audit-template', 'work-template', '代码审计任务模板', true],
    ['security-code-audit-plan', 'plan', '持续代码审计计划', true],
  ], [
    { kind: 'role-knowledge', from: 'security-investigator-role', to: 'security-investigator-knowledge' },
    { kind: 'role-skill', from: 'security-investigator-role', to: 'security-investigation-skill' },
    { kind: 'role-skill', from: 'security-investigator-role', to: 'security-report-skill' },
    { kind: 'role-connection', from: 'security-investigator-role', to: 'security-alert-mcp' },
    { kind: 'role-connection', from: 'security-investigator-role', to: 'security-alert-data' },
    { kind: 'role-connection', from: 'security-investigator-role', to: 'security-remediation-tool' },
    { kind: 'role-work', from: 'security-investigator-role', to: 'security-investigation-template' },
    { kind: 'role-work', from: 'security-investigator-role', to: 'security-investigation-plan' },
    { kind: 'role-knowledge', from: 'security-appsec-auditor-role', to: 'security-appsec-knowledge' },
    { kind: 'role-skill', from: 'security-appsec-auditor-role', to: 'security-code-audit-skill' },
    { kind: 'role-skill', from: 'security-appsec-auditor-role', to: 'security-report-skill' },
    { kind: 'role-connection', from: 'security-appsec-auditor-role', to: 'security-code-mcp' },
    { kind: 'role-connection', from: 'security-appsec-auditor-role', to: 'security-code-data' },
    { kind: 'role-connection', from: 'security-appsec-auditor-role', to: 'security-code-remediation-tool' },
    { kind: 'role-work', from: 'security-appsec-auditor-role', to: 'security-code-audit-template' },
    { kind: 'role-work', from: 'security-appsec-auditor-role', to: 'security-code-audit-plan' },
  ], 'SOC'),
  'bundle-design': builtinManifest('bundle-design', '设计行业模板', 'Design', '组合 Brief、素材规范、版本审阅与交付流程。', [
    ['design-review-role', 'role', '设计审阅岗位', true],
    ['design-brand-knowledge', 'knowledge', '品牌与素材规范', true],
    ['design-brief-skill', 'skill', '设计 Brief 整理技能', true],
    ['design-asset-mcp', 'mcp', '设计素材连接', false, 'resource-mcp'],
    ['design-asset-data', 'data-source', '设计素材数据源', false],
    ['design-delivery-tool', 'execution-tool', '设计交付工具', false],
    ['design-review-template', 'work-template', '设计稿审阅与交付', true],
    ['design-review-plan', 'plan', '版本审阅计划', false],
  ]),
} as const
