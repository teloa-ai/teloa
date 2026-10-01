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

test('欢迎区按新字标换算且保持帽高',async()=>{
  const styles=await readFile(new URL('ConversationBrand.module.css',client),'utf8')
  assert.doesNotMatch(styles,/618\.3|146\.3/)
  assert.match(styles,/calc\(var\(--brand-height\)\*567\.33\/108\.79\)/)
  assert.match(styles,/\.mark\{--brand-height:19px/)
  assert.match(styles,/max-width:740px\)\{\.mark\{--brand-height:18px\}/)
})

test('关于页字标与欢迎区同帽高',async()=>{
  const about=await readFile(new URL('AboutSettings.tsx',client),'utf8')
  assert.match(about,/<BrandLogo theme=\{theme\} height=\{19\}\/>/)
})

test('左栏品牌区左缘与导航项对齐并按新字标校正尺寸',async()=>{
  const styles=await readFile(new URL('WorkbenchFrame.module.css',client),'utf8')
  // 个人版左栏顶部只剩品牌与「新建」，不再有空间名行：品牌块自己收着 16px 的底部留白，左缘仍是 10px。
  assert.match(styles,/\.brand\{display:flex;align-items:center;gap:9px;padding:4px 10px 16px\}/)
  assert.match(styles,/\.brand img\{display:block;width:81px;height:16px;object-fit:contain\}/)
  assert.match(styles,/\.brandIdentity\{[^}]*gap:4px/)
  assert.match(styles,/\.brandStudio\{[^}]*font-size:var\(--teloa-font-caption\);line-height:1\.4/)
  assert.match(styles,/\.navItem\{[^}]*padding:8px 10px/)
})
