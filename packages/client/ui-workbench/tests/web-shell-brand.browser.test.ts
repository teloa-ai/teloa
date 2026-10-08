import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {prototypeThemes} from '../src/brand/prototype-theme.ts'
import {serveIndex} from './fixtures/dsh-web-shell.ts'

// 官方入口模块：刷新时 DSH 外壳在这里向 #root 追加启动卡片。
const entryScript=/\/assets\/index-[^/]+\.js$/
const rgb=(hex:string)=>'rgb('+[1,3,5].map(at=>parseInt(hex.slice(at,at+2),16)).join(', ')+')'
const splash=(page:any)=>page.evaluate(()=>{
 const root=document.getElementById('root')!,style=getComputedStyle(root,'::before')
 return {children:root.childElementCount,content:style.content,position:style.position,inset:[style.top,style.right,style.bottom,style.left].join(' '),background:style.backgroundColor,image:style.backgroundImage,at:style.backgroundPosition,size:style.backgroundSize}
})
const visible=(state:{content:string})=>state.content!=='none'

async function open(browser:any,origin:string,{colorScheme='light',script='hold'}:{colorScheme?:'light'|'dark';script?:'hold'|'block'}={}){
 const page=await browser.newPage({viewport:{width:1000,height:700},colorScheme})
 // 启动就绪由测试放行：先停在 DSH 加载中的真实启动卡片，再决定挂载或失败。
 await page.addInitScript(()=>{let releaseBoot=()=>{};const promise=new Promise<void>(done=>{releaseBoot=done});Object.assign(globalThis,{__DSH_BOOT_READY__:{promise,resolve(){},reject(){}},releaseBoot})})
 let release=()=>{};const held=new Promise<void>(done=>{release=done})
 await page.route(entryScript,async(route:any)=>{if(script==='block')return route.abort();await held;await route.continue()})
 await page.goto(origin+'/',{waitUntil:'commit'})
 await page.waitForFunction(()=>document.readyState!=='loading'&&[...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].every(link=>link.sheet))
 return {page,runEntry:release}
}

test('刷新时先显示居中的 Teloa 标识，加载中盖住 DSH 启动卡片，加载失败时让出失败说明',async t=>{
 const {origin}=await serveIndex(t)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const {page,runEntry}=await open(browser,origin)
 assert.equal(await page.title(),'Teloa')
 assert.equal(await page.evaluate(()=>document.body.innerText.trim()),'')
 const before=await splash(page)
 assert.deepEqual({...before,image:before.image.includes('data:image/svg+xml')&&before.image.includes(encodeURIComponent(prototypeThemes.light['--teloa-design-text']!))},
  {children:0,content:'""',position:'fixed',inset:'0px 0px 0px 0px',background:rgb(prototypeThemes.light['--teloa-design-bg']!),image:true,at:'50% 50%',size:'56px 56px'})
 const first=await page.screenshot()
 runEntry()
 await page.locator('#root > [data-dsh-boot] [data-dsh-boot-spinner]').waitFor({state:'attached'})
 assert.deepEqual(await page.evaluate(()=>[...document.getElementById('root')!.children].map(child=>child.hasAttribute('data-dsh-boot'))),[true],'#root 里只有 DSH 自己的启动卡片，挂载交接不受影响')
 assert.ok(visible(await splash(page)))
 assert.ok(Buffer.compare(await page.screenshot(),first)===0,'DSH 启动卡片被过渡画面盖住')
 await page.evaluate(()=>(globalThis as any).releaseBoot())
 await page.getByText('Failed to load plugins').waitFor()
 assert.equal((await splash(page)).content,'none','加载失败不能被过渡画面挡住')
})

test('工作台挂载替换 #root 内容后过渡画面消失',async t=>{
 const {origin}=await serveIndex(t)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const {page,runEntry}=await open(browser,origin)
 runEntry()
 await page.locator('#root > [data-dsh-boot] [data-dsh-boot-spinner]').waitFor({state:'attached'})
 assert.ok(visible(await splash(page)))
 // 与 DSH 渲染器一致：应用挂载后 #root 只剩工作台自己的节点。
 await page.evaluate(()=>{const main=document.createElement('main');main.textContent='工作台';document.getElementById('root')!.replaceChildren(main)})
 assert.equal((await splash(page)).content,'none')
 await page.getByText('工作台').waitFor()
})

test('过渡画面随系统深浅色，并尊重本人在设置里选的主题',async t=>{
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const scheme=async(origin:string,colorScheme:'light'|'dark')=>{
  const {page}=await open(browser,origin,{colorScheme,script:'block'}),state=await splash(page)
  return {background:state.background,ink:[prototypeThemes.light,prototypeThemes.dark].findIndex(theme=>state.image.includes(encodeURIComponent(theme['--teloa-design-text']!)))}
 }
 const lightState={background:rgb(prototypeThemes.light['--teloa-design-bg']!),ink:0},darkState={background:rgb(prototypeThemes.dark['--teloa-design-bg']!),ink:1}
 const system=(await serveIndex(t)).origin
 assert.deepEqual(await scheme(system,'light'),lightState)
 assert.deepEqual(await scheme(system,'dark'),darkState)
 let preference:'light'|'dark'|'system'='dark'
 const chosen=(await serveIndex(t,{themePreference:()=>preference})).origin
 assert.deepEqual(await scheme(chosen,'light'),darkState,'本人选深色时不先闪浅色')
 preference='light'
 assert.deepEqual(await scheme(chosen,'dark'),lightState,'本人选浅色时不跟系统深色')
 preference='system'
 assert.deepEqual(await scheme(chosen,'dark'),darkState)
})
