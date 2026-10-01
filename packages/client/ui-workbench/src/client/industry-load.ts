import type { IndustryInspection } from './industry-content.ts'
import type { IndustryResourceKind } from './industry-manifest.ts'
import type { BusinessScope } from './business-directory.ts'

/**
 * 页面内的已加载行业模板投影。
 *
 * 真正的加载由宿主完成（`industry-load-api` 提交、`IndustryLoadRecord` 回来）；
 * 这里只保留仍按页面态读取的形状，不再有就地加载的写入函数。
 */
export type LoadedIndustryResource={id:string;localId:string;kind:IndustryResourceKind;title:string;version:string;inspection:IndustryInspection}
export type IndustryLoad={id:string;requestKey:string;spaceId:BusinessScope;itemId:string;sourceHash:string;title:string;version:string;createdAt:string;resources:LoadedIndustryResource[];relations:{kind:string;from:string;to:string}[];entrypoints:string[];skipped:string[]}
