import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readMarketCatalogEntry,marketCatalogUpstreamTreeHash} from '../src/market-catalog.ts'

const loc=(text:string)=>({'zh-CN':text,en:text})
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const sample=():any=>({format:'teloa.market-catalog-entry/v1',id:'hermes.notes',kind:'skill',delivery:'upstream',version:'1.0.0',taxonomy:{functions:['office-docs'],industries:['general']},skill:{name:'notes',title:loc('笔记'),summary:loc('整理笔记')},upstream:{kind:'github',repository:{host:'github.com',owner:'example',repo:'skills'},commit:'a'.repeat(40),path:'plugins/notes/skills/notes',files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),sha256:'1'.repeat(64),size:1},{path:'licenses/upstream/LICENSE',repositoryPath:'LICENSE',gitBlob:'c'.repeat(40),sha256:'2'.repeat(64),size:2},{path:'licenses/upstream/plugins/notes/NOTICE.txt',repositoryPath:'plugins/notes/NOTICE.txt',gitBlob:'d'.repeat(40),sha256:'3'.repeat(64),size:3}]},origin:{marketplace:'hermes',installs:null,installsLabel:'未公开',countedAt:'2026-09-27'},alternatives:[],unsupportedComponents:[],modifications:[],license:{spdx:'Apache-2.0',files:['licenses/upstream/LICENSE','licenses/upstream/plugins/notes/NOTICE.txt']},compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-27',reviewer:'Fixture'}})

test('GitHub 固定许可支持仓库根和祖先目录的原路径，保留安装路径与许可清单',()=>{
 const row=sample(),entry=readMarketCatalogEntry(row)
 assert.deepEqual(entry,row)
 assert.notEqual(marketCatalogUpstreamTreeHash(row.upstream,sha),marketCatalogUpstreamTreeHash({...row.upstream,files:row.upstream.files.map(({repositoryPath,...file}:any)=>file)},sha))
 const moved=sample();moved.upstream.files[1].repositoryPath='plugins/LICENSE';moved.upstream.files[1].path='licenses/upstream/plugins/LICENSE'
 assert.notEqual(marketCatalogUpstreamTreeHash(row.upstream,sha),marketCatalogUpstreamTreeHash(moved.upstream,sha))
})

test('GitHub 文件项必须固定 sha256（git blob 只作定位）；缺失、格式错误都拒绝，指纹绑定 sha256',()=>{
 for(const change of [(file:any)=>{delete file.sha256},(file:any)=>{file.sha256='A'.repeat(64)},(file:any)=>{file.sha256='1'.repeat(63)},(file:any)=>{file.sha256=null}]){
  const row=sample();change(row.upstream.files[0])
  assert.throws(()=>readMarketCatalogEntry(row),(error:any)=>error?.code==='teloa/invalid-input'&&/上游文件/.test(error.message))
 }
 const row=sample(),changed=sample();changed.upstream.files[0].sha256='5'.repeat(64)
 assert.notEqual(marketCatalogUpstreamTreeHash(row.upstream,sha),marketCatalogUpstreamTreeHash(changed.upstream,sha))
})

test('固定 THIRD_PARTY_NOTICES.md 可从根或祖先目录保留，近似名称和非祖先路径仍拒绝',()=>{
 for(const repositoryPath of ['THIRD_PARTY_NOTICES.md','plugins/notes/THIRD_PARTY_NOTICES.md','third_party_notices.MD']){
  const row=sample(),file={path:'licenses/upstream/'+repositoryPath,repositoryPath,gitBlob:'e'.repeat(40),sha256:'4'.repeat(64),size:50}
  row.upstream.files.push(file);row.license.files.push(file.path)
  assert.deepEqual(readMarketCatalogEntry(row),row)
  const changed=structuredClone(row);changed.upstream.files.at(-1).gitBlob='f'.repeat(40)
  assert.notEqual(marketCatalogUpstreamTreeHash(row.upstream,sha),marketCatalogUpstreamTreeHash(changed.upstream,sha))
 }
 for(const repositoryPath of ['THIRD_PARTY_NOTICES.txt','THIRD_PARTY_NOTICES.md.js','MY_THIRD_PARTY_NOTICES.md','README.md','other/THIRD_PARTY_NOTICES.md']){
  const row=sample(),file={path:'licenses/upstream/'+repositoryPath,repositoryPath,gitBlob:'e'.repeat(40),sha256:'4'.repeat(64),size:50}
  row.upstream.files.push(file);row.license.files.push(file.path)
  assert.throws(()=>readMarketCatalogEntry(row),/祖先目录/)
 }
})

test('许可映射拒绝任意文件、跨技能路径、穿越、覆盖、缺失许可声明、未知字段和大小写冲突',()=>{
 for(const change of [
  (r:any)=>{r.upstream.files[1].repositoryPath='../LICENSE'},
  (r:any)=>{r.upstream.files[1].repositoryPath='other/LICENSE';r.upstream.files[1].path='licenses/upstream/other/LICENSE'},
  (r:any)=>{r.upstream.files[1].repositoryPath='README.md';r.upstream.files[1].path='licenses/upstream/README.md'},
  (r:any)=>{r.upstream.files[1].repositoryPath='LICENSE.js';r.upstream.files[1].path='licenses/upstream/LICENSE.js'},
  (r:any)=>{r.upstream.files[1].path='SKILL.md'},
  (r:any)=>{r.upstream.files[1].path='LICENSE'},
  (r:any)=>{r.upstream.files[1].size=null},
  (r:any)=>{r.license.files=[]},
  (r:any)=>{r.license.files.push('missing')},
  (r:any)=>{r.upstream.files[1].url='https://example.com/LICENSE'},
  (r:any)=>{r.upstream.files.push({...r.upstream.files[1],path:'licenses/upstream/license',repositoryPath:'license'});r.license.files.push('licenses/upstream/license')},
 ]){const row=sample();change(row);assert.throws(()=>readMarketCatalogEntry(row))}
})

test('无目录外许可的 GitHub 声明与指纹形状（绑定 blob、sha256、大小），ClawHub 不接受 repositoryPath',()=>{
 const row=sample();row.upstream.files=row.upstream.files.slice(0,1);row.license.files=[]
 assert.deepEqual(readMarketCatalogEntry(row),row)
 assert.equal(marketCatalogUpstreamTreeHash(row.upstream,sha),sha(JSON.stringify(['github','github.com','example','skills',row.upstream.commit,row.upstream.path,[['SKILL.md','b'.repeat(40),'1'.repeat(64),1]]])))
 row.upstream={kind:'clawhub',owner:'example',slug:'notes',version:'1.0.0',files:[{path:'LICENSE',repositoryPath:'LICENSE',sha256:'b'.repeat(64),size:1}]}
 assert.throws(()=>readMarketCatalogEntry(row))
})

test('上游仓库名与契约共用定义：.github 可入目录，.git 结尾拒绝',()=>{
 const row=sample();row.upstream.repository.repo='.github'
 assert.equal((readMarketCatalogEntry(row) as {upstream:{repository:{repo:string}}}).upstream.repository.repo,'.github')
 row.upstream.repository.repo='skills.git'
 assert.throws(()=>readMarketCatalogEntry(row),/上游仓库名/)
})

test('目录文件路径拒绝 C1、行/段分隔符与双向控制符（与后端 quoted() 口径一致），防确认卡里伪装文件名',()=>{
 const invisible=['\u0080','\u0085','\u009b','\u009f','\u2028','\u2029','\u200e','\u200f','\u202a','\u202e','\u2066','\u2069']
 for(const char of invisible){
  for(const change of [
   (r:any)=>{r.upstream.files[0].path='SKILL'+char+'.md'},
   (r:any)=>{r.upstream.path='plugins/notes'+char+'/skills/notes'},
   (r:any)=>{r.upstream.files[1].repositoryPath='LICENSE'+char+'.txt';r.upstream.files[1].path='licenses/upstream/LICENSE'+char+'.txt';r.license.files[0]='licenses/upstream/LICENSE'+char+'.txt'},
  ]){const row=sample();change(row);assert.throws(()=>readMarketCatalogEntry(row),(error:any)=>error?.code==='teloa/invalid-input'&&/安全的相对路径/.test(error.message),JSON.stringify(char))}
 }
 // 普通非 ASCII（中文、带变音符）仍可用
 const row=sample();row.upstream.files[0].path='参考/résumé.md';row.upstream.files.push({path:'SKILL.md',gitBlob:'e'.repeat(40),sha256:'6'.repeat(64),size:1})
 assert.doesNotThrow(()=>readMarketCatalogEntry(row))
})
