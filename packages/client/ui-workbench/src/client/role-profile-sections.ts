// 「编辑」里的六组人话分组：只是把 RoleDetail 已有的字段重新分组呈现，不新增任何契约字段。
// 顺序照规格 §4.5.2 的表格固定：工作方式 / 它记得的事 / 它能用的工具 / 它读过的资料 / 边界，
// 末尾补第六组「运行状态」——身份栏原先常驻的生命周期与状态三问挪进来（终审 T2），同样默认折叠。
export const ROLE_PROFILE_SECTIONS = ['how', 'memory', 'tools', 'reading', 'limit', 'runtime'] as const
export type RoleProfileSection = typeof ROLE_PROFILE_SECTIONS[number]

const SECTION_KEYS: Readonly<Record<RoleProfileSection, { title: string; lead: string }>> = {
  how: { title: 'team.profile.group.how', lead: 'team.profile.group.howLead' },
  memory: { title: 'team.profile.group.memory', lead: 'team.profile.group.memoryLead' },
  tools: { title: 'team.profile.group.tools', lead: 'team.profile.group.toolsLead' },
  reading: { title: 'team.profile.group.reading', lead: 'team.profile.group.readingLead' },
  limit: { title: 'team.profile.group.limit', lead: 'team.profile.group.limitLead' },
  runtime: { title: 'team.profile.group.runtime', lead: 'team.profile.group.runtimeLead' },
}

export function roleProfileSectionKeys(section: RoleProfileSection): { title: string; lead: string } {
  return SECTION_KEYS[section]
}
