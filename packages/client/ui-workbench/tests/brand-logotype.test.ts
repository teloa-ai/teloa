import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {LOGOTYPE_ASPECT} from '../src/brand/logotype.ts'

const brand=new URL('../src/brand/',import.meta.url)
const client=new URL('../src/client/',import.meta.url)
const baseline=JSON.parse(await readFile(new URL('./fixtures/ui-freeze-baseline.json',import.meta.url),'utf8'))

test('字标 SVG 用新版外框且不含重影图层',async()=>{
  for(const [file,fill] of [['teloa-light.svg','#242723'],['teloa-dark.svg','#E9ECE4']] as const){
    const source=await readFile(new URL(file,brand),'utf8')
    assert.ok(source.includes(`viewBox="${baseline.brand.viewBox}"`),file)
    assert.doesNotMatch(source,/<filter|opacity/,file)
    assert.match(source,new RegExp('fill="'+fill+'"'),file)
    assert.doesNotMatch(source,/viewBox="-44\.5 -10\.3 618\.3 146\.3"/,file)
  }
})

test('方块标只有 T 字形并按配色方案切色',async()=>{
  const mark=await readFile(new URL('teloa-mark.svg',brand),'utf8')
  assert.match(mark,/viewBox="-16 -19 138 138"/)
  assert.match(mark,/prefers-color-scheme:\s*dark/)
  assert.match(mark,/#242723/)
  assert.match(mark,/#E9ECE4/)
  assert.doesNotMatch(mark,/currentColor/)
  assert.doesNotMatch(mark,/<rect|<filter|opacity/)
  assert.match(mark,/role="img"/)
  assert.match(mark,/aria-label="Teloa"/)
})

test('宽高比常量集中在 logotype.ts 并被 BrandLogo 使用',async()=>{
  assert.equal(LOGOTYPE_ASPECT,baseline.brand.width/baseline.brand.height)
  const logo=await readFile(new URL('BrandLogo.tsx',client),'utf8')
  assert.match(logo,/LOGOTYPE_ASPECT/)
  assert.match(logo,/height\*LOGOTYPE_ASPECT/)
  assert.doesNotMatch(logo,/618\.3|146\.3/)
})

test('欢迎区主助手头像复用员工头像组件，品牌槽不复制原输入与工作区',async()=>{
  const [brand,welcome,styles]=await Promise.all([readFile(new URL('ConversationBrand.tsx',client),'utf8'),readFile(new URL('ConversationWelcome.tsx',client),'utf8'),readFile(new URL('ConversationWelcome.module.css',client),'utf8')])
  assert.match(brand,/<ConversationWelcome\/>/)
  assert.match(welcome,/<EmployeeAvatar assistant/)
  assert.match(styles,/width:48px;height:48px/,'1.0 欢迎区头像 48px')
  assert.doesNotMatch(brand+welcome,/textarea|workspace\.select|createSession/)
})

test('关于页字标与欢迎区同帽高',async()=>{
  const about=await readFile(new URL('AboutSettings.tsx',client),'utf8')
  assert.match(about,/<BrandLogo theme=\{theme\} height=\{19\}\/>/)
})

test('左栏品牌区左缘与导航项对齐并按新字标校正尺寸',async()=>{
  const styles=await readFile(new URL('WorkbenchFrame.module.css',client),'utf8')
  // 1.0：品牌与「新建」「搜索」同处顶部一行，品牌块左缘 10px 与导航项文字对齐，留白交给行容器。
  assert.match(styles,/\.brand\{display:flex;align-items:center;gap:9px;padding:0 0 0 10px\}/)
  assert.match(styles,/\.navHeader\{display:flex;align-items:center;justify-content:space-between;[^}]*min-height:28px/)
  assert.match(styles,/\.brand img\{display:block;width:81px;height:16px;object-fit:contain\}/)
  assert.match(styles,/\.brandIdentity\{[^}]*gap:4px/)
  assert.match(styles,/\.brandStudio\{[^}]*font-size:var\(--teloa-font-caption\);line-height:1\.4/)
  // 版本名紧跟字标显示为小号灰字，不做胶囊：长名称（Enterprise）与短名称（Pro）都不抢字标。
  // 只取基础规则：窄屏抽屉另有 `.navigation .brandTier{display:none}` 收起版本名。
  const tier=styles.match(/(?:^|\})\.brandTier\{[^}]*\}/m)?.[0]??""
  assert.match(tier,/padding:0;border:0;background:none/)
  assert.match(tier,/font-size:var\(--teloa-font-caption\);line-height:16px;font-weight:var\(--teloa-weight-regular\)/)
  assert.doesNotMatch(tier,/border-radius|border:1px/)
  assert.match(styles,/\.navItem\{[^}]*min-height:34px;[^}]*padding:0 10px/)
})

test('侧栏品牌行为非中文版本名留出空间，长名称收缩而不是压住新建与搜索',async()=>{
  const styles=await readFile(new URL('WorkbenchFrame.module.css',client),'utf8')
  // 英文 Community 比中文社区版宽；236px 侧栏下会伸到 quickActions。
  assert.match(styles,/\.navigation\{[^}]*width:266px;flex:0 0 266px/)
  const tier=styles.match(/(?:^|\})\.brandTier\{[^}]*\}/m)?.[0]??""
  assert.match(tier,/flex:0 1 auto/)
  assert.match(tier,/min-width:0/)
  assert.match(tier,/overflow:hidden/)
  assert.match(tier,/text-overflow:ellipsis/)
})
