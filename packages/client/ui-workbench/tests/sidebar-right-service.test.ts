import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {requireSidebarRight,sessionFileAddress,WORK_CONTEXT_INJECT} from '../src/client/sidebar-right-service.ts'

const source=await readFile(new URL('../src/client/sidebar-right-service.ts',import.meta.url),'utf8')

test('右栏控制面改为正式 type-import，不再用 Reflect.get 手写结构类型',()=>{
 assert.match(source,/import type \{[^}]*ISidebarRight[^}]*\} from '@deepseek-ai\/dsh-client-ui-sidebar-right\/client'/)
 assert.doesNotMatch(source,/Reflect\.get\(ctx,'sidebarRight'\)/)
})

test('注入清单仍含 sidebarRight',()=>{
 assert.ok(WORK_CONTEXT_INJECT.includes('sidebarRight'))
})

test('上下文缺席时 requireSidebarRight 返回 undefined 而不是抛错',()=>{
 assert.equal(requireSidebarRight(undefined),undefined)
 const service={isExpanded:()=>false,toggleExpanded:()=>{}}
 assert.equal(requireSidebarRight({sidebarRight:service} as never),service)
})

test('会话文件地址逐段编码，与 ui-sidebar-documentpreview 的 parseFileAddress 对称',()=>{
 assert.equal(sessionFileAddress('s1','output/a.py'),'dsh-resource://file/session/s1/output/a.py')
 assert.equal(sessionFileAddress('s 1','out put/报 告.md'),'dsh-resource://file/session/s%201/out%20put/%E6%8A%A5%20%E5%91%8A.md')
 assert.equal(sessionFileAddress('s1','a#b?c/d'),'dsh-resource://file/session/s1/a%23b%3Fc/d')
})
