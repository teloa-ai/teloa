import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {marketCatalogUpstreamTreeHash,type MarketCatalogUpstreamGithub} from '../src/market-catalog.ts'
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const github=():MarketCatalogUpstreamGithub=>({kind:'github',repository:{host:'github.com',owner:'example',repo:'skills'},commit:'a'.repeat(40),path:'skills/notes',files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),sha256:'1'.repeat(64),size:1},{path:'LICENSE',gitBlob:'c'.repeat(40),sha256:'2'.repeat(64),size:2}]})
test('GitHub 指纹按文件路径排序，绑定仓库、提交、子目录、blob 与大小',()=>{
 const source=github(),hash=marketCatalogUpstreamTreeHash(source,sha)
 assert.equal(marketCatalogUpstreamTreeHash({...source,files:[...source.files].reverse()},sha),hash)
 for(const change of [
  (s:MarketCatalogUpstreamGithub)=>{s.repository.owner='other'},
  (s:MarketCatalogUpstreamGithub)=>{s.repository.repo='other'},
  (s:MarketCatalogUpstreamGithub)=>{s.commit='d'.repeat(40)},
  (s:MarketCatalogUpstreamGithub)=>{s.path='other'},
  (s:MarketCatalogUpstreamGithub)=>{s.files[0]!.gitBlob='e'.repeat(40)},
  (s:MarketCatalogUpstreamGithub)=>{s.files[0]!.size=null},
  (s:MarketCatalogUpstreamGithub)=>{s.files[0]!.sha256='3'.repeat(64)},
  (s:MarketCatalogUpstreamGithub)=>{s.files.pop()},
 ]){const changed=github();change(changed);assert.notEqual(marketCatalogUpstreamTreeHash(changed,sha),hash)}
})
test('ClawHub 保留旧版指纹字节，不改变已有安装回执身份',()=>{
 const files=[{path:'SKILL.md',sha256:'a'.repeat(64),size:1},{path:'LICENSE',sha256:'b'.repeat(64),size:2}]
 assert.equal(marketCatalogUpstreamTreeHash({kind:'clawhub',owner:'example',slug:'notes',version:'1',files},sha),sha(JSON.stringify(files.map(file=>[file.path,file.sha256]).sort())))
})
