/**
 * 全球使用统计上报协议（应用 → metrics.teloa.ai）。
 *
 * 2026-09-25 用户裁定：统计默认参与并上报，应用内不提供设置页与关闭开关，
 * 因此这里不再有参与状态、`usage-stats/get|set` 记录与请求体；只保留出站事件的字段白名单。
 * 是否发送由宿主 `detectExclusion` 在发送前判定：只有 TELOA_USAGE_STATS=on 才发送，off / CI / 验收 / 开发优先排除。
 */

/** 安装上报协议事件 */
export type UsageStatsInstallationEvent = {
  readonly schemaVersion: 1
  readonly installationId: string
  readonly event: 'installation'
  readonly appVersion: string
  readonly edition: 'free'
}

/** 活跃日上报协议事件 */
export type UsageStatsActiveDayEvent = {
  readonly schemaVersion: 1
  readonly installationId: string
  readonly event: 'active-day'
  readonly appVersion: string
  readonly edition: 'free'
  readonly day: string
}

export type UsageStatsEvent = UsageStatsInstallationEvent | UsageStatsActiveDayEvent | UsageStatsResourceInstallEvent

export function buildInstallationEvent(installationId: string, appVersion: string): UsageStatsInstallationEvent {
  return {schemaVersion: 1, installationId, event: 'installation', appVersion, edition: 'free'}
}

export function buildActiveDayEvent(
  installationId: string,
  appVersion: string,
  day: string,
): UsageStatsActiveDayEvent {
  return {schemaVersion: 1, installationId, event: 'active-day', appVersion, edition: 'free', day}
}

/** 市场资源安装上报的条目类型；模型条目只给配置引导，不上报。 */
export type MarketInstallKind = 'skill' | 'solution' | 'connector' | 'role'

/** 官方目录条目与安装发生的原始 UTC 日；都来自宿主官方目录或添加回执，不含任何本机信息。 */
export type MarketInstallEntry = {
  readonly id: string
  readonly version: string
  readonly kind: MarketInstallKind
  readonly day: string
}

/** 资源安装上报协议事件（市场二期）：day 为原始日期，服务端据此去重，并只接受今天、昨天、前天。 */
export type UsageStatsResourceInstallEvent = {
  readonly schemaVersion: 1
  readonly installationId: string
  readonly event: 'resource-install'
  readonly appVersion: string
  readonly edition: 'free'
  readonly entryId: string
  readonly entryVersion: string
  readonly kind: MarketInstallKind
  readonly day: string
}

export function buildResourceInstallEvent(
  installationId: string,
  appVersion: string,
  entry: MarketInstallEntry,
): UsageStatsResourceInstallEvent {
  return {schemaVersion: 1, installationId, event: 'resource-install', appVersion, edition: 'free', entryId: entry.id, entryVersion: entry.version, kind: entry.kind, day: entry.day}
}
