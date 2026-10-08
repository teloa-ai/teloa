import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {prototypeThemes} from '../src/brand/prototype-theme.ts'
import {serveIndex} from './fixtures/dsh-web-shell.ts'

// 官方入口模块：刷新时 DSH 外壳在这里向 #root 追加启动卡片。
const entryScript=/\/assets\/index-[^/]+\.js$/
const brand=(name:string)=>readFile(new URL('../src/brand/'+name,import.meta.url),'utf8')
const logotypes={light:await brand('teloa-light.svg'),dark:await brand('teloa-dark.svg')}
const light=prototypeThemes.light,dark=prototypeThemes.dark
const rgb=(hex:string)=>'rgb('+[1,3,5].map(at=>parseInt(hex.slice(at,at+2),16)).join(', ')+')'
/** 背景图里的字标是哪一份现有文件（逐字比较）。 */
const logotype=(image:string)=>{
 const source=decodeURIComponent(image.match(/url\("data:image\/svg\+xml,([^"]+)"\)/)?.[1]??'')
 return source===logotypes.light?'light':source===logotypes.dark?'dark':'none'
}
const shell=async(page:any)=>{
 const state=await page.evaluate(()=>{
  const root=document.getElementById('root')!,before=getComputedStyle(root,'::before'),after=getComputedStyle(root,'::after')
  return {children:root.childElementCount,
   overlay:{content:before.content,position:before.position,inset:[before.top,before.right,before.bottom,before.left].join(' '),background:before.backgroundColor,image:before.backgroundImage,size:before.backgroundSize},
   indicator:{content:after.content,position:after.position,width:after.width,height:after.height,animation:after.animationName,track:after.backgroundColor}}
 })
 return {...state,overlay:{...state.overlay,image:logotype(state.overlay.image)}}
}
const capture=process.env.TELOA_WEB_SHELL_CAPTURE
// 截图留给人工核对：等加载条走到中段再拍。
const shot=async(page:any,name:string)=>{if(capture){await mkdir(capture,{recursive:true});await page.waitForTimeout(700);await page.screenshot({path:join(capture,name+'.png')})}}

async function open(browser:any,origin:string,{colorScheme='light',reducedMotion='no-preference',script='hold'}:{colorScheme?:'light'|'dark';reducedMotion?:'reduce'|'no-preference';script?:'hold'|'block'}={}){
 const page=await browser.newPage({viewport:{width:1000,height:700},colorScheme,reducedMotion})
 // 启动就绪由测试放行：先停在 DSH 加载中的真实启动卡片，再决定挂载或失败。
 await page.addInitScript(()=>{let releaseBoot=()=>{};const promise=new Promise<void>(done=>{releaseBoot=done});Object.assign(globalThis,{__DSH_BOOT_READY__:{promise,resolve(){},reject(){}},releaseBoot})})
 let release=()=>{};const held=new Promise<void>(done=>{release=done})
 await page.route(entryScript,async(route:any)=>{if(script==='block')return route.abort();await held;await route.continue()})
 await page.goto(origin+'/',{waitUntil:'commit'})
 await page.waitForFunction(()=>document.readyState!=='loading'&&[...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].every(link=>link.sheet))
 return {page,runEntry:release}
}

test('刷新时先显示 Teloa 字标与加载指示，加载中盖住 DSH 启动卡片，加载失败时让出失败说明并换上 Teloa 字标',async t=>{
 const {origin}=await serveIndex(t)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const {page,runEntry}=await open(browser,origin)
 assert.equal(await page.title(),'Teloa')
 assert.equal(await page.evaluate(()=>document.body.innerText.trim()),'')
 assert.deepEqual(await shell(page),{children:0,
  overlay:{content:'""',position:'fixed',inset:'0px 0px 0px 0px',background:rgb(light['--teloa-design-bg']!),image:'light',size:'96px auto'},
  indicator:{content:'""',position:'fixed',width:'96px',height:'2px',animation:'teloa-boot-sweep',track:rgb(light['--teloa-design-border']!)}})
 await shot(page,'light')
 // 加载条一直在动：比较前先藏起来，只比较遮罩是否盖住官方启动卡片。
 const still=await page.addStyleTag({content:'#root::after{visibility:hidden!important}'})
 const first=await page.screenshot()
 runEntry()
 await page.locator('#root > [data-dsh-boot] [data-dsh-boot-spinner]').waitFor({state:'attached'})
 assert.deepEqual(await page.evaluate(()=>[...document.getElementById('root')!.children].map(child=>child.hasAttribute('data-dsh-boot'))),[true],'#root 里只有 DSH 自己的启动卡片，挂载交接不受影响')
 assert.equal((await shell(page)).overlay.content,'""')
 assert.ok(Buffer.compare(await page.screenshot(),first)===0,'DSH 启动卡片被过渡画面盖住')
 await still.evaluate((element:HTMLElement)=>element.remove())
 await page.evaluate(()=>(globalThis as any).releaseBoot())
 await page.getByText('Failed to load plugins').waitFor()
 const failed=await shell(page)
 assert.deepEqual([failed.overlay.content,failed.indicator.content],['none','none'],'加载失败不能被过渡画面挡住')
 assert.ok(await page.getByText(/__ModuleLoader__/).isVisible(),'失败原因原样保留')
 const wordmark=await page.locator('#root > [data-dsh-boot] > * > :first-child').evaluate((element:HTMLElement)=>{
  const style=getComputedStyle(element);return {text:element.textContent,fontSize:style.fontSize,color:style.color,width:style.width,image:style.backgroundImage}
 })
 assert.deepEqual({...wordmark,image:logotype(wordmark.image)},{text:'HARNESS',fontSize:'0px',color:'rgba(0, 0, 0, 0)',width:'96px',image:'light'},'失败卡上的 DSH 字样换成 Teloa 字标')
 await shot(page,'failure')
})

test('减少动效时加载指示改为缓慢呼吸',async t=>{
 const {origin}=await serveIndex(t)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const {page}=await open(browser,origin,{reducedMotion:'reduce',script:'block'})
 const state=await shell(page)
 assert.equal(state.overlay.image,'light')
 assert.deepEqual([state.indicator.content,state.indicator.animation],['""','teloa-boot-breathe'])
 await shot(page,'reduced-motion')
})

test('工作台挂载替换 #root 内容后过渡画面消失',async t=>{
 const {origin}=await serveIndex(t)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const {page,runEntry}=await open(browser,origin)
 runEntry()
 await page.locator('#root > [data-dsh-boot] [data-dsh-boot-spinner]').waitFor({state:'attached'})
 assert.equal((await shell(page)).overlay.content,'""')
 // 与 DSH 渲染器一致：应用挂载后 #root 只剩工作台自己的节点。
 await page.evaluate(()=>{const main=document.createElement('main');main.textContent='工作台';document.getElementById('root')!.replaceChildren(main)})
 const mounted=await shell(page)
 assert.deepEqual([mounted.overlay.content,mounted.indicator.content],['none','none'])
 await page.getByText('工作台').waitFor()
})

test('过渡画面随系统深浅色，并尊重本人在设置里选的主题',async t=>{
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const scheme=async(origin:string,colorScheme:'light'|'dark',name?:string)=>{
  const {page}=await open(browser,origin,{colorScheme,script:'block'}),state=await shell(page)
  if(name)await shot(page,name)
  return {background:state.overlay.background,logotype:state.overlay.image,track:state.indicator.track}
 }
 const lightState={background:rgb(light['--teloa-design-bg']!),logotype:'light',track:rgb(light['--teloa-design-border']!)}
 const darkState={background:rgb(dark['--teloa-design-bg']!),logotype:'dark',track:rgb(dark['--teloa-design-border']!)}
 const system=(await serveIndex(t)).origin
 assert.deepEqual(await scheme(system,'light'),lightState)
 assert.deepEqual(await scheme(system,'dark','dark'),darkState)
 let preference:'light'|'dark'|'system'='dark'
 const chosen=(await serveIndex(t,{themePreference:()=>preference})).origin
 assert.deepEqual(await scheme(chosen,'light'),darkState,'本人选深色时不先闪浅色')
 preference='light'
 assert.deepEqual(await scheme(chosen,'dark'),lightState,'本人选浅色时不跟系统深色')
 preference='system'
 assert.deepEqual(await scheme(chosen,'dark'),darkState)
})
