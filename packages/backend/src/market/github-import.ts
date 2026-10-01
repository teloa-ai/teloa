import {WorkError,isRecord,skillFrontmatterName} from '@teloa/contract'
import type {MarketActor,MarketContent,MarketContentStore,MarketImportReceipt} from './content-store.ts'
import type {GithubSourceReceipt} from './github-source.ts'

/** 已固定来源的读取口；实现方须保留 github-source 的记录摘要校验。 */
export type GithubImportSource={read:(ownerId:string,input:{requestId:string})=>Promise<GithubSourceReceipt>}
type ImportStore=Pick<MarketContentStore,'import'>

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const uuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid('GitHub 导入请求格式不正确或包含未知字段。')
 return value
}

/** 只读首个 frontmatter 块里的顶层 name；必须符合 DSH 技能名文法，宿主安装时还会用官方解析器复核。 */
function skillName(bytes:Uint8Array):string{
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw invalid('SKILL.md 必须是 UTF-8 文本。')}
 const name=skillFrontmatterName(text)
 if(!name||!/^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw invalid('SKILL.md 的 name 不是合法技能名。')
 if(name.startsWith('teloa-'))throw invalid('以 teloa- 开头的技能名保留给 Teloa 内置技能，请换一个名称。')
 return name
}

/**
 * 把已经固定就绪的 GitHub 来源导入为本人行业模板内容。
 * 只读取宿主已保存的字节，不访问网络；来源出处随导入回执一起固定，供后续同仓库新提交比对。
 */
export class GithubImportService{
 private readonly store:ImportStore
 private readonly sources:GithubImportSource
 constructor(store:ImportStore,sources:GithubImportSource){this.store=store;this.sources=sources}
 async importIndustry(owner:MarketActor,input:unknown):Promise<{receipt:MarketImportReceipt;content:MarketContent}>{
  // 先判主体：只有本人可以固定内容，Agent 主体不应先读到来源字节再被内容仓拒绝。
  if(!owner||typeof owner.ownerId!=='string'||!owner.ownerId||owner.kind!=='human')throw new WorkError('teloa/forbidden','当前主体无权导入 GitHub 固定来源。')
  const row=exact(input,['requestId','githubRequestId','manifestPath'])
  if(!uuid(row.requestId))throw invalid('市场导入请求 ID 必须是 UUID。')
  if(!uuid(row.githubRequestId))throw invalid('GitHub 来源请求 ID 必须是 UUID。')
  if(typeof row.manifestPath!=='string'||!row.manifestPath.trim())throw invalid('行业清单路径必须填写。')
  const receipt=await this.sources.read(owner.ownerId,{requestId:row.githubRequestId})
  if(receipt.stage!=='ready')throw new WorkError('teloa/source-unavailable','GitHub 固定来源尚未就绪。')
  if(!receipt.files.some(file=>file.path===row.manifestPath))throw invalid('GitHub 固定来源中没有此行业清单文件。')
  // 与上传目录一致：只固定清单所在目录及其子目录的文件，路径前缀原样保留，根清单时等同全量。
  const root=row.manifestPath.includes('/')?row.manifestPath.slice(0,row.manifestPath.lastIndexOf('/')+1):''
  const files=receipt.files.filter(file=>file.path.startsWith(root))
  // 同一 requestId 重放由市场内容仓按导入请求去重，这里不另建幂等记录。
  return this.store.import(owner,{
   kind:'industry-template',requestId:row.requestId,source:{...receipt.provenance},manifestPath:row.manifestPath,
   // 可信度只由固定来源的回执决定：调用方不能自报仓库可信度，否则导入方能凭空抬高来源等级。
   trust:receipt.trust,
   files:files.map(file=>({path:file.path,bytes:file.bytes})),references:[],
  })
 }
 /**
  * 把固定来源中的一个 Skill 目录导入为本人原子 Skill。`skillPath` 指向 SKILL.md；
  * 名称取自 SKILL.md frontmatter 的 name，版本记为 0.0.0+提交前 12 位（上游没有可核对的版本号）。
  * 信任沿用固定来源回执（未审核），界面据此提示安装前核对内容。
  */
 async importSkill(owner:MarketActor,input:unknown):Promise<{receipt:MarketImportReceipt;content:MarketContent}>{
  if(!owner||typeof owner.ownerId!=='string'||!owner.ownerId||owner.kind!=='human')throw new WorkError('teloa/forbidden','当前主体无权导入 GitHub 固定来源。')
  const row=exact(input,['requestId','githubRequestId','skillPath'])
  if(!uuid(row.requestId))throw invalid('市场导入请求 ID 必须是 UUID。')
  if(!uuid(row.githubRequestId))throw invalid('GitHub 来源请求 ID 必须是 UUID。')
  if(typeof row.skillPath!=='string'||(row.skillPath!=='SKILL.md'&&!row.skillPath.endsWith('/SKILL.md')))throw invalid('技能路径必须指向 SKILL.md。')
  const receipt=await this.sources.read(owner.ownerId,{requestId:row.githubRequestId})
  if(receipt.stage!=='ready')throw new WorkError('teloa/source-unavailable','GitHub 固定来源尚未就绪。')
  const scope=receipt.provenance.path===undefined?'':receipt.provenance.path+'/'
  if(!row.skillPath.startsWith(scope))throw invalid('技能路径不在固定的子目录内。')
  const entry=receipt.files.find(file=>file.path===row.skillPath)
  if(!entry)throw invalid('GitHub 固定来源中没有这个 SKILL.md。')
  const root=row.skillPath.slice(0,row.skillPath.length-'SKILL.md'.length),files=receipt.files.filter(file=>file.path.startsWith(root))
  if(files.filter(file=>file.path.split('/').at(-1)==='SKILL.md').length!==1)throw invalid('技能目录必须只包含一个 SKILL.md。')
  const name=skillName(entry.bytes)
  return this.store.import(owner,{
   kind:'atomic-skill',requestId:row.requestId,source:{...receipt.provenance},
   metadata:{id:name,title:name,version:'0.0.0+'+receipt.provenance.resolvedCommit.slice(0,12),categories:[]},
   trust:receipt.trust,files:files.map(file=>({path:file.path,bytes:file.bytes})),
  })
 }
}
