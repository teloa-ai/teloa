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

/** 失败卡上字样节点（换成 Teloa 字标）与失败标题的颜色，以及卡片底色。 */
const failureCard=(page:any)=>page.evaluate(()=>{
 const card=document.querySelector('#root > [data-dsh-boot]')!,wordmark=card.firstElementChild!.firstElementChild as HTMLElement
 const title=[...card.querySelectorAll('div')].find(element=>element.textContent==='Failed to load plugins')!
 const style=getComputedStyle(wordmark)
 return {text:wordmark.textContent,fontSize:style.fontSize,width:style.width,fill:style.backgroundColor,mask:(style.maskImage||style.webkitMaskImage).includes('data:image/svg+xml'),title:getComputedStyle(title).color,card:getComputedStyle(card).backgroundColor}
})
async function fail(page:any,runEntry:()=>void){
 runEntry()
 await page.locator('#root > [data-dsh-boot] [data-dsh-boot-spinner]').waitFor({state:'attached'})
 await page.evaluate(()=>(globalThis as any).releaseBoot())
 await page.getByText('Failed to load plugins').waitFor()
}

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
 const {title,card,...wordmark}=await failureCard(page)
 assert.deepEqual(wordmark,{text:'HARNESS',fontSize:'0px',width:'96px',fill:title,mask:true},'失败卡上的 DSH 字样换成 Teloa 字标，颜色与卡片文字一致')
 await shot(page,'failure')
})

test('减少动效时加载指示改为缓慢呼吸',async t=>{
 const {origin}=await serveIndex(t)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const {page}=await open(browser,origin,{reducedMotion:'reduce',script:'block'})
 const state=await shell(page)
 assert.deepEqual([state.logotype.content,state.logotype.mask,state.logotype.animation],['""',true,'teloa-boot-breathe'])
 // 加载条不移动，只有颜色在边框色与次要文字色之间缓慢往返：固定动画时间点取样，结果与运行快慢无关。
 const breathing=await page.evaluate(()=>{
  const style=getComputedStyle(document.getElementById('root')!,'::after')
  const animation=document.getAnimations().find(item=>(item as CSSAnimation).animationName==='teloa-boot-breathe')!
  animation.pause()
  const at=(time:number)=>{animation.currentTime=time;const current=getComputedStyle(document.getElementById('root')!,'::after');return {color:current.getPropertyValue('--teloa-boot-pulse'),position:current.backgroundPosition}}
  return {duration:style.animationDuration,count:style.animationIterationCount,direction:style.animationDirection,start:at(0),middle:at(1200),end:at(2399.9)}
 })
 assert.deepEqual([breathing.duration,breathing.count,breathing.direction],['2.4s','infinite','alternate'])
 assert.equal(breathing.start.color,rgb(light['--teloa-design-border']!),'起点是边框色')
 assert.notEqual(breathing.middle.color,breathing.start.color)
 assert.notEqual(breathing.end.color,breathing.middle.color)
 assert.equal(new Set([breathing.start.position,breathing.middle.position,breathing.end.position]).size,1,'加载条位置不变')
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
 // 4× 栅格化后对每个目标像素的 16 个样本取均值，避免微小坐标取整触发的边缘采样量化差异主导误差。
 // 仍在实际使用的目标尺寸上比较，保留原阈值；平移、缺字与轮廓变形须被同一判据拒绝。
 const controls=[
  ['路径平移',TELOA_LOGOTYPE_SVG.replace('<path ',"<path transform='translate(1.5 0)' ")],
  ['缺失首字母',TELOA_LOGOTYPE_SVG.replace(/d='M[^z]+z/,"d='")],
  ['轮廓变形',TELOA_LOGOTYPE_SVG.replace('M.5-2.5h105','M.5-2.5h100')],
 ] as const
 for(const [name,svg] of controls)assert.notEqual(svg,TELOA_LOGOTYPE_SVG,name+'对照确实改变字形')
 const differences=await page.evaluate(async({original,minified,controls}:{original:string;minified:string;controls:readonly(readonly[string,string])[]})=>{
  const load=(svg:string)=>new Promise<HTMLImageElement>((done,fail)=>{const image=new Image();image.onload=()=>done(image);image.onerror=fail;image.src='data:image/svg+xml,'+encodeURIComponent(svg)})
  const [a,...candidates]=await Promise.all([original,minified,...controls.map(([,svg])=>svg)].map(load))
  const samples=4
  return [96,192,384].map(width=>{
   const height=Math.ceil(width*108.79/567.33)
   const coverage=(image:HTMLImageElement)=>{
    const canvas=document.createElement('canvas');canvas.width=width*samples;canvas.height=height*samples
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0,width*samples,width*108.79/567.33*samples)
    const data=context.getImageData(0,0,canvas.width,canvas.height).data,alpha:number[]=[]
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
     let sum=0
     for(let dy=0;dy<samples;dy++)for(let dx=0;dx<samples;dx++)sum+=data[((y*samples+dy)*canvas.width+x*samples+dx)*4+3]!
     alpha.push(sum/(samples*samples))
    }
    return alpha
   }
   const left=coverage(a!)
   const compare=(image:HTMLImageElement)=>{
    const right=coverage(image);let max=0,sum=0
    for(let at=0;at<left.length;at++){const delta=Math.abs(left[at]!-right[at]!);max=Math.max(max,delta);sum+=delta}
    return {max,mean:sum/left.length}
   }
   return {width,...compare(candidates[0]!),controls:candidates.slice(1).map((image,index)=>({name:controls[index]![0],...compare(image)}))}
  })
 },{original:source,minified:TELOA_LOGOTYPE_SVG,controls})
 for(const {width,max,mean,controls} of differences){
  t.diagnostic(JSON.stringify({width,max,mean,controls}))
  assert.ok(mean<0.1,width+'px 平均差 '+mean)
  assert.ok(max<=128,width+'px 最大差 '+max+'（只允许边缘抗锯齿的个别采样差）')
  for(const control of controls)assert.ok(control.mean>=0.1||control.max>128,width+'px '+control.name+'应超过视觉一致性阈值')
 }
})

test('失败卡上的字标颜色与卡片文字一致，各主题状态下都看得清',async t=>{
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const check=async(origin:string,colorScheme:'light'|'dark',label:string)=>{
  const {page,runEntry}=await open(browser,origin,{colorScheme})
  await fail(page,runEntry)
  const state=await failureCard(page)
  assert.equal(state.fill,state.title,label+'：字标与失败标题同色')
  assert.notEqual(state.fill,state.card,label+'：字标与卡片底色不同')
 }
 const system=(await serveIndex(t)).origin
 await check(system,'light','系统浅色')
 await check(system,'dark','系统深色、没有主题插件')
 let preference:'light'|'dark'='dark'
 const chosen=(await serveIndex(t,{themePreference:()=>preference})).origin
 await check(chosen,'light','本人选深色')
 preference='light'
 await check(chosen,'dark','本人选浅色')
})

test('不支持遮罩的浏览器只显示底色与加载条，失败卡保留原字样',async t=>{
 const {origin}=await serveIndex(t)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const {page,runEntry}=await open(browser,origin)
 // 把 @supports 条件换成恒假，模拟不支持遮罩的浏览器。
 await page.evaluate(()=>{
  const own=[...document.querySelectorAll('style')].find(style=>style.textContent!.includes('--teloa-boot'))!
  own.textContent=own.textContent!.replace('@supports (mask-image:url("")) or (-webkit-mask-image:url(""))','@supports not (display:block)')
 })
 const state=await shell(page)
 assert.equal(state.overlay.background,rgb(light['--teloa-design-bg']!))
 assert.deepEqual({content:state.logotype.content,width:state.logotype.width,height:state.logotype.height,fill:state.logotype.fill,mask:state.logotype.mask,animation:state.logotype.animation},
  {content:'""',width:'96px',height:'2px',fill:'rgba(0, 0, 0, 0)',mask:false,animation:'teloa-boot-sweep'},'只剩加载条，不出现实色块')
 await fail(page,runEntry)
 const {title,card,...wordmark}=await failureCard(page)
 assert.deepEqual({text:wordmark.text,fontSize:wordmark.fontSize,mask:wordmark.mask,fill:wordmark.fill},{text:'HARNESS',fontSize:'16px',mask:false,fill:'rgba(0, 0, 0, 0)'},'失败卡保留原字样')
})
