import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const pageSource=await readFile(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8')

test('业务空间提供项目子页；左栏平台级「项目」入口按 2026-09-25 裁定新增（覆盖一期「不增加一级导航」）',async()=>{
 assert.match(pageSource,/section\('projects'/)
 assert.match(pageSource,/<ProjectWorkspace/)
 // 项目仍是业务摘要条的直接入口；左栏「项目」总览只是跨业务视角，不改归属。
 const beforeMore=pageSource.split('<details ref={scopeMoreRef}')[0]??''
 assert.match(beforeMore,/aria-pressed=\{target\.section==='projects'\}/)
 const workNavigation=await readFile(new URL('../src/client/WorkNavigation.tsx',import.meta.url),'utf8')
 assert.match(workNavigation,/\['projects','navigation\.projects',FolderKanban\]/)
})

test('项目页读取真实详情和六类关系，不伪造项目主会话',async()=>{
 const source=await readFile(new URL('../src/client/ProjectWorkspace.tsx',import.meta.url),'utf8')
 assert.match(source,/api\.get\(selectedId\)/)
 assert.match(source,/projectLinkKinds\.map/)
 assert.doesNotMatch(source,/mainConversation|task\.conversations/)
 assert.doesNotMatch(source,/业务对象/)
})

test('项目目录无数据时显示正常空态，不把示例项目或界面原型暴露给用户',async()=>{
 const source=await readFile(new URL('../src/client/ProjectWorkspace.tsx',import.meta.url),'utf8')
 const messages=await readFile(new URL('../src/client/i18n/locales/project-workspace.ts',import.meta.url),'utf8')
 assert.match(source,/className=\{css\.directoryEmpty\}/)
 assert.match(source,/<FolderKanban size=\{27\}\/>/)
 assert.doesNotMatch(source,/project\.prototype\.badge/)
 assert.doesNotMatch(source,/project\.empty\.action/)
 assert.doesNotMatch(source,/showPrototype|prototype:boolean/)
 assert.match(messages,/\['project\.empty\.title','还没有项目'/)
 assert.doesNotMatch(messages,/项目目录尚未接入后端|原型/)
})
