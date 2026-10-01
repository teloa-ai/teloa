import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const client=new URL('../src/client/',import.meta.url)

test('设置页标题不重复应用品牌与部署说明',async()=>{
  const [shell,brand]=await Promise.all([
    readFile(new URL('SettingsShell.tsx',client),'utf8'),
    readFile(new URL('SettingsBrand.tsx',client),'utf8'),
  ])
  assert.doesNotMatch(brand,/BrandLogo|<img/)
  assert.match(brand,/t\('shell\.settings'\)/)
  assert.doesNotMatch(shell,/settings\.description/)
  assert.doesNotMatch(shell,/AI-Native Team Studio|Personal|Local deployment|单机部署/)
})

test('设置目录和内容建立明确的可访问关联',async()=>{
  const shell=await readFile(new URL('SettingsShell.tsx',client),'utf8')
  assert.match(shell,/const selectedRow=rows\.find\(row=>row\.id===active\)\?\?rows\[0\]/)
  assert.match(shell,/id=\{`settings-entry-\$\{row\.id\}`\}/)
  assert.match(shell,/aria-controls="settings-content"/)
  assert.match(shell,/title=\{entryLabel\(row\)\}/)
  assert.match(shell,/id="settings-content"/)
  assert.match(shell,/aria-labelledby=\{selectedRow\?`settings-entry-\$\{selectedRow\.id\}`:undefined\}/)
})

test('设置页在窄栏中约束标题、操作和菜单宽度',async()=>{
  const [shell,css]=await Promise.all([
    readFile(new URL('SettingsShell.tsx',client),'utf8'),
    readFile(new URL('SettingsShell.module.css',client),'utf8'),
  ])
  assert.match(css,/\.shell\{[^}]*overflow:hidden/)
  assert.match(css,/\.heading\{[^}]*flex:1[^}]*min-width:0/)
  assert.match(css,/\.actions\{[^}]*max-width:100%/)
  assert.match(css,/\.actions\{[^}]*flex-wrap:wrap/)
  assert.match(css,/\.navigation button\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis/)
  assert.match(shell,/className=\{css\.navigationViewport\}/)
  assert.match(shell,/className=\{css\.navigationScrollHint\} aria-hidden="true"/)
  assert.match(css,/@media\(max-width:760px\)[\s\S]*\.navigationViewport\{[^}]*max-width:100%[^}]*overflow:hidden/)
  assert.match(css,/@media\(max-width:760px\)[\s\S]*\.navigation button\{[^}]*max-width:none[^}]*overflow:visible[^}]*text-overflow:clip/,'窄屏标签不能被省略号截断')
  assert.match(css,/@media\(max-width:760px\)[\s\S]*\.navigationScrollHint\{[^}]*display:flex/,'横向目录需要可见的继续滚动提示')
  assert.match(css,/@media\(max-width:760px\)[\s\S]*\.navigation\{[^}]*scrollbar-width:thin/,'横向目录保留可见滚动轨道')
})

test('设置目录注册使用随当前语言求值的标签',async()=>{
  const [entry,integration]=await Promise.all([
    readFile(new URL('index.ts',client),'utf8'),
    readFile(new URL('settings-integration.ts',client),'utf8'),
  ])
  assert.match(entry,/id:'teloa-about'[\s\S]{0,120}label:\(\)=>requireI18n\(\)\.t\('settings\.about'\)/)
  assert.match(integration,/id:'teloa-workspaces'[\s\S]{0,120}label:\(\)=>t\('settings\.workspace'\)/)
  assert.match(integration,/id:'general'[\s\S]{0,120}label:\(\)=>t\('settings\.general'\)/)
  assert.doesNotMatch(entry,/id:'teloa-about'[\s\S]{0,120}label:'关于'/)
  assert.doesNotMatch(integration,/label:'(?:执行位置|通用设置)'/)
})
