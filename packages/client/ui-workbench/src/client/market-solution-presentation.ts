import type {IndustryManifest,IndustryResource} from './industry-manifest.ts'
import {mcpConnectionReadOnly,readIndustryMcpConnectionDefinition,type MarketCatalogConnectorEntry,type MarketCatalogSolutionEntry,type MarketCatalogText} from '@teloa/contract'
import type {IndustryContent} from './industry-directory.ts'
import {COMPOSITION_ROWS,type CompositionRowId} from './industry-composition.ts'
import {localizedIndustryResourceTitle} from './industry-template-presentation.ts'
import {marketCategoryOf} from './market-home-presentation.ts'
import {marketRuntimeForItem,type MarketSkillRuntime} from './market-runtime-state.ts'
import type {MarketResourceEntry} from './market-resource-index.ts'
import type {MarketItem} from './market-preview.ts'

/** 分类只有一处定义：取七行分类法某一行的资源类型集合。 */
const compositionKinds=(id:CompositionRowId):readonly IndustryResource['kind'][]=>COMPOSITION_ROWS.find(row=>row.id===id)!.kinds

export type SolutionRowResource={id:string;kind:IndustryResource['kind'];title:string}

/**
 * 产品页每一行列出来的条目：跟计数说的是同一批东西。
 * 业务看板只列被管起来的东西（视图数在计数里说），任务模板只列模板本身（自动化与动作数在附注里说），
 * 其余五行就是这一行的全部资源。
 */
export function solutionRowResources(manifest:IndustryManifest,id:CompositionRowId,locale:string):SolutionRowResource[]{
 const kinds:readonly IndustryResource['kind'][]=id==='board'?['object-type','business-configuration']:id==='method'?['work-template']:compositionKinds(id)
 return manifest.resources.filter(resource=>kinds.includes(resource.kind))
  .map(resource=>({id:resource.id,kind:resource.kind,title:localizedIndustryResourceTitle(resource,locale)}))
}

type VersionParts={core:string[];prerelease:string[]|null}

function versionParts(value:string):VersionParts|undefined{
 const match=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
 return match?{core:[match[1]!,match[2]!,match[3]!],prerelease:match[4]?.split('.')??null}:undefined
}

function compareNumericIdentifier(left:string,right:string):number{
 const a=left.replace(/^0+(?=\d)/,''),b=right.replace(/^0+(?=\d)/,'')
 return a.length-b.length||a.localeCompare(b)
}

/** 精确 SemVer 的先后顺序；异常输入只用于旧数据兜底，保持稳定的字典序。 */
function compareVersions(left:string,right:string):number{
 const a=versionParts(left),b=versionParts(right)
 if(!a||!b)return left.localeCompare(right,'en',{numeric:true,sensitivity:'base'})
 for(let index=0;index<3;index++){
  const order=compareNumericIdentifier(a.core[index]!,b.core[index]!)
  if(order)return order
 }
 if(!a.prerelease&&!b.prerelease)return 0
 if(!a.prerelease)return 1
 if(!b.prerelease)return -1
 const length=Math.max(a.prerelease.length,b.prerelease.length)
 for(let index=0;index<length;index++){
  const x=a.prerelease[index],y=b.prerelease[index]
  if(x===undefined)return -1
  if(y===undefined)return 1
  if(x===y)continue
  const xNumeric=/^\d+$/.test(x),yNumeric=/^\d+$/.test(y)
  if(xNumeric&&yNumeric)return compareNumericIdentifier(x,y)
  if(xNumeric!==yNumeric)return xNumeric?-1:1
  return x.localeCompare(y)
 }
 return 0
}

/**
 * 市场方案目录是“当前可采用版本”，不是版本历史页。同一模板逻辑 ID 只保留最高版本；
 * 同版本存在两份固定内容时再按持久化时间选较新的那份。历史内容仍留在后端，升级与审计读取不受影响。
 * 非方案条目原样保留，避免这条目录规则波及 Skill、连接、资料等独立分类。
 */
export function currentSolutionCatalog(items:readonly MarketItem[]):MarketItem[]{
 const rows:MarketItem[]=[],positions=new Map<string,number>()
 for(const item of items){
  // 「先问问它适不适合我」临时带进来的官方方案（来源为 Teloa 官方目录）只随问答草稿存在，不是本机内容，不进目录
  if(item.source.kind==='catalog')continue
  if(marketCategoryOf(item)!=='industry'||!item.manifest?.id){rows.push(item);continue}
  const key=item.manifest.id,position=positions.get(key)
  if(position===undefined){positions.set(key,rows.length);rows.push(item);continue}
  const current=rows[position]!,versionOrder=compareVersions(item.manifest.version,current.manifest!.version)
  const newerSameVersion=versionOrder===0&&(item.contentStorage?.createdAt??'')>(current.contentStorage?.createdAt??'')
  if(versionOrder>0||newerSameVersion)rows[position]=item
 }
 return rows
}

/**
 * 「已添加」的唯一判据：加载记录仍在生效（`status==='active'`），且模板标识与版本都对得上这份方案当前版本。
 * 卡片与产品页共用它，避免一边只看 templateId、一边还比版本，出现「卡上写已添加、点进去还能再添加」。
 * 卸载（`unloaded`）与被升级取代（`superseded`）都不算已添加：它们是历史，不是当前生效的加载。
 */
export function solutionInstalled(
 item:{manifest?:{id?:string;version?:string}|undefined},
 loads:readonly {status:string;templateId:string;templateVersion:string}[],
):boolean{
 const manifest=item.manifest
 if(!manifest?.id||!manifest.version)return false
 return loads.some(load=>load.status==='active'&&load.templateId===manifest.id&&load.templateVersion===manifest.version)
}

/** 页头「已添加 · N」的唯一口径：逐条复用 solutionInstalled，不另起一套判据。没有清单的条目天然不计。 */
export function solutionInstalledCount(
 items:readonly {manifest?:{id?:string;version?:string}|undefined}[],
 loads:readonly {status:string;templateId:string;templateVersion:string}[],
):number{
 return items.filter(item=>solutionInstalled(item,loads)).length
}

export type SolutionMark='added'|'restart'|'available'|'conflict'
/** 只收敛既有状态，不重算：已加载优先于需重启，两者都不是才是可添加。 */
export function solutionMark(input:{loaded:boolean;restartRequired:boolean}):SolutionMark{
 return input.loaded?'added':input.restartRequired?'restart':'available'
}

/**
 * `marketRuntimeForItem` 的实测状态 → 三档记号。没列进来的状态（尚未安装、正在核对安装状态、状态未核验）
 * 一律落到「可添加」：拿不到运行事实时宁可少说，也不能凭空说「已添加」。
 * 「已停用」「被同名能力遮蔽」「可用性未核验」都算已经在手上，用户要做的是去管理它而不是再装一遍。
 */
const RUNTIME_MARKS:Readonly<Record<string,SolutionMark>>={
 '已安装并可用':'added','已安装，可用性未核验':'added','已安装，当前被同名能力遮蔽':'added','已停用':'added',
 '安装待核对':'restart','安装记录存在，运行缺失':'restart',
}

/**
 * 通用目录卡的状态记号：方案按加载记录判（与方案卡同一判据），其余条目按实测安装状态归三档。
 * 扩展装完要重启才生效，原型 `市场方案.jsx:96` 的 `stateOf` 同样对 plugin 给「需重启」。
 */
export function marketItemMark(
 item:MarketItem,
 loads:readonly {status:string;templateId:string;templateVersion:string}[],
 runtime?:MarketSkillRuntime,
):SolutionMark{
 const category=marketCategoryOf(item)
 if(category==='industry')return solutionMark({loaded:solutionInstalled(item,loads),restartRequired:false})
 if(category==='plugin')return 'restart'
 const observed=runtime?marketRuntimeForItem(item,runtime):undefined
 return observed?RUNTIME_MARKS[observed.status]??'available':'available'
}

/**
 * 资源目录卡（同事/技能/连接/资料四签）的状态记号：与通用目录卡共用同一套档位与同一份 RUNTIME_MARKS。
 * 同一标识两份内容对不上（`status==='conflict'`）时先给「有冲突」，不再落「可添加」——
 * 冲突的条目现在加不了，卡面要看得出来；原委仍在右侧详情里逐条写明。
 * 扩展装完要重启，一律「需重启」；只有引用的条目拿不到运行事实，落「可添加」。
 * 通用目录卡的 `marketItemMark` 没有这一档：`MarketItem` 本身不带冲突状态，冲突只在资源索引里判得出来。
 */
export function marketResourceMark(
 entry:{kind:IndustryResource['kind'];status?:MarketResourceEntry['status']},
 item:MarketItem|undefined,
 runtime?:MarketSkillRuntime,
):SolutionMark{
 if(entry.status==='conflict')return 'conflict'
 if(entry.kind==='plugin')return 'restart'
 const observed=item&&runtime?marketRuntimeForItem(item,runtime):undefined
 return observed?RUNTIME_MARKS[observed.status]??'available':'available'
}

export type SolutionMember={id:string;title:string;initial:string;seed:string}
/** seed 拼 bundleId 与资源 id：同一模板里两位同名同事，靠这两段拿到不同形象，不靠标题去重。 */
export function solutionMembers(manifest:IndustryManifest,locale:string,bundleId:string):SolutionMember[]{
 return manifest.resources.filter(resource=>compositionKinds('staff').includes(resource.kind)).map(resource=>{
  const title=localizedIndustryResourceTitle(resource,locale)
  return {id:resource.id,title,initial:[...title][0]??'',seed:bundleId+':'+resource.id}
 })
}

/**
 * 本机方案页接入源的只读判定（与官方页同一口径 `mcpConnectionReadOnly`）：连接声明从已保存的包内文件读（按清单所在目录找），
 * 官方连接器目录由调用方给。没有包内文件、读不出声明或没有连接器目录时一律不算只读，界面按保守口径写「写」。
 */
export function localReadOnlyConnections(manifest:IndustryManifest,content:IndustryContent|undefined,connectors:readonly Pick<MarketCatalogConnectorEntry,'connector'>[]):string[]{
 if(!content||!connectors.length)return []
 const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
 return manifest.resources.filter(resource=>{
  if(resource.kind!=='mcp'||resource.source.kind!=='local')return false
  const file=content.files.find(row=>row.path===root+(resource.source as {path:string}).path)
  if(!file)return false
  try{return mcpConnectionReadOnly(readIndustryMcpConnectionDefinition(JSON.parse(new TextDecoder().decode(file.bytes))),connectors)}catch{return false}
 }).map(resource=>resource.id)
}

const catalogMetadata=(value:MarketCatalogText)=>({original:value['zh-CN'],defaultLocale:'en',locales:{'zh-CN':value['zh-CN'],en:value.en}})
/**
 * 官方方案（还没添加到本机）作为「先问问它适不适合我」的依据：标题、简介、准备事项与现在可做取自目录条目，清单取自随发行固定的方案包。
 * 来源写明是 Teloa 官方目录；这条只随问答草稿存在，不当作本机方案列出。
 */
export function officialSolutionItem(entry:MarketCatalogSolutionEntry,manifest:IndustryManifest):MarketItem{
 const {title,summary,capabilities}=entry.solution
 return {id:'catalog:'+entry.id+'@'+entry.version,kind:'bundle',title:title['zh-CN'],version:entry.version,scope:manifest.scope,visibility:'public',summary:summary['zh-CN'],
  requirements:capabilities.needs.map(value=>value['zh-CN']),output:capabilities.now.map(value=>value['zh-CN']).join('；'),author:'Teloa',license:entry.license.spdx,
  source:{kind:'catalog',entryId:entry.id,version:entry.version},owner:'Teloa',compatibility:entry.compatibility.conditions.map(value=>value['zh-CN']).join(' '),components:[],manifest,
  localized:{title:catalogMetadata(title),summary:catalogMetadata(summary),requirements:capabilities.needs.map(catalogMetadata)}}
}
