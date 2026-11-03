import {roleWriteDefinition,type PageCreateDraftPreview} from '@teloa/contract'
import type {TeloaTranslate} from './i18n/index.js'
import {responsibilityGroups} from './role-runtime-config.ts'
import {roleModelLabel} from './role-models.ts'

/** 按完整岗位契约核对职责和边界，不受宿主通用字段预览的行数截断影响。 */
export function createRolePreview(preview:PageCreateDraftPreview,t:TeloaTranslate,scopeNames:Readonly<Record<string,string>>){
 if(preview.draft.entity!=='role')throw Error('需要正式员工草案。')
 const role=roleWriteDefinition(JSON.parse(preview.draft.body)),runtime=role.runtimeConfig
 const list=(items:string[])=>items.length?items.join('\n'):t('team.form.notDeclared')
 return {
  kind:role.kind,avatarKey:role.avatarKey,
  fields:[
   {path:t('team.form.name'),value:role.name},
   {path:t('team.form.kind'),value:t(role.kind==='twin'?'team.form.twin':'team.form.employee')},
   {path:t('team.detail.businessScope'),value:role.scopes.map(id=>scopeNames[id]??id).join('\n')},
   {path:t('team.form.mission'),value:role.duty},
   ...responsibilityGroups(role.responsibility).map(group=>({path:t(group.labelKey),value:list(group.items)})),
   {path:t('team.form.dataBoundary'),value:role.dataScope},
   {path:t('team.form.executionBoundary'),value:role.executionScope},
   {path:t('market.industry.resource.skill'),value:list(role.skills.map((_,index)=>preview.roleReferences?.skills[index]??t('create.role.skillUnverified')))},
   {path:t('team.form.materials'),value:role.knowledge.length?role.knowledge.map((_,index)=>preview.roleReferences?.knowledge[index]??t('create.role.materialUnverified')).join('\n'):t('team.form.noneSelected')},
   {path:t('team.form.runtimeSelect'),value:runtime?.agentPresetId??t('team.form.runtimeInherit')},
   {path:t('roleModels.primary'),value:runtime?.model?roleModelLabel(runtime.model):t('roleModels.inherit')},
   {path:t('roleModels.fallback'),value:runtime?.fallbackModel?roleModelLabel(runtime.fallbackModel):t('team.form.noneSelected')},
  ],
  consequences:[t('create.next.role'),t('team.form.noGrant')],
 }
}
