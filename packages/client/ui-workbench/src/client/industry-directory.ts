import {isIndustryManifest} from './industry-manifest.ts'
import {industryFileLimits,validateIndustryFilePath,isGrokRecipe} from '@teloa/contract'
import type { ResolvedIndustryReference } from './industry-reference.ts'
import { itemFromManifest, MAX_MANIFEST_BYTES, parseMarketManifest, type MarketItem } from './market-preview.ts'
import {isSharePackageV2,readSharePackageV2,sharePackageSummary,sharePackageV2ToFiles,type SharePackageV2} from './share-package-plan.ts'

export type IndustryFileInput={path:string;size:number;read:()=>Promise<Uint8Array>}
export type IndustryContent={resolved?:ResolvedIndustryReference[];baseHash?:string;manifestPath:string;hash:string;files:{path:string;hash:string;bytes:Uint8Array}[];resources:{id:string;state:'available'|'missing'|'unresolved'}[]}
export const INDUSTRY_FILE_LIMIT=industryFileLimits.fileBytes,INDUSTRY_TOTAL_LIMIT=industryFileLimits.totalBytes
const MAX_FILE=INDUSTRY_FILE_LIMIT,MAX_TOTAL=INDUSTRY_TOTAL_LIMIT
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('')
export const validateIndustryPath=validateIndustryFilePath

/** 只读取用户选择的文件，不执行脚本，不解析符号链接或访问外部来源。 */
export async function readIndustryFiles(inputs:readonly IndustryFileInput[]):Promise<IndustryContent['files']>{
 if(!inputs.length||inputs.length>500)throw Error('目录需包含 1～500 个文件。')
 const paths=new Set<string>();let total=0
 for(const input of inputs){
  validateIndustryPath(input.path)
  if(paths.has(input.path))throw Error('目录文件路径重复：'+input.path)
  paths.add(input.path)
  if(!Number.isSafeInteger(input.size)||input.size<0||input.size>MAX_FILE)throw Error('文件大小超出 2 MiB 限制。')
  total+=input.size
 }
 if(total>MAX_TOTAL)throw Error('目录总大小超出 20 MiB 限制。')
 const files:IndustryContent['files']=[]
 for(const input of [...inputs].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)){
  const bytes=Uint8Array.from(await input.read())
  if(bytes.byteLength!==input.size)throw Error('读取大小与所选文件不一致：'+input.path)
  files.push({path:input.path,hash:await digest(bytes),bytes})
 }
 return files
}

async function itemFromFiles(allFiles:IndustryContent['files'],manifestPath:string,name:string):Promise<MarketItem>{
 validateIndustryPath(manifestPath)
 const root=manifestPath.includes('/')?manifestPath.slice(0,manifestPath.lastIndexOf('/')+1):''
 const files=allFiles.filter(file=>file.path.startsWith(root)),paths=new Set(files.map(file=>file.path))
 const total=files.reduce((sum,file)=>sum+file.bytes.byteLength,0)
 const content=files.find(file=>file.path===manifestPath)
 if(!content)throw Error('选择的清单文件不存在。')
 let raw:string
 try{raw=new TextDecoder('utf-8',{fatal:true}).decode(content.bytes)}catch{throw Error('行业清单必须为 UTF-8 文本。')}
 const parsed=await parseMarketManifest(raw)
 if(parsed.packageContent)return itemFromManifest(parsed,{kind:'upload',name,size:content.bytes.byteLength})
 if(!isIndustryManifest(parsed.manifest))throw Error('目录加载需使用完整行业资源 v2/v3 清单；旧清单仍可单独导入。')
 const resources=parsed.manifest.resources.map(resource=>({id:resource.id,state:resource.source.kind==='public'?'unresolved' as const:paths.has(root+resource.source.path)?'available' as const:'missing' as const}))
 const hash=await digest(new TextEncoder().encode(JSON.stringify({manifestPath,files:files.map(file=>[file.path,file.hash])})))
 const item=itemFromManifest(parsed,{kind:'upload',name,size:total})
 return {...item,id:'directory-'+hash,packageContent:{manifestPath,hash,files,resources},compatibility:'目录内容已读取；组件语义、公共引用和宿主兼容性待核对，未加载到工作空间。'}
}

export async function readIndustryDirectory(inputs:readonly IndustryFileInput[],manifestPath:string,name:string):Promise<MarketItem>{
 return itemFromFiles(await readIndustryFiles(inputs),manifestPath,name)
}
/** 按冻结选择把 v2 分享包转成可固定保存的业务包；分享方署名与许可只是声明，不提升为已签名或已审来源。 */
export async function shareIndustryItem(pkg:SharePackageV2,choice:{scope:string;skills:readonly string[]}):Promise<MarketItem>{
 const converted=sharePackageV2ToFiles(pkg,choice),encoder=new TextEncoder()
 const item=await readIndustryDirectory(converted.files.map(f=>{const bytes=encoder.encode(f.text);return {path:f.path,size:bytes.length,read:async()=>bytes}}),'teloa.json',converted.title)
 return {...item,author:converted.publisher,license:converted.license,trust:{publisher:converted.publisher,repository:null,license:{status:'declared',value:converted.license},signature:{status:'unverified',signer:null},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'本地上传来源尚未完成签名与兼容审查'}}}
}
export type SharePackageIssue='credential'|'local-path'|'too-large'|'capability'|'invalid'|'incomplete'
const shareIssueText:Readonly<Record<SharePackageIssue,string>>={
 credential:'模板含疑似密钥或账号信息，请删去后重新生成；账号在导入后「设置连接」时填写。',
 'local-path':'模板含本机文件路径，请删去后重新生成。',
 'too-large':'模板文件过大，请精简内容后重新生成。',
 capability:'模板里列出的能力与实际内容对不上，请在原会话里让 AI 重新生成。',
 invalid:'模板内容不完整或含不支持的字段，请在原会话里让 AI 重新生成后再导入。',
 incomplete:'模板缺少资源正文，无法加载；请导入完整模板包（ZIP、目录或分享包）后再试。',
}
/** 分享包校验失败的可读原因；issue 供界面按语言显示，message 供目录发现列表直接显示。 */
export class SharePackageImportError extends Error{
 readonly issue:SharePackageIssue
 constructor(issue:SharePackageIssue){super(shareIssueText[issue]);this.issue=issue}
}
const shareIssueOf=(message:string):SharePackageIssue=>/credential/i.test(message)?'credential':/local path/i.test(message)?'local-path':/exceeds/i.test(message)?'too-large':/capabilit/i.test(message)?'capability':'invalid'
/** 市场导入收到 AI 创建或他人分享的 v2 分享包时，按包内声明的范围与全部技能转换；不是分享包返回 undefined。 */
export async function sharePackageItem(value:unknown):Promise<MarketItem|undefined>{
 if(!isSharePackageV2(value))return undefined
 let pkg:SharePackageV2
 try{pkg=readSharePackageV2(value)}catch(error){throw new SharePackageImportError(shareIssueOf(error instanceof Error?error.message:''))}
 const summary=sharePackageSummary(pkg)
 return shareIndustryItem(pkg,{scope:summary.scope,skills:summary.skills.map(s=>s.resourceId)})
}
export type IndustryDiscovery={path:string;item?:MarketItem;error?:string}
export async function discoverIndustryTemplates(inputs:readonly IndustryFileInput[],name:string):Promise<IndustryDiscovery[]>{
 const files=await readIndustryFiles(inputs),results:IndustryDiscovery[]=[]
 for(const file of files){
  if(!/\.json$/i.test(file.path))continue
  const named=['teloa.json','recipe.json'].includes(file.path.split('/').at(-1)??'')
  let recognized=named
  try{
   if(file.bytes.byteLength>MAX_MANIFEST_BYTES){if(named)throw Error('行业清单不能超过1MiB。');continue}
   const raw=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes)
   const value:unknown=JSON.parse(raw)
   recognized=named||isGrokRecipe(value)||!!(value&&typeof value==='object'&&typeof Reflect.get(value,'format')==='string'&&(Reflect.get(value,'format').startsWith('teloa.business-package/')||Reflect.get(value,'format')==='teloa.template-share/v2'))
   if(!recognized)continue
   if(results.length>=50)throw Error('一次目录发现最多支持50个行业清单，请选择更小的目录。')
   results.push({path:file.path,item:await sharePackageItem(value)??await itemFromFiles(files,file.path,name)})
  }catch(error){
   if(!recognized)continue
   if(results.length>=50)throw Error('一次目录发现最多支持50个行业清单，请选择更小的目录。')
   results.push({path:file.path,error:error instanceof Error?error.message:'清单解析失败。'})
  }
 }
 return results
}
