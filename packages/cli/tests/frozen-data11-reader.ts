import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

/** 原data11断言使用同一提交的真实JSON和读者，不随当前版本推进。 */
export async function frozenData11(t:{after:(action:()=>unknown)=>void}){
 const fixture=new URL('./fixtures/data11-source-recovery/',import.meta.url)
 const proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8')) as {files:{path:string;bytes:number;sha256:string}[]}
 const root=await mkdtemp(join(tmpdir(),'teloa-data11-reader-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}))
 for(const file of proof.files){
  const bytes=await readFile(new URL(file.path,fixture))
  assert.equal(bytes.length,file.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256)
  await writeFile(join(root,file.path.replace('.ts.txt','.ts')),bytes)
 }
 return await import(pathToFileURL(join(root,'data-version.ts')).href) as typeof import('../src/data-version.ts')
}
