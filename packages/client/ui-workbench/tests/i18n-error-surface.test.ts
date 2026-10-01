import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const root=new URL('../src/client/',import.meta.url)

test('会话目录和首页经安全错误映射显示目录读取失败',async()=>{
  const [binding,directory,home]=await Promise.all([
    readFile(new URL('binding-client.ts',root),'utf8'),
    readFile(new URL('WorkDirectory.tsx',root),'utf8'),
    readFile(new URL('WorkHome.tsx',root),'utf8'),
  ])
  assert.doesNotMatch(binding,/error instanceof Error\?error\.message:'工作目录读取失败。'/)
  for(const source of [directory,home]){
    assert.match(source,/localizeWorkError\(locale,directory\.error\)/)
    assert.doesNotMatch(source,/\{error\|\|directory\.error\}/)
  }
})

test('市场和行业恢复界面不向 alert 透传原始错误文本',async()=>{
  const [market,savedIndustry,load,frame]=await Promise.all([
    readFile(new URL('MarketPage.tsx',root),'utf8'),
    readFile(new URL('SavedIndustryDirectory.tsx',root),'utf8'),
    readFile(new URL('IndustryLoadForm.tsx',root),'utf8'),
    readFile(new URL('WorkbenchFrame.tsx',root),'utf8'),
  ])
  assert.doesNotMatch(market,/error instanceof Error\?error\.message/)
  assert.match(market,/localizeWorkError\(locale,error\)/)
  assert.match(savedIndustry,/localizeWorkError\(locale,knowledge\.recoveryError\?\?knowledge\.error\)/)
  assert.match(frame,/setIndustryRoleError\(localizeWorkError\(locale,error\)\)/)
  assert.match(savedIndustry,/roles\.recoveryError\?localizeWorkError\(locale,roles\.recoveryError\):roles\.error/)
  assert.match(load,/localizeWorkError\(locale,recoveryError\)/)
})

test('任务、成果、岗位与交接恢复错误均经过稳定错误码本地化',async()=>{
  const [executions,artifacts,tasks,handoffs,frame]=await Promise.all([
    readFile(new URL('TaskExecutions.tsx',root),'utf8'),
    readFile(new URL('ArtifactPanel.tsx',root),'utf8'),
    readFile(new URL('TaskPage.tsx',root),'utf8'),
    readFile(new URL('TaskHandoffs.tsx',root),'utf8'),
    readFile(new URL('WorkbenchFrame.tsx',root),'utf8'),
  ])
  assert.match(executions,/localizeWorkError\(locale,api\.recoveryMessage\(\)\)/)
  assert.match(artifacts,/localizeWorkError\(locale,recovery\.message\)/)
  assert.match(tasks,/localizeWorkError\(locale,persistence\?\.stateError\)/)
  assert.match(handoffs,/localizeWorkError\(locale,api\.changeError\)/)
  assert.match(frame,/localizeWorkError\(locale,taskApi\.recoveryMessage\(\)\)/)
  assert.match(frame,/localizeWorkError\(locale,roleApi\.recoveryMessage\(\)\)/)
  assert.match(frame,/localizeWorkError\(locale,handoffApi\.recoveryMessage\(\)\)/)
})

test('关于页只呈现一次 AI-Native Team Studio 品牌概念',async()=>{
  const source=await readFile(new URL('AboutSettings.tsx',root),'utf8')
  assert.doesNotMatch(source,/<strong>AI-Native Team Studio<\/strong>/)
  assert.match(source,/t\('about\.studio'\)/)
})
