import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {supportQrKind} from '../src/client/support-qr.ts'
import {ABOUT_PLAN_MESSAGE_ROWS} from '../src/client/i18n/locales/about-plans.ts'

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

test('版本卡片描述三个产品定位与使用场景，不混入开发进度、认证技术或购买动作',async()=>{
 const [view,styles,rows]=await Promise.all([
  readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8'),
  readFile(new URL('../src/client/AboutSettings.module.css',import.meta.url),'utf8'),
  readFile(new URL('../src/client/i18n/locales/about-plans.ts',import.meta.url),'utf8'),
 ])
 const products=[...view.matchAll(/product:'(Free|Pro|Cloud|Enterprise)'/g)].map(match=>match[1])
 assert.deepEqual(products,['Free','Pro','Enterprise'])
 assert.match(view,/card\.product===application\.product/)
 assert.match(rows,/版本定位/)
 assert.match(rows,/开箱即用的 Mac 原生应用/)
 assert.match(rows,/手机随时新建、跟进与接续工作/)
 assert.match(rows,/AI 团队协作与自动化/)
 assert.match(rows,/企业云或内网部署/)
 assert.match(rows,/组织成员与共享 AI 员工/)
 assert.match(rows,/权限隔离与操作审计/)
 assert.match(rows,/SSO 与组织身份管理/)
 assert.match(rows,/企业数据与业务系统集成/)
 assert.doesNotMatch(rows,/尚未开放|尚未開放|规划中|規劃中|开发中|Alpha|not yet available|planned|Public Web|公开 Web|公開 Web/i)
 assert.doesNotMatch(rows,/Harness|技术候选|开发.{0,2}暂停/)
 assert.doesNotMatch(rows,/Cloud 是 Pro|Cloud execution belongs to Pro|备份恢复与更新维护|Local and cloud execution/)
 assert.doesNotMatch(view,/LIMIT_ROWS|planLimits|name:'Team'/)
 assert.match(rows,/客户掌控执行与数据/)
 assert.doesNotMatch(rows,/企业私有化 Web|放开上限|Team 全部|托管模型额度/)
 assert.match(rows,/自备模型 API 密钥/)
 assert.match(rows,/模型费用另计/)
 assert.match(rows,/三个版本共用 Teloa 核心/)
 for(const position of ['开源','个人 / 专业','企业团队'])assert.ok(rows.includes(position),position)
 assert.doesNotMatch(rows,/\bFree\b/)
 assert.ok(ABOUT_PLAN_MESSAGE_ROWS.every(row=>row.length===11&&row.slice(1).every(value=>value.trim())), '全部词条应完整覆盖十语言')
 assert.match(view,/t\(card\.product===application\.product\?'about\.plans\.current':card\.position\)/)
 assert.match(view,/<Check size=\{14\} aria-hidden/)
 assert.doesNotMatch(view,/Clock3|about\.plans\.planned|about\.plans\.available|about\.plans\.card\.community\.badge/)
 assert.match(styles,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
 const section=view.slice(view.indexOf('className={css.plansSection}'),view.indexOf('</section>',view.indexOf('className={css.plansSection}')))
 assert.doesNotMatch(section,/<button/)
})

test('版本定位区不再有配额措辞小字（用户 2026-09-21 裁定：小字不加）',async()=>{
  const [view,rows]=await Promise.all([
    readFile(new URL('../src/client/AboutSettings.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/i18n/locales/about-plans.ts',import.meta.url),'utf8'),
  ])
  assert.doesNotMatch(view,/about\.plans\.limitNote/)
  assert.doesNotMatch(rows,/about\.plans\.limitNote/)
})
