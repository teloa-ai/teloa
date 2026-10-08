import {createHash} from 'node:crypto'
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises'
import {createRequire,registerHooks} from 'node:module'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

// 通用机制来自桌面核心兼容流程：固定官方来源、完整上下文 apply、精确前后摘要。
// 社区只创建私有完整包副本；绝不改安装图里的 pnpm store/hardlink 或用户插件。
const version='0.2.1-alpha.1',upstream='5badb15009ae1756c3afe0ae0cef1faafc290ccc'
const specs=[
 ['session','append-admission','dsh-session'],['session-controller','input-admission','dsh-api-session-controller'],
 ['subagent','prompt-admission','dsh-subagent'],['subagent-in-process-driver','input-admission','dsh-subagent-in-process-driver'],
 ['agent-loop','work-admission','dsh-agent-loop'],['agent','announcement-abort','dsh-agent'],
 ['session-persistence','open-admission','dsh-session-persistence'],['session-persistence-jsonl','open-admission','dsh-session-persistence-jsonl'],
 ['llm','stream-admission','dsh-llm'],['tools','work-admission','dsh-tools'],
 ['compaction-basic','summary-request','dsh-compaction-basic'],['goal-round-driver','input-admission','dsh-goal-round-driver'],
].map(([part,patch,name])=>({name:'@deepseek-ai/'+name,basename:'dsh-'+part+'-'+version+'-'+patch}))
export const nativeRuntimeCompatibilityFiles=Object.freeze(specs.flatMap(spec=>[spec.basename+'.json',spec.basename+'.patch']))
const hash=value=>createHash('sha256').update(value).digest('hex'),sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const exec=promisify(execFile),trusted=new WeakMap();let installed
const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&!isAbsolute(rel)&&rel.split(sep)[0]!=='..'}
const refuse=reason=>Error('原生运行图核对失败，拒绝启动：'+reason)
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
async function privateDirectory(path){
 await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path)
 if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||await realpath(path)!==path)throw refuse('运行副本目录的类型或权限不正确。')
}
async function sourceFiles(root){
 const files=[]
 async function visit(directory){for(const name of (await readdir(directory)).sort()){
  if(directory===root&&name==='node_modules')continue
  const path=join(directory,name),info=await lstat(path)
  if(info.isSymbolicLink())throw refuse('官方包内有未经核对的软链。')
  if(info.isDirectory())await visit(path)
  else if(info.isFile())files.push({path:relative(root,path).split(sep).join('/'),sha256:hash(await readFile(path))})
  else throw refuse('官方包文件类型不正确。')
 }}
 await visit(root);return files
}
function manifestValue(bytes,spec){
 const manifest=JSON.parse(bytes),targets=['lib/index.js','lib/types/index.d.ts']
 if(manifest.schema!=='teloa.dsh-compat-patch/v1'||manifest.package!==spec.name||manifest.version!==version||manifest.upstreamCommit!==upstream||!sha(manifest.patchSha256)||!Array.isArray(manifest.api)||manifest.api.some(api=>typeof api!=='string'||!api)||!Array.isArray(manifest.files)||manifest.files.length!==targets.length)throw refuse('固定官方兼容清单版本、来源或能力不一致。')
 const found=new Set()
 for(const row of manifest.files){if(!row||Object.keys(row).sort().join(',')!=='afterSha256,beforeSha256,path'||!targets.includes(row.path)||found.has(row.path)||!sha(row.beforeSha256)||!sha(row.afterSha256)||row.beforeSha256===row.afterSha256)throw refuse('兼容补丁目标不在固定允许清单。');found.add(row.path)}
 return manifest
}
function validatePatch(bytes,manifest){
 if(bytes.length>1024*1024||hash(bytes)!==manifest.patchSha256)throw refuse('兼容补丁摘要不一致。')
 const targets=new Set(manifest.files.map(row=>row.path)),seen=new Set(),lines=bytes.toString('utf8').split('\n');let inHunk=false
 for(let i=0;i<lines.length;i++){
  const line=lines[i]
  if(line.startsWith('--- ')){const path=line.slice(6);if(line!=='--- a/'+path||lines[++i]!=='+++ b/'+path||!targets.has(path)||seen.has(path))throw refuse('兼容补丁目标越界。');seen.add(path);inHunk=false}
  else if(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?:.*)$/.test(line)){if(!seen.size)throw refuse('兼容补丁缺少目标。');inHunk=true}
  else if(!(i===lines.length-1&&line==='')&&!(inHunk&&(/^[ +\-]/.test(line)||line==='\\ No newline at end of file')))throw refuse('兼容补丁格式不正确。')
 }
 if(seen.size!==targets.size)throw refuse('兼容补丁目标不完整。')
}
async function verifyCopy(root,expected){
 const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||await realpath(root)!==root)throw refuse('私有副本类型或权限已变化。')
 const files=await sourceFiles(root);if(JSON.stringify(files)!==JSON.stringify(expected))throw refuse('私有运行副本摘要已变化，保留现场。')
 for(const file of files){const info=await lstat(join(root,file.path));if(info.nlink!==1||info.mode&0o077)throw refuse('私有副本不能是共享硬链接或公开文件。')}
}

/** 固定来源的完整官方包副本；缓存按全部源文件与兼容输入摘要命名，重入逐项核对。 */
export async function prepareNativeRuntime({programRoot,runtimeRoot}){
 if(typeof programRoot!=='string'||typeof runtimeRoot!=='string'||!isAbsolute(programRoot)||!isAbsolute(runtimeRoot))throw refuse('程序与运行目录必须是绝对路径。')
 const program=await realpath(programRoot),runtime=await realpath(runtimeRoot)
 if(runtime!==resolve(runtimeRoot)||runtime===program||inside(runtime,program))throw refuse('运行副本目录不是规范私有目录。')
 await privateDirectory(runtime)
 const require=createRequire(join(program,'package.json')),anchor=await realpath(require.resolve('@deepseek-ai/dsh/package.json')),official=createRequire(anchor),compat=join(program,'packages/harness-dsh/compat')
 if(!inside(program,anchor)||JSON.parse(await readFile(anchor)).version!==version)throw refuse('DSH 不是当前程序固定安装。')
 const rows=[]
 for(const spec of specs){
  let packagePath=official.resolve(spec.name+'/package.json')
  const previous=installed?.packages.find(row=>packagePath===row.root||inside(row.root,packagePath))
  if(previous)packagePath=join(previous.source,relative(previous.root,packagePath))
  const source=dirname(await realpath(packagePath)),metadata=JSON.parse(await readFile(join(source,'package.json')))
  if(!inside(program,source)||metadata.name!==spec.name||metadata.version!==version)throw refuse('官方兼容包不属于当前固定程序。')
  const bytes=await readFile(join(compat,spec.basename+'.json')),manifest=manifestValue(bytes,spec),patch=await readFile(join(compat,spec.basename+'.patch'));validatePatch(patch,manifest)
  const before=await sourceFiles(source)
  for(const file of manifest.files)if(before.find(row=>row.path===file.path)?.sha256!==file.beforeSha256)throw refuse('官方兼容输入文件摘要不一致。')
  const after=before.map(file=>({...file,sha256:manifest.files.find(row=>row.path===file.path)?.afterSha256??file.sha256}))
  rows.push({...spec,source,manifest,manifestSha256:hash(bytes),patch,before,after})
 }
 const fingerprint=hash(JSON.stringify(rows.map(row=>[row.name,row.source,row.manifestSha256,row.before]))),base=join(runtime,'native-runtime'),target=join(base,fingerprint)
 await privateDirectory(base)
 let present=true;try{await lstat(target)}catch(error){if(error.code!=='ENOENT')throw error;present=false}
 if(!present){
  const staging=await mkdtemp(join(base,'.staging-'))
  try{
   for(const row of rows){
    const copy=join(staging,row.name.slice('@deepseek-ai/'.length));await privateDirectory(copy)
    for(const file of row.before){const target=join(copy,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});const bytes=await readFile(join(row.source,file.path));if(hash(bytes)!==file.sha256)throw refuse('官方输入在复制期间已变化。');await writeFile(target,bytes,{flag:'wx',mode:0o600})}
    const patchPath=join(staging,row.basename+'.patch');await writeFile(patchPath,row.patch,{flag:'wx',mode:0o600})
    const options={cwd:copy,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},timeout:10000,maxBuffer:1024*1024}
    await exec('git',['apply','--check','--whitespace=nowarn',patchPath],options);await exec('git',['apply','--whitespace=nowarn',patchPath],options)
    for(const file of row.manifest.files)await chmod(join(copy,file.path),0o600)
    await verifyCopy(copy,row.after);await rm(patchPath)
   }
   await writeFile(join(staging,'receipt.json'),JSON.stringify({schema:'teloa.native-runtime/v1',fingerprint,packages:rows.map(row=>({name:row.name,source:row.source,manifestSha256:row.manifestSha256,files:row.after}))}),{flag:'wx',mode:0o600})
   try{await rename(staging,target)}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error}
  }finally{await rm(staging,{recursive:true,force:true})}
 }
 await privateDirectory(target)
 const receipt=JSON.parse(await readFile(join(target,'receipt.json'))),expected={schema:'teloa.native-runtime/v1',fingerprint,packages:rows.map(row=>({name:row.name,source:row.source,manifestSha256:row.manifestSha256,files:row.after}))}
 if(JSON.stringify(receipt)!==JSON.stringify(expected))throw refuse('运行副本回执已变化。')
 for(const row of rows)await verifyCopy(join(target,row.name.slice('@deepseek-ai/'.length)),row.after)
 const plan=freeze({fingerprint,packages:rows.map(row=>({name:row.name,source:row.source,root:join(target,row.name.slice('@deepseek-ai/'.length))})),compatibilityAPIs:Object.fromEntries(rows.map(row=>[row.name,row.manifest.api]))})
 trusted.set(plan,plan.packages);return plan
}

/** 物理宿主加载任何 DSH 执行模块之前调用。peer 从原安装解析，再映射至同一私有副本。 */
export function installNativeRuntime(plan){
 const packages=trusted.get(plan);if(!packages||typeof registerHooks!=='function')throw refuse('运行图必须来自固定输入准备，且需要 Node 24 的同步解析接口。')
 if(installed){if(installed.fingerprint!==plan.fingerprint||installed.roots!==JSON.stringify(packages))throw refuse('同一物理宿主不能切换原生执行图。');return installed.hook}
 const remap=(url,from,to)=>{
  if(typeof url!=='string'||!url.startsWith('file:'))return url
  const path=fileURLToPath(url),row=packages.find(row=>path===row[from]||inside(row[from],path));return row?pathToFileURL(join(row[to],relative(row[from],path))).href:url
 }
 const hook=registerHooks({resolve(specifier,context,nextResolve){const result=nextResolve(specifier,{...context,parentURL:remap(context.parentURL,'root','source')});return {...result,url:remap(result.url,'source','root')}}})
 installed={fingerprint:plan.fingerprint,roots:JSON.stringify(packages),packages,hook};return hook
}
