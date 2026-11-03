import metadata from './data-version.json' with {type:'json'}
import type {ReleaseManifest} from './contracts.ts'

/** 此文件及发行 builder 共用 JSON 真源；兼容读取不代表可以无备份迁移或降级。 */
export const dataVersionMetadata=Object.freeze(metadata)
export const supportedDataVersion=(version:number):boolean=>version===metadata.dataVersion||metadata.migrations.some(row=>row.from===version)
export function canUseData(release:Pick<ReleaseManifest,'dataVersion'|'compatibleDataVersions'>,version:number):boolean{
 return supportedDataVersion(version)&&release.dataVersion===version&&release.compatibleDataVersions.includes(version)
}
export function canUpgradeData(release:Pick<ReleaseManifest,'dataVersion'|'compatibleDataVersions'>,version:number):boolean{
 // 保留已声明的历史迁移；每条边仍须经备份核验，不能由兼容列表推导迁移或降级。
 return canUseData(release,version)||canUseData(release,release.dataVersion)&&metadata.migrations.some(row=>row.from===version&&row.to===release.dataVersion)
}
