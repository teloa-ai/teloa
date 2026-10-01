import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const read=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

test('搜索弹层点击卡片外面（backdrop）会关闭，卡片内部（含内边距）点击不会误关',async()=>{
 const source=await read('WorkspaceSearch.tsx')
 // 用几何范围判断，而不是 target===dialog——后者会把 <dialog> 自身的内边距也算作「外面」。
 assert.match(source,/const closeFromBackdrop=\(event:React\.MouseEvent<HTMLDialogElement>\)=>\{/)
 assert.match(source,/if\(busy\)return/)
 assert.match(source,/const rect=event\.currentTarget\.getBoundingClientRect\(\)/)
 assert.match(source,/event\.clientX>=rect\.left&&event\.clientX<=rect\.right&&event\.clientY>=rect\.top&&event\.clientY<=rect\.bottom/)
 assert.match(source,/if\(!inside\)close\(\)/)
 assert.match(source,/onClick=\{closeFromBackdrop\}/)
})

test('搜索弹层保留叉号按钮与 Esc（onCancel）两种关闭方式',async()=>{
 const source=await read('WorkspaceSearch.tsx')
 assert.match(source,/aria-label=\{t\('workspaceSearch\.closeAria'\)\}[^]*?onClick=\{close\}/)
 assert.match(source,/<X size=\{20\}\/>/)
 assert.match(source,/onCancel=\{event=>\{if\(busy\)event\.preventDefault\(\);else close\(\)\}\}/)
})
