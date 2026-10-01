import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {defaultPersonalDisplayName,normalizePersonalDisplayName} from '../src/client/personal-profile.ts'

test('个人版用户名规范化并提供可用默认身份',()=>{
  assert.equal(defaultPersonalDisplayName,'Max')
  assert.equal(normalizePersonalDisplayName('  Max   Luo  '),'Max Luo')
  assert.throws(()=>normalizePersonalDisplayName('   '),/不能为空/)
  assert.throws(()=>normalizePersonalDisplayName('我'.repeat(41)),/40/)
})

test('导航账户区展示用户名与「我的分身」入口，不重复显示部署形态与个人偏好',async()=>{
  // 个人版壳层去掉了「我的工作空间」与部署徽标：姓名下面换成「我的分身」这一个入口。
  // navigation.localDeployment 在账户区退场后再无引用方，孤儿清理二期已连同十一列翻译一起删除。
  const [source,locale]=await Promise.all([
    readFile(new URL('../src/client/WorkNavigation.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/i18n/locales/zh-CN.ts',import.meta.url),'utf8'),
  ])
  assert.match(source,/profile\.displayName/)
  assert.match(source,/navigation\.twin/)
  assert.doesNotMatch(source,/navigation\.localDeployment/)
  assert.doesNotMatch(locale,/navigation\.localDeployment/)
  assert.doesNotMatch(source,/<strong>本人<\/strong>|>个人偏好</)
})

test('「个人版」标识不在品牌区、账户区或关于页重复出现',async()=>{
  const [source,home,about]=await Promise.all([
    readFile(new URL('../src/client/WorkNavigation.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/WorkHome.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8'),
  ])
  for(const [name,value] of [['WorkNavigation',source],['WorkHome',home],['AboutSettings',about]] as const){
    assert.doesNotMatch(value,/app\.edition\.personal/,name)
  }
})

test('首页与任务核对使用个人资料中的本人显示名',async()=>{
  const [home,task]=await Promise.all([
    readFile(new URL('../src/client/WorkHome.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/TaskPage.tsx',import.meta.url),'utf8'),
  ])
  for(const source of [home,task]){
    assert.match(source,/personalProfile/)
    assert.match(source,/profile\.displayName/)
    assert.doesNotMatch(source,/Max · 本人/)
  }
})
