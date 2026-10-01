import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {planBusinessSharePackage,type BusinessShareDeclaration,type BusinessShareInput} from '../src/client/business-share-package.ts'

/** 源声明取 `tests/fixtures/业务定制层/SOC`（与规格 §12.1–12.2 的样例逐字一致），不在测试里另抄一份。 */
const socDir=fileURLToPath(new URL('../../../../tests/fixtures/业务定制层/SOC/',import.meta.url))
const shareFixtureDir=fileURLToPath(new URL('../../../../tests/fixtures/业务定制层分享/SOC声明包/',import.meta.url))
const OBJECT_TYPES=['alert-ticket','asset','incident-ticket']
const VIEWS=['soc-alert-list','soc-alert-trend','soc-pending-board','soc-risk-distribution']
const ACTIONS=['assign-alert-review','isolate-endpoint']

async function body(path:string):Promise<Record<string,unknown>>{
 return JSON.parse(await readFile(join(socDir,path),'utf8')) as Record<string,unknown>
}
async function declaration(path:string):Promise<BusinessShareDeclaration>{
 const value=await body(path)
 return {localId:value.id as string,version:value.version as string,body:value}
}
const declarations=(folder:string,ids:readonly string[])=>Promise.all(ids.map(id=>declaration(folder+'/'+id+'.json')))

async function socInput():Promise<BusinessShareInput>{
 return {
  scope:'SOC',packageId:'soc-share',packageVersion:'1.0.0',
  title:'安全运营台账声明',description:'把 SOC 的三类对象、四张视图与两个动作并成一个只含声明的包。',
  objectTypes:await declarations('object-types',OBJECT_TYPES),
  views:await declarations('views',VIEWS),
  actions:await declarations('actions',ACTIONS),
  sources:[{sourceId:'security-alert-http',sourceNoun:'告警源'}],
  available:{workTemplates:['alert-triage-review','endpoint-isolation-record'],executionTools:['soc-endpoint-isolation']},
 }
}
const decode=(bytes:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(bytes)
const textOf=(result:ReturnType<typeof planBusinessSharePackage>,path:string)=>{
 const file=result.files.find(row=>row.path===path)
 assert.ok(file,'缺少文件：'+path)
 return decode(file.bytes)
}

test('SOC 全量声明生成 10 个资源与清单，字节逐字钉住',async()=>{
 const result=planBusinessSharePackage(await socInput())
 assert.equal(result.manifestPath,'teloa.json')
 assert.deepEqual(result.excluded,[])
 // 资源顺序固定 data-source → object-type → business-view → business-action，同类内按标识升序；文件第一项是清单。
 assert.deepEqual(result.files.map(file=>file.path),[
  'teloa.json',
  'connections/security-alert-http.json',
  'object-types/alert-ticket.json','object-types/asset.json','object-types/incident-ticket.json',
  'views/soc-alert-list.json','views/soc-alert-trend.json','views/soc-pending-board.json','views/soc-risk-distribution.json',
  'actions/assign-alert-review.json','actions/isolate-endpoint.json',
 ])
 assert.equal(result.manifest.resources.length,10)
 assert.deepEqual(result.manifest.resources.map(row=>[row.id,row.kind,row.required]),[
  ['security-alert-http','data-source',true],
  ['alert-ticket','object-type',true],['asset','object-type',true],['incident-ticket','object-type',true],
  ['soc-alert-list','business-view',false],['soc-alert-trend','business-view',false],['soc-pending-board','business-view',false],['soc-risk-distribution','business-view',false],
  ['assign-alert-review','business-action',false],['isolate-endpoint','business-action',false],
 ])
 for(const [path,expected] of Object.entries(PINNED))assert.equal(textOf(result,path),expected,path)
 assert.equal(Object.keys(PINNED).length,result.files.length)
})

test('SOC 生成包逐字等于入库夹具，夹具是可审查的接收方字节基准',async()=>{
 // 任务模板正文不属于声明包，因此这一份可在接收方直接加载的 SOC 包会排除两个动作及其默认动作。
 const input=await socInput()
 const result=planBusinessSharePackage({...input,available:{workTemplates:[],executionTools:input.available.executionTools}})
 const actual=new Map(result.files.map(file=>[file.path,decode(file.bytes)]))
 const expectedPaths=[
  'teloa.json','connections/security-alert-http.json',
  ...OBJECT_TYPES.map(id=>'object-types/'+id+'.json'),
  ...VIEWS.map(id=>'views/'+id+'.json'),
 ]
 assert.deepEqual([...actual.keys()],expectedPaths)
 assert.deepEqual(result.excluded.map(row=>[row.kind,row.localId]),[
  ['business-action','assign-alert-review'],['business-action','isolate-endpoint'],['default-action','alert-ticket'],
 ])
 for(const path of expectedPaths){
  const expected=await readFile(join(shareFixtureDir,path),'utf8')
  assert.equal(actual.get(path),expected,path)
 }
})

test('同一入参两次生成逐字节相同；入参数组顺序打乱后仍逐字节相同',async()=>{
 const input=await socInput()
 const first=planBusinessSharePackage(input),second=planBusinessSharePackage(input)
 const bytes=(result:ReturnType<typeof planBusinessSharePackage>)=>result.files.map(file=>[file.path,decode(file.bytes)])
 assert.deepEqual(bytes(second),bytes(first))
 assert.deepEqual(second.manifest,first.manifest)
 const shuffled=planBusinessSharePackage({...input,
  objectTypes:[...input.objectTypes].reverse(),views:[...input.views].reverse(),actions:[...input.actions].reverse()})
 assert.deepEqual(bytes(shuffled),bytes(first))
 assert.deepEqual(shuffled.manifest,first.manifest)
})

test('任务模板不可用时动作按条排除，并去掉悬挂的 defaultAction',async()=>{
 const input=await socInput()
 const none=planBusinessSharePackage({...input,available:{workTemplates:[],executionTools:['soc-endpoint-isolation']}})
 assert.deepEqual(none.excluded.filter(row=>row.kind==='business-action').map(row=>row.localId),['assign-alert-review','isolate-endpoint'])
 const dropped=none.excluded.filter(row=>row.kind==='default-action')
 assert.equal(dropped.length,1)
 assert.equal(dropped[0]?.localId,'alert-ticket')
 assert.match(dropped[0]?.reason??'',/assign-alert-review/)
 assert.doesNotMatch(textOf(none,'object-types/alert-ticket.json'),/defaultAction/)
 assert.equal(none.manifest.resources.filter(row=>row.kind==='business-action').length,0)
 // 只缺终端隔离记录那一份任务模板：仅 isolate-endpoint 排除，alert-ticket 的 defaultAction 仍然闭合。
 const partial=planBusinessSharePackage({...input,available:{workTemplates:['alert-triage-review'],executionTools:['soc-endpoint-isolation']}})
 assert.deepEqual(partial.excluded.map(row=>[row.kind,row.localId]),[['business-action','isolate-endpoint']])
 assert.match(textOf(partial,'object-types/alert-ticket.json'),/"defaultAction":"assign-alert-review"/)
 // 执行工具不可用也按条排除（后端核对 2/4 的同一条判据）。
 const noTool=planBusinessSharePackage({...input,available:{workTemplates:input.available.workTemplates,executionTools:[]}})
 assert.deepEqual(noTool.excluded.map(row=>[row.kind,row.localId]),[['business-action','isolate-endpoint']])
 assert.match(noTool.excluded[0]?.reason??'',/soc-endpoint-isolation/)
})

test('视图引用不存在的字段或类型不允许的度量时按条排除，理由里带字段名',async()=>{
 const input=await socInput()
 const distribution=await body('views/soc-risk-distribution.json')
 const missing={...distribution,dimension:{field:'nope',limit:3}}
 const byMissing=planBusinessSharePackage({...input,views:[{localId:'soc-risk-distribution',version:distribution.version as string,body:missing}]})
 assert.deepEqual(byMissing.excluded.map(row=>row.kind),['business-view'])
 assert.match(byMissing.excluded[0]?.reason??'',/nope/)
 assert.equal(byMissing.manifest.resources.filter(row=>row.kind==='business-view').length,0)
 const list=await body('views/soc-alert-list.json')
 const asMeasure={...list,measures:[{id:'accounts',label:'涉及账号数',aggregation:'max',field:'host'}]}
 const byType=planBusinessSharePackage({...input,views:[{localId:'soc-alert-list',version:list.version as string,body:asMeasure}]})
 assert.deepEqual(byType.excluded.map(row=>row.kind),['business-view'])
 assert.match(byType.excluded[0]?.reason??'',/host/)
 assert.match(byType.excluded[0]?.reason??'',/text/)
})

test('身份与来源声明对不上时直接拒绝生成，不生成半份包',async()=>{
 const input=await socInput()
 assert.throws(()=>planBusinessSharePackage({...input,sources:[]}),/security-alert-http/)
 assert.throws(()=>planBusinessSharePackage({...input,scope:'general'}),/general/)
 assert.throws(()=>planBusinessSharePackage({...input,objectTypes:input.objectTypes.map(row=>row.localId==='alert-ticket'?{...row,localId:'renamed'}:row)}),/renamed/)
 assert.throws(()=>planBusinessSharePackage({...input,views:input.views.map(row=>({...row,version:'2.0.0'}))}),/2\.0\.0/)
 // 声明的 domain 必须等于分享范围（后端读取层 :117-119 的同一条）。
 const foreign=await body('object-types/asset.json')
 assert.throws(()=>planBusinessSharePackage({...input,objectTypes:[{localId:'asset',version:foreign.version as string,body:{...foreign,domain:'AppSec'}}]}),/AppSec/)
 assert.throws(()=>planBusinessSharePackage({...input,sources:[...input.sources,{sourceId:'security-alert-http'}]}),/多次/)
})

test('白名单重建拒收多余键，整包零实例身份与零真实取值披露',async()=>{
 const input=await socInput()
 const alert=await body('object-types/alert-ticket.json')
 /**
  * 结构性判据的表现是**拒收**而不是静默剥离：`read*` 的 `exact()` 要求键数相等，塞一个多余键整份声明就读不出来。
  * 拒收比剥离更强——剥离会让分享的人以为包里带着他写的那一位，而实际没有。
  */
 for(const key of ['ownerId','loadId','snapshotHash','coverage','rows'])
  assert.throws(()=>planBusinessSharePackage({...input,objectTypes:[{localId:'alert-ticket',version:alert.version as string,body:{...alert,[key]:'security-alert-http'}}]}),Error,key)
 // 嵌套一层同理：字段声明里塞真实取值样例也读不出来。
 assert.throws(()=>planBusinessSharePackage({...input,objectTypes:[{localId:'alert-ticket',version:alert.version as string,
  body:{...alert,fields:[{...(alert.fields as Record<string,unknown>[])[0],value:'高'}]}}]}),Error)
 const result=planBusinessSharePackage(input)
 const all=result.files.map(file=>decode(file.bytes)).join('\n')
 // 形状扫描：uuid 与 64 位 hex 零命中（`loadId`/`contentId`/`definitionHash` 那一族的形状兜底）。
 assert.doesNotMatch(all,/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
 assert.doesNotMatch(all,/\b[0-9a-f]{64}\b/)
 // 键名扫描：真实数据与实例身份两条 Global Constraints 的键一个都不许出现（`summary` 例外——它是动作输入的合法部位）。
 for(const key of ['ownerId','spaceId','loadId','contentId','itemInstanceId','draftId','definitionHash','fileHash','contentHash','snapshotHash','receivedAt','observedAt','latestReceivedAt','coverage','rows','quality'])
  assert.equal(all.includes(key),false,key)
})

test('来源名词给了就进包，不给整个键缺省',async()=>{
 const input=await socInput()
 const withNoun=planBusinessSharePackage(input)
 assert.equal(textOf(withNoun,'connections/security-alert-http.json'),'{"format":"teloa.data-source/v1","scopes":["SOC"],"sourceId":"security-alert-http","sourceNoun":"告警源"}')
 assert.equal(withNoun.manifest.resources[0]?.title,'告警源')
 const withoutNoun=planBusinessSharePackage({...input,sources:[{sourceId:'security-alert-http'}]})
 const parsed=JSON.parse(textOf(withoutNoun,'connections/security-alert-http.json')) as Record<string,unknown>
 assert.equal('sourceNoun' in parsed,false)
 assert.equal(withoutNoun.manifest.resources[0]?.title,'security-alert-http')
 // ≤12 字判据由 `readIndustryDataSourceDefinition` 兜住，生成器不另放宽一格。
 assert.throws(()=>planBusinessSharePackage({...input,sources:[{sourceId:'security-alert-http',sourceNoun:'十三个字的来源名词不可以啦'}]}),Error)
})

test('英文两项给了才写 localized，三条要求逐条满足；不给则全树零 localized',async()=>{
 const input=await socInput()
 const bare=planBusinessSharePackage(input)
 // 「不给则全树零 localized」现在只在清单层面成立：正文声明可以合法自带声明级 `localized`（契约新增字段），
 // 未传英文两项时收窄成「清单没有 localized，清单资源条目也没有」；正文文件是否带 localized 由声明自己决定。
 assert.equal(bare.manifest.localized,undefined)
 assert.ok(bare.manifest.resources.every(resource=>resource.localized===undefined))
 assert.doesNotMatch(textOf(bare,'teloa.json'),/localized/)
 const result=planBusinessSharePackage({...input,english:{title:'Security operations ledger declarations',description:'Object types, views and actions of the SOC scope, declarations only.'}})
 const localized=result.manifest.localized
 assert.equal(localized?.title?.original,input.title)
 assert.equal(localized?.title?.defaultLocale,'en')
 assert.equal(localized?.title?.locales['zh-CN'],input.title)
 assert.equal(localized?.title?.locales.en,'Security operations ledger declarations')
 assert.equal(localized?.description?.original,input.description)
 assert.equal(localized?.description?.locales.en,'Object types, views and actions of the SOC scope, declarations only.')
 for(const resource of result.manifest.resources){
  const title=resource.localized?.title
  assert.equal(title?.original,resource.title,resource.id)
  assert.equal(title?.defaultLocale,'en',resource.id)
  // 三条要求：`zh-CN` 与 `en` 都是字符串（不是 `fallback`），`original` 与资源名逐字相等。
  assert.equal(typeof title?.locales['zh-CN'],'string',resource.id)
  assert.equal(typeof title?.locales.en,'string',resource.id)
  // 资源没有英文名可填，`locales.en` 放的是资源标题原文——这是回落而不是翻译。
  assert.equal(title?.locales.en,resource.title,resource.id)
 }
})

test('文件数与总量上限在生成处就挡住',async()=>{
 const input=await socInput()
 const board=await body('views/soc-pending-board.json')
 const views=(count:number)=>Array.from({length:count},(_unused,index):BusinessShareDeclaration=>({localId:'view-'+index,version:board.version as string,body:{...board,id:'view-'+index}}))
 // 600 份视图先撞清单的 500 项资源上限。
 assert.throws(()=>planBusinessSharePackage({...input,views:views(600)}),/500/)
 // 494 视图 + 3 对象类型 + 2 动作 + 1 数据源 = 500 项资源，恰好过清单那一关，再加清单本身就是 501 个文件。
 assert.throws(()=>planBusinessSharePackage({...input,views:views(494)}),/共 501 个文件/)
 /**
  * 单文件 2 MiB 那一格今天**不可触达**：白名单本身把一份声明的体量压在 1 MiB 以下（动作最多 100 项输入 ×
  * 4000 码元 ≈ 0.8 MiB，对象类型 50 字段 × 32 枚举取值 ≈ 0.3 MiB），因此源码里那一条是结构性兜底，
  * 这里钉的是可触达的总量上限：53 份满员动作 ≈ 21 MiB。
  */
 const filler='x'.repeat(4000)
 const action=await body('actions/assign-alert-review.json')
 const inputs=Array.from({length:100},()=>({from:'literal',value:filler}))
 const bulk=Array.from({length:53},(_unused,index):BusinessShareDeclaration=>({localId:'bulk-'+index,version:action.version as string,body:{...action,id:'bulk-'+index,inputs}}))
 assert.throws(()=>planBusinessSharePackage({...input,actions:bulk}),/20 MiB/)
})

/** 逐字快照：包内字节是机器生成物（决定 D8 的规范化输出），改动这里等于改动接收方算出的 `contentHash`。 */
const PINNED:Record<string,string>={
 "teloa.json":"{\"description\":\"把 SOC 的三类对象、四张视图与两个动作并成一个只含声明的包。\",\"domain\":\"SOC\",\"entrypoints\":[],\"format\":\"teloa.business-package/v2\",\"id\":\"soc-share\",\"relations\":[],\"resources\":[{\"id\":\"security-alert-http\",\"kind\":\"data-source\",\"required\":true,\"source\":{\"kind\":\"local\",\"path\":\"connections/security-alert-http.json\"},\"title\":\"告警源\",\"version\":\"1.0.0\"},{\"id\":\"alert-ticket\",\"kind\":\"object-type\",\"required\":true,\"source\":{\"kind\":\"local\",\"path\":\"object-types/alert-ticket.json\"},\"title\":\"告警工单\",\"version\":\"1.0.1\"},{\"id\":\"asset\",\"kind\":\"object-type\",\"required\":true,\"source\":{\"kind\":\"local\",\"path\":\"object-types/asset.json\"},\"title\":\"资产\",\"version\":\"1.0.1\"},{\"id\":\"incident-ticket\",\"kind\":\"object-type\",\"required\":true,\"source\":{\"kind\":\"local\",\"path\":\"object-types/incident-ticket.json\"},\"title\":\"事件工单\",\"version\":\"1.0.1\"},{\"id\":\"soc-alert-list\",\"kind\":\"business-view\",\"required\":false,\"source\":{\"kind\":\"local\",\"path\":\"views/soc-alert-list.json\"},\"title\":\"告警清单\",\"version\":\"1.0.1\"},{\"id\":\"soc-alert-trend\",\"kind\":\"business-view\",\"required\":false,\"source\":{\"kind\":\"local\",\"path\":\"views/soc-alert-trend.json\"},\"title\":\"告警趋势\",\"version\":\"1.0.1\"},{\"id\":\"soc-pending-board\",\"kind\":\"business-view\",\"required\":false,\"source\":{\"kind\":\"local\",\"path\":\"views/soc-pending-board.json\"},\"title\":\"待处理告警\",\"version\":\"1.0.1\"},{\"id\":\"soc-risk-distribution\",\"kind\":\"business-view\",\"required\":false,\"source\":{\"kind\":\"local\",\"path\":\"views/soc-risk-distribution.json\"},\"title\":\"风险分布\",\"version\":\"1.0.1\"},{\"id\":\"assign-alert-review\",\"kind\":\"business-action\",\"required\":false,\"source\":{\"kind\":\"local\",\"path\":\"actions/assign-alert-review.json\"},\"title\":\"交给同事核对\",\"version\":\"1.0.1\"},{\"id\":\"isolate-endpoint\",\"kind\":\"business-action\",\"required\":false,\"source\":{\"kind\":\"local\",\"path\":\"actions/isolate-endpoint.json\"},\"title\":\"隔离这台主机\",\"version\":\"1.0.1\"}],\"scope\":\"SOC\",\"title\":\"安全运营台账声明\",\"version\":\"1.0.0\"}",
 "connections/security-alert-http.json":"{\"format\":\"teloa.data-source/v1\",\"scopes\":[\"SOC\"],\"sourceId\":\"security-alert-http\",\"sourceNoun\":\"告警源\"}",
 "object-types/alert-ticket.json":"{\"defaultAction\":\"assign-alert-review\",\"domain\":\"SOC\",\"fields\":[{\"from\":\"严重度\",\"label\":\"严重度\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Severity\",\"zh-CN\":\"严重度\"},\"original\":\"严重度\"},\"values\":[{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"High\",\"zh-CN\":\"高\"},\"original\":\"高\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Medium\",\"zh-CN\":\"中\"},\"original\":\"中\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Low\",\"zh-CN\":\"低\"},\"original\":\"低\"}]},\"name\":\"severity\",\"required\":true,\"type\":\"enum\",\"values\":[\"高\",\"中\",\"低\"]},{\"from\":\"主机\",\"label\":\"主机\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Host\",\"zh-CN\":\"主机\"},\"original\":\"主机\"}},\"name\":\"host\",\"required\":true,\"type\":\"text\"},{\"from\":\"当前判定\",\"label\":\"当前判定\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Triage status\",\"zh-CN\":\"当前判定\"},\"original\":\"当前判定\"},\"values\":[{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Unreviewed\",\"zh-CN\":\"还没有人看\"},\"original\":\"还没有人看\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Under review\",\"zh-CN\":\"正在核对\"},\"original\":\"正在核对\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Needs your decision\",\"zh-CN\":\"等你确认\"},\"original\":\"等你确认\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Confirmed maintenance\",\"zh-CN\":\"已确认维护\"},\"original\":\"已确认维护\"}]},\"name\":\"verdict\",\"required\":true,\"type\":\"enum\",\"values\":[\"还没有人看\",\"正在核对\",\"等你确认\",\"已确认维护\"]},{\"from\":\"首次出现\",\"label\":\"首次出现\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"First seen\",\"zh-CN\":\"首次出现\"},\"original\":\"首次出现\"}},\"name\":\"first-seen-at\",\"required\":true,\"type\":\"datetime\"},{\"from\":\"最近变化\",\"label\":\"最近变化\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Last updated\",\"zh-CN\":\"最近变化\"},\"original\":\"最近变化\"}},\"name\":\"last-changed-at\",\"required\":true,\"type\":\"datetime\"},{\"from\":\"涉及账号数\",\"label\":\"涉及账号数\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Affected accounts\",\"zh-CN\":\"涉及账号数\"},\"original\":\"涉及账号数\"}},\"name\":\"account-count\",\"required\":false,\"type\":\"number\"},{\"from\":\"关联调查\",\"label\":\"关联调查\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Linked investigation\",\"zh-CN\":\"关联调查\"},\"original\":\"关联调查\"}},\"name\":\"incident\",\"referenceType\":\"incident-ticket\",\"required\":false,\"type\":\"reference\"}],\"format\":\"teloa.business-object-type/v1\",\"id\":\"alert-ticket\",\"lead\":\"来自告警平台和终端记录，进来之后先归并再判断。\",\"localized\":{\"lead\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Alerts from security monitoring and endpoint records are correlated before analysts make a decision.\",\"zh-CN\":\"来自告警平台和终端记录，进来之后先归并再判断。\"},\"original\":\"来自告警平台和终端记录，进来之后先归并再判断。\"},\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Alert tickets\",\"zh-CN\":\"告警工单\"},\"original\":\"告警工单\"},\"unit\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"alerts\",\"zh-CN\":\"条\"},\"original\":\"条\"}},\"progress\":{\"changedAtField\":\"last-changed-at\",\"stageField\":\"verdict\",\"unfinished\":[\"还没有人看\",\"正在核对\",\"等你确认\"],\"waitingForYou\":[\"等你确认\"]},\"sourceId\":\"security-alert-http\",\"title\":\"告警工单\",\"unit\":\"条\",\"version\":\"1.0.1\"}",
 "object-types/asset.json":"{\"domain\":\"SOC\",\"fields\":[{\"from\":\"环境\",\"label\":\"环境\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Environment\",\"zh-CN\":\"环境\"},\"original\":\"环境\"},\"values\":[{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Production\",\"zh-CN\":\"生产\"},\"original\":\"生产\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Test\",\"zh-CN\":\"测试\"},\"original\":\"测试\"}]},\"name\":\"environment\",\"required\":true,\"type\":\"enum\",\"values\":[\"生产\",\"测试\"]},{\"from\":\"负责人\",\"label\":\"负责人\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Owner\",\"zh-CN\":\"负责人\"},\"original\":\"负责人\"}},\"name\":\"owner-name\",\"required\":false,\"type\":\"text\"},{\"from\":\"资产等级\",\"label\":\"资产等级\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Asset tier\",\"zh-CN\":\"资产等级\"},\"original\":\"资产等级\"},\"values\":[{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Important\",\"zh-CN\":\"重要\"},\"original\":\"重要\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Standard\",\"zh-CN\":\"一般\"},\"original\":\"一般\"}]},\"name\":\"grade\",\"required\":false,\"type\":\"enum\",\"values\":[\"重要\",\"一般\"]},{\"from\":\"接入时间\",\"label\":\"接入时间\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Onboarded at\",\"zh-CN\":\"接入时间\"},\"original\":\"接入时间\"}},\"name\":\"registered-at\",\"required\":false,\"type\":\"datetime\"}],\"format\":\"teloa.business-object-type/v1\",\"id\":\"asset\",\"lead\":\"从资产台账同步，告警要落到具体机器上才查得下去。\",\"localized\":{\"lead\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Assets are synchronized from the asset inventory so every alert can be traced to a specific endpoint.\",\"zh-CN\":\"从资产台账同步，告警要落到具体机器上才查得下去。\"},\"original\":\"从资产台账同步，告警要落到具体机器上才查得下去。\"},\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Assets\",\"zh-CN\":\"资产\"},\"original\":\"资产\"},\"unit\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"assets\",\"zh-CN\":\"台\"},\"original\":\"台\"}},\"sourceId\":\"security-alert-http\",\"title\":\"资产\",\"unit\":\"台\",\"version\":\"1.0.1\"}",
 "object-types/incident-ticket.json":"{\"domain\":\"SOC\",\"fields\":[{\"from\":\"当前状态\",\"label\":\"当前状态\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Status\",\"zh-CN\":\"当前状态\"},\"original\":\"当前状态\"},\"values\":[{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"New\",\"zh-CN\":\"进来的事\"},\"original\":\"进来的事\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"In progress\",\"zh-CN\":\"正在处理\"},\"original\":\"正在处理\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Needs you\",\"zh-CN\":\"需要你\"},\"original\":\"需要你\"},{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Completed\",\"zh-CN\":\"已完成\"},\"original\":\"已完成\"}]},\"name\":\"state\",\"required\":true,\"type\":\"enum\",\"values\":[\"进来的事\",\"正在处理\",\"需要你\",\"已完成\"]},{\"from\":\"负责同事\",\"label\":\"负责同事\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Assignee\",\"zh-CN\":\"负责同事\"},\"original\":\"负责同事\"}},\"name\":\"owner\",\"required\":true,\"type\":\"text\"},{\"from\":\"立案时间\",\"label\":\"立案时间\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Opened at\",\"zh-CN\":\"立案时间\"},\"original\":\"立案时间\"}},\"name\":\"opened-at\",\"required\":true,\"type\":\"datetime\"},{\"from\":\"用到的对象数\",\"label\":\"用到的对象数\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Related objects\",\"zh-CN\":\"用到的对象数\"},\"original\":\"用到的对象数\"}},\"name\":\"object-count\",\"required\":false,\"type\":\"number\"},{\"from\":\"涉及资产\",\"label\":\"涉及资产\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Affected asset\",\"zh-CN\":\"涉及资产\"},\"original\":\"涉及资产\"}},\"name\":\"asset\",\"referenceType\":\"asset\",\"required\":false,\"type\":\"reference\"}],\"format\":\"teloa.business-object-type/v1\",\"id\":\"incident-ticket\",\"lead\":\"告警里说不清的，立成一件调查，交给同事查到有结论为止。\",\"localized\":{\"lead\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Alerts that need deeper investigation become incident tickets and stay assigned until a conclusion is reached.\",\"zh-CN\":\"告警里说不清的，立成一件调查，交给同事查到有结论为止。\"},\"original\":\"告警里说不清的，立成一件调查，交给同事查到有结论为止。\"},\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Incident tickets\",\"zh-CN\":\"事件工单\"},\"original\":\"事件工单\"},\"unit\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"cases\",\"zh-CN\":\"件\"},\"original\":\"件\"}},\"sourceId\":\"security-alert-http\",\"title\":\"事件工单\",\"unit\":\"件\",\"version\":\"1.0.1\"}",
 "views/soc-alert-list.json":"{\"chart\":\"table\",\"domain\":\"SOC\",\"filters\":[],\"format\":\"teloa.business-view/v1\",\"id\":\"soc-alert-list\",\"kind\":\"list\",\"limit\":100,\"localized\":{\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Alert list\",\"zh-CN\":\"告警清单\"},\"original\":\"告警清单\"}},\"measures\":[{\"aggregation\":\"max\",\"field\":\"account-count\",\"id\":\"accounts\",\"label\":\"涉及账号数\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Affected accounts\",\"zh-CN\":\"涉及账号数\"},\"original\":\"涉及账号数\"}}}],\"objectType\":\"alert-ticket\",\"sort\":{\"by\":\"dimension\",\"direction\":\"asc\"},\"title\":\"告警清单\",\"version\":\"1.0.1\"}",
 "views/soc-alert-trend.json":"{\"chart\":\"line\",\"dimension\":{\"bucket\":\"day\",\"field\":\"first-seen-at\",\"limit\":30},\"domain\":\"SOC\",\"filters\":[],\"format\":\"teloa.business-view/v1\",\"id\":\"soc-alert-trend\",\"kind\":\"trend\",\"limit\":30,\"localized\":{\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Alert trend\",\"zh-CN\":\"告警趋势\"},\"original\":\"告警趋势\"}},\"measures\":[{\"aggregation\":\"count\",\"id\":\"high\",\"label\":\"高\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"High\",\"zh-CN\":\"高\"},\"original\":\"高\"}},\"where\":{\"field\":\"severity\",\"op\":\"eq\",\"values\":[\"高\"]}},{\"aggregation\":\"count\",\"id\":\"med\",\"label\":\"中\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Medium\",\"zh-CN\":\"中\"},\"original\":\"中\"}},\"where\":{\"field\":\"severity\",\"op\":\"eq\",\"values\":[\"中\"]}},{\"aggregation\":\"count\",\"id\":\"low\",\"label\":\"低\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Low\",\"zh-CN\":\"低\"},\"original\":\"低\"}},\"where\":{\"field\":\"severity\",\"op\":\"eq\",\"values\":[\"低\"]}}],\"objectType\":\"alert-ticket\",\"sort\":{\"by\":\"dimension\",\"direction\":\"asc\"},\"title\":\"告警趋势\",\"version\":\"1.0.1\",\"window\":{\"field\":\"first-seen-at\",\"relative\":\"last-30d\"}}",
 "views/soc-pending-board.json":"{\"chart\":\"number\",\"domain\":\"SOC\",\"filters\":[{\"field\":\"verdict\",\"op\":\"in\",\"values\":[\"还没有人看\",\"正在核对\",\"等你确认\"]}],\"format\":\"teloa.business-view/v1\",\"id\":\"soc-pending-board\",\"kind\":\"board-card\",\"limit\":1,\"localized\":{\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Pending alerts\",\"zh-CN\":\"待处理告警\"},\"original\":\"待处理告警\"}},\"measures\":[{\"aggregation\":\"count\",\"id\":\"pending\",\"label\":\"条\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Alerts\",\"zh-CN\":\"条\"},\"original\":\"条\"}}}],\"objectType\":\"alert-ticket\",\"title\":\"待处理告警\",\"version\":\"1.0.1\"}",
 "views/soc-risk-distribution.json":"{\"chart\":\"bar\",\"dimension\":{\"field\":\"severity\",\"limit\":3},\"domain\":\"SOC\",\"filters\":[{\"field\":\"verdict\",\"op\":\"ne\",\"values\":[\"已确认维护\"]}],\"format\":\"teloa.business-view/v1\",\"id\":\"soc-risk-distribution\",\"kind\":\"distribution\",\"limit\":3,\"localized\":{\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Risk distribution\",\"zh-CN\":\"风险分布\"},\"original\":\"风险分布\"}},\"measures\":[{\"aggregation\":\"count\",\"id\":\"total\",\"label\":\"条数\",\"localized\":{\"label\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Alerts\",\"zh-CN\":\"条数\"},\"original\":\"条数\"}}}],\"objectType\":\"alert-ticket\",\"sort\":{\"by\":\"measure\",\"direction\":\"desc\",\"measureId\":\"total\"},\"title\":\"风险分布\",\"version\":\"1.0.1\"}",
 "actions/assign-alert-review.json":"{\"domain\":\"SOC\",\"format\":\"teloa.business-action/v1\",\"id\":\"assign-alert-review\",\"inputs\":[{\"field\":\"host\",\"from\":\"field\"},{\"from\":\"object\",\"part\":\"title\"},{\"from\":\"object\",\"part\":\"summary\"}],\"localized\":{\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Assign for peer review\",\"zh-CN\":\"交给同事核对\"},\"original\":\"交给同事核对\"}},\"objectType\":\"alert-ticket\",\"target\":{\"kind\":\"work-template\",\"localId\":\"alert-triage-review\"},\"title\":\"交给同事核对\",\"version\":\"1.0.1\"}",
 "actions/isolate-endpoint.json":"{\"domain\":\"SOC\",\"format\":\"teloa.business-action/v1\",\"id\":\"isolate-endpoint\",\"inputs\":[{\"from\":\"object\",\"part\":\"summary\"},{\"from\":\"literal\",\"value\":\"按告警工单发起，影响范围以资产台账为准。\"}],\"localized\":{\"title\":{\"defaultLocale\":\"en\",\"locales\":{\"en\":\"Isolate this endpoint\",\"zh-CN\":\"隔离这台主机\"},\"original\":\"隔离这台主机\"}},\"objectType\":\"alert-ticket\",\"target\":{\"kind\":\"execution-tool\",\"localId\":\"soc-endpoint-isolation\",\"targetFrom\":{\"field\":\"host\",\"from\":\"field\"},\"tool\":\"security.endpoint.isolate\",\"workTemplate\":\"endpoint-isolation-record\"},\"title\":\"隔离这台主机\",\"version\":\"1.0.1\"}",
}
