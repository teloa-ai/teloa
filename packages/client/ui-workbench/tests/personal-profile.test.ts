import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {defaultPersonalDisplayName,normalizePersonalDisplayName,personalAvatarInitials,personalDisplayName} from '../src/client/personal-profile.ts'

test('个人资料不编造默认姓名，用户填写的姓名规范化',()=>{
  assert.equal(defaultPersonalDisplayName,'')
  assert.equal(normalizePersonalDisplayName('  Max   Luo  '),'Max Luo')
  assert.throws(()=>normalizePersonalDisplayName('   '),/不能为空/)
  assert.throws(()=>normalizePersonalDisplayName('我'.repeat(41)),/40/)
  assert.throws(()=>normalizePersonalDisplayName('max@example.test'),/邮箱/)
})

test('主界面使用真实姓名，缺失或邮箱姓名使用调用方的本地化账号标识',()=>{
  assert.equal(personalDisplayName('  Max\u00a0 Luo  ','账号'),'Max Luo')
  assert.equal(personalDisplayName('E\u0301lodie','Account'),'Élodie')
  for(const name of ['', '  ', 'max@example.test', 'Max <max@example.test>', 'max＠example.test', '🧑', '\u200b']){
    assert.equal(personalDisplayName(name,'账号'),'账号')
    assert.equal(personalDisplayName(name,'Account'),'Account')
    assert.equal(personalAvatarInitials(name),'')
  }
})

test('本人头像多段姓名取首尾缩写，单名与 Unicode 保留完整字素',()=>{
  for(const [name,expected] of [
    ['Max Luo','ML'], ['  max   luo  ','ML'], ['María del Carmen Sánchez','MS'],
    ['Max','M'], ['李雷','李'], ['김민수','김'], ['E\u0301lodie C\u0327elik','ÉÇ'],
    ['𐐨ana 𐐺in','𐐀𐐒'], ["‘Max’ Luo",'ML'], ['👩‍💻 Ana María','AM'],
  ])assert.equal(personalAvatarInitials(name!),expected,name)
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
    assert.match(source,/usePersonalProfile/)
    assert.match(source,/profile\.displayName/)
    assert.doesNotMatch(source,/Max · 本人/)
  }
})
