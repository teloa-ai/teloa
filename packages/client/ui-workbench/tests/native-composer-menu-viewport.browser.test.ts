import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile,readdir,mkdir,mkdtemp,rm,writeFile,statfs} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {build} from 'vite'
// @ts-expect-error 复用现有本机无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {dshFrontendBootStart} from './fixtures/dsh-official.ts'

test('NF03 原生加号候选菜单逃离滚动裁切，缩放/滚动/键盘/外点保持原草稿与控制器',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client')
 const evidence=process.env.TELOA_NF03_EVIDENCE??await mkdtemp(join(tmpdir(),'teloa-nf03-'))
 if(!process.env.TELOA_NF03_EVIDENCE)t.after(()=>rm(evidence,{recursive:true,force:true}))
 const minimumFreeBytes=Number(process.env.TELOA_NF03_MIN_FREE_BYTES??0)
 assert.ok(Number.isSafeInteger(minimumFreeBytes)&&minimumFreeBytes>=0)
 await mkdir(evidence,{recursive:true})
 const req=createRequire(new URL('../package.json',import.meta.url)),official=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const nativePath=join(dirname(req.resolve('@deepseek-ai/dsh-client-ui-input-trigger/package.json')),'lib/client.js'),native=await readFile(nativePath,'utf8')
 assert.equal(native.split('\t\texports.apply = apply;').length,2)
 // 只为夹具导出闭包中的真实 MenuView；其函数和真实 InputTriggerController 均不替写。
 const exposed=native.replace('\t\texports.apply = apply;','\t\texports.nf03Fixture={MenuView};\n\t\texports.apply = apply;')
 const frontend=join(dirname(official.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets')
 const source=await readFile(join(frontend,(await readdir(frontend)).find(x=>/^index-.*\.js$/.test(x))!),'utf8')
 const seedFactory=source.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1],boot=dshFrontendBootStart(source);assert.ok(seedFactory&&boot>0)
 const seedSource=source.slice(0,boot)+'\nexport const staticSeeds='+seedFactory+'();'
 const entry=`import {staticSeeds as seeds} from 'official-static-seeds';import {NativeComposerMenuViewport} from '${client}/NativeComposerMenuViewport.tsx';import home from '${client}/HomeNativeConversation.module.css';
 const React=seeds.react.default??seeds.react,{createElement:h,useState,useRef}=React,{createRoot}=seeds['react-dom/client'],factories=new Map();window.__ModuleLoader__={load:r=>factories.set(r.id,r.factory)};new Function(${JSON.stringify(exposed)})();
 const native=factories.get('@deepseek-ai/dsh-client-ui-input-trigger')(id=>{if(!(id in seeds))throw Error('未授权依赖 '+id);return seeds[id]}),MenuView=native.nf03Fixture.MenuView;
 const evidence=window.nf03={picks:0,mutations:0,renders:0,dismissals:0,launcherClicks:0,currentBinding:true};let input,setDraft,fix;
 const source={name:'command',trigger:'/',candidates:async()=>Array.from({length:24},(_,i)=>({name:'entry'+i,label:i===0?'文件':i===1?'目标':i===2?'计划':'候选 '+i,section:i<3?'材料':'指令'})),onPick:({candidate})=>{evidence.picks++;return {text:' ['+candidate.name+']'}}};
 const controller=new native.InputTriggerController({sessionId:'nf03-synthetic-local',roster:{all:()=>[source,{name:'employee',trigger:'@',candidates:async()=>[{name:'employee',label:'员工'}]}],sources:trigger=>trigger==='/'?[source]:[{name:'employee',trigger:'@',candidates:async()=>[{name:'employee',label:'员工'}]}]},actx:{bail:(_ctx,event,request)=>{if(event!=='slash/input-insert-text')throw Error('非本机草稿动作');evidence.mutations++;setDraft(value=>value+request.text);return true}}});
 function App(){const [draft,update]=useState('保留未发送草稿'),[enabled,setEnabled]=useState(false),ref=useRef(null);input=ref;setDraft=update;fix=setEnabled;evidence.renders++;
 return h('main',null,h('header',null,'工作台'),h('nav',null,'总览　　需要你　　任务　　自动化'),h('section',{id:'home',className:home.home},h('div',{className:home.homeConversation},h('div',{id:'native-shell'},h('div',{id:'card','data-composer-card':true},h('div',{'data-composer-overlay':true},h(MenuView,{menu:controller.menu,headers:controller.headers,onPick:(...x)=>controller.pick(...x),onCrumb:(...x)=>controller.pickCrumb(...x),onHover:(...x)=>controller.hover(...x),onDismiss:()=>controller.dismiss(),t:x=>x}),enabled&&h(NativeComposerMenuViewport,{dismissCommandMenu:()=>{const menu=controller.menu.getSnapshot();if(!evidence.currentBinding||!menu.open||menu.hit?.trigger!=='/'||menu.groups.length!==1||menu.groups[0]?.source!=='command')return false;controller.dismiss();evidence.dismissals++;return !controller.menu.getSnapshot().open}})),h('textarea',{ref,value:draft,'aria-label':'未发送草稿',onChange:e=>update(e.target.value),onKeyDown:e=>{const key={ArrowDown:'down',ArrowUp:'up',Escape:'escape',Enter:'enter',Tab:e.shiftKey?'tabBack':'tab'}[e.key];if(key&&controller.arbitrate(key,e.nativeEvent.isComposing)!=='pass')e.preventDefault()}}),h('button',{'aria-label':'添加','aria-haspopup':'listbox',onMouseDown:e=>e.preventDefault(),onClick:()=>{evidence.launcherClicks++;ref.current.focus();controller.toggleSource('command',{trigger:'/',query:'',quoted:false,position:'leading',span:{start:draft.length,end:draft.length,draftRev:1}});controller.track(draft,draft.length,{tier:'plain'},1)}},'+'),h('input',{type:'file',multiple:true,hidden:true})))),h('div',{id:'overview'},'工作概览')),
 h('button',{id:'outside'},'会话外部'))}
 window.nf03.enable=()=>fix(true);window.nf03.disable=()=>fix(false);window.nf03.controller=controller;createRoot(document.getElementById('root')).render(h(App));`
 await writeFile(join(evidence,'fixture.mjs'),entry)
 const seedId='\0nf03-seeds',reactId='\0nf03-react',jsxId='\0nf03-jsx'
 const reactSource="import {staticSeeds as s} from 'official-static-seeds';const v=s.react;export default v.default??v;export const {useState,useRef,useLayoutEffect}=v;"
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'nf03-real-native-seeds',enforce:'pre',resolveId:(id,importer)=>id==='official-static-seeds'?seedId:id==='react'?reactId:id==='react/jsx-runtime'?jsxId:importer===seedId&&id.startsWith('.')?resolve(frontend,id):null,load:id=>id===seedId?seedSource:id===reactId?reactSource:id===jsxId?"import {staticSeeds as s} from 'official-static-seeds';export const {jsx,jsxs,Fragment}=s['react/jsx-runtime'];":null}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(evidence,'fixture.mjs'),name:'NF03Fixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(x=>x.type==='chunk')!.code,css=bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')
 const themeSource=await readFile(join(dirname(req.resolve('@deepseek-ai/dsh-client-ui-theme/package.json')),'lib/client.js'),'utf8')
 const themeCSS=Array.from(themeSource.matchAll(/(?:var|const) \w+_css_default = ("(?:[^"\\]|\\.)*");/g),m=>JSON.parse(m[1]!)).join('\n')
 const nativeCSS=themeCSS+'\n'+(await Promise.all((await readdir(frontend)).filter(x=>x.endsWith('.css')).map(x=>readFile(join(frontend,x),'utf8')))).join('\n')
 const outcomes=[]
 for(const engine of (process.env.TELOA_NF03_BROWSERS??'chromium').split(',')){
  const fs=await statfs(root),beforeBrowserFreeBytes=fs.bavail*fs.bsize;assert.ok(beforeBrowserFreeBytes>=minimumFreeBytes,'本轮测试 floor 不满足，不启动浏览器')
  const executablePath=process.env['TELOA_NF03_'+engine.toUpperCase()+'_EXECUTABLE']
  const playwright=loadPlaywright(),browser=await playwright[engine].launch({...engine==='chromium'?launchOptions():{headless:true},...executablePath?{executablePath}:{}})
  try{
   const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(6000);page.on('pageerror',(e:Error)=>errors.push(e.message))
   await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/nf03'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head></head><body><div id="root"></div></body></html>'}):route.abort())
   await page.goto('http://127.0.0.1/nf03');await page.addStyleTag({content:nativeCSS+'\n'+css+'\nhtml,body{margin:0;height:100%;font-family:sans-serif;background:#faf9f7;color:#262624}header{height:60px;padding:16px;box-sizing:border-box}nav{height:48px;border-bottom:1px solid #ddd;padding-left:16px}#home{height:650px}#native-shell{height:410px;overflow:hidden;position:relative;display:flex;align-items:flex-end;padding:0 24px;box-sizing:border-box}#card{width:100%;height:126px;position:relative;border:1px solid #ddd;border-radius:12px;background:white;padding:12px;box-sizing:border-box}#card>[data-composer-overlay]{position:absolute;top:0;left:0;right:0;height:0}textarea{box-sizing:border-box;display:block;width:100%;height:70px;border:0;background:transparent;resize:none;font:inherit}#card>button{width:32px;height:30px;border:0;border-radius:6px}#overview{height:900px;padding:24px}#outside{position:fixed;right:8px;bottom:8px} [data-trigger-menu]{background:white}'})
   await page.addScriptTag({content:script});const add=page.getByRole('button',{name:'添加',exact:true}),draft=page.getByRole('textbox',{name:'未发送草稿'})
   await add.click();await page.locator('[data-trigger-menu]').waitFor();const before=await page.evaluate(()=>{const menu=document.querySelector<HTMLElement>('[data-trigger-menu]')!,clip=document.querySelector<HTMLElement>('#native-shell')!,r=menu.getBoundingClientRect(),c=clip.getBoundingClientRect();return {menuTop:r.top,clipTop:c.top,clipped:r.top<c.top}});assert.equal(before.clipped,true)
   if(engine==='chromium')await page.screenshot({path:join(evidence,'before-native-menu.png')})
   await page.evaluate(()=>(window as any).nf03.enable());await page.waitForFunction(()=>document.querySelector('[data-trigger-menu]')?.matches(':popover-open'))
   const fit=async()=>{await page.waitForTimeout(80);return page.evaluate(()=>{const m=document.querySelector<HTMLElement>('[data-trigger-menu]')!,r=m.getBoundingClientRect(),vv=visualViewport!;return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:vv.width,height:vv.height,x:vv.offsetLeft,y:vv.offsetTop,topLayer:m.matches(':popover-open'),visibleTop:document.elementFromPoint(r.left+20,r.top+12)?.closest('[data-trigger-menu]')===m}})}
   const first=await fit();assert.equal(first.topLayer,true);assert.equal(first.visibleTop,true);assert.ok(first.top>=first.y&&first.bottom<=first.y+first.height)
   const launched=await page.evaluate(()=>{const c=(window as any).nf03.controller;return {open:c.menu.getSnapshot().open,launcher:c.launcher.getSnapshot(),clicks:(window as any).nf03.launcherClicks}})
   assert.deepEqual({open:launched.open,launcher:launched.launcher},{open:true,launcher:null},'真实 track 更新后菜单仍开但 launcher 已丢失')
   await add.click();await page.locator('[data-trigger-menu]').waitFor({state:'detached'})
   assert.deepEqual(await page.evaluate(()=>({clicks:(window as any).nf03.launcherClicks,dismissals:(window as any).nf03.dismissals,open:(window as any).nf03.controller.menu.getSnapshot().open})),{clicks:launched.clicks,dismissals:1,open:false},'关闭经原生控制器，不再进入 focus/toggle 或只隐藏DOM')
   await add.click();await page.locator('[data-trigger-menu]').waitFor();await page.evaluate(()=>{(window as any).nf03.currentBinding=false})
   await add.click();await page.locator('[data-trigger-menu]').waitFor();assert.equal(await page.evaluate(()=>(window as any).nf03.dismissals),1,'失效scope不拦截原生点击')
   await page.evaluate(()=>{(window as any).nf03.currentBinding=true});await add.click();await page.locator('[data-trigger-menu]').waitFor({state:'detached'})
   await page.evaluate(()=>{const c=(window as any).nf03.controller;c.toggleSource('employee',{trigger:'@',query:'',quoted:false,position:'inline',span:{start:0,end:0,draftRev:1}})})
   await page.locator('[data-trigger-menu]').waitFor();const employeeBefore=await page.evaluate(()=>({clicks:(window as any).nf03.launcherClicks,dismissals:(window as any).nf03.dismissals}))
   await add.click();await page.locator('[data-trigger-menu]').waitFor();assert.deepEqual(await page.evaluate(()=>({clicks:(window as any).nf03.launcherClicks,dismissals:(window as any).nf03.dismissals,trigger:(window as any).nf03.controller.menu.getSnapshot().hit.trigger,commandOnly:(window as any).nf03.controller.menu.getSnapshot().groups.every((g:{source:string})=>g.source==='command')})),{clicks:employeeBefore.clicks+1,dismissals:employeeBefore.dismissals,trigger:'/',commandOnly:true},'员工候选已开时仍由原生加号切到command，不误当关闭')
   assert.equal(await draft.inputValue(),'保留未发送草稿');await page.keyboard.press('ArrowDown');assert.notEqual(await page.getByRole('listbox').getAttribute('aria-activedescendant'),null)
   await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');assert.ok((await page.getByRole('listbox').getAttribute('aria-activedescendant'))?.endsWith('-23'))
   await draft.dispatchEvent('keydown',{key:'Escape',isComposing:true});assert.equal(await page.locator('[data-trigger-menu]').count(),1,'IME期间Escape仍交原控制器，不关闭/发送')
   await page.keyboard.press('Escape');await page.locator('[data-trigger-menu]').waitFor({state:'detached'});assert.equal(await draft.inputValue(),'保留未发送草稿')
   await add.click();await page.waitForFunction(()=>document.querySelector('[data-trigger-menu]')?.matches(':popover-open'));await page.locator('#outside').click();await page.locator('[data-trigger-menu]').waitFor({state:'detached'});assert.equal(await draft.inputValue(),'保留未发送草稿')
   await add.click();await page.waitForFunction(()=>document.querySelector('[data-trigger-menu]')?.matches(':popover-open'));await page.screenshot({path:join(evidence,engine+'-normal.png')})
   await page.evaluate(()=>{document.getElementById('home')!.scrollTop=100});const scrolled=await fit();assert.ok(scrolled.top>=scrolled.y&&scrolled.bottom<=scrolled.y+scrolled.height)
   await page.evaluate(()=>{document.getElementById('home')!.scrollTop=0});await page.setViewportSize({width:640,height:450});const narrow=await fit();assert.ok(narrow.left>=narrow.x&&narrow.right<=narrow.x+narrow.width&&narrow.top>=narrow.y&&narrow.bottom<=narrow.y+narrow.height)
   await page.screenshot({path:join(evidence,engine+'-200pct-layout.png')});assert.equal(await draft.inputValue(),'保留未发送草稿')
   let visualViewport2x
   if(engine==='chromium'){
    await page.setViewportSize({width:1280,height:900});const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});const zoom=await fit();assert.ok(zoom.left>=zoom.x&&zoom.right<=zoom.x+zoom.width&&zoom.top>=zoom.y&&zoom.bottom<=zoom.y+zoom.height);visualViewport2x=zoom;await page.screenshot({path:join(evidence,'chromium-visual-viewport-2x.png')});await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});await cdp.detach()
   }
   await page.evaluate(()=>{(window as any).nf03.oldMenu=document.querySelector('[data-trigger-menu]');(window as any).nf03.disable()});assert.equal(await page.evaluate(()=>(window as any).nf03.oldMenu.hasAttribute('popover')),false);assert.equal(await page.evaluate(()=>(window as any).nf03.oldMenu.style.getPropertyValue('--native-menu-top')),'')
   const disabledBefore=await page.evaluate(()=>({clicks:(window as any).nf03.launcherClicks,dismissals:(window as any).nf03.dismissals}))
   await add.click();assert.deepEqual(await page.evaluate(()=>({clicks:(window as any).nf03.launcherClicks,dismissals:(window as any).nf03.dismissals})),{clicks:disabledBefore.clicks+1,dismissals:disabledBefore.dismissals},'卸载适配后 click 捕获已清理，仍由原生响应')
   assert.equal(await draft.inputValue(),'保留未发送草稿');assert.equal(await page.evaluate(()=>(window as any).nf03.mutations),0);assert.equal(await page.evaluate(()=>(window as any).nf03.picks),0)
   await page.evaluate(()=>(window as any).nf03.enable());await page.waitForFunction(()=>document.querySelector('[data-trigger-menu]')?.matches(':popover-open'));await page.getByRole('option').first().click();assert.equal(await draft.inputValue(),'保留未发送草稿 [entry0]');assert.equal(await page.evaluate(()=>(window as any).nf03.picks),1,'toplayer内React原生鼠标选择仍回原控制器');assert.deepEqual(errors,[])
   outcomes.push({engine,beforeBrowserFreeBytes,minimumFreeBytes,before,first,scrolled,narrow,visualViewport2x,rawNativeSHA256:createHash('sha256').update(native).digest('hex'),realNativeControllerAndMenuView:true,IMEAndKeyboardControllerUnchanged:true,formalWrites:0,localDraftOnlyPicks:1,models:0,network:'all external aborted',errors})
   await writeFile(join(evidence,'browser-result.json'),JSON.stringify(outcomes,null,2)+'\n')
  }finally{await browser.close()}
 }
 await writeFile(join(evidence,'browser-result.json'),JSON.stringify(outcomes,null,2)+'\n')
})
