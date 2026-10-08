import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {Context} from '@deepseek-ai/cordis'
import {prototypeThemes} from '../src/brand/prototype-theme.ts'
import {serveIndex,upstreamFile} from './fixtures/dsh-web-shell.ts'

const brandFile=(name:string)=>readFile(new URL('../src/brand/'+name,import.meta.url),'utf8')
const markSource=await brandFile('teloa-mark.svg')
const markPath=markSource.match(/ d="([^"]+)"/)![1]!,markViewBox=markSource.match(/viewBox="([^"]+)"/)![1]!
const light=prototypeThemes.light,dark=prototypeThemes.dark
// 宿主或网关会在 __DSH_BOOT__ 前后插入脚本；品牌改动不能挪动它们。
const hostRows=[
 {kind:'script',placement:'head',text:'globalThis.hostBridge=1'},
 {kind:'global',name:'__DSH_BOOT__',value:{entries:[{id:'plugin',url:'plugins/x/client.js'}]}},
 {kind:'script',placement:'body',text:'globalThis.hostBody=1'},
]
const ownStyle=/<style>[^<]*--teloa-boot[^<]*<\/style>/g

test('刷新首页标题为 Teloa，#root 保持为空，其余结构与注入顺序和上游逐字节一致',async t=>{
 const upstream=await (await fetch((await serveIndex(t,{brand:false,hostRows})).origin+'/')).text()
 const response=await fetch((await serveIndex(t,{hostRows})).origin+'/'),branded=await response.text()
 assert.equal(response.status,200)
 assert.match(upstream,/<title>DeepSeek Harness<\/title>/,'上游标题变化时需要重新核对品牌替换')
 assert.match(branded,/<title>Teloa<\/title>/)
 assert.doesNotMatch(branded,/DeepSeek Harness/)
 assert.ok(branded.includes('<div id="root"></div>'),'#root 不放任何节点，DSH 启动卡片交接只认它自己追加的节点')
 const own=branded.match(ownStyle)??[]
 assert.equal(own.length,1,'只加一段过渡样式')
 assert.doesNotMatch(own[0]!,/<script/i)
 assert.equal(branded.replace(own[0]!,'').replace('<title>Teloa</title>','<title>DeepSeek Harness</title>'),upstream)
})

test('浅色与深色网站图标是 Teloa 标识，沿用上游地址',async t=>{
 const {origin}=await serveIndex(t)
 for(const [path,ink] of [['/favicon.svg',light['--teloa-design-text']],['/favicon-dark.svg',dark['--teloa-design-text']]] as const){
  const response=await fetch(origin+path),body=await response.text()
  assert.equal(response.status,200,path)
  assert.equal(response.headers.get('content-type'),'image/svg+xml',path)
  assert.notEqual(body,await upstreamFile(path.slice(1)),path)
  assert.ok(body.includes(`viewBox="${markViewBox}"`),path)
  assert.ok(body.includes(`d="${markPath}"`),'与 teloa-mark.svg 同一字形')
  assert.ok(body.includes(`fill="${ink}"`),path)
  assert.doesNotMatch(body,/<text|DeepSeek|DSH/)
  const head=await fetch(origin+path,{method:'HEAD'})
  assert.equal(head.status,200);assert.equal(await head.text(),'')
  assert.equal((await fetch(origin+path,{method:'POST'})).status,405)
 }
 assert.equal((await fetch(origin+'/LICENSE')).status,404,'其余地址仍由官方静态服务处理')
})

test('应用清单 name 与 short_name 为 Teloa，主题色与背景色取 Teloa 浅色令牌，其余字段与上游一致',async t=>{
 const {origin}=await serveIndex(t)
 const response=await fetch(origin+'/manifest.webmanifest')
 assert.equal(response.status,200)
 assert.equal(response.headers.get('content-type'),'application/manifest+json')
 const manifest=await response.json(),upstream=JSON.parse(await upstreamFile('manifest.webmanifest'))
 assert.deepEqual(manifest,{...upstream,name:'Teloa',short_name:'Teloa',theme_color:light['--teloa-design-bg'],background_color:light['--teloa-design-bg']})
})

test('过渡画面只是 #root 的样式：字标逐字取自现有文件，带加载指示，不写任何文字',async t=>{
 const {origin}=await serveIndex(t)
 const css=(await (await fetch(origin+'/')).text()).match(ownStyle)![0]!
 assert.doesNotMatch(css,/DeepSeek|Harness/i)
 assert.deepEqual(css.match(/content:[^;}]*/g),['content:""','content:""'],'两个伪元素都不带文字')
 const images=[...css.matchAll(/url\("data:image\/svg\+xml,([^"]+)"\)/g)].map(match=>decodeURIComponent(match[1]!))
 assert.deepEqual(images,[await brandFile('teloa-light.svg'),await brandFile('teloa-dark.svg')],'浅色与深色字标各一份，逐字取自现有文件')
 assert.ok(css.includes(light['--teloa-design-bg']!)&&css.includes(dark['--teloa-design-bg']!))
 assert.match(css,/prefers-color-scheme:dark/)
 assert.match(css,/body\[data-ds-dark-theme\]/,'本人选的深色主题优先')
 assert.match(css,/@keyframes teloa-boot-sweep/)
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{[^@]*animation:teloa-boot-breathe/)
})

test('没有 webServer 的组合（桌面壳）照常加载，只登记过渡样式行',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(await import('../src/index.ts'))
 const table:Array<{kind:string;text?:string}>=[]
 ctx.emit('webserver/index-inject',table)
 assert.equal(table.length,1)
 assert.equal(table[0]!.kind,'style')
 assert.match(table[0]!.text!,/--teloa-boot/)
})
