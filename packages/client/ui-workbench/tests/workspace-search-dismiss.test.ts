import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const read=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

test('搜索弹层复用配对外点关闭，保留忙碌保护和卡片几何边界',async()=>{
 const source=await read('WorkspaceSearch.tsx')
 const shared=await read('use-dialog-dismiss.ts')
 assert.match(source,/useDialogDismiss\(close,!busy\)/)
 assert.match(source,/\.\.\.dismissEvents/)
 assert.match(shared,/event\.target!==event\.currentTarget/)
 assert.match(shared,/event\.currentTarget\.getBoundingClientRect\(\)/)
 assert.match(shared,/event\.clientX<box\.left\|\|event\.clientX>box\.right\|\|event\.clientY<box\.top\|\|event\.clientY>box\.bottom/)
 assert.match(shared,/outsidePointer\.current!==undefined&&outsidePointer\.current===event\.pointerId&&outside\(event\)/)
 assert.match(shared,/if\(dismiss&&canClose\)/)
 assert.doesNotMatch(source,/onClick=\{closeFromBackdrop\}/)
})

test('搜索弹层保留叉号按钮与 Esc（onCancel）两种关闭方式',async()=>{
 const source=await read('WorkspaceSearch.tsx')
 assert.match(source,/aria-label=\{t\('workspaceSearch\.closeAria'\)\}[^]*?onClick=\{close\}/)
 assert.match(source,/<X size=\{20\}\/>/)
 const shared=await read('use-dialog-dismiss.ts')
 assert.match(shared,/onCancel:[^]*?event\.preventDefault\(\);event\.stopPropagation\(\);if\(canClose\)close\(\)/)
})
