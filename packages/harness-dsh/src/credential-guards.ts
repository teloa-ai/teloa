import type {Context} from '@deepseek-ai/cordis'
import type {PostToolDecision,PreToolDecision,ToolExecutionResult} from '@deepseek-ai/dsh-tools'
import type {ContentBlock} from '@deepseek-ai/dsh-llm'
import {existsSync,readdirSync,realpathSync,statSync} from 'node:fs'
import {homedir} from 'node:os'
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {detectSecrets,encodedForms,redactSecrets} from '@teloa/contract'

/**
 * 凭据读取面的守卫与脱敏（规格 §4）。启发式抬门槛，不是安全边界：单条管道「读取即外发」、
 * 自定义编码与拼接都能绕过，残余写入发布说明。拒绝理由固定，不回显路径与值。
 */
const denial='该操作会读取或外发本机保存的密钥，已拒绝。密钥只能在设置页管理。'
// 不区分大小写：macOS APFS 与 Windows NTFS 默认不区分大小写，`.CREDENTIALS.ENC` 读到的是同一个文件。
const markers=/\.credentials\.|credential-keys|teloa-credentials|teloa-secrets|mcp\/credentials|密钥\//i
// ln：造一条指向受保护祖先的链接，之后 `find -L`/`grep -R` 就能跟进去；cp -a、ditto 等保留链接或整树复制同理。
// 命令名前允许 `/`（`/usr/bin/tar`），并认 g/bsd 前缀变体（`bsdtar`、`gtar`、`gfind`）；xargs 把上游输出当路径读。
const recursiveCommand=/(?:^|[\s;&|(/])(?:g|bsd)?(?:find|rg|tar|zip|rsync|du|ln|ditto|cpio|pax|7z|xargs)\b|\bgrep\s+-[a-zA-Z]*[rR]|\bcp\s+-[a-zA-Z]*[rRa]|\bscp\s+-[a-zA-Z]*r|\bls\s+-[a-zA-Z]*R/
const recursiveTool=/grep|search|glob|find/i
const commandRules=[
 /\bsecurity\s+(?:find|dump|export)-|\bsecret-tool\b|\bcmdkey\b|\bkwallet-query\b/i,
 /\/proc\b[^\n]*\benviron\b/,
 /\bps\s+(?:[^|;&\n]*\s)?(?:e[a-z]*|-[a-zA-Z]*E[a-zA-Z]*)(?:\s|$)/,
 // BSD 式首参带 e（`ps auxe`、`ps axe`）显示环境；`-e`（Linux 的全部进程）不算。
 /\bps\s+[a-df-zA-Z]*e[a-zA-Z]*(?:\s|$)/,
 /\b(?:gdb|lldb|dtrace|dtruss)\b[^|;&\n]*\s(?:-p|--pid|attach)\b/,
 /\b(?:base64\s+(?:-d|-D|--decode)|xxd\s+-r|openssl\s+(?:enc|base64)\b[^|]*\s-d)\b[^\n]*\|\s*(?:ba|z|da)?sh\b/,
 /\beval\s+["']?\$\(/,
]
const caseInsensitive=process.platform==='darwin'||process.platform==='win32'
/** 比较前统一成 NFC，不区分大小写的平台再转小写（不存在的尾段 realpath 规范化不到）。 */
const fold=(path:string)=>{const nfc=path.normalize('NFC');return caseInsensitive?nfc.toLowerCase():nfc}
const inside=(child:string,parent:string)=>{const path=relative(fold(parent),fold(child));return path===''||(!path.startsWith('..')&&!isAbsolute(path))}
/** 不存在的路径取最近存在祖先的 realpath 再拼回剩余部分，符号链接一律按真实位置判定。 */
function canonicalPath(path:string):string{
 let current=resolve(path),rest=''
 while(!existsSync(current)){const parent=dirname(current);if(parent===current)return resolve(path);rest=join(basename(current),rest);current=parent}
 // native 版返回磁盘上的真实大小写与 NFC 形式（JS 版按字面返回，`.ENV` 会与 `.env` 失配）。
 try{return join(realpathSync.native(current),rest)}catch{return resolve(path)}
}
/**
 * 受保护集合（关键决定 8）：凭据文件、主密钥、密钥挂载、数据库口令文件、受管 MCP 旧凭据目录，以及含这些文件副本的备份目录。
 * 不含整个 DSH_HOME：`$DSH_HOME/skills` 等合法读取照常；`.credentials.*.bak-*` 这类同目录副本由文件名标记词拦截。
 */
export function protectedRootsFor(input:{providerPaths:readonly string[];runtimeRoot:string;projectRoot?:string;env:Readonly<Record<string,string|undefined>>}):string[]{
 const roots=[...input.providerPaths,join(input.runtimeRoot,'database.json'),join(input.runtimeRoot,'postgres.env'),join(input.runtimeRoot,'mcp','credentials'),join(input.runtimeRoot,'backups'),'/run/secrets','/run/teloa-secrets','/run/teloa-credentials']
 for(const [name,value] of Object.entries(input.env))if((/_FILE$/.test(name)||name==='CREDENTIALS_DIRECTORY')&&value&&isAbsolute(value))roots.push(value)
 if(input.projectRoot){
  roots.push(join(input.projectRoot,'密钥'))
  try{for(const name of readdirSync(input.projectRoot))if(name.startsWith('.runtime-upgrade-backup-'))roots.push(join(input.projectRoot,name))}catch{/* 目录不可读时只守已知路径 */}
 }
 return [...new Set(roots.map(canonicalPath))]
}
function strings(value:unknown,out:string[]=[]):string[]{
 if(typeof value==='string')out.push(value)
 else if(Array.isArray(value))for(const item of value)strings(item,out)
 else if(value&&typeof value==='object')for(const item of Object.values(value))strings(item,out)
 return out
}
/** `~+` 与 `$PWD` 按当前解析基准展开（会话 shell 的 PWD 是会话 cwd，不是宿主进程的 PWD）。 */
function expand(token:string,env:Readonly<Record<string,string|undefined>>,home:string,cwd:string):string{
 return token.replace(/^~\+(?=\/|$)/,cwd).replace(/^~(?=\/|$)/,home).replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g,(whole,name:string)=>name==='HOME'?home:name==='PWD'?cwd:env[name]??whole)
}
/** 花括号展开（逐层，最多 64 个分支）：`$DSH_HOME/{.env,}`、`{$DSH_HOME,/x}/.env`。 */
function braces(word:string,limit={left:64}):string[]{
 const match=/^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/s.exec(word)
 if(!match||limit.left<=0)return [word]
 return match[2]!.split(',').flatMap(alt=>{limit.left--;return braces(match[1]+alt+match[3],limit)})
}
const braceExpanded=(text:string)=>text.split(/(\s+)/).map(word=>/\s/.test(word)?word:braces(word).join(' ')).join('')
/**
 * 路径词元：带 `/`、以 `.`/`~`/`$` 开头、带通配符（`* ? [`；花括号另行展开，见 braces），或按会话 cwd 解析后真实存在（覆盖 `teloa_group_attach({path:'报告.md'})`
 * 这类不带斜杠、实为改名链接的参数）。单行参数整体也作为一个候选（路径里可能有空格）。
 */
function pathCandidates(text:string,bases:readonly string[]):string[]{
 // `curl -d @file`、`-F f=@file` 与 `file://…` 去掉前缀后按路径判定
 const raw=text.split(/[\s"'`=;|&()<>,]+/).filter(Boolean).flatMap(token=>{const bare=token.replace(/^(?:-[a-zA-Z]+)?@/,'').replace(/^file:\/\//i,'');return bare&&bare!==token?[token,bare]:[token]})
 if(!text.includes('\n')&&text.trim()&&!raw.includes(text.trim()))raw.push(text.trim())
 return [...new Set(raw)].filter(token=>token.includes('/')||/^[.~$]/.test(token)||/[*?[]/.test(token)||bases.some(base=>existsSync(resolve(base,token))))
}
/** 通配词元的静态前缀所在目录逐项取真实路径（只展开一层）：`cat *`、`head ./c*` 里的改名链接也按真实位置判定。 */
function globHits(head:string,cwd:string,roots:readonly string[]):boolean{
 const slash=head.lastIndexOf('/'),dir=slash===-1?'.':head.slice(0,slash+1),prefix=head.slice(slash+1)
 let names:string[]
 try{names=readdirSync(resolve(cwd,dir))}catch{return false}
 return names.some(name=>{if(!name.startsWith(prefix))return false;const entry=canonicalPath(resolve(cwd,dir,name));return roots.some(root=>inside(entry,root)||inside(root,entry))})
}
/** 去引号与反斜杠转义后的写法：`"$DSH_HOME"/.env`、`.e""nv`、`.e\\nv`、`$"…"` 在 shell 里都拼回原路径。 */
const unquoted=(text:string)=>text.replace(/\$(["'])/g,'$1').replace(/\\([\s\S])/g,'$1').replace(/["']/g,'')
/**
 * 相对路径的解析基准：会话 cwd，加上同一命令串里 `cd`/`pushd` 依次切到的目录（`&&`、`;`、`|` 链与连续 cd）。
 * 只认字面目标；变量间接、`$()` 与子 shell 里的 cd 属于残余（规格 §4）。
 */
function bases(text:string,input:{cwd:string;env:Readonly<Record<string,string|undefined>>;home:string}):string[]{
 const out=[input.cwd]
 let current=input.cwd
 for(const match of text.matchAll(/(?:^|[\n;&|(])\s*(?:cd|pushd)\s+([^\s;&|)]+)/g)){current=resolve(current,expand(match[1]!,input.env,input.home,current));out.push(current)}
 return [...new Set(out)]
}
/**
 * 兜底（宁可误拒）：路径写法无法穷举（变量间接、`$()`、解释器内拼接……），命令串去引号后只要出现受保护文件的文件名
 * （不区分大小写，按路径分隔边界匹配），且带读取、复制、打包、网络或解释器类程序，一律拒绝。
 * 受保护文件名取自受保护集合里的文件（已存在的普通文件，或不存在但文件名带点的项；目录不参与）。
 */
const readerProgram=/(?:^|[\s;&|(/`])(?:cat|tac|less|more|head|tail|nl|wc|cp|mv|install|scp|sftp|rsync|(?:g|bsd)?tar|zip|7z|curl|wget|nc|ncat|socat|base64|xxd|od|hexdump|strings|[efz]?grep|rg|ag|awk|gawk|sed|g?find|xargs|python[\d.]*|node|deno|bun|perl|ruby|php|lua|bash|sh|zsh|dash|fish|openssl|gpg|dd|tee|diff|cmp|vi|vim|nvim|nano|emacs|ed|open|pbcopy|xclip|ditto|cpio|pax|ln|sort|uniq|cut|tr|jq|yq|source|paste|split|zcat|gzip|bzip2|xz|iconv|read|mapfile|readarray|rev|fold|column|pr|comm|join|sqlite3|look|shuf|ex|view)\b/
/** shell 自身的读文件语法：`< file`、`$(<file)`（不含 heredoc `<<`、进程替换 `<(`、`<&`），以及 `.` 形式的 source。 */
const readSyntax=/(?<![<>])<(?![<(&])\s*["']?\S|(?:^|[\s;&|(])\.\s+\S/
const escapeRegex=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
/** 受保护文件名集合与其匹配式；尾边界含通配符（`.env*`、`.env?`）。 */
function protectedNames(roots:readonly string[]):{list:string[];pattern:RegExp}|undefined{
 const list=[...new Set(roots.filter(root=>{try{return statSync(root).isFile()}catch{return basename(root).includes('.')}}).map(root=>basename(root).toLowerCase()))]
 return list.length?{list,pattern:new RegExp(`(?:^|[\\s/"'=@:(,<>|;&])(?:${list.map(escapeRegex).join('|')})(?=$|[\\s"'\`;|&)<>,*?[])`,'i')}:undefined
}
/**
 * 带通配的词元取最后一段转成正则，能匹配受保护文件名即算命中（`.en[v]`、`.en?`、`.e*v`、`database.js*`）。
 * 字面字符少于 2 个的通配（`*`、`?*`）不参与，否则 `cat *` 这类普通写法全被兜底误拒。
 */
function globNamesHit(text:string,list:readonly string[]):boolean{
 for(const token of text.split(/[\s"'`=;|&()<>,]+/)){
  if(!/[*?[]/.test(token))continue
  const last=token.slice(token.lastIndexOf('/')+1)
  if(last.replace(/\[[^\]]*\]|[*?]/g,'').length<2)continue
  let source=''
  for(let index=0;index<last.length;index++){
   const char=last[index]!
   if(char==='*')source+='[^/]*'
   else if(char==='?')source+='[^/]'
   else if(char==='['){const end=last.indexOf(']',index+1);if(end===-1){source+='\\[';continue}source+='['+last.slice(index+1,end).replace(/^!/,'^').replace(/\\/g,'\\\\')+']';index=end}
   else source+=escapeRegex(char)
  }
  let pattern:RegExp
  try{pattern=new RegExp(`^${source}$`,'i')}catch{continue}
  if(list.some(name=>pattern.test(name)))return true
 }
 return false
}
export function guardDecision(args:unknown,input:{toolName:string;cwd:string;roots:readonly string[];known:readonly string[];env:Readonly<Record<string,string|undefined>>;home:string}):string|undefined{
 const texts=strings(args)
 if(input.known.length){const forms=input.known.flatMap(encodedForms);if(texts.some(text=>detectSecrets(text,forms).some(item=>item.kind==='stored')))return denial}
 const names=protectedNames(input.roots)
 for(const text of new Set(texts.flatMap(text=>{const bare=unquoted(text);return [text,bare,braceExpanded(text),braceExpanded(bare)]}))){
  if(markers.test(text)||commandRules.some(rule=>rule.test(text)))return denial
  if(names&&(names.pattern.test(text)||globNamesHit(text,names.list))&&(readerProgram.test(text)||readSyntax.test(text)))return denial
  const recursive=recursiveCommand.test(text)||recursiveTool.test(input.toolName),from=bases(text,input)
  for(const raw of pathCandidates(text,from)){
   for(const base of from){
    const token=expand(raw,input.env,input.home,base),globAt=token.search(/[*?[]/),head=globAt===-1?token:token.slice(0,globAt)
    const target=canonicalPath(resolve(base,head||'.'))
    if(input.roots.some(root=>inside(target,root)))return denial
    if((globAt!==-1||recursive)&&input.roots.some(root=>inside(root,target)))return denial
    if(globAt!==-1&&globHits(head,base,input.roots))return denial
   }
  }
 }
 return undefined
}
export function redactContent(blocks:readonly ContentBlock[],known:readonly string[]):ContentBlock[]{
 return blocks.map(block=>block.type==='text'?{...block,text:redactSecrets(block.text,known)}:block)
}
const changed=(before:readonly ContentBlock[],after:readonly ContentBlock[])=>before.some((block,index)=>block.type==='text'&&after[index]?.type==='text'&&block.text!==(after[index] as {text:string}).text)
/** 返回替换后的决定；未命中返回 undefined，由调用方原样放行。 */
export function redactToolDecision(result:Readonly<ToolExecutionResult>|{isError:boolean;content:readonly ContentBlock[];error?:{message:string}},decision:PostToolDecision,known:readonly string[]):PostToolDecision|undefined{
 const extra=decision.additionalContexts?{additionalContexts:decision.additionalContexts}:{}
 if(decision.kind==='block'){const feedback=redactContent(decision.feedback,known);return changed(decision.feedback,feedback)?{...decision,feedback}:undefined}
 if('value' in decision&&decision.value!==undefined){const text=JSON.stringify(decision.value),safe=redactSecrets(text,known);return safe===text?undefined:{kind:'accept',content:[{type:'text',text:safe}],...extra}}
 const base=decision.content??result.content,content=redactContent(base,known)
 if(result.isError){
  const message=result.error?.message??'',safeMessage=redactSecrets(message,known)
  if(!changed(base,content)&&safeMessage===message)return undefined
  return {kind:'block',feedback:content.length?content:[{type:'text',text:safeMessage}],...extra}
 }
 return changed(base,content)?{kind:'accept',content,...extra}:undefined
}
export function registerCredentialGuards(ctx:Context,input:{roots:()=>readonly string[];known:()=>readonly string[]}):void{
 const home=homedir()
 ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  const reason=guardDecision(exec.arguments,{toolName:exec.name,cwd:exec.agent?.session.header.cwd??process.cwd(),roots:input.roots(),known:input.known(),env:process.env,home})
  return reason?{kind:'deny',reason}:next()
 },{prepend:true})
 // prepend：作为最外层包住其他 post-execute 监听器，脱敏作用在最终决定上。
 ctx.on('tools/post-execute',async(_exec,result,next):Promise<PostToolDecision>=>{
  const decision=await next()
  return redactToolDecision(result,decision,input.known())??decision
 },{prepend:true})
 ctx.on('tools/ptc-dispatch-log',async(_dispatch,next)=>redactContent(await next(),input.known()))
}
export function redactRunMessage<T>(input:T,known:()=>readonly string[]):T{
 if(!input||typeof input!=='object'||typeof (input as {text?:unknown}).text!=='string')return input
 return {...input,text:redactSecrets((input as unknown as {text:string}).text,known())}
}
