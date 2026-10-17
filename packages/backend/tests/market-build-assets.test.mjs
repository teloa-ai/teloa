import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {copyOfficialMarketIndex} from '../scripts/copy-market-assets.mjs'
const sha=value=>createHash('sha256').update(value).digest('hex')
test('干净构建逐字带入固定上游索引，不依赖旧 lib 或在线回退',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-market-build-'))
 try{const source=join(root,'source.json'),target=join(root,'lib/market/index.json'),bytes=Buffer.from('{"format":"teloa.upstream-index/v1","entries":[]}\n');await writeFile(source,bytes);await copyOfficialMarketIndex({source,target,expectedSha256:sha(bytes)});assert.deepEqual(await readFile(target),bytes)}finally{await rm(root,{recursive:true,force:true})}
})
test('来源摘要不一致时拒绝构建，不替换已有可用索引',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-market-build-'))
 try{const source=join(root,'source.json'),target=join(root,'index.json');await writeFile(source,'changed');await writeFile(target,'original');await assert.rejects(copyOfficialMarketIndex({source,target,expectedSha256:sha('expected')}),/摘要/);assert.equal(await readFile(target,'utf8'),'original')}finally{await rm(root,{recursive:true,force:true})}
})
