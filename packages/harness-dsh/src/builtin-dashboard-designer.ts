/**
 * Teloa 内置「看板设计」技能（官方目录条目 teloa.dashboard-designer）：
 * 字节来自随发行固定的官方目录快照，物化与登记复用 `builtin-skill-creator.ts` 的通用函数，只登记到本人普通会话。
 * 技能只引导模型读字段、试跑 SQL、生成草案；草案校验与确认仍走既有业务声明链路，不另开写口。
 */
export const builtinDashboardDesignerName='teloa-dashboard-designer'
