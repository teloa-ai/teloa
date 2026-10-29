import {detectSecrets,type SecretKind} from './secret-shape.ts'
import {industryFileLimits,validateIndustryFilePath} from './industry-file-boundary.ts'

export type BusinessShareInspectionInput={files:readonly {path:string;bytes:Uint8Array}[];purpose:string}
export type BusinessShareInspectionOptions={allowBinaryAssets:true}
export type BusinessShareInspection={digest:string;fileList:readonly {path:string;digest:string}[];findings:readonly {path:string;kind:SecretKind|'url-credentials';start:number;end:number}[]}
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true}),binaryDecoder=new TextDecoder('utf-8')
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('')
function scan(text:string){
 const found:Array<{kind:SecretKind|'url-credentials';start:number;end:number}>=detectSecrets(text)
 for(const match of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi)){
  try{const url=new URL(match[0]);if(url.username||url.password)found.push({kind:'url-credentials',start:match.index!,end:match.index!+match[0].length})}catch{}
 }
 return found
}
/** 检查实际生成的正文，命中只回传类别与位置；摘要不包含检测结果。 */
export async function inspectBusinessShareContent(input:BusinessShareInspectionInput,options?:BusinessShareInspectionOptions):Promise<BusinessShareInspection>{
 if(typeof input.purpose!=='string'||input.purpose.length>2000||!Array.isArray(input.files)||!input.files.length||input.files.length>industryFileLimits.count)throw Error('分享内容或用途不合法。')
 const paths=new Set<string>(),files=input.files.map(file=>{validateIndustryFilePath(file.path);if(paths.has(file.path)||!(file.bytes instanceof Uint8Array)||file.bytes.byteLength>industryFileLimits.fileBytes)throw Error('分享文件重复或超出限制。');paths.add(file.path);return {path:file.path,bytes:Uint8Array.from(file.bytes)}}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
 if(files.reduce((sum,file)=>sum+file.bytes.byteLength,0)>industryFileLimits.totalBytes)throw Error('分享内容超出总大小限制。')
 const findings:BusinessShareInspection['findings'][number][]=scan(input.purpose).map(row=>({path:'purpose',...row})),fileList:BusinessShareInspection['fileList'][number][]=[],canonical:Array<{path:string;digest:string}>=[]
 for(const [index,file] of files.entries()){
  const nameHits=scan(file.path),path=nameHits.length?'file['+index+']':file.path,hash=await digest(file.bytes)
  fileList.push({path,digest:hash});canonical.push({path:file.path,digest:hash})
  findings.push(...nameHits.map(row=>({path,...row})))
  // 二进制附件仍扫描全部解码文本，替换非法UTF-8，不跳过其中可能存在的ASCII密钥。
  const text=(options?.allowBinaryAssets===true?binaryDecoder:decoder).decode(file.bytes)
  findings.push(...scan(text).map(row=>({path,...row})))
  // JSON 转义不能使声明中的实际字符串免检；脱敏位置指向原字符串整体。
  for(const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)){
   let decoded:string;try{decoded=JSON.parse(match[0])}catch{continue}
   if(decoded===match[0].slice(1,-1))continue
   for(const hit of scan(decoded))findings.push({path,kind:hit.kind,start:match.index!,end:match.index!+match[0].length})
  }
 }
 return {digest:await digest(encoder.encode(JSON.stringify({format:'teloa.business-share-inspection/v1',purpose:input.purpose,files:canonical}))),fileList,findings}
}
export async function assertBusinessShareInspection(input:BusinessShareInspectionInput,expectedDigest:string,options?:BusinessShareInspectionOptions):Promise<void>{
 const checked=await inspectBusinessShareContent(input,options)
 if(checked.findings.length)throw Error('分享内容检测到疑似凭据，请修改后重新预览。')
 if(!/^[a-f0-9]{64}$/.test(expectedDigest)||checked.digest!==expectedDigest)throw Error('分享内容或用途已变化，请重新预览。')
}
