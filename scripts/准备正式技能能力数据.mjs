import {readdir,readFile} from 'node:fs/promises'
import {basename,join,relative} from 'node:path'
import {IndustryLoadService,MarketContentStore,createIndustryLoadSource} from '../packages/backend/src/index.ts'

const capabilityKinds=new Set(['skill','mcp'])
const fixedContentNotice='本机固定内容，仅用于展示结构，不表示外部连接已就绪。'
const fixedContentNoticeEn='Local fixed content for structural display only; it does not indicate that external connections are ready. '

async function collectFiles(root){
 const files=[]
 async function walk(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const absolute=join(directory,entry.name)
   if(entry.isDirectory())await walk(absolute)
   else files.push({path:relative(root,absolute).split('\\').join('/'),bytes:await readFile(absolute)})
  }
 }
 await walk(root)
 return files.sort((left,right)=>left.path.localeCompare(right.path))
}

async function readPackage(directory){
 const files=await collectFiles(directory),entry=files.find(file=>file.path==='teloa.json')
 if(!entry)throw new Error('正式能力包缺少根目录 teloa.json。')
 let manifest
 try{manifest=JSON.parse(entry.bytes.toString('utf8'))}catch{throw new Error('正式能力包的 teloa.json 不是合法 JSON。')}
 manifest.description=`${fixedContentNotice}${typeof manifest.description==='string'?manifest.description:''}`
 const localizedDescription=manifest.localized?.description
 if(localizedDescription&&typeof localizedDescription==='object'){
  if(typeof localizedDescription.original==='string')localizedDescription.original=fixedContentNotice+localizedDescription.original
  if(localizedDescription.locales&&typeof localizedDescription.locales==='object')for(const [locale,value] of Object.entries(localizedDescription.locales))if(typeof value==='string')localizedDescription.locales[locale]=(locale.startsWith('zh')?fixedContentNotice:fixedContentNoticeEn)+value
 }
 entry.bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n')
 const resources=Array.isArray(manifest.resources)?manifest.resources:[]
 const capabilities=resources.filter(resource=>resource&&capabilityKinds.has(resource.kind))
 if(typeof manifest.id!=='string'||!manifest.id||typeof manifest.version!=='string'||!manifest.version)throw new Error('正式能力包缺少稳定的模板身份或版本。')
 return {files,manifest,capabilities}
}

/** 只把经审阅的完整包固定到市场目录，不加载业务空间。 */
export async function ensureFormalMarketTemplate({pool,identity,ownerId,requestId,directory,sourceName=`本机固定${basename(directory)}目录（仅用于展示结构，不表示外部连接已就绪）`}){
 const {files,manifest,capabilities}=await readPackage(directory)
 const market=new MarketContentStore(pool,identity)
 const {content}=await market.import({ownerId,kind:'human'},{
  kind:'industry-template',
  requestId:requestId(`formal-market-content:${manifest.id}:${manifest.version}`),
  source:{kind:'upload',name:sourceName},
  manifestPath:'teloa.json',files,references:[],
 })
 return {content,manifest,capabilities}
}

/**
 * 经市场固定内容与行业加载服务准备正式能力数据。这里只登记来源，不伪造安装、
 * 连接或可用状态；团队能力页会据此显示“待安装／待连接”的真实下一步。
 */
export async function ensureFormalCapabilityData({pool,identity,ownerId,requestId,directory,sourceName=`本机固定${basename(directory)}能力目录（仅用于展示结构，不表示外部连接已就绪）`}){
 const {content,manifest,capabilities}=await ensureFormalMarketTemplate({pool,identity,ownerId,requestId,directory,sourceName})
 if(!capabilities.some(resource=>resource.kind==='skill')||!capabilities.some(resource=>resource.kind==='mcp'))throw new Error('正式能力包必须同时声明至少一项 Skill 和一项 MCP／连接。')
 const market=new MarketContentStore(pool,identity)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const currentLoads=(await loads.list(ownerId,{})).items
 const stale=currentLoads.find(load=>load.status==='active'&&load.templateId===content.logicalId&&(load.contentId!==content.id||load.contentHash!==content.hash))
 if(stale)throw new Error(`本机固定能力目录 ${manifest.id} 已有不同内容的活动加载，请通过行业模板升级流程处理，不能并行加载。`)
 const existing=currentLoads.find(load=>load.status==='active'&&load.contentId===content.id&&load.contentHash===content.hash)
 let load=existing
 if(!load){
  const space=(await pool.query("select id,version from teloa_business_spaces where owner_id=$1 and kind='personal'",[ownerId])).rows[0]
  if(!space)throw new Error('本人工作空间尚未准备，不能登记正式技能与连接。')
  load=await loads.create(ownerId,{
   requestId:requestId(`formal-capability-load:${manifest.id}:${manifest.version}`),
   contentId:content.id,contentHash:content.hash,
   target:{kind:'existing',spaceId:space.id,expectedVersion:space.version},
  })
 }
 const rows=load.items.filter(item=>capabilityKinds.has(item.kind))
 const expected=new Map(capabilities.map(resource=>[`${resource.kind}:${resource.id}`,resource]))
 if(rows.length!==expected.size||rows.some(item=>!expected.has(`${item.kind}:${item.localId}`)))throw new Error('正式能力加载结果与固定能力包声明不一致。')
 return {
  load,
  capabilities:rows.map(item=>({kind:item.kind,id:item.localId,instanceId:item.instanceId,title:item.title,version:item.version,status:item.status})),
 }
}
