import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, cp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { ReferenceCatalog } from '../src/catalog.ts'

test('内置公共资料随所属包独立读取，不依赖根 resource 目录',async t=>{
  const root=await mkdtemp(join(tmpdir(),'teloa-public-reference-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const packageRoot=join(root,'packages/mcp-reference')
  await cp(new URL('../',import.meta.url),packageRoot,{recursive:true,filter:path=>!/(?:^|\/)(?:node_modules|tests)(?:\/|$)/.test(path)})
  const {createPublicReferenceCatalog}=await import(pathToFileURL(join(packageRoot,'src/local.ts')).href)
  const catalog:ReferenceCatalog=createPublicReferenceCatalog()
  const list=await catalog.list()
  assert.deepEqual(list.references.map(({id,title,source})=>({id,title,source})),[
    {id:'workbench',title:'工作台与业务',source:'工作台与业务.md'},
    {id:'capabilities',title:'技能与连接',source:'技能与连接.md'},
  ])
  for(const ref of list.references){
    const bytes=await readFile(new URL('../materials/'+ref.source,import.meta.url))
    const actual=await catalog.read(ref.id,ref.version)
    assert.equal(actual.text,bytes.toString('utf8'))
    assert.equal(actual.bytes,bytes.length)
    assert.equal(actual.version,createHash('sha256').update(bytes).digest('hex'))
  }
})

async function fixture(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'teloa-reference-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const text='# 资料\n明确来源与推断。\n'
  await writeFile(join(root,'参考资料.md'),text)
  const catalog=new ReferenceCatalog(root,[{id:'reference',title:'参考资料',file:'参考资料.md'}])
  return {root,text,catalog,version:createHash('sha256').update(text).digest('hex')}
}
test('目录与读取使用同一内容版本，结果保留中文来源与实际字节数',async t=>{
  const {catalog,text,version}=await fixture(t)
  const list=await catalog.list()
  assert.equal(list.schema,'teloa.reference-list/v1')
  assert.deepEqual(list.references,[{id:'reference',title:'参考资料',version,source:'参考资料.md',bytes:Buffer.byteLength(text)}])
  assert.deepEqual(await catalog.read('reference',version),{schema:'teloa.reference/v1',...list.references[0],text})
})
test('目录之后来源变化不能静默换版本，未知 ID 和路径不能读取文件',async t=>{
  const {catalog,root,version}=await fixture(t)
  await writeFile(join(root,'参考资料.md'),'新的版本')
  await assert.rejects(catalog.read('reference',version),{code:'reference/version-conflict'})
  for(const id of ['unknown','../参考资料.md','/etc/passwd'])await assert.rejects(catalog.read(id,version),{code:'reference/not-found'})
})
test('非法 UTF-8、过大内容、缺失来源、目录和越界链接不能表现为正常资料',async t=>{
  const {root}=await fixture(t)
  await writeFile(join(root,'invalid'),Buffer.from([0xff]))
  await writeFile(join(root,'large'),'a'.repeat(128*1024+1))
  await mkdir(join(root,'directory'))
  await symlink('/etc/hosts',join(root,'outside'))
  for(const file of ['invalid','large','missing','directory','outside','../outside']){
    const catalog=new ReferenceCatalog(root,[{id:'bad',title:'不可用资料',file}])
    await assert.rejects(catalog.list(),{code:'reference/source-unavailable'})
  }
})
