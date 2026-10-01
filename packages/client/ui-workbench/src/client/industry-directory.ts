import {isIndustryManifest} from './industry-manifest.ts'
import type { ResolvedIndustryReference } from './industry-reference.ts'
import { itemFromManifest, MAX_MANIFEST_BYTES, parseMarketManifest, type MarketItem } from './market-preview.ts'

export type IndustryFileInput={path:string;size:number;read:()=>Promise<Uint8Array>}
export type IndustryContent={resolved?:ResolvedIndustryReference[];baseHash?:string;manifestPath:string;hash:string;files:{path:string;hash:string;bytes:Uint8Array}[];resources:{id:string;state:'available'|'missing'|'unresolved'}[]}
export const INDUSTRY_FILE_LIMIT=2*1024*1024,INDUSTRY_TOTAL_LIMIT=20*1024*1024
const MAX_FILE=INDUSTRY_FILE_LIMIT,MAX_TOTAL=INDUSTRY_TOTAL_LIMIT
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('')
export const validateIndustryPath=(path:string)=>{if(!path||path.length>500||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:?%#\u0000-\u001f\u007f]/.test(path))throw Error('目录文件路径无效：'+path)}

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
 if(!isIndustryManifest(parsed.manifest))throw Error('目录加载需使用完整行业资源 v2/v3 清单；旧清单仍可单独导入。')
 const resources=parsed.manifest.resources.map(resource=>({id:resource.id,state:resource.source.kind==='public'?'unresolved' as const:paths.has(root+resource.source.path)?'available' as const:'missing' as const}))
 const hash=await digest(new TextEncoder().encode(JSON.stringify({manifestPath,files:files.map(file=>[file.path,file.hash])})))
 const item=itemFromManifest(parsed,{kind:'upload',name,size:total})
 return {...item,id:'directory-'+hash,packageContent:{manifestPath,hash,files,resources},compatibility:'目录内容已读取；组件语义、公共引用和宿主兼容性待核对，未加载到工作空间。'}
}

export async function readIndustryDirectory(inputs:readonly IndustryFileInput[],manifestPath:string,name:string):Promise<MarketItem>{
 return itemFromFiles(await readIndustryFiles(inputs),manifestPath,name)
}
export type IndustryDiscovery={path:string;item?:MarketItem;error?:string}
export async function discoverIndustryTemplates(inputs:readonly IndustryFileInput[],name:string):Promise<IndustryDiscovery[]>{
 const files=await readIndustryFiles(inputs),results:IndustryDiscovery[]=[]
 for(const file of files){
  if(!/\.json$/i.test(file.path))continue
  const named=file.path.split('/').at(-1)==='teloa.json'
  let recognized=named
  try{
   if(file.bytes.byteLength>MAX_MANIFEST_BYTES){if(named)throw Error('行业清单不能超过1MiB。');continue}
   const raw=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes)
   const value:unknown=JSON.parse(raw)
   recognized=named||!!(value&&typeof value==='object'&&typeof Reflect.get(value,'format')==='string'&&Reflect.get(value,'format').startsWith('teloa.business-package/'))
   if(!recognized)continue
   if(results.length>=50)throw Error('一次目录发现最多支持50个行业清单，请选择更小的目录。')
   results.push({path:file.path,item:await itemFromFiles(files,file.path,name)})
  }catch(error){
   if(!recognized)continue
   if(results.length>=50)throw Error('一次目录发现最多支持50个行业清单，请选择更小的目录。')
   results.push({path:file.path,error:error instanceof Error?error.message:'清单解析失败。'})
  }
 }
 return results
}
