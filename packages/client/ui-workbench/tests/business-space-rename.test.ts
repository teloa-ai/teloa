import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {BusinessSpaceRenameAlert,submitBusinessSpaceRename} from '../src/client/business-space-rename.ts'
import {changeBusinessDirectory,type BusinessSpaceChange,type BusinessSpaceRecord} from '../src/client/business-directory.ts'
import {localizeWorkError} from '../lib/types/client/i18n/errors.js'

const localize=(error:unknown)=>localizeWorkError('zh-CN',error)
const space=():BusinessSpaceRecord=>({id:'11111111-1111-4111-8111-111111111111',name:'我的工作空间',description:'',version:2,kind:'personal',createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-11T00:00:00.000Z'})

test('改名成功才返回空串，调用方据此关闭表单',async()=>{
 const sent:unknown[]=[]
 const message=await submitBusinessSpaceRename(async change=>{sent.push(change)},{expectedVersion:2,name:'调查工作空间',description:'说明'},localize)
 assert.equal(message,'')
 assert.deepEqual(sent,[{type:'rename',expectedVersion:2,name:'调查工作空间',description:'说明'}])
})

test('宿主版本冲突不静默：返回本地化文案，save 未成功因此表单不会被关闭',async()=>{
 let closed=false
 const conflict=Object.assign(Error('version conflict'),{rejected:true,code:'teloa/version-conflict'})
 const message=await submitBusinessSpaceRename(async()=>{throw conflict},{expectedVersion:1,name:'调查工作空间',description:''},localize)
 assert.equal(message,localize(conflict))
 assert.ok(message.trim())
 // 调用方的 save 形如 `await directoryChange(...); close()`：拒绝时 close 根本到不了。
 const save=async(change:BusinessSpaceChange)=>{
  if(change.expectedVersion!==2)throw conflict
  closed=true
 }
 assert.equal(await submitBusinessSpaceRename(save,{expectedVersion:1,name:'名称',description:''},localize),localize(conflict))
 assert.equal(closed,false)
 assert.equal(await submitBusinessSpaceRename(save,{expectedVersion:2,name:'名称',description:''},localize),'')
 assert.equal(closed,true)
})

test('本地校验失败走同一条提示路径：空名称与超长说明都不发请求',async()=>{
 let sent=0
 const directory={space:space(),labels:[]}
 const save=(change:BusinessSpaceChange)=>{changeBusinessDirectory(directory,change);sent++}
 assert.ok((await submitBusinessSpaceRename(save,{expectedVersion:2,name:'  ',description:''},localize)).trim())
 assert.ok((await submitBusinessSpaceRename(save,{expectedVersion:2,name:'名称',description:'x'.repeat(2001)},localize)).trim())
 assert.equal(sent,0)
 assert.equal(await submitBusinessSpaceRename(save,{expectedVersion:2,name:'名称',description:''},localize),'')
 assert.equal(sent,1)
})

test('错误区域在有错误时才渲染，且用 role="alert" 播报',()=>{
 assert.equal(renderToStaticMarkup(createElement(BusinessSpaceRenameAlert,{message:''})),'')
 const markup=renderToStaticMarkup(createElement(BusinessSpaceRenameAlert,{message:'业务空间已变化，请重新核对。'}))
 assert.match(markup,/role="alert"/)
 assert.match(markup,/业务空间已变化/)
})

test('改名表单把失败留在原地：表单不自行关闭；业务范围内页不再托管改名表单',async()=>{
 const [form,page]=await Promise.all([
  readFile(new URL('../src/client/BusinessSpaceForm.tsx',import.meta.url),'utf8'),
  readFile(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8'),
 ])
 assert.match(form,/setError\(await submitBusinessSpaceRename\(save,\{expectedVersion:initial\.version,name,description\},error=>localizeWorkError\(locale,error\)\)\)/)
 assert.match(form,/<BusinessSpaceRenameAlert message=\{error\}\/>/)
 // 只看提交路径本身：`close` 在里面出现过就是自行关闭，出现在别处（取消按钮、Esc）才是对的。
 const submitBody=form.slice(form.indexOf('const submit=async()=>{'),form.indexOf('return <dialog'))
 assert.ok(submitBody.includes('submitBusinessSpaceRename'),'截取到的必须是提交路径')
 assert.doesNotMatch(submitBody,/\bclose\b/,'提交路径里不能自行关闭表单')
 assert.match(form,/onCancel=\{close\}/)
 assert.equal([...form.matchAll(/onClick=\{close\}/g)].length,2,'关闭只挂在标题栏关闭与取消两个按钮上')
 // 第二期：范围内页页头摘掉「管理」菜单之后，个人版界面上不再有改名入口——
 // 提交路径的「失败留在原地」由表单自己保证，业务页这一侧只剩「不再托管改名表单」这一条。
 assert.doesNotMatch(page,/BusinessSpaceForm|directoryChange/)
})
