import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'

const root=new URL('../../../',import.meta.url)
const pkgRoot=new URL('../',import.meta.url)
const read=(path:string,base:URL=root)=>readFile(new URL(path,base),'utf8')

test('local-embedding 自带组合补丁：只插入 teloa-local-embedding 一行，不带 disabled；@teloa/bundle 不默认加载',async()=>{
 const manifest=JSON.parse(await read('package.json',pkgRoot)) as {dsh:unknown;exports:Record<string,string>}
 assert.deepEqual(manifest.dsh,{bundle:{patch:'./cordis.patch.yml'}})
 assert.equal(manifest.exports['./cordis.patch.yml'],'./cordis.patch.yml')
 const {parse}=createRequire(new URL('packages/harness-dsh/package.json',root))('yaml') as {parse:(text:string)=>unknown}
 assert.deepEqual(parse(await read('cordis.patch.yml',pkgRoot)),[{insert:[{id:'teloa-local-embedding',name:'@teloa/local-embedding'}]}])
 assert.doesNotMatch(await read('packages/bundle/cordis.patch.yml'),/teloa-local-embedding|@teloa\/local-embedding/)
 assert.equal((JSON.parse(await read('packages/bundle/package.json')) as {dependencies:Record<string,string>}).dependencies['@teloa/local-embedding'],undefined)
})

test('依赖：第三方只有 @huggingface/tokenizers@0.2.0；DSH 公开包钉 0.1.7-rc.1；不依赖 onnxruntime-node（按需受管安装）',async()=>{
 const manifest=JSON.parse(await read('package.json',pkgRoot)) as Record<string,Record<string,string>|undefined>
 const deps=manifest.dependencies!
 assert.deepEqual(Object.keys(deps).filter(name=>!name.startsWith('@deepseek-ai/')&&!name.startsWith('@teloa/')),['@huggingface/tokenizers'])
 assert.equal(deps['@huggingface/tokenizers'],'0.2.0')
 for(const [name,version] of Object.entries(deps))if(name.startsWith('@deepseek-ai/'))assert.equal(version,name==='@deepseek-ai/cordis'?'4.0.4':'0.1.7-rc.1',name)
 for(const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])assert.equal(manifest[field]?.['onnxruntime-node'],undefined,field)
})
