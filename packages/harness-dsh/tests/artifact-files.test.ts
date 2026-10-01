import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { FsTarget,FsInfo } from '@deepseek-ai/dsh-fs'
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
  if(intent.version!==version)throw Error('FS_STALE_VERSION')
  writes++;content=text;version='v3';return {version,before:'a\r\n',after:text,operation:'update'}
 }})
 const original=await f.read('artifacts/files/read',{sessionId:'s1',path:'result.txt'},signal);assert.ok('sha256' in original)
 const payload={sessionId:'s1',path:'result.txt',expectedId:original.id,expectedSha256:original.sha256,text:'new text'}
 await assert.rejects(f.read('artifacts/files/write',{...payload,expectedSha256:'0'.repeat(64)},signal),/变化|版本/);assert.equal(writes,0)
 race=true;await assert.rejects(f.read('artifacts/files/write',payload,signal),/STALE|变化|版本/);assert.equal(writes,0)
 race=false;const result=await f.read('artifacts/files/write',payload,signal);assert.ok('sha256' in result);assert.equal(result.sha256,createHash('sha256').update('new text').digest('hex'));assert.equal(writes,1)
 await f.read('artifacts/files/write',payload,signal);assert.equal(writes,1)
 await assert.rejects(f.read('artifacts/files/write',{...payload,path:'.runtime/secret'},signal),/路径/)
})
