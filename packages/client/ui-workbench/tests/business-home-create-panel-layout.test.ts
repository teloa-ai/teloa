import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const read=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

/**
 * 「再加一类业务」展开面板过去用 position:absolute 盖在卡片上方，390 与 1440 都拦过点击（今天 e2e 挖出）。
 * 改成随文档流：面板不再绝对定位，展开时用 flex-basis:100% 把自己挤到 pageHeader 下一行，把卡片往下推。
 */
test('BusinessHome「再加一类业务」面板不再绝对定位，展开时随文档流把卡片往下推',async()=>{
 const css=await read('BusinessHome.module.css')
 assert.doesNotMatch(css,/\.create\{[^}]*position:absolute/,'.create 不应再是绝对定位')
 assert.match(css,/\.pageHeader\{[^}]*flex-wrap:wrap/,'pageHeader 要能换行，展开的面板才挤得到下一行')
 assert.match(css,/\.createOpen\{[^}]*flex:1 1 100%/,'展开态要用 flex-basis:100% 强制换行到自己的一整行')
 assert.match(css,/\.create\{[^}]*width:100%/)

 const source=await read('BusinessHome.tsx')
 assert.match(source,/useDismissible\(createControlRef, ?createOpen, ?\(\)\s*=>\s*setCreateOpen\(false\), undefined, 'click'\)/)
 assert.match(source,/ref=\{createControlRef\}/)
 assert.match(source,/className=\{clsx\(css\.createControl, ?createOpen ?&& ?css\.createOpen\)\}/)
})
