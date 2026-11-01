import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {FsError,type FsTarget,type FsInfo,type FileSystem} from '@deepseek-ai/dsh-fs'
import { createArtifactFileReader,type ArtifactFileAccess } from '../src/artifact-files.ts'
const target=(key:string)=>({targetKey:key,displayPath:key}) as FsTarget
const info=(version='v1',size=3)=>({version,type:'file',size}) as FsInfo
const signal=new AbortController().signal,now='2026-09-11T07:00:00Z'
function fixture(){
  let reads=0,stats=0,changed=false,escaped=false,denied=false
  const access:ArtifactFileAccess={sessionId:'s1',cwd:'/work',fs:{processPath:target=>String(target.targetKey),resolve:async path=>target(path==='.'?'/work':path==='.runtime'?'/work/.runtime':path==='.git'?'/work/.git':escaped?'/work/.runtime/secret':'/work/'+path),contains:(a,b)=>b.targetKey===a.targetKey||b.targetKey.startsWith(a.targetKey+'/'),stat:async()=>info(changed&&++stats>1?'v2':'v1'),readBytes:async()=>{reads++;return Uint8Array.from([97,13,10])}},list:async()=>[{path:'result.txt',kind:'file'}]}
  const read=createArtifactFileReader(async id=>{if(denied)throw Error('未绑定');assert.equal(id,'s1');return access},()=>now)
  return {read,access,reads:()=>reads,change:()=>{changed=true},escape:()=>{escaped=true},deny:()=>{denied=true}}
}
test('文件目录查询只返回合法相对路径，保留查询与会话且最多100项，不读取正文',async()=>{
 const f=fixture(),calls:Array<{query:string;signal:AbortSignal}>=[]
 const safe=Array.from({length:105},(_,i)=>({path:`results/item-${i}.txt`,kind:'file' as const}))
 f.access.list=async(query,signal)=>{calls.push({query,signal});return [...['../secret','/outside.txt','.runtime/a','nested/.git/config','nested/.runtime/data','.git/config'].map(path=>({path,kind:'file' as const})),...safe]}
 f.access.fs.stat=async()=>{throw Error('目录查询不能打开文件')}
 f.access.fs.writeText=async()=>{throw Error('目录查询不能写文件')}
 const result=await f.read('artifacts/files/list',{sessionId:'s1',query:'results'},signal)
 assert.deepEqual(result,{sessionId:'s1',query:'results',items:safe.slice(0,100)})
 assert.deepEqual(calls,[{query:'results',signal}]);assert.equal(f.reads(),0)
})
test('文件目录在调用提供方之前拒绝错绑定、非法参数及已取消请求，提供方错误不伪装为空',async()=>{
 const f=fixture();let calls=0
 f.access.list=async()=>{calls++;throw Error('合成目录提供方故障')}
 for(const payload of [{sessionId:'s1',query:'../secret'},{sessionId:'s1',query:'',ownerId:'other'},{sessionId:'s1',query:'.git'},{sessionId:'bad session',query:''}])await assert.rejects(f.read('artifacts/files/list',payload,signal))
 f.access.sessionId='other';await assert.rejects(f.read('artifacts/files/list',{sessionId:'s1',query:''},signal),/绑定/);f.access.sessionId='s1'
 await assert.rejects(f.read('artifacts/files/list',{sessionId:'s1',query:''},AbortSignal.abort()))
 assert.equal(calls,0)
 await assert.rejects(f.read('artifacts/files/list',{sessionId:'s1',query:''},signal),/合成目录提供方故障/);assert.equal(calls,1)
 assert.equal(f.reads(),0)
})
test('文件目录提供方延迟响应取消时，已取消查询不再返回目录',async()=>{
 const f=fixture(),abort=new AbortController()
 f.access.list=async()=>{abort.abort();return [{path:'late.txt',kind:'file'}]}
 await assert.rejects(f.read('artifacts/files/list',{sessionId:'s1',query:''},abort.signal),{name:'AbortError'})
 assert.equal(f.reads(),0)
})
test('文件通过当前会话文件系统读取，版本来自原始字节且保留 CRLF',async()=>{
  const f=fixture(),result=await f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal)
  assert.ok('contentBase64' in result);assert.equal(result.contentBase64,'YQ0K');assert.equal(result.bytes,3)
  assert.equal(result.sha256,createHash('sha256').update('a\r\n').digest('hex'));assert.equal(result.capturedAt,now)
})
test('读前核验工作绑定和规范路径，运行目录及其别名不能作为产物读取',async()=>{
  const f=fixture()
  await assert.rejects(f.read('artifacts/files/read',{sessionId:'s1',path:'../secret'},signal),/路径/)
  await assert.rejects(f.read('artifacts/files/read',{sessionId:'s1',path:'.runtime/secret'},signal),/路径/)
  f.escape();await assert.rejects(f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal),/范围|目录/)
  assert.equal(f.reads(),0)
  f.deny();await assert.rejects(f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal),/未绑定/)
})
test('读取时文件发生变化不返回混合快照，超限或目录不读取内容',async()=>{
  const f=fixture();f.change()
  await assert.rejects(f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal),/变化/)
  for(const metadata of [{...info(),type:'directory' as const},info('v1',9*1024*1024)]){
    const g=fixture();g.access.fs.stat=async()=>metadata
    await assert.rejects(g.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal),/文件|MiB/)
    assert.equal(g.reads(),0)
  }
})
test('路径别名不能绕过嵌套运行目录的排除规则',async()=>{
  const f=fixture(),original=f.access.fs.resolve
  f.access.fs.resolve=async(path,opts)=>path==='alias.txt'?target('/work/nested/.runtime/data.txt'):original(path,opts)
  await assert.rejects(f.read('artifacts/files/read',{sessionId:'s1',path:'alias.txt'},signal),/范围|目录/)
  assert.equal(f.reads(),0)
})
test('网页编辑使用 DSH 版本保护，旧快照和校验后的并发变化都不能覆盖',async()=>{
 const f=fixture();let writes=0,content='a\r\n',version='v1',race=false
 f.access.fs.readBytes=async()=>new TextEncoder().encode(content)
 f.access.fs.stat=async()=>info(version,content.length)
 Object.assign(f.access.fs,{writeText:async(_target:FsTarget,text:string,intent:{kind:string;version:string})=>{
  assert.equal(intent.kind,'replaceIfVersion');if(race)version='v2'
  if(intent.version!==version)throw new FsError('stale file version','FS_STALE_VERSION')
  writes++;content=text;version='v3';return {version,before:'a\r\n',after:text,operation:'update'}
 }})
 const original=await f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal);assert.ok('sha256' in original)
 const payload={sessionId:'s1',path:'result.txt',expectedId:original.id,expectedSha256:original.sha256,text:'new text'}
 await assert.rejects(f.read('artifacts/files/write',{...payload,expectedSha256:'0'.repeat(64)},signal),/变化|版本/);assert.equal(writes,0)
 race=true;await assert.rejects(f.read('artifacts/files/write',payload,signal),(error:any)=>error.code==='teloa/file-changed');assert.equal(writes,0)
 race=false;const result=await f.read('artifacts/files/write',payload,signal);assert.ok('sha256' in result);assert.equal(result.sha256,createHash('sha256').update('new text').digest('hex'));assert.equal(writes,1)
 await f.read('artifacts/files/write',payload,signal);assert.equal(writes,1)
 await assert.rejects(f.read('artifacts/files/write',{...payload,path:'.runtime/secret'},signal),/路径/)
})
test('网页编辑沿当前会话的沙箱根写入，不误用部署默认目录',async()=>{
 const f=fixture();let content='a\r\n',version='v1',writes=0
 const policy={mode:'workspace-write' as const,workspaceRoot:'/work'}
 Object.assign(f.access,{writePolicy:()=>policy})
 Object.assign(f.access.fs,{sandboxMode:'workspace-write',readBytes:async()=>new TextEncoder().encode(content),stat:async()=>info(version,content.length),writeText:async(_target:FsTarget,text:string,intent:{version:string},_signal:AbortSignal,resolved:Parameters<FileSystem['writeText']>[4])=>{
  if(!resolved||resolved.workspaceRoot!=='/work')throw new FsError('deployment fallback cannot write this session workspace','FS_SANDBOX_DENIED')
  assert.equal(resolved.mode,'workspace-write');assert.equal(intent.version,version);writes++;content=text;version='v2';return {operation:'update',version,before:'a\r\n',after:text}
 }})
 const original=await f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal);assert.ok('sha256'in original)
 const saved=await f.read('artifacts/files/write',{sessionId:'s1',path:'result.txt',expectedId:original.id,expectedSha256:original.sha256,text:'session scoped edit'},signal)
 assert.ok('sha256'in saved);assert.equal(saved.sha256,createHash('sha256').update('session scoped edit').digest('hex'));assert.equal(writes,1)
})
test('会话改为只读或缺少受限写策略时不写文件，并返回可理解的拒绝',async()=>{
 const f=fixture();let readonly=false,writes=0
 Object.assign(f.access,{writePolicy:()=>({mode:readonly?'read-only':'workspace-write',workspaceRoot:'/work'})})
 Object.assign(f.access.fs,{sandboxMode:'workspace-write',writeText:async(_target:FsTarget,_text:string,_intent:unknown,_signal:AbortSignal,resolved:Parameters<FileSystem['writeText']>[4])=>{
  if(!resolved||resolved.mode==='read-only')throw new FsError('session file access denied','FS_SANDBOX_DENIED')
  writes++;throw Error('must not write')
 }})
 const original=await f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal);assert.ok('sha256'in original)
 f.access.fs.readBytes=async()=>{readonly=true;return Uint8Array.from([97,13,10])}
 const payload={sessionId:'s1',path:'result.txt',expectedId:original.id,expectedSha256:original.sha256,text:'denied edit'}
 await assert.rejects(f.read('artifacts/files/write',payload,signal),(error:any)=>error.code==='teloa/forbidden');assert.equal(writes,0)
 Object.assign(f.access,{writePolicy:undefined});readonly=false
 await assert.rejects(f.read('artifacts/files/write',payload,signal),(error:any)=>error.code==='teloa/file-unavailable');assert.equal(writes,0)
})
test('bare文件系统忽略第五参数时仍由入口拒绝只读会话',async()=>{
 const f=fixture();let writes=0
 Object.assign(f.access,{writePolicy:()=>({mode:'read-only'})})
 Object.assign(f.access.fs,{writeText:async()=>{writes++;throw Error('bare provider must not be called')}})
 const original=await f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal);assert.ok('sha256'in original)
 await assert.rejects(f.read('artifacts/files/write',{sessionId:'s1',path:'result.txt',expectedId:original.id,expectedSha256:original.sha256,text:'denied bare edit'},signal),(error:any)=>error.code==='teloa/forbidden');assert.equal(writes,0)
})
