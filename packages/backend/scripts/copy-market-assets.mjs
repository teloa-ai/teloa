import {readFile,writeFile,mkdir,rename} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

/** 固定索引是运行输入；先核对字节，再原子写入，不能依赖上次构建残留。 */
export async function copyOfficialMarketIndex({source,target,expectedSha256}){
 const bytes=await readFile(source)
 if(!/^[a-f0-9]{64}$/.test(expectedSha256)||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)throw Error('固定上游市场索引摘要不一致，构建已停止。')
 await mkdir(dirname(target),{recursive:true})
 const temporary=target+'.'+randomUUID()+'.tmp'
 await writeFile(temporary,bytes,{flag:'wx'})
 await rename(temporary,target)
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
 const {officialUpstreamIndexSha256}=await import(pathToFileURL(join(root,'lib/market/official-upstream-index-sha256.js')))
 await copyOfficialMarketIndex({source:join(root,'src/market/official-upstream-index.json'),target:join(root,'lib/market/official-upstream-index.json'),expectedSha256:officialUpstreamIndexSha256})
}
