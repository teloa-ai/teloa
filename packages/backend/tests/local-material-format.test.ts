import assert from 'node:assert/strict'
import test from 'node:test'
import {Pool} from 'pg'
import {AuthorizedLocalMaterialCatalog} from '../src/capabilities/authorized-local-material-catalog.ts'

test('本机原件不支持格式给稳定原因，其他非法输入不误报格式且不访问数据库',async t=>{
 let connections=0
 const pool=new Pool({host:'127.0.0.1',port:1,user:'fixture',password:'fixture',database:'fixture',max:1})
 pool.connect=async()=>{connections++;throw Error('No database needed')};t.after(()=>pool.end())
 const catalog=new AuthorizedLocalMaterialCatalog(pool,{id:()=>assert.fail('不能创建资料身份'),now:()=>assert.fail('不能写时间')})
 const actor={ownerId:'owner',kind:'human' as const,scopeIds:['general']},base={requestId:'11111111-1111-4111-8111-111111111111',title:'Example',scopeIds:['general']}
 for(const path of ['example.txt','example.pdf','example.docx','example.png'])await assert.rejects(catalog.register(actor,{...base,path}),{code:'teloa/invalid-input',details:{reason:'local-material-format-unsupported'}})
 for(const path of ['../example.pdf','/example.pdf','.private/example.pdf'])await assert.rejects(catalog.register(actor,{...base,path}),error=>{
  assert.equal(Reflect.get(Object(error),'code'),'teloa/invalid-input');assert.equal(Reflect.get(Object(error),'details'),undefined);return true
 })
 await assert.rejects(catalog.register({...actor,kind:'agent'},{...base,path:'example.pdf'}),{code:'teloa/forbidden'})
 assert.equal(connections,0)
 // 支持格式仍越过纯输入校验；本测试的借用口主动拒绝，不实际连接或登记。
 for(const path of ['example.md','example.markdown','example.MD'])await assert.rejects(catalog.register(actor,{...base,path}),/No database needed/)
 assert.equal(connections,3)
})
