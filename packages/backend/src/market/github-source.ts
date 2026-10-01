import {createHash} from 'node:crypto'
import {inflateRawSync} from 'node:zlib'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,isGithubRepositoryName,MARKET_CATALOG_FORBIDDEN_EXTENSIONS,marketCatalogGithubFileRepositoryPath,type MarketCatalogUpstreamGithub} from '@teloa/contract'
import type {MarketSourceTrust} from './content-store.ts'

export type GithubHttpRequest={url:string;method:'GET';headers:Readonly<Record<string,string>>;redirect:'manual';signal:AbortSignal}
export type GithubHttpResponse={status:number;headers:Readonly<Record<string,string|undefined>>;body:AsyncIterable<Uint8Array>}
export type GithubHttpPort={request:(request:GithubHttpRequest)=>Promise<GithubHttpResponse>}
export type GithubSourceProvenance={kind:'github';owner:string;repo:string;requestedRef:string;resolvedCommit:string;archiveHash:string;path?:string}
export type GithubSourceFile={path:string;hash:string;bytes:Uint8Array}
export type GithubSourceReceipt={requestId:string;ownerId:string;stage:'ready';provenance:GithubSourceProvenance;trust:MarketSourceTrust;files:GithubSourceFile[];createdAt:string;updatedAt:string}

/** `path` 存在时只按固定提交读取该子目录（Git 树 + 逐文件 raw 读取），不下整仓归档。 */
type RequestSpec={owner:string;repo:string;ref:string;path?:string}
type RequestInput=RequestSpec&{requestId:string}
type StoredRequest={owner_id:unknown;request_id:unknown;request_spec:unknown;stage:unknown;resolved_commit:unknown;archive_hash:unknown;tree_hash:unknown;record_hash:unknown;created_at:unknown;updated_at:unknown}

const SUBTREE_DEADLINE_MS=120000,SUBTREE_CONCURRENCY=4
/**
 * commit 解析：`Accept: application/vnd.github.sha` 只回 40 字节 sha，不随 tip commit 的 files[]/patch 大小起伏（JSON 形态常达 1–3 MB，会误拒合法 ref）。
 * commit 对象（/git/commits/{sha}）只含元数据与提交说明、不含 files，256 KiB 足以容纳超长提交说明。
 */
const MAX_SHA_BYTES=1024,MAX_COMMIT_OBJECT_BYTES=256*1024
const MAX_ARCHIVE_BYTES=20*1024*1024,MAX_FILE_BYTES=2*1024*1024,MAX_FILES=500,MAX_ENTRIES=1000
/**
 * Git 树读取限额只针对「本次要装的内容」及其必经祖先，与仓库整体大小无关：
 * - 单次树响应 8 MiB：整体缓冲后 JSON 解析，防单个响应撑爆内存。目标子树的列表若超过 8 MiB（约 4 万条）必然超出 500 文件上限；
 *   沿途祖先目录的单层列表实测只有 KB 级，单层 ≥4 万条的祖先目录极罕见，此类仓库不支持。
 * - 累计 32 MiB：防异常上游用大量大目录列表在时限内耗尽内存与带宽；为 4 个满额单次响应，路径上即使有几层超大目录也不误拒。
 * - 1000 棵树：每棵树一次 API 请求且计入 GitHub 限流，防深或分散路径造成无界请求；已审清单 500 文件时平均每个文件可有 2 棵独立祖先树。
 */
const MAX_TREE_RESPONSE_BYTES=8*1024*1024,MAX_TREE_TOTAL_BYTES=32*1024*1024,MAX_TREES=1000
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,COMMIT=/^[0-9a-f]{40}$/
const OWNER=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const invalid=(message='GitHub 来源请求格式不正确。')=>new WorkError('teloa/invalid-input',message)
const unavailable=(message='GitHub 来源暂不可用。')=>new WorkError('teloa/source-unavailable',message)
const corrupt=()=>new WorkError('teloa/storage-corrupt','GitHub 固定来源记录损坏，已停止读取。')
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value)
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>isRecord(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}

function ownerIdentity(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。');return value}
function refName(value:unknown):string{
 if(typeof value!=='string'||value.length<1||value.length>200||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)||value.includes('..')||value.includes('//')||value.includes('@{')||value.endsWith('/')||value.endsWith('.')||value.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.lock')))throw invalid('GitHub ref 不是受支持的分支、标签或提交标识。')
 return value
}
function subdirectory(value:unknown):string{
 if(typeof value!=='string'||!value||value.length>300||value.startsWith('/')||value.endsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:?%#\u0000-\u001f\u007f]/.test(value))throw invalid('GitHub 子目录必须是仓库内的安全相对路径。')
 return value.normalize('NFC')
}
function normalize(value:unknown):RequestInput{
 const row=exact(value,['requestId','owner','repo','ref','path'])
 if(!uuid(row.requestId))throw invalid('GitHub 来源请求 ID 必须是 UUID。')
 if(typeof row.owner!=='string'||!OWNER.test(row.owner)||row.owner.includes('--'))throw invalid('GitHub owner 标识不合法。')
 if(!isGithubRepositoryName(row.repo))throw invalid('GitHub repo 标识不合法。')
 return {requestId:row.requestId.toLowerCase(),owner:row.owner,repo:row.repo,ref:refName(row.ref),...(row.path===undefined?{}:{path:subdirectory(row.path)})}
}
function storedSpec(value:unknown):RequestSpec{try{const row=exact(value,['owner','repo','ref','path']);const normalized=normalize({requestId:'00000000-0000-4000-8000-000000000000',...row});return {owner:normalized.owner,repo:normalized.repo,ref:normalized.ref,...(normalized.path===undefined?{}:{path:normalized.path})}}catch{throw corrupt()}}
function header(headers:Readonly<Record<string,string|undefined>>,name:string):string|undefined{const key=Object.keys(headers).find(value=>value.toLowerCase()===name);return key?headers[key]:undefined}
type GithubHost='api.github.com'|'codeload.github.com'|'raw.githubusercontent.com'
function checkedUrl(value:string,host:GithubHost):string{const url=new URL(value);if(url.protocol!=='https:'||url.hostname!==host||url.port||url.username||url.password)throw unavailable('GitHub 请求目标不在允许的主机范围内。');return url.toString()}

/** 403/429 且剩余配额为 0（或带 retry-after）视为 GitHub API 限流；文案给出重置时间，便于自动化 harness 定位与择时重试。 */
function rateLimited(status:number,headers:Readonly<Record<string,string|undefined>>):string|undefined{
 const remaining=header(headers,'x-ratelimit-remaining'),reset=header(headers,'x-ratelimit-reset'),retryAfter=header(headers,'retry-after')
 if(status!==403&&status!==429)return undefined
 if(remaining!=='0'&&retryAfter===undefined)return undefined
 const resetAt=retryAfter!==undefined&&/^\d+$/.test(retryAfter)?Date.now()+Number(retryAfter)*1000:reset!==undefined&&/^\d+$/.test(reset)?Number(reset)*1000:undefined
 const when=resetAt===undefined?'请稍后重试':`约 ${Math.max(1,Math.ceil((resetAt-Date.now())/60000))} 分钟后（${new Date(resetAt).toISOString()}）重置`
 return `GitHub API 限流（HTTP ${status}，剩余配额 ${remaining??'未知'}），${when}`
}
/** `label` 说明这次请求在取什么（阶段 + 相对路径），失败文案据此定位到具体请求，不再只有「请求未成功」。 */
async function requestBytes(http:GithubHttpPort,url:string,host:GithubHost,max:number,accept:string,timeoutMs:number,label:string):Promise<Uint8Array>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),target=checkedUrl(url,host),pathname=new URL(target).pathname
 try{
  let response:GithubHttpResponse
  try{response=await http.request({url:target,method:'GET',redirect:'manual',signal:controller.signal,headers:{accept,'user-agent':'Teloa-AI-Studio/0.0.1'}})}catch{throw unavailable(`GitHub ${label} 请求未完成（网络错误或超时 ${timeoutMs} ms）：${pathname}`)}
  if(response.status>=300&&response.status<400)throw unavailable(`GitHub ${label} 返回了不允许跟随的重定向（HTTP ${response.status}）：${pathname}`)
  if(response.status!==200){const limited=rateLimited(response.status,response.headers);throw unavailable(limited?`${limited}；${label} 未读取：${pathname}`:`GitHub ${label} 请求失败（HTTP ${response.status}）：${pathname}`)}
  const length=header(response.headers,'content-length')
  if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>max))throw unavailable(`GitHub ${label} 响应 ${length} 字节，超过 ${max} 字节上限：${pathname}`)
  const parts:Uint8Array[]=[];let total=0
  try{for await(const chunk of response.body){if(!(chunk instanceof Uint8Array))throw Error();total+=chunk.byteLength;if(total>max){controller.abort();throw Error()}parts.push(Uint8Array.from(chunk))}}catch(error){if(error instanceof WorkError)throw error;throw unavailable(`GitHub ${label} 响应读取失败或超过 ${max} 字节上限：${pathname}`)}
  const output=new Uint8Array(total);let offset=0;for(const part of parts){output.set(part,offset);offset+=part.byteLength}return output
 }finally{clearTimeout(timer)}
}

const decodeJson=(body:Uint8Array,label:string):unknown=>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body))}catch{throw unavailable(`GitHub ${label} 响应不是有效 JSON。`)}}
/** 只取 40 位 sha；ref 本身是 40 位时 GitHub 必须原样返回。 */
async function resolveCommit(http:GithubHttpPort,spec:RequestSpec):Promise<string>{
 const body=await requestBytes(http,`https://api.github.com/repos/${spec.owner}/${spec.repo}/commits/${encodeURIComponent(spec.ref)}`,'api.github.com',MAX_SHA_BYTES,'application/vnd.github.sha',10000,`commit 解析 ${spec.ref}`)
 let value:string;try{value=new TextDecoder('utf-8',{fatal:true}).decode(body).trim()}catch{throw unavailable('GitHub commit 响应不是 UTF-8 文本。')}
 if(!COMMIT.test(value))throw unavailable(`GitHub 没有为 ${spec.ref} 返回固定的 40 位 commit。`)
 if(COMMIT.test(spec.ref)&&value!==spec.ref)throw unavailable(`GitHub 返回的 commit ${value} 与请求的 40 位 ref ${spec.ref} 不一致。`)
 return value
}
/** 读取 commit 对象，取根树 sha 供根树回包交叉核对（≈1 KB，不含 files/patch）。 */
async function commitTree(http:GithubHttpPort,spec:RequestSpec,commit:string,timeoutMs:number):Promise<string>{
 const value=decodeJson(await requestBytes(http,`https://api.github.com/repos/${spec.owner}/${spec.repo}/git/commits/${commit}`,'api.github.com',MAX_COMMIT_OBJECT_BYTES,'application/vnd.github+json',timeoutMs,`commit 对象 ${commit.slice(0,12)}`),'commit 对象')
 if(!isRecord(value)||value.sha!==commit||!isRecord(value.tree)||typeof value.tree.sha!=='string'||!COMMIT.test(value.tree.sha))throw unavailable(`GitHub commit 对象 ${commit.slice(0,12)} 缺少匹配的 sha 或根树 sha。`)
 return value.tree.sha
}

function u16(buffer:Buffer,offset:number):number{if(offset<0||offset+2>buffer.length)throw unavailable('GitHub ZIP 结构无效。');return buffer.readUInt16LE(offset)}
function u32(buffer:Buffer,offset:number):number{if(offset<0||offset+4>buffer.length)throw unavailable('GitHub ZIP 结构无效。');return buffer.readUInt32LE(offset)}
function crc32(value:Uint8Array):number{let crc=0xffffffff;for(const byte of value){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return (crc^0xffffffff)>>>0}
function finalPath(raw:string,root:string):string{
 const normalized=raw.normalize('NFC'),parts=normalized.split('/')
 if(parts.length<2||parts[0]!==root||parts.some(part=>!part||part==='.'||part==='..')||normalized.startsWith('/')||/[\\:?%#\u0000-\u001f\u007f]/.test(normalized))throw unavailable('GitHub 来源包含不安全路径：'+quoted(raw.slice(root.length+1)))
 const path=parts.slice(1).join('/');if(path.length>500)throw unavailable('GitHub 来源文件路径超过 500 字符：'+shown(path.slice(0,80))+'…');return path
}
function extractZip(input:Uint8Array):GithubSourceFile[]{
 // 归档只按静态字节树解析；这里不会执行脚本，也不会展开 submodule 或 Git LFS 指针。
 const buffer=Buffer.from(input),from=Math.max(0,buffer.length-65557);let end=-1
 for(let at=buffer.length-22;at>=from;at--)if(u32(buffer,at)===0x06054b50){end=at;break}
 if(end<0||u16(buffer,end+4)!==0||u16(buffer,end+6)!==0)throw unavailable('GitHub ZIP 不支持多卷格式。')
 const diskEntries=u16(buffer,end+8),entries=u16(buffer,end+10),centralSize=u32(buffer,end+12),centralOffset=u32(buffer,end+16)
 if(entries!==diskEntries||entries===0xffff||entries>MAX_ENTRIES||centralOffset===0xffffffff||centralSize===0xffffffff||centralOffset+centralSize>end)throw unavailable('GitHub ZIP 目录无效或超过条目限制。')
 const decoder=new TextDecoder('utf-8',{fatal:true}),files:GithubSourceFile[]=[];let at=centralOffset,total=0,root:string|undefined;const paths=new Set<string>(),folded=new Set<string>()
 for(let index=0;index<entries;index++){
  if(u32(buffer,at)!==0x02014b50)throw unavailable('GitHub ZIP 中央目录无效。')
  const flags=u16(buffer,at+8),method=u16(buffer,at+10),expectedCrc=u32(buffer,at+16),compressedSize=u32(buffer,at+20),size=u32(buffer,at+24),nameLength=u16(buffer,at+28),extraLength=u16(buffer,at+30),commentLength=u16(buffer,at+32),external=u32(buffer,at+38),localOffset=u32(buffer,at+42),nameStart=at+46,nameEnd=nameStart+nameLength
  if(nameEnd+extraLength+commentLength>centralOffset+centralSize||flags&1||![0,8].includes(method)||compressedSize===0xffffffff||size===0xffffffff)throw unavailable('GitHub ZIP 包含不支持的条目。')
  let raw:string;try{raw=decoder.decode(buffer.subarray(nameStart,nameEnd))}catch{throw unavailable('GitHub ZIP 路径必须是 UTF-8。')}
  const parts=raw.normalize('NFC').split('/'),entryRoot=parts[0];if(!entryRoot)throw unavailable('GitHub ZIP 根目录无效。');if(root===undefined)root=entryRoot;else if(root!==entryRoot)throw unavailable('GitHub ZIP 必须只有一个根目录。')
  const mode=(external>>>16)&0xffff,type=mode&0xf000,directory=raw.endsWith('/')
  if(type===0xa000)throw unavailable('GitHub ZIP 不接受符号链接。')
  if(type!==0&&type!==0x8000&&type!==0x4000)throw unavailable('GitHub ZIP 包含不支持的文件类型。')
  if(!directory){
   if(files.length>=MAX_FILES||size>MAX_FILE_BYTES||total+size>MAX_ARCHIVE_BYTES)throw unavailable('GitHub ZIP 解压内容超过大小限制。')
   const path=finalPath(raw,root),fold=path.toLocaleLowerCase('en-US');if(paths.has(path)||folded.has(fold))throw unavailable('GitHub ZIP 包含重复或大小写冲突路径。')
   if(u32(buffer,localOffset)!==0x04034b50)throw unavailable('GitHub ZIP 本地目录无效。')
   const localFlags=u16(buffer,localOffset+6),localMethod=u16(buffer,localOffset+8),localNameLength=u16(buffer,localOffset+26),localExtraLength=u16(buffer,localOffset+28),dataStart=localOffset+30+localNameLength+localExtraLength,dataEnd=dataStart+compressedSize
   if(localFlags!==flags||localMethod!==method||dataEnd>centralOffset)throw unavailable('GitHub ZIP 条目边界无效。')
   let localName:string;try{localName=decoder.decode(buffer.subarray(localOffset+30,localOffset+30+localNameLength))}catch{throw unavailable('GitHub ZIP 路径必须是 UTF-8。')}if(localName!==raw)throw unavailable('GitHub ZIP 目录身份不一致。')
   let content:Buffer;try{content=method===0?Buffer.from(buffer.subarray(dataStart,dataEnd)):inflateRawSync(buffer.subarray(dataStart,dataEnd),{maxOutputLength:MAX_FILE_BYTES})}catch{throw unavailable('GitHub ZIP 文件无法安全解压。')}
   if(content.length!==size||crc32(content)!==expectedCrc)throw unavailable('GitHub ZIP 文件摘要或长度不一致。')
   const copy=Uint8Array.from(content);files.push({path,hash:sha(copy),bytes:copy});paths.add(path);folded.add(fold);total+=copy.byteLength
  }
  at=nameEnd+extraLength+commentLength
 }
 if(at!==centralOffset+centralSize||!root||files.length===0)throw unavailable('GitHub ZIP 目录不完整或没有文件。')
 return files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0)
}

const gitBlob=(bytes:Uint8Array)=>createHash('sha1').update('blob '+bytes.byteLength+'\0').update(bytes).digest('hex')
type TreeItem=Record<string,unknown>&{path:string}
type GitTree={sha:string;items:TreeItem[];folds:Map<string,TreeItem[]>}
const fold=(name:string)=>name.normalize('NFC').toLocaleLowerCase('en-US')
const isDirectory=(item:TreeItem):item is TreeItem&{sha:string}=>item.type==='tree'&&item.mode==='040000'&&typeof item.sha==='string'&&COMMIT.test(item.sha)
/** 树条目的人话种类，用于错误文案定位；不参与任何判定。 */
const describe=(item:TreeItem)=>item.mode==='120000'?'符号链接':item.type==='commit'||item.mode==='160000'?'子模块':item.type==='blob'?'文件':'未知类型 '+shown(String(item.type))
const isLink=(item:TreeItem)=>item.mode==='120000'
const isSubmodule=(item:TreeItem)=>item.type==='commit'||item.mode==='160000'
/** C0/DEL/C1 控制字符、行/段分隔符与双向控制符：在文案里不可见或会改变显示顺序。 */
const INVISIBLE=/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
/** 截断到 200 字的 JSON 字面量；JSON.stringify 只转义 C0，其余不可见字符在这里补成 \uXXXX。 */
const quoted=(value:string)=>JSON.stringify(value.slice(0,200)).replace(new RegExp(INVISIBLE.source,'g'),char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))+(value.length>200?'…':'')
/** 上游可控的名字进入文案前转义：含不可见字符或超过 200 字时用 quoted 显示，正常名字原样显示。 */
const shown=(value:string)=>INVISIBLE.test(value)||value.length>200?quoted(value):value
type WalkResult={item:TreeItem;raw:string;ancestors:Set<string>}|{missing:string;similar?:string}|{notDirectory:string;item:TreeItem}
/**
 * 固定提交的 Git 树按需读取：从根树非递归逐级下降，只读目标路径需要的树；树数、累计字节与截止时间和 raw 下载共享。
 * 只校验实际经过或要安装的条目；仓库其他部分的名字不读取、不影响安装。
 */
function gitTreeReader(http:GithubHttpPort,spec:RequestSpec,deadline:number){
 const cache=new Map<string,GitTree>();let usedBytes=0,requests=0
 const expired=()=>unavailable('子目录下载超过 120 秒，已停止；请缩小子目录后重试。')
 const request=async(ref:string,expectedSha:string|undefined,recursive:boolean,label:string)=>{
  const remaining=deadline-Date.now()
  if(remaining<=0)throw expired()
  if(requests>=MAX_TREES)throw unavailable(`GitHub 目录树读取已达 ${MAX_TREES} 棵上限（${label}），已停止。`)
  if(usedBytes>=MAX_TREE_TOTAL_BYTES)throw unavailable(`GitHub 目录树累计字节已达 ${MAX_TREE_TOTAL_BYTES/1024/1024} MiB 上限（${label}），已停止。`)
  requests++
  // 单次上限取 8 MiB 与累计剩余预算的较小者；被累计预算截停时文案点明是累计限额，与单次 8 MiB 区分。
  const budget=MAX_TREE_TOTAL_BYTES-usedBytes,capped=budget<MAX_TREE_RESPONSE_BYTES
  // GitHub Get a tree：recursive 取任何值（含 false/0）都会递归，非递归必须完全省略该参数。
  const body=await requestBytes(http,`https://api.github.com/repos/${spec.owner}/${spec.repo}/git/trees/${ref}${recursive?'?recursive=1':''}`,'api.github.com',capped?budget:MAX_TREE_RESPONSE_BYTES,'application/vnd.github+json',Math.min(10000,remaining),capped?`${label}（累计 ${MAX_TREE_TOTAL_BYTES/1024/1024} MiB 预算仅剩 ${budget} 字节）`:label)
  usedBytes+=body.byteLength
  if(Date.now()>=deadline)throw expired()
  const value=decodeJson(body,label)
  if(!isRecord(value)||!Array.isArray(value.tree)||typeof value.truncated!=='boolean'||typeof value.sha!=='string'||!COMMIT.test(value.sha)||value.tree.some(item=>!isRecord(item)||typeof item.path!=='string'))throw unavailable(`GitHub ${label} 回包格式无效（需 40 位 sha、truncated 与 tree 条目数组）。`)
  if(expectedSha!==undefined&&value.sha!==expectedSha)throw unavailable(`GitHub ${label} 回包 sha ${value.sha} 与预期 ${expectedSha} 不一致。`)
  return {sha:value.sha,truncated:value.truncated,items:value.tree as TreeItem[]}
 }
 /** 非递归读取一棵树。根按固定 commit 读取，expected 为 commit 对象给出的根树 sha（已审路径无 commit 请求时为 undefined，只验格式）；子树回包必须等于父项声明的 sha。 */
 const read=async(ref:string,expected:string|undefined,label:string):Promise<GitTree>=>{
  const cached=cache.get(ref);if(cached)return cached
  const value=await request(ref,expected,false,label)
  if(value.truncated)throw unavailable(`GitHub ${label} 非递归单层列表被截断（单层条目过多），无法固定文件。`)
  const folds=new Map<string,TreeItem[]>()
  for(const item of value.items){const key=fold(item.path);folds.set(key,[...folds.get(key)??[],item])}
  const tree={sha:value.sha,items:value.items,folds};cache.set(value.sha,tree);return tree
 }
 /** 沿已校验的 NFC 路径下降；经过的名字若有 NFC/大小写等价项则拒绝，祖先须为普通目录树且不成环。找不到时说明缺在哪一级、有无仅大小写/NFC 不同的候选。 */
 const walk=async(root:GitTree,path:string):Promise<WalkResult>=>{
  const parts=path.split('/'),raw:string[]=[],ancestors=new Set([root.sha]);let tree=root
  for(let index=0;;index++){
   const name=parts[index]!,at=parts.slice(0,index+1).join('/'),matches=tree.folds.get(fold(name))
   if(!matches)return {missing:at}
   if(matches.length>1)throw unavailable(`GitHub 目录树中 ${parts.slice(0,index).join('/')||'根'} 下有多个与 ${name} 同名或大小写/NFC 等价的条目，无法唯一确定。`)
   const item=matches[0]!
   if(item.path.normalize('NFC')!==name)return {missing:at,similar:shown([...raw,item.path].join('/'))}
   raw.push(item.path)
   // 声明为树却模式或 sha 非法是上游损坏，祖先与目标一律 unavailable、同一文案。
   if(item.type==='tree'&&!isDirectory(item))throw unavailable(`GitHub 子目录 ${shown(at)} 声明为树但模式或 sha 非法。`)
   if(index===parts.length-1)return {item,raw:raw.join('/'),ancestors}
   if(!isDirectory(item))return {notDirectory:at,item}
   if(ancestors.has(item.sha))throw unavailable(`GitHub 目录 ${at} 的树 sha 与其祖先重复（环路），已停止。`)
   ancestors.add(item.sha);tree=await read(item.sha,item.sha,`目录树 ${at}`)
  }
 }
 /**
  * 列出目标子树全部条目（路径为树中原始路径）：先一次递归读取该子树；GitHub 标记截断（该子树 ≥10 万条或 ≥7 MB）时，
  * 先按截断回包已带的部分条目估算：部分条目是全集的子集，若它就已超过 500 文件或 1000 目录，全集必然超限，直接失败、不再逐级请求；
  * 只有部分列表仍在可安装规模内才逐级展开（保留环路检测、单段名校验，链接/子模块与超 500 文件即停）。
  */
 const list=async(sha:string,raw:string,ancestors:Set<string>):Promise<TreeItem[]>=>{
  const whole=await request(sha,sha,true,`子目录 ${raw} 递归列表`)
  if(!whole.truncated)return whole.items.map(item=>({...item,path:raw+'/'+item.path}))
  const partialTrees=whole.items.filter(item=>item.type==='tree').length,partialFiles=whole.items.length-partialTrees
  if(partialFiles>MAX_FILES||partialTrees>=MAX_TREES)throw unavailable(`子目录 ${raw} 的递归列表被 GitHub 截断，已返回的部分就含 ${partialFiles} 个文件、${partialTrees} 个目录，超过 ${MAX_FILES} 文件/${MAX_TREES} 目录的安装上限，不再逐级展开。`)
  const output:TreeItem[]=[],queue=[{sha,raw,ancestors:new Set([...ancestors,sha])}];let expanded=0,files=0
  for(let next=queue.shift();next;next=queue.shift()){
   if(++expanded>MAX_TREES)throw unavailable(`子目录 ${raw} 逐级展开超过 ${MAX_TREES} 棵目录树，已停止。`)
   const tree=await read(next.sha,next.sha,`目录树 ${shown(next.raw)}`)
   for(const item of tree.items){
    if(item.path.includes('/'))throw unavailable(`GitHub 非递归目录树 ${shown(next.raw)} 的条目含路径分隔符：${quoted(item.path)}`)
    const path=next.raw+'/'+item.path
    output.push({...item,path})
    if(isLink(item))throw unavailable(`子目录包含符号链接（${shown(path)}），无法固定。`)
    if(isSubmodule(item))throw unavailable(`子目录包含子模块（${shown(path)}），无法固定。`)
    if(item.type!=='tree'){if(++files>MAX_FILES)throw unavailable(`子目录 ${raw} 超过 ${MAX_FILES} 个文件，已停止展开。`);continue}
    if(!isDirectory(item))throw unavailable(`GitHub 子目录 ${shown(path)} 声明为树但模式或 sha 非法。`)
    if(next.ancestors.has(item.sha))throw unavailable(`GitHub 子目录 ${shown(path)} 的树 sha 与其祖先重复（环路），已停止。`)
    queue.push({sha:item.sha,raw:path,ancestors:new Set([...next.ancestors,item.sha])})
   }
  }
  return output
 }
 return {read,walk,list}
}
/**
 * 子目录模式：从固定提交根树非递归下降到目标，不读整仓递归树；普通导入再列出目标子树，已审目录只读声明文件的祖先树，
 * 并可补充声明的祖先许可文件。逐个从 raw 主机按提交读取，
 * 用 Git blob 摘要核对字节。子目录快照摘要取 [path,blob,size] 序列，代替整仓归档摘要。
 * 普通导入先读 commit 对象取根树 sha，再按根树 sha（而不是 commit）请求根树并核对回包 sha（+1 次 ≈1 KB 请求，树请求数不变）：
 * GitHub `GET /git/trees/{commit}` 的回包 sha 是请求时传入的 commit，按 commit 请求根本核不了根树。已审路径由目录钉住每个 blob，不为此多发请求，根树仍按 commit 请求、只验格式。
 */
async function downloadSubtree(http:GithubHttpPort,spec:RequestSpec&{path:string},commit:string,selection?:ReadonlyMap<string,MarketCatalogUpstreamGithub['files'][number]>):Promise<{archiveHash:string;files:GithubSourceFile[]}>{
 // 整次下载（commit 对象 + 树 + raw）限时 120 秒、raw 4 路并发：上游慢或内容多时尽快失败，不长时间占着数据库连接与请求锁。
 const deadline=Date.now()+SUBTREE_DEADLINE_MS,trees=gitTreeReader(http,spec,deadline),tree:TreeItem[]=[]
 const rootTree=selection?undefined:await commitTree(http,spec,commit,10000)
 const root=await trees.read(rootTree??commit,rootTree,`根树（commit ${commit.slice(0,12)}）`)
 const hint=(similar:string|undefined)=>similar===undefined?'':`；仓库中有大小写或 Unicode 规范化不同的 ${similar}，路径区分大小写，请按仓库实际名称填写`
 if(selection){
  for(const repositoryPath of selection.keys()){
   const found=await trees.walk(root,repositoryPath)
   if('missing' in found)throw unavailable(`GitHub 固定提交缺少目录声明的文件：${repositoryPath}（${found.missing} 不存在${hint(found.similar)}）。`)
   if('notDirectory' in found)throw unavailable(`GitHub 路径 ${found.notDirectory} 不是普通目录树（${describe(found.item)}），无法继续下降。`)
   tree.push({...found.item,path:found.raw})
  }
 }else{
  const found=await trees.walk(root,spec.path)
  if('missing' in found)throw invalid(`固定提交中不存在目录 ${spec.path}：${found.missing} 不存在${hint(found.similar)}。`)
  // 目标或其某一级祖先是文件/链接/子模块/未知类型：请求的路径本身不成立，按输入错误定位（声明为树却损坏已在 walk 里按 unavailable 拒绝）。
  if('notDirectory' in found)throw invalid(`${found.notDirectory} 不是目录（${describe(found.item)}），无法按子目录导入 ${spec.path}。`)
  if(!isDirectory(found.item))throw invalid(`${spec.path} 不是目录（${describe(found.item)}），无法按子目录导入。`)
  if(found.ancestors.has(found.item.sha))throw unavailable(`GitHub 子目录 ${spec.path} 的树 sha 与其祖先重复（环路），已停止。`)
  tree.push(...await trees.list(found.item.sha,found.raw,found.ancestors))
 }
 const prefix=spec.path+'/',entries:{path:string;raw:string;sha:string;size:number;sha256?:string}[]=[],folded=new Set<string>(),matched=new Set<string>();let total=0
 for(const item of tree){
  // 树里的路径可能是 NFD；比对前按请求同样做 NFC，请求上游时仍用树里的原始路径。
  const repositoryPath=item.path.normalize('NFC'),expected=selection?.get(repositoryPath)
  // 目录添加只读已审查的普通文件；未声明的脚本、链接等不下载，也不进入内容仓。
  if(selection?!expected:!repositoryPath.startsWith(prefix))continue
  if(item.type==='tree')continue
  const name=shown(repositoryPath)
  if(isSubmodule(item))throw unavailable(`子目录包含子模块（${name}），无法固定。`)
  if(isLink(item))throw unavailable(`子目录包含符号链接（${name}），无法固定。`)
  if(item.type!=='blob'||(item.mode!=='100644'&&item.mode!=='100755')||typeof item.sha!=='string'||!COMMIT.test(item.sha)||!Number.isSafeInteger(item.size)||(item.size as number)<0)throw unavailable(`GitHub 目录树条目格式无效（需 blob、100644/100755、40 位 sha、非负整数 size）：${name}`)
  if(expected&&(item.mode!=='100644'||item.sha!==expected.gitBlob||expected.size!==null&&item.size!==expected.size))throw unavailable(`GitHub 文件 ${name} 与已审查目录清单不一致（模式 ${String(item.mode).slice(0,8)}、blob ${String(item.sha).slice(0,12)}、大小 ${String(item.size).slice(0,20)}）。`)
  if((item.size as number)>MAX_FILE_BYTES)throw unavailable(`子目录中文件 ${name} 为 ${String(item.size)} 字节，超过 2 MiB。`)
  const path=finalPath('root/'+(expected?prefix+expected.path:item.path),'root'),fold=path.toLocaleLowerCase('en-US')
  if(folded.has(fold))throw unavailable(`子目录包含重复或大小写冲突路径：${shown(path)}`)
  folded.add(fold);total+=item.size as number
  if(entries.length>=MAX_FILES||total>MAX_ARCHIVE_BYTES)throw unavailable(`子目录 ${spec.path} 超过 ${MAX_FILES} 个文件或 20 MiB（已计 ${entries.length} 个文件、${total} 字节）。`)
  entries.push({path,raw:item.path,sha:item.sha,size:item.size as number,...(expected?{sha256:expected.sha256}:{})});matched.add(repositoryPath)
 }
 if(selection&&entries.length!==selection.size)throw unavailable(`GitHub 固定提交缺少目录声明的文件：${[...selection.keys()].filter(key=>!matched.has(key)).join('、')}`)
 if(!entries.length)throw invalid(`子目录 ${spec.path} 在固定提交中没有可安装的普通文件。`)
 const files:GithubSourceFile[]=[],queue=[...entries]
 let failed=false
 const worker=async()=>{
  try{for(let entry=failed?undefined:queue.shift();entry;entry=failed?undefined:queue.shift()){
   const remaining=deadline-Date.now()
   if(remaining<=0)throw unavailable('子目录下载超过 120 秒，已停止；请缩小子目录后重试。')
   const bytes=await requestBytes(http,`https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${commit}/${entry.raw.split('/').map(encodeURIComponent).join('/')}`,'raw.githubusercontent.com',MAX_FILE_BYTES,'application/octet-stream',Math.min(15000,remaining),`文件 ${shown(entry.raw)}`)
   if(Date.now()>=deadline)throw unavailable('子目录下载超过 120 秒，已停止；请缩小子目录后重试。')
   if(bytes.byteLength!==entry.size||gitBlob(bytes)!==entry.sha)throw unavailable(`上游文件 ${shown(entry.raw)} 与固定提交不一致（大小 ${bytes.byteLength}/${entry.size}）。`)
   const hash=sha(bytes)
   // 已审目录：git blob 只作定位，最终按目录钉的 sha256 逐文件核对
   if(entry.sha256!==undefined&&hash!==entry.sha256)throw unavailable(`上游文件 ${shown(entry.raw)} 的 sha256 与已审查目录清单不一致。`)
   files.push({path:entry.path,hash,bytes})
  }}catch(error){failed=true;queue.length=0;throw error}
 }
 await Promise.all(Array.from({length:Math.min(SUBTREE_CONCURRENCY,entries.length)},worker))
 files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0)
 return {archiveHash:sha(stable(entries.map(entry=>[entry.path,entry.sha,entry.size]))),files}
}

/** 目录上游添加的薄适配：复用固定子目录读取，只读取审核清单，不创建另一套来源存储或下载器。 */
export async function downloadGithubCatalogSkill(source:MarketCatalogUpstreamGithub,http:GithubHttpPort):Promise<{path:string;bytes:Uint8Array}[]>{
 if(source.kind!=='github'||source.repository.host!=='github.com'||!COMMIT.test(source.commit))throw invalid('目录 GitHub 来源必须固定到 github.com 的完整提交。')
 const spec=normalize({requestId:'00000000-0000-4000-8000-000000000000',owner:source.repository.owner,repo:source.repository.repo,ref:source.commit,path:source.path})
 if(!Array.isArray(source.files)||source.files.length<1||source.files.length>MAX_FILES)throw invalid('目录 GitHub 文件数量不正确。')
 const selection=new Map<string,MarketCatalogUpstreamGithub['files'][number]>(),folded=new Set<string>(),sourceFolded=new Set<string>();let total=0
 for(const file of source.files){
  const path=finalPath('root/'+file.path,'root'),parts=path.split('/'),fold=path.toLocaleLowerCase('en-US')
  if(parts.some(part=>part.startsWith('.'))||parts.slice(0,-1).includes('scripts')||MARKET_CATALOG_FORBIDDEN_EXTENSIONS.test(path))throw invalid('目录 GitHub 文件包含禁止安装的路径。')
  const repositoryPath=marketCatalogGithubFileRepositoryPath(spec.path!,file).normalize('NFC'),sourceFold=repositoryPath.toLocaleLowerCase('en-US')
  if(sourceFolded.has(sourceFold)||folded.has(fold)||!COMMIT.test(file.gitBlob)||typeof file.sha256!=='string'||!/^[0-9a-f]{64}$/.test(file.sha256)||file.size!==null&&(!Number.isSafeInteger(file.size)||file.size<0||file.size>MAX_FILE_BYTES))throw invalid('目录 GitHub 文件声明无效或重复。')
  total+=file.size??0;selection.set(repositoryPath,{...file,path});folded.add(fold);sourceFolded.add(sourceFold)
 }
 if(total>MAX_ARCHIVE_BYTES||!source.files.some(file=>file.path==='SKILL.md'&&file.repositoryPath===undefined))throw invalid('目录 GitHub 文件超限或缺少 SKILL.md。')
 const result=await downloadSubtree(http,{...spec,path:spec.path!},source.commit,selection)
 return result.files.map(file=>({path:file.path.slice(spec.path!.length+1),bytes:file.bytes}))
}

function treeHash(files:GithubSourceFile[]):string{return sha(stable(files.map(file=>[file.path,file.hash,file.bytes.byteLength])))}
function sourceTrust(spec:RequestSpec):MarketSourceTrust{return {publisher:spec.owner,repository:{host:'github.com',owner:spec.owner,repo:spec.repo},license:{status:'missing'},signature:{status:'unverified',signer:null},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'GitHub 归档已固定，许可证、签名和宿主兼容性尚未核对'}}}
function readyHash(requestId:string,ownerId:string,spec:RequestSpec,commit:string,archiveHash:string,tree:string):string{return sha(stable([requestId,ownerId,spec,'ready',commit,archiveHash,tree]))}

export async function initializeGithubSources(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_github_source_requests(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  stage text not null check(stage in ('resolving','downloading','ready')),resolved_commit text,archive_hash text,tree_hash text,record_hash text,
  created_at timestamptz not null,updated_at timestamptz not null,primary key(owner_id,request_id),
  check((stage='resolving' and resolved_commit is null and archive_hash is null and tree_hash is null and record_hash is null)
     or (stage='downloading' and resolved_commit ~ '^[0-9a-f]{40}$' and archive_hash is null and tree_hash is null and record_hash is null)
     or (stage='ready' and resolved_commit ~ '^[0-9a-f]{40}$' and archive_hash ~ '^[0-9a-f]{64}$' and tree_hash ~ '^[0-9a-f]{64}$' and record_hash ~ '^[0-9a-f]{64}$'))
 );
 create table if not exists teloa_github_source_files(
  owner_id text not null,request_id uuid not null,path text not null,file_hash text not null check(file_hash ~ '^[0-9a-f]{64}$'),bytes bytea not null,
  primary key(owner_id,request_id,path),foreign key(owner_id,request_id) references teloa_github_source_requests(owner_id,request_id)
 );
 `)}

export class GithubSourceService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly http:GithubHttpPort
 constructor(pool:Pool,identity:{now:()=>string},http:GithubHttpPort){this.pool=pool;this.identity=identity;this.http=http}
 private async readReady(db:PoolClient,row:StoredRequest,spec:RequestSpec):Promise<GithubSourceReceipt>{
  if(row.stage!=='ready'||!uuid(row.request_id)||typeof row.owner_id!=='string'||!COMMIT.test(String(row.resolved_commit))||!hex(row.archive_hash)||!hex(row.tree_hash)||!hex(row.record_hash))throw corrupt()
  const rows=(await db.query('select path,file_hash,bytes from teloa_github_source_files where owner_id=$1 and request_id=$2 order by path',[row.owner_id,row.request_id])).rows,files:GithubSourceFile[]=[]
  if(rows.length<1||rows.length>MAX_FILES)throw corrupt();let total=0
  for(const item of rows){if(typeof item.path!=='string'||!hex(item.file_hash)||!(item.bytes instanceof Uint8Array))throw corrupt();let path:string;try{path=finalPath('root/'+item.path,'root')}catch{throw corrupt()}const copy=Uint8Array.from(item.bytes);total+=copy.byteLength;if(copy.byteLength>MAX_FILE_BYTES||total>MAX_ARCHIVE_BYTES||sha(copy)!==item.file_hash)throw corrupt();files.push({path,hash:item.file_hash,bytes:copy})}
  const tree=treeHash(files);if(tree!==row.tree_hash||readyHash(row.request_id,row.owner_id,spec,row.resolved_commit as string,row.archive_hash,tree)!==row.record_hash)throw corrupt()
  return {requestId:row.request_id,ownerId:row.owner_id,stage:'ready',provenance:{kind:'github',owner:spec.owner,repo:spec.repo,requestedRef:spec.ref,resolvedCommit:row.resolved_commit as string,archiveHash:row.archive_hash,...(spec.path===undefined?{}:{path:spec.path})},trust:sourceTrust(spec),files,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
 }
 /** 只读取已固定就绪的来源；沿用与 resolve 相同的完整性校验，不触发任何网络请求。 */
 async read(ownerValue:unknown,inputValue:unknown):Promise<GithubSourceReceipt>{
  const ownerId=ownerIdentity(ownerValue),input=exact(inputValue,['requestId'])
  if(!uuid(input.requestId))throw invalid('GitHub 来源请求 ID 必须是 UUID。')
  let db:PoolClient
  try{db=await this.pool.connect()}catch{throw new WorkError('teloa/storage-unavailable','GitHub 来源存储当前不可用。')}
  try{
   const row=(await db.query('select * from teloa_github_source_requests where owner_id=$1 and request_id=$2',[ownerId,input.requestId.toLowerCase()])).rows[0] as StoredRequest|undefined
   if(!row||row.stage!=='ready')throw unavailable('GitHub 固定来源不存在或尚未就绪。')
   return await this.readReady(db,row,storedSpec(row.request_spec))
  }catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','GitHub 来源存储操作未完成。')}
  finally{db.release()}
 }
 async resolve(ownerValue:unknown,inputValue:unknown):Promise<GithubSourceReceipt>{
  const ownerId=ownerIdentity(ownerValue),input=normalize(inputValue),spec:RequestSpec={owner:input.owner,repo:input.repo,ref:input.ref,...(input.path===undefined?{}:{path:input.path})},at=this.identity.now();if(!Number.isFinite(Date.parse(at)))throw invalid('GitHub 来源时间无效。')
  let db:PoolClient
  try{db=await this.pool.connect()}catch{throw new WorkError('teloa/storage-unavailable','GitHub 来源存储当前不可用。')}
  const lock=stable(['github-source',ownerId,input.requestId]);let locked=false
  try{
   await db.query('select pg_advisory_lock(hashtextextended($1,0))',[lock]);locked=true
   let row=(await db.query('select * from teloa_github_source_requests where owner_id=$1 and request_id=$2',[ownerId,input.requestId])).rows[0] as StoredRequest|undefined
   if(!row){row=(await db.query("insert into teloa_github_source_requests(owner_id,request_id,request_spec,stage,created_at,updated_at) values($1,$2,$3,'resolving',$4,$4) returning *",[ownerId,input.requestId,JSON.stringify(spec),at])).rows[0] as StoredRequest}
   const fixedSpec=storedSpec(row.request_spec);if(stable(fixedSpec)!==stable(spec))throw new WorkError('teloa/conflict','同一 GitHub 来源请求不能更换 owner、repo 或 ref。')
   if(row.stage==='ready')return await this.readReady(db,row,fixedSpec)
   if(row.stage==='resolving'){
    if(row.resolved_commit!==null||row.archive_hash!==null||row.tree_hash!==null||row.record_hash!==null)throw corrupt()
    const commit=await resolveCommit(this.http,fixedSpec)
    row=(await db.query("update teloa_github_source_requests set stage='downloading',resolved_commit=$3,updated_at=$4 where owner_id=$1 and request_id=$2 and stage='resolving' returning *",[ownerId,input.requestId,commit,this.identity.now()])).rows[0] as StoredRequest|undefined;if(!row)throw corrupt()
   }
   if(row.stage!=='downloading'||!COMMIT.test(String(row.resolved_commit))||row.archive_hash!==null||row.tree_hash!==null||row.record_hash!==null)throw corrupt()
   const fetched=fixedSpec.path!==undefined?await downloadSubtree(this.http,{...fixedSpec,path:fixedSpec.path},row.resolved_commit as string):await (async()=>{const archive=await requestBytes(this.http,`https://codeload.github.com/${fixedSpec.owner}/${fixedSpec.repo}/zip/${row.resolved_commit}`,'codeload.github.com',MAX_ARCHIVE_BYTES,'application/zip, application/octet-stream;q=0.9',30000,`整仓归档 ${String(row.resolved_commit).slice(0,12)}`);return {archiveHash:sha(archive),files:extractZip(archive)}})()
   const {archiveHash,files}=fetched,tree=treeHash(files),updated=this.identity.now(),record=readyHash(input.requestId,ownerId,fixedSpec,row.resolved_commit as string,archiveHash,tree)
   if(!Number.isFinite(Date.parse(updated)))throw invalid('GitHub 来源时间无效。')
   await db.query('begin')
   try{for(const file of files)await db.query('insert into teloa_github_source_files(owner_id,request_id,path,file_hash,bytes) values($1,$2,$3,$4,$5)',[ownerId,input.requestId,file.path,file.hash,Buffer.from(file.bytes)]);row=(await db.query("update teloa_github_source_requests set stage='ready',archive_hash=$3,tree_hash=$4,record_hash=$5,updated_at=$6 where owner_id=$1 and request_id=$2 and stage='downloading' and resolved_commit=$7 returning *",[ownerId,input.requestId,archiveHash,tree,record,updated,row.resolved_commit])).rows[0] as StoredRequest|undefined;if(!row)throw corrupt();await db.query('commit')}catch(error){await db.query('rollback').catch(()=>{});throw error}
   return await this.readReady(db,row,fixedSpec)
  }catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','GitHub 来源存储操作未完成。')}
  finally{if(locked)await db.query('select pg_advisory_unlock(hashtextextended($1,0))',[lock]).catch(()=>{});db.release()}
 }
}
