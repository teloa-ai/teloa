import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

/** 冻结前一源码版本的 data16 读者；历史门槛不随当前 metadata 升级而改变。 */
export async function frozenData16(t:{after:(action:()=>unknown)=>void}){
 const fixture=new URL('./fixtures/data16-native-continuation/',import.meta.url)
 const proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8'))
 const root=await mkdtemp(join(tmpdir(),'teloa-data16-reader-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}))
 for(const file of proof.files){
  const bytes=await readFile(new URL(file.path,fixture))
  assert.equal(bytes.length,file.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256)
  await writeFile(join(root,file.path.replace('.js.txt','.js')),bytes)
 }
 const old=await import(pathToFileURL(join(root,'data-version.js')).href) as typeof import('../src/data-version.ts')
 return {root,old}
}
