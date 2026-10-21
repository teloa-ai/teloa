export type BusinessMoreAction='work'|'completed'|'dashboards'|'automations'|'adjustment'|'connector'|'sources'|'manual-definition'|'share'|'changes'|'team'
const businessActions=['adjustment','connector','sources','manual-definition','share','completed','work','changes','team'] as const
const generalActions=['work','completed','automations'] as const
/** 同一业务在各页签共享动作顺序，数据与能力入口由原业务上下文承接。 */
export function businessMoreActions(scope:string):readonly BusinessMoreAction[]{return scope==='general'?generalActions:businessActions}
export const businessMoreActionTitles={work:'business.more.currentTasks',completed:'business.done.title',dashboards:'business.more.dashboards',automations:'business.section.continuous',adjustment:'business.more.adjustment',connector:'business.more.connector',sources:'business.more.sources','manual-definition':'business.more.manualDefinition',share:'business.more.shareBusiness',changes:'business.more.changes',team:'business.more.team'} as const
