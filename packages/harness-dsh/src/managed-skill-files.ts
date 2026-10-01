import {constants} from 'node:fs'
import {lstat,mkdir,mkdtemp,open,readdir,rename,rm} from 'node:fs/promises'
import {dirname,join,resolve,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import type {SkillInstallSourceBundle} from '@teloa/backend'

type Native={name:string;description:string;modelInvocable:boolean;userInvocable:boolean;bodyHash:string}
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const corrupt=()=>new WorkError('teloa/storage-corrupt','受管技能文件与固定安装内容不一致，未覆盖文件。')
const invalid=()=>new WorkError('teloa/invalid-input','技能文件路径或安装身份无效。')
const missing=(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='ENOENT'
const sameNative=(a:Native,b:Native)=>a.name===b.name&&a.description===b.description&&a.modelInvocable===b.modelInvocable&&a.userInvocable===b.userInvocable&&a.bodyHash===b.bodyHash
const order=(a:string,b:string)=>a<b?-1:a>b?1:0

/** 每一层先核对普通目录，避免 recursive mkdir 透过符号链接写到受管根外。 */
async function directory(path:string):Promise<void>{
 const parent=dirname(path);if(parent!==path)await directory(parent)
 try{await mkdir(path,{mode:0o700})}catch(error){if(!(typeof error==='object'&&error!==null&&'code' in error&&error.code==='EEXIST'))throw error}
 const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw corrupt()
}
function checked(bundle:SkillInstallSourceBundle){
 if(bundle.entryPath!=='SKILL.md'||!Array.isArray(bundle.files)||!bundle.files.length||bundle.files.length>500)throw invalid()
 const names=new Set<string>();let total=0
 for(const file of bundle.files){
  if(typeof file.path!=='string'||file.path.length>500||file.path!==file.path.trim()||file.path.startsWith('/')||/[\\:?%#\u0000-\u001f\u007f]/.test(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..'))throw invalid()
  const portable=file.path.normalize('NFC').toLowerCase();if(names.has(portable))throw invalid();names.add(portable)
  if(!(file.bytes instanceof Uint8Array)||file.bytes.byteLength>2*1024*1024)throw invalid();total+=file.bytes.byteLength
  if(digest(file.bytes)!==file.hash)throw corrupt()
 }
 if(total>20*1024*1024||bundle.files.filter(file=>file.path.split('/').at(-1)==='SKILL.md').length!==1||!bundle.files.some(file=>file.path==='SKILL.md'))throw invalid()
 for(const name of names){let parent=dirname(name);while(parent!=='.'){if(names.has(parent))throw invalid();parent=dirname(parent)}}
 const files=bundle.files.map(file=>({...file,bytes:Uint8Array.from(file.bytes)})).sort((a,b)=>order(a.path,b.path))
 if(digest(JSON.stringify(files.map(file=>[file.path,file.hash])))!==bundle.bundleHash)throw corrupt()
 try{new TextDecoder('utf-8',{fatal:true}).decode(files.find(file=>file.path==='SKILL.md')!.bytes)}catch{throw invalid()}
 return files
}

/** 仅发布固定字节，不执行附件。DB 准备回执及串行锁由安装服务负责。 */
export class ManagedSkillFiles{
 readonly root:string
 private readonly parse:(directory:string)=>Promise<Native>
 private readonly invalidate:(path:string)=>void
 constructor(root:string,parse:(directory:string)=>Promise<Native>,invalidate:(path:string)=>void){if(!root.startsWith(sep)||resolve(root)!==root)throw invalid();this.root=root;this.parse=parse;this.invalidate=invalidate}
 async ready():Promise<void>{await directory(this.root)}
 path(id:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))throw invalid();return join(this.root,id,'SKILL.md')}
 private async stage(bundle:SkillInstallSourceBundle){
  const files=checked(bundle);await directory(this.root)
  // 临时树不在原生发现根内，准备或解析失败不会进入技能目录。
  const staging=join(dirname(this.root),'skill-staging');await directory(staging)
  const container=await mkdtemp(join(staging,'install-')),target=join(container,'entry')
  try{
   await directory(target)
   for(const file of files){const path=join(target,file.path);await directory(dirname(path));const handle=await open(path,'wx',0o600);try{await handle.writeFile(file.bytes);await handle.sync()}finally{await handle.close()}}
   const native=await this.parse(target);return {container,target,native}
  }catch(error){await rm(container,{recursive:true,force:true});throw error}
 }
 async inspect(bundle:SkillInstallSourceBundle):Promise<Native>{const stage=await this.stage(bundle);try{return stage.native}finally{await rm(stage.container,{recursive:true,force:true})}}
 async verify(id:string,bundle:SkillInstallSourceBundle,native:Native):Promise<void>{
  const expected=checked(bundle),path=this.path(id),target=dirname(path);await directory(this.root)
  const files=new Map(expected.map(file=>[file.path,file])),directories=new Set<string>()
  for(const file of expected){let parent=dirname(file.path);while(parent!=='.'){directories.add(parent);parent=dirname(parent)}}
  const visit=async(current:string,relative:string)=>{
   const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw corrupt()
   for(const name of await readdir(current)){const relativePath=relative?relative+'/'+name:name,child=join(current,name),stat=await lstat(child)
    if(stat.isSymbolicLink())throw corrupt()
    if(stat.isDirectory()){if(!directories.has(relativePath))throw corrupt();await visit(child,relativePath);continue}
    const expectedFile=files.get(relativePath);if(!stat.isFile()||!expectedFile||stat.size!==expectedFile.bytes.byteLength)throw corrupt()
    const handle=await open(child,constants.O_RDONLY|constants.O_NOFOLLOW)
    try{const actual=await handle.stat();if(!actual.isFile()||actual.size!==expectedFile.bytes.byteLength||digest(await handle.readFile())!==expectedFile.hash)throw corrupt()}finally{await handle.close()}
    files.delete(relativePath)
   }
  }
  try{await visit(target,'');if(files.size||!sameNative(await this.parse(target),native))throw corrupt()}catch(error){if(missing(error))throw corrupt();throw error}
 }
 async publish(id:string,bundle:SkillInstallSourceBundle,native:Native):Promise<void>{
  const path=this.path(id),target=dirname(path);checked(bundle);await directory(this.root)
  try{await lstat(target);await this.verify(id,bundle,native);this.invalidate(path);return}catch(error){if(!missing(error))throw error}
  const stage=await this.stage(bundle)
  try{
   if(!sameNative(stage.native,native))throw corrupt()
   // 同一安装 ID 的发布由持久服务锁串行；已有目录只核验，不覆盖。
   try{await lstat(target);throw corrupt()}catch(error){if(!missing(error))throw error}
   await rename(stage.target,target)
   this.invalidate(path)
   await this.verify(id,bundle,native)
  }finally{await rm(stage.container,{recursive:true,force:true})}
 }
}
