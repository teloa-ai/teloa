/**
 * 声明包生成器：把本机已经跑通的一套业务声明（对象类型 / 视图 / 动作 / 来源名词）并成一个
 * 只含声明的行业模板包，交给市场固定与 ZIP 分享。
 *
 * 为什么脱敏用「按契约字段重建」这条结构性判据，而不是列一张黑名单：黑名单要枚举「不该进包的东西」，
 * 而不该进包的东西是**开放集合**——固定快照的取值、`snapshotHash`、`coverage`、`rows`、`loadId`、
 * `ownerId`、摘要……台账每多一位披露，黑名单就漏一格，而且漏了没人知道。白名单重建是**封闭集合**：
 * 每份正文先过契约的 `read*`，再拿**返回值**去序列化，原始 `body` 上的多余键一个都进不去；
 * 于是包内字段集恒等于契约 `read*` 的键集，新的泄漏面只可能来自契约自己扩字段（那是评审看得见的改动）。
 *
 * 纯函数：不读时钟、不取随机数、不碰网络与存储，同一入参两次调用输出逐字节相同；排序是本模块的责任，
 * 调用方给的数组顺序打乱不影响输出。任何不合法入参一律 `throw Error`（客户端侧不造 `WorkError`；
 * 契约 `read*` 自己抛的 `WorkError` 是 `Error` 子类，原样往上传即可）。
 */
import {businessFieldCapabilities,industryUpdateCanonical,localizedMetadata,readBusinessActionDefinition,readBusinessObjectTypeDefinition,readBusinessViewDefinition,readIndustryDataSourceDefinition} from '@teloa/contract'
import type {BusinessActionDefinition,BusinessObjectTypeDefinition,BusinessViewDefinition,IndustryDataSourceDefinition,LocalizedMetadata} from '@teloa/contract'
import {INDUSTRY_FILE_LIMIT,INDUSTRY_TOTAL_LIMIT,validateIndustryPath} from './industry-directory.ts'
import {validateIndustryManifest} from './industry-manifest.ts'
import type {IndustryManifest,IndustryResource} from './industry-manifest.ts'

/** 一份待打包的声明正文：身份由调用方给（模板侧来自清单资源，本地侧来自第二期的本地声明版本），正文是未解析的 JSON 值。 */
export type BusinessShareDeclaration={localId:string;version:string;body:unknown}
/** 被排除的一项及其可读理由；界面逐条显示，不许静默丢弃。 */
export type BusinessShareExclusion={kind:'business-view'|'business-action'|'default-action';localId:string;reason:string}
export type BusinessShareInput={
 /** 业务范围标签，等于生成清单的 domain；`general` 一律拒绝。 */
 scope:string
 /** 包身份与门面文字，全部由调用方（用户）给，生成器不猜。 */
 packageId:string;packageVersion:string;title:string;description:string
 /** 可选英文两项；给了才写 localized（决定 D3）。 */
 english?:{title:string;description:string}
 objectTypes:readonly BusinessShareDeclaration[]
 views:readonly BusinessShareDeclaration[]
 actions:readonly BusinessShareDeclaration[]
 /** 对象类型绑定的来源身份与来源名词，用来生成包内的数据源声明（决定 D6）。 */
 sources:readonly {sourceId:string;sourceNoun?:string}[]
 /** 当前加载内可用的任务模板 / 执行工具本地标识，只用于闭合性判定，正文一律不打包（决定 D2）。 */
 available:{workTemplates:readonly string[];executionTools:readonly string[]}
}
export type BusinessSharePackage={
 manifestPath:'teloa.json'
 manifest:IndustryManifest
 files:{path:string;bytes:Uint8Array}[]
 excluded:BusinessShareExclusion[]
}

const fail=(message:string):never=>{throw Error(message)}
const asc=(a:string,b:string)=>a<b?-1:a>b?1:0
const encode=(text:string)=>new TextEncoder().encode(text)
/** 清单资源标识的字符集（`industry-manifest.ts` 的 `id()`）：不收点与下划线，而数据源标识收，这一格差要单独挡。 */
const manifestId=/^[a-zA-Z0-9][a-zA-Z0-9-]*$/
/**
 * 门面文字判据：清单的 `text()` 会先 trim，而 `localizedMetadata` 又要求 `original` 与清单字段逐字相等，
 * 入参这里就把 trim 立住，错误话才指得到人而不是从清单校验里冒出来。禁全部 C0 控制符与 DEL 的理由与
 * 契约 `business-definitions.ts` 的 `label()` 同一条：这些文字会同时进界面与模型上下文（市场预览摘要），
 * 允许换行等于允许在模型上下文里另起一段。
 */
const facade=(value:unknown,what:string,max:number):string=>{
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(what+'必须是不含首尾空白与控制字符、且不超过 '+max+' 字的单行文本。')
 return value as string
}
/** 英文两项只覆盖清单门面（决定 D3），资源没有英文名可填，因此资源的 `locales.en` 放的是资源标题原文——**这是回落，不是翻译**，T5 界面要照实说出来。 */
const facadeLocalized=(original:string,english:string):LocalizedMetadata=>localizedMetadata({original,defaultLocale:'en',locales:{'zh-CN':original,en:english}})

/** 身份逐条核对后返回白名单重建的正文：`read*` 先把多余键挡掉，再核对三条身份，错误话里写清是哪一份声明的哪一条。 */
function rebuilt<T extends {id:string;version:string;domain:string}>(declaration:BusinessShareDeclaration,scope:string,read:(value:unknown)=>T,what:string):T{
 const definition=read(declaration.body)
 if(declaration.localId!==definition.id)fail(what+'「'+declaration.localId+'」的正文标识是 '+definition.id+'，与声明身份不一致。')
 if(declaration.version!==definition.version)fail(what+'「'+declaration.localId+'」的正文版本是 '+definition.version+'，与声明版本 '+declaration.version+' 不一致。')
 if(definition.domain!==scope)fail(what+'「'+declaration.localId+'」的业务范围是 '+definition.domain+'，与分享范围 '+scope+' 不一致。')
 return definition
}

/**
 * 闭合性预检 ①（照后端读取层 `business-definition-source.ts:163-192` 核对 1/4 逐条同构）：
 * 视图的 `objectType` 必须在本次分享的对象类型里，维度 / 度量 / 筛选 / 时间窗引用的字段必须在那份对象类型的
 * `fields` 里、且与 `businessFieldCapabilities` 交叉表相符。返回 `undefined` 即闭合，否则是可读的排除理由。
 */
function viewExclusion(view:BusinessViewDefinition,objectTypes:ReadonlyMap<string,BusinessObjectTypeDefinition>):string|undefined{
 const objectType=objectTypes.get(view.objectType)
 if(!objectType)return '统计的对象类型 '+view.objectType+' 不在本次分享的对象类型里。'
 const fieldOf=(name:string)=>objectType.fields.find(field=>field.name===name)
 const {dimension,measures,filters,window}=view
 if(dimension){
  const field=fieldOf(dimension.field)
  if(!field)return '维度字段 '+dimension.field+' 不在对象类型 '+objectType.id+' 的字段声明里。'
  if(!businessFieldCapabilities[field.type].dimension)return '维度字段 '+dimension.field+' 的类型 '+field.type+' 不允许作维度。'
  if(field.type==='datetime'&&!dimension.bucket)return '维度字段 '+dimension.field+' 是时间字段，必须带分桶。'
 }
 for(const measure of measures){
  if(measure.field!==undefined){
   const field=fieldOf(measure.field)
   if(!field)return '度量 '+measure.id+' 绑定的字段 '+measure.field+' 不在对象类型 '+objectType.id+' 的字段声明里。'
   if(!businessFieldCapabilities[field.type].measure)return '度量 '+measure.id+' 绑定的字段 '+measure.field+' 的类型 '+field.type+' 不允许作度量。'
   if(!businessFieldCapabilities[field.type].aggregations.includes(measure.aggregation))return '度量 '+measure.id+' 的聚合方式 '+measure.aggregation+' 与字段 '+measure.field+' 的类型 '+field.type+' 不匹配。'
  }
  if(measure.where){
   const field=fieldOf(measure.where.field)
   if(!field)return '度量 '+measure.id+' 的筛选字段 '+measure.where.field+' 不在对象类型 '+objectType.id+' 的字段声明里。'
   if(!businessFieldCapabilities[field.type].operators.includes(measure.where.op))return '度量 '+measure.id+' 的筛选算子 '+measure.where.op+' 与字段 '+measure.where.field+' 的类型 '+field.type+' 不匹配。'
  }
 }
 for(const filter of filters){
  const field=fieldOf(filter.field)
  if(!field)return '筛选字段 '+filter.field+' 不在对象类型 '+objectType.id+' 的字段声明里。'
  if(!businessFieldCapabilities[field.type].operators.includes(filter.op))return '筛选算子 '+filter.op+' 与字段 '+filter.field+' 的类型 '+field.type+' 不匹配。'
 }
 if(window){
  const field=fieldOf(window.field)
  if(!field)return '时间窗字段 '+window.field+' 不在对象类型 '+objectType.id+' 的字段声明里。'
  if(field.type!=='datetime')return '时间窗字段 '+window.field+' 的类型 '+field.type+' 不是时间字段。'
 }
 return undefined
}

/**
 * 闭合性预检 ②（照 `business-definition-source.ts:194-212` 核对 2/4 逐条同构）：动作的 `objectType` 同上；
 * `execution-tool` 目标的 `localId` 与目标指向的任务模板都必须是当前加载内可用的项，否则排除这个动作
 * ——不把被引用的任务模板正文一起打包（决定 D2：那是模板作者的正文，塞进「我的声明包」等于替别人重新发布）。
 *
 * 后端那一条里还有两项本层核不了、只能由接收方加载时兜住的判据，要在这里写明而不是假装核过了：
 * 一是加载项的状态（任务模板 `pending-adapter`、执行工具是连接器可用态）——`available` 两份名单本来就该只放
 * 「当前加载内可用」的标识，状态判定是给名单的调用方（T5）的责任；二是 `inputs.length===requirements.length`
 * ——任务模板正文既不在包里也不在入参里，本层没有 `requirements` 可比，由接收方加载时的核对 2/4 兜住，
 * 生成预览因此要对每个动作写出「输入 N 项，接收方的任务模板必须正好要求 N 项」（`inputs.length` 在包内动作文件里，
 * T3 / T5 直接读得到），让分享的人在出包之前就知道这条会被谁核。
 */
function actionExclusion(action:BusinessActionDefinition,objectTypes:ReadonlyMap<string,BusinessObjectTypeDefinition>,available:BusinessShareInput['available']):string|undefined{
 if(!objectTypes.has(action.objectType))return '作用的对象类型 '+action.objectType+' 不在本次分享的对象类型里。'
 const target=action.target
 if(target.kind==='execution-tool'&&!available.executionTools.includes(target.localId))return '引用的执行工具 '+target.localId+' 不在当前加载的可用项里。'
 const template=target.kind==='work-template'?target.localId:target.workTemplate
 if(!available.workTemplates.includes(template))return '引用的任务模板 '+template+' 不在当前加载的可用项里；任务模板是模板作者的正文，不随声明包一起分享，接收方要自己补上。'
 return undefined
}

/** 清单内资源顺序：`data-source → object-type → business-view → business-action`，同类内按标识升序。 */
const kindRank:Record<'data-source'|'object-type'|'business-view'|'business-action',number>={'data-source':0,'object-type':1,'business-view':2,'business-action':3}
type ShareEntry={kind:keyof typeof kindRank;localId:string;path:string;title:string;version:string;required:boolean;text:string}

/** 自检 ①：每个文件再过一次对应的 `read*`，且 `industryUpdateCanonical(read*(JSON.parse(text)))===text`（规范化幂等）。 */
function reread(entry:ShareEntry):unknown{
 const value:unknown=JSON.parse(entry.text)
 if(entry.kind==='data-source')return readIndustryDataSourceDefinition(value)
 if(entry.kind==='object-type')return readBusinessObjectTypeDefinition(value)
 if(entry.kind==='business-view')return readBusinessViewDefinition(value)
 return readBusinessActionDefinition(value)
}

export function planBusinessSharePackage(input:BusinessShareInput):BusinessSharePackage{
 // 范围先立住：契约三个 `read*` 各自也拒 general，这里先拒一次是为了让错误话说的是范围不合法，而不是某一份声明不合法。
 const scope=facade(input.scope,'分享范围',80)
 if(scope==='general')fail('general 不是业务范围，不能分享。')
 const packageId=facade(input.packageId,'包标识',120)
 if(!manifestId.test(packageId))fail('包标识 '+packageId+' 只允许字母、数字与连字符。')
 const packageVersion=facade(input.packageVersion,'包版本',80)
 const title=facade(input.title,'包名称',120),description=facade(input.description,'包说明',2000)
 const english=input.english===undefined?undefined:{title:facade(input.english.title,'包英文名称',120),description:facade(input.english.description,'包英文说明',2000)}

 // 身份逐条核对 + 白名单重建。先按标识排序，闭合性排除项的顺序也就与入参顺序无关。
 const sorted=(rows:readonly BusinessShareDeclaration[])=>[...rows].sort((a,b)=>asc(a.localId,b.localId))
 const objectTypes=sorted(input.objectTypes).map(row=>rebuilt(row,scope,readBusinessObjectTypeDefinition,'对象类型'))
 const viewDefinitions=sorted(input.views).map(row=>rebuilt(row,scope,readBusinessViewDefinition,'业务视图'))
 const actionDefinitions=sorted(input.actions).map(row=>rebuilt(row,scope,readBusinessActionDefinition,'业务动作'))
 const objectTypeById=new Map(objectTypes.map(row=>[row.id,row]))
 const excluded:BusinessShareExclusion[]=[]

 const views:BusinessViewDefinition[]=[]
 for(const view of viewDefinitions){
  const reason=viewExclusion(view,objectTypeById)
  if(reason!==undefined){excluded.push({kind:'business-view',localId:view.id,reason});continue}
  views.push(view)
 }
 const actions:BusinessActionDefinition[]=[]
 for(const action of actionDefinitions){
  const reason=actionExclusion(action,objectTypeById,input.available)
  if(reason!==undefined){excluded.push({kind:'business-action',localId:action.id,reason});continue}
  actions.push(action)
 }
 /**
  * 闭合性预检 ③（照 `business-definition-source.ts:214-220` 核对 3/4）：`defaultAction` 指向被排除或不存在的动作时
  * **去掉 `defaultAction` 这个可选键**，不留一个悬挂标识（留着接收方加载时会直接整份拒绝），并记一条排除项。
  */
 const actionById=new Map(actions.map(row=>[row.id,row]))
 const objectTypeBodies=objectTypes.map(objectType=>{
  if(objectType.defaultAction===undefined)return objectType
  const action=actionById.get(objectType.defaultAction)
  if(action&&action.objectType===objectType.id)return objectType
  excluded.push({kind:'default-action',localId:objectType.id,reason:'默认动作 '+objectType.defaultAction+' 没有随包一起分享，已去掉这一位；接收方补齐任务模板后可自行指定默认动作。'})
  // 这一份的 `defaultAction` 就地去掉：`exactOptionalPropertyTypes` 下写 `undefined` 也是一个键，只能真的不带。
  const {defaultAction:_dropped,...rest}=objectType
  return rest
 })
 /**
  * 闭合性预检 ④（照 `business-definition-source.ts:222-225` 核对 4/4）：对象类型的 `sourceId` 必须有对应的来源声明。
  * 这一条不排除而是直接拒绝生成——对象类型是台账的骨架，少了来源声明接收方整份包一条也加载不出来（`teloa/source-unavailable`）。
  */
 if(new Set(input.sources.map(row=>row.sourceId)).size!==input.sources.length)fail('来源声明里同一个数据源标识出现了多次；哪一条的来源名词算数不能由入参顺序决定。')
 const referenced=new Set<string>()
 for(const objectType of objectTypes){
  if(!input.sources.some(row=>row.sourceId===objectType.sourceId))fail('对象类型「'+objectType.id+'」绑定的数据源 '+objectType.sourceId+' 没有对应的来源声明，整份包在接收方一条也加载不出来。')
  referenced.add(objectType.sourceId)
 }
 // 未被任何对象类型引用的 `sourceId` 不进包：不摆空连接件。
 const dataSources:IndustryDataSourceDefinition[]=[...referenced].sort(asc).map(sourceId=>{
  if(!manifestId.test(sourceId))fail('数据源标识 '+sourceId+' 含点或下划线，不能直接当清单资源标识；换一个只含字母数字与连字符的标识再分享。')
  const row=input.sources.find(candidate=>candidate.sourceId===sourceId)
  return readIndustryDataSourceDefinition({format:'teloa.data-source/v1',sourceId,scopes:[scope],...(row?.sourceNoun!==undefined?{sourceNoun:row.sourceNoun}:{})})
 })

 /**
  * `required` 的口径照 SOC 夹具：`object-type` 与 `data-source` 为 `true`，`business-view` 与 `business-action` 为 `false`
  * ——可选声明合法未打包时加载项落 `skipped`，读取层会跳过而不是拖垮整份加载。
  * 数据源声明正文里没有版本这一位，它是随这个包一起生成出来的，因此用包版本；资源名用来源名词，没有名词就用标识本身，不编一个假名字。
  */
 const entries:ShareEntry[]=[
  ...dataSources.map((definition):ShareEntry=>({kind:'data-source',localId:definition.sourceId,path:'connections/'+definition.sourceId+'.json',title:definition.sourceNoun??definition.sourceId,version:packageVersion,required:true,text:industryUpdateCanonical(definition)})),
  ...objectTypeBodies.map((definition):ShareEntry=>({kind:'object-type',localId:definition.id,path:'object-types/'+definition.id+'.json',title:definition.title,version:definition.version,required:true,text:industryUpdateCanonical(definition)})),
  ...views.map((definition):ShareEntry=>({kind:'business-view',localId:definition.id,path:'views/'+definition.id+'.json',title:definition.title,version:definition.version,required:false,text:industryUpdateCanonical(definition)})),
  ...actions.map((definition):ShareEntry=>({kind:'business-action',localId:definition.id,path:'actions/'+definition.id+'.json',title:definition.title,version:definition.version,required:false,text:industryUpdateCanonical(definition)})),
 ].sort((a,b)=>kindRank[a.kind]-kindRank[b.kind]||asc(a.localId,b.localId))
 // 标识字符集已由契约限住，仍过一次 `validateIndustryPath` 兜底：路径是拼出来的，拼错一次就是目录穿越。
 const manifestPath='teloa.json' as const
 validateIndustryPath(manifestPath)
 for(const entry of entries)validateIndustryPath(entry.path)

 const resources:IndustryResource[]=entries.map(entry=>({
  id:entry.localId,kind:entry.kind,title:entry.title,
  ...(english?{localized:{title:facadeLocalized(entry.title,entry.title)}}:{}),
  version:entry.version,required:entry.required,source:{kind:'local',path:entry.path},
 }))
 // `relations:[]`、`entrypoints:[]`：本期不放宽入口，也不动 `relationTargets` 三处（规格 §3.2）。
 const manifestText=industryUpdateCanonical({
  format:'teloa.business-package/v2',id:packageId,title,version:packageVersion,domain:scope,scope,description,
  ...(english?{localized:{title:facadeLocalized(title,english.title),description:facadeLocalized(description,english.description)}}:{}),
  resources,relations:[],entrypoints:[],
 })
 const files=[{path:manifestPath,bytes:encode(manifestText)},...entries.map(entry=>({path:entry.path,bytes:encode(entry.text)}))]

 // 自检 ①：规范化幂等。包内文件是机器生成物，这一条保证接收方再规范化一次得到同一串字节（决定 D8）。
 for(const entry of entries)if(industryUpdateCanonical(reread(entry))!==entry.text)fail('生成的文件 '+entry.path+' 规范化后与自身不一致。')
 // 自检 ②：清单过 `validateIndustryManifest`（顺带把资源标识重复、本地化原文不一致这些整份包加载不出来的毛病挡在生成处）。
 const manifest=validateIndustryManifest(JSON.parse(manifestText) as unknown)
 if(industryUpdateCanonical(manifest)!==manifestText)fail('生成的清单规范化后与自身不一致。')
 /**
  * 自检 ③：文件数与大小照 `industry-directory.ts` 的既有上限（500 个文件、单文件 2 MiB、总量 20 MiB），
  * 生成处就挡住，不要等到 `readIndustryFiles` 再拒——那时用户已经点了下载。
  * 注：单文件 2 MiB 这一格今天由白名单本身兜住（一份动作最多 100 项输入 × 4000 码元 ≈ 0.8 MiB，
  * 对象类型 50 字段 × 32 枚举取值 ≈ 0.3 MiB），因此这一条是结构性兜底而不是可触达的判据；
  * 总量 20 MiB 与文件数 500 都是可触达的，测试钉的是这两条。
  */
 if(files.length>500)fail('分享包共 '+files.length+' 个文件，超过 500 个的上限。')
 let total=0
 for(const file of files){
  if(file.bytes.byteLength>INDUSTRY_FILE_LIMIT)fail('分享包文件 '+file.path+' 超过 2 MiB 的上限。')
  total+=file.bytes.byteLength
 }
 if(total>INDUSTRY_TOTAL_LIMIT)fail('分享包总大小 '+total+' 字节，超过 20 MiB 的上限。')
 return {manifestPath,manifest,files,excluded}
}
