import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('移动端全局搜索分类页签在溢出时给出可见滚动提示，末项不被无提示截断',async()=>{
 const css=await readFile(new URL('../src/client/WorkspaceSearch.module.css',import.meta.url),'utf8')
 assert.match(css,/\.types\{[^}]*overflow-x:auto/,'页签条保持横向滚动')
 const mobile=css.match(/@media\(max-width:740px\)\{[^]*?\}\s*$/)
 assert.ok(mobile,'存在移动端媒体查询')
 assert.match(mobile![0],/\.types\{[^}]*mask-image:linear-gradient\(to right/,'移动端在页签条右缘给出渐隐提示')
 assert.match(mobile![0],/scroll-padding-right:/,'移动端为最后一个页签保留滚动内边距')
})
