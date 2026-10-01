import {createHash} from 'node:crypto'
import type {BusinessTaskActionSource} from './business-tasks.ts'

/**
 * 动作与工作模板的固定来源单列摘要，避免把声明版本、模板文件与映射结果混进对象来源摘要。
 * 对象来源摘要已被安全动作冻结链使用，改变它会让历史安全动作无故失效。
 */
export function businessTaskActionSourceDigest(source:BusinessTaskActionSource):string{
 return createHash('sha256').update(JSON.stringify([
  source.schema,source.taskId,source.ownerId,
  source.action.id,source.action.version,source.action.definitionHash,
  source.action.source.loadId,source.action.source.scope,source.action.source.localId,source.action.source.version,source.action.source.contentHash,source.action.source.fileHash,source.action.source.origin,
  source.template.loadId,source.template.itemInstanceId,source.template.itemLocalId,source.template.contentId,source.template.contentHash,source.template.templateId,source.template.templateVersion,source.template.fileHash,
  source.template.title,source.template.method,source.template.requirements,source.inputs,source.template.output,
  source.template.skills.map(skill=>[skill.id,skill.title,skill.version]),source.template.scope,source.createdAt,
 ])).digest('hex')
}
