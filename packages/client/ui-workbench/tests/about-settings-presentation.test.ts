import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {supportQrKind} from '../src/client/support-qr.ts'

test('关于页默认只显示紧凑联系入口，二维码按需在单一弹窗中呈现',async()=>{
  const [view,styles]=await Promise.all([
    readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/AboutSettings.module.css',import.meta.url),'utf8'),
  ])

  assert.match(view,/const \[activeQr,setActiveQr\]=useState/)
  assert.match(view,/role="dialog"/)
  assert.match(view,/aria-modal="true"/)
  assert.match(view,/activeQr&&<QrDialog/)
  assert.match(view,/className=\{css\.connectionSummary\}/)
  assert.match(view,/className=\{css\.connectionActions\}/)
  assert.doesNotMatch(view,/className=\{css\.connections\}/)
  assert.match(styles,/\.connectionSummary\{/)
  assert.match(styles,/\.dialogBackdrop\{/)
})

test('关于页二维码弹窗提供关闭文案并保留三个明确入口',async()=>{
  const [view,messages,locale]=await Promise.all([
    readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/i18n/messages.ts',import.meta.url),'utf8'),
    readFile(new URL('../src/client/i18n/locales/zh-CN.ts',import.meta.url),'utf8'),
  ])

  for(const key of ['about.author','about.followAccount','about.support'])assert.match(view,new RegExp(`t\\(['"]${key}['"]\\)`))
  assert.match(view,/t\(['"]about\.close['"]\)/)
  assert.match(messages,/'about\.close'/)
  assert.match(locale,/'about\.close': '关闭'/)
})

test('只有简体中文界面使用微信收款码，繁中与其他语言使用 PayPal 收款码',async()=>{
  assert.equal(supportQrKind('zh-CN'),'wechat')
  for(const locale of ['zh-Hant','zh-TW','zh-HK'] as const)assert.equal(supportQrKind(locale),'paypal',locale)
  for(const locale of ['en','ja','ko','vi','es','fr','de','pt'] as const)assert.equal(supportQrKind(locale),'paypal',locale)

  const view=await readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8')
  assert.match(view,/paypal-support\.jpg/)
  assert.match(view,/supportQrKind\(locale\)/)
  assert.match(view,/paypalQrCode,viewBox:'290 940 600 600'/)
})

test('构建基础只留标题与一句话致谢，不再显示 DSH 标识与版本号（用户 2026-09-20）',async()=>{
 const view=await readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(view,/dshMarkPath|__DSH_VERSION__|about\.dshMark|about\.version'/)
 assert.match(view,/<p className=\{css\.foundationLine\}>\{t\('about\.foundationDescription'\)\}<\/p>/)
 assert.doesNotMatch(view,/about\.foundation'/)
})

test('关于页列出 Max Luo、Morgan Chen、Caleb Pan，联系方式只保留一份且仍归属 Max Luo',async()=>{
  const view=await readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8')
  assert.match(view,/<strong>Max Luo<\/strong>/)
  assert.match(view,/<strong>Morgan Chen<\/strong>/)
  assert.match(view,/<strong>Caleb Pan<\/strong>/)
  assert.doesNotMatch(view,/>Max <span>/)
  assert.equal((view.match(/className=\{css\.contactLinks\}/g)||[]).length,1)
})

test('版本卡片区分当前开源版与规划中的专业客户端、托管和企业私有化部署',async()=>{
 const [view,styles,rows]=await Promise.all([
  readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8'),
  readFile(new URL('../src/client/AboutSettings.module.css',import.meta.url),'utf8'),
  readFile(new URL('../src/client/i18n/locales/about-plans.ts',import.meta.url),'utf8'),
 ])
 const names=[...view.matchAll(/name:'(Free|Pro|Cloud|Enterprise)'/g)].map(match=>match[1])
 assert.deepEqual(names,['Free','Pro','Cloud','Enterprise'])
 assert.equal((view.match(/current:true/g)||[]).length,1)
 assert.equal((view.match(/badge:'about.plans.planned'/g)||[]).length,3)
 assert.doesNotMatch(view,/LIMIT_ROWS|planLimits|name:'Team'/)
 assert.match(rows,/企业私有化部署/)
 for(const feature of ["多种智能体引擎","分布式部署","安全合规","操作审计","安全网关"])assert.ok(rows.includes(feature),feature)
 assert.doesNotMatch(rows,/企业私有化 Web|放开上限|Team 全部|托管模型额度/)
 assert.match(rows,/自备模型 API 密钥/)
 assert.match(rows,/Free 与 Pro 共享个人核心功能/)
 assert.match(styles,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
 const section=view.slice(view.indexOf('className={css.plansSection}'),view.indexOf('</section>',view.indexOf('className={css.plansSection}')))
 assert.doesNotMatch(section,/<button/)
})

test('版本与方案区不再有配额措辞小字（用户 2026-09-21 裁定：小字不加）',async()=>{
  const [view,rows]=await Promise.all([
    readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/i18n/locales/about-plans.ts',import.meta.url),'utf8'),
  ])
  assert.doesNotMatch(view,/about\.plans\.limitNote/)
  assert.doesNotMatch(rows,/about\.plans\.limitNote/)
})
