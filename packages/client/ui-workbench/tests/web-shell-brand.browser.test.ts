import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,readFile} from 'node:fs/promises'
// @ts-expect-error 生成脚本是无类型声明的纯 Node 模块。
import {minifyLogotype} from '../scripts/generate-logotype.mjs'
import {join} from 'node:path'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {prototypeThemes} from '../src/brand/prototype-theme.ts'
import {TELOA_LOGOTYPE_SVG} from '../src/brand/logotype-svg.ts'
import {serveIndex} from './fixtures/dsh-web-shell.ts'

// 官方入口模块：刷新时 DSH 外壳在这里向 #root 追加启动卡片。
const entryScript=/\/assets\/index-[^/]+\.js$/
const light=prototypeThemes.light,dark=prototypeThemes.dark
const rgb=(hex:string)=>'rgb('+[1,3,5].map(at=>parseInt(hex.slice(at,at+2),16)).join(', ')+')'
const shell=(page:any)=>page.evaluate(()=>{
 const root=document.getElementById('root')!,before=getComputedStyle(root,'::before'),after=getComputedStyle(root,'::after')
 return {children:root.childElementCount,
  overlay:{content:before.content,position:before.position,inset:[before.top,before.right,before.bottom,before.left].join(' '),background:before.backgroundColor},
  logotype:{content:after.content,position:after.position,width:after.width,height:after.height,color:after.color,fill:after.backgroundColor,mask:(after.maskImage||after.webkitMaskImage).includes('data:image/svg+xml'),animation:after.animationName,track:after.getPropertyValue('--teloa-boot-track').trim()}}
})
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
  overlay:{content:'""',position:'fixed',inset:'0px 0px 0px 0px',background:rgb(light['--teloa-design-bg']!)},
  logotype:{content:'""',position:'fixed',width:'96px',height:'37px',color:rgb(light['--teloa-design-text']!),fill:rgb(light['--teloa-design-text']!),mask:true,animation:'teloa-boot-sweep',track:light['--teloa-design-border']}})
 await shot(page,'light')
 // 加载条一直在动：比较前先停住，只比较遮罩是否盖住官方启动卡片。
 const still=await page.addStyleTag({content:'#root::after{animation:none!important}'})
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
 assert.deepEqual([failed.overlay.content,failed.logotype.content],['none','none'],'加载失败不能被过渡画面挡住')
 assert.ok(await page.getByText(/__ModuleLoader__/).isVisible(),'失败原因原样保留')
 const wordmark=await page.locator('#root > [data-dsh-boot] > * > :first-child').evaluate((element:HTMLElement)=>{
  const style=getComputedStyle(element);return {text:element.textContent,fontSize:style.fontSize,width:style.width,fill:style.backgroundColor,mask:(style.maskImage||style.webkitMaskImage).includes('data:image/svg+xml')}
 })
 assert.deepEqual(wordmark,{text:'HARNESS',fontSize:'0px',width:'96px',fill:rgb(light['--teloa-design-text']!),mask:true},'失败卡上的 DSH 字样换成 Teloa 字标')
 await shot(page,'failure')
})

test('减少动效时加载指示改为缓慢呼吸',async t=>{
 const {origin}=await serveIndex(t)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const {page}=await open(browser,origin,{reducedMotion:'reduce',script:'block'})
 const state=await shell(page)
 assert.deepEqual([state.logotype.content,state.logotype.mask,state.logotype.animation],['""',true,'teloa-boot-breathe'])
 // 加载条不移动，只有颜色在边框色与次要文字色之间缓慢变化。
 const sample=()=>page.evaluate(()=>{const style=getComputedStyle(document.getElementById('root')!,'::after');return {color:style.getPropertyValue('--teloa-boot-pulse'),position:style.backgroundPosition}})
 const first=await sample();await page.waitForTimeout(800);const later=await sample()
 assert.equal(later.position,first.position)
 assert.notEqual(later.color,first.color)
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
 assert.deepEqual([mounted.overlay.content,mounted.logotype.content],['none','none'])
 await page.getByText('工作台').waitFor()
})

test('过渡画面随系统深浅色，并尊重本人在设置里选的主题',async t=>{
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const scheme=async(origin:string,colorScheme:'light'|'dark',name?:string)=>{
  const {page}=await open(browser,origin,{colorScheme,script:'block'}),state=await shell(page)
  if(name)await shot(page,name)
  return {background:state.overlay.background,logotype:state.logotype.color,track:state.logotype.track}
 }
 const lightState={background:rgb(light['--teloa-design-bg']!),logotype:rgb(light['--teloa-design-text']!),track:light['--teloa-design-border']}
 const darkState={background:rgb(dark['--teloa-design-bg']!),logotype:rgb(dark['--teloa-design-text']!),track:dark['--teloa-design-border']}
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

test('精简字形与原字标在工作台用到的尺寸上视觉一致',async t=>{
 const source=await readFile(new URL('../src/brand/teloa-light.svg',import.meta.url),'utf8')
 assert.equal(minifyLogotype(source),TELOA_LOGOTYPE_SVG)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage()
 // 按字形覆盖率（透明度）比较：原文件带固定颜色，精简字形用 currentColor，着色由使用方决定。
 const differences=await page.evaluate(async({original,minified}:{original:string;minified:string})=>{
  const load=(svg:string)=>new Promise<HTMLImageElement>((done,fail)=>{const image=new Image();image.onload=()=>done(image);image.onerror=fail;image.src='data:image/svg+xml,'+encodeURIComponent(svg)})
  const [a,b]=[await load(original),await load(minified)]
  return [96,192,384].map(width=>{
   const height=Math.ceil(width*108.79/567.33)
   const coverage=(image:HTMLImageElement)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d')!;context.drawImage(image,0,0,width,width*108.79/567.33);return context.getImageData(0,0,width,height).data}
   const left=coverage(a),right=coverage(b);let max=0,sum=0
   for(let at=3;at<left.length;at+=4){const delta=Math.abs(left[at]!-right[at]!);max=Math.max(max,delta);sum+=delta}
   return {width,max,mean:sum/(left.length/4)}
  })
 },{original:source,minified:TELOA_LOGOTYPE_SVG})
 for(const {width,max,mean} of differences){
  assert.ok(mean<0.1,width+'px 平均差 '+mean)
  assert.ok(max<=128,width+'px 最大差 '+max+'（只允许边缘抗锯齿的个别采样差）')
 }
})
