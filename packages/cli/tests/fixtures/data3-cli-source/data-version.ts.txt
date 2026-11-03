import metadata from './data-version.json' with {type:'json'}
import type {ReleaseManifest} from './contracts.ts'

/** 此文件及发行 builder 共用 JSON 真源；兼容读取不代表可以无备份迁移或降级。 */
export const dataVersionMetadata=Object.freeze(metadata)
export const supportedDataVersion=(version:number):boolean=>version===metadata.dataVersion||metadata.migrations.some(row=>row.from===version)
export function canUseData(release:Pick<ReleaseManifest,'dataVersion'|'compatibleDataVersions'>,version:number):boolean{
 return supportedDataVersion(version)&&release.dataVersion===version&&release.compatibleDataVersions.includes(version)
}
export function canUpgradeData(release:Pick<ReleaseManifest,'dataVersion'|'compatibleDataVersions'>,version:number):boolean{
 return canUseData(release,version)||release.dataVersion===metadata.dataVersion&&canUseData(release,release.dataVersion)&&metadata.migrations.some(row=>row.from===version&&row.to===release.dataVersion)
}
