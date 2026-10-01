import type { SkillInstallationRecord, SkillInstallSourceIdentity } from './skill-install-api.js'

export function skillInstallationSourceLabel(source:SkillInstallSourceIdentity){
  return source.kind==='atomic'?'本人固定内容':source.kind==='industry-local'?'行业加载内固定内容':'行业加载引用的公共固定内容'
}

export function installationDirectoryMeta(record:SkillInstallationRecord){
  return {
    source:skillInstallationSourceLabel(record.source),
    identity:record.source.resourceId+' · '+record.source.resourceVersion+' · 记录 v'+record.version,
    availability:record.state==='installed'?'启用状态请打开详情核对':'安装结果待核对',
  }
}
