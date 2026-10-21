import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有浏览器夹具没有声明文件。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
import {businessMoreActions} from '../src/client/business-more-actions.ts'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,temp:string,script:string,styles:string
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {BusinessMoreMenu} from '${client}BusinessMoreMenu.tsx';import {ContextDrawer} from '${client}ContextDrawer.tsx';import {BusinessShareForm} from '${client}BusinessShareForm.tsx';import {BusinessDashboardShareForm} from '${client}BusinessDashboardShareForm.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import tokens from '${client}theme-tokens.module.css';import css from '${client}BusinessPage.module.css';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(k,p)=>translateMessage('zh-CN',k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.moreFixture={calls:[]};f.theme=dark=>{for(const [k,v] of Object.entries(prototypeThemes[dark?'dark':'light']))document.body.style.setProperty(k,v)};f.theme(false);
const hosts=[0,1].map(()=>({dashboard:{export:async()=>{f.calls.push('unexpected export');throw Error()}},share:{source:{read:async()=>({objectTypes:[{}],views:[],actions:[],sources:[],available:[]})},plan:async()=>{f.calls.push('unexpected plan');throw Error()}}}));
function App(){const [sharing,setSharing]=useState(),[host,setHost]=useState(0),[namespace,setNamespace]=useState(0);f.currentHost=host;f.currentNamespace=namespace;f.namespace=()=>setNamespace(value=>1-value);f.host=()=>setHost(value=>1-value);const [scope,setScope]=useState('SOC'),[blocked,setBlocked]=useState(false),[compact,setCompact]=useState(false);f.compact=()=>setCompact(true);f.general=()=>setScope('general');f.block=()=>setBlocked(true);return <I18nProvider runtime={runtime}><main className={tokens.tokens}><button type="button">菜单外面</button><button type="button" onClick={()=>setSharing('formal')}>打开正式分享</button><button type="button" onClick={()=>setSharing('legacy')}>打开旧业务分享</button><textarea aria-label="原会话草稿" defaultValue="关闭菜单后仍保留"/><div data-menu-clip style={compact?{height:220,overflow:'auto',marginTop:300}:undefined}><section className={css.page} style={{height:'auto'}}><div style={{display:'flex',justifyContent:'flex-end'}}><BusinessMoreMenu scope={scope} unavailable={blocked?{changes:'当前连接正在核对'}:{}} choose={(action,scope)=>f.calls.push({action,scope})}/></div></section></div>{sharing&&<ContextDrawer title="分享业务配置" close={()=>setSharing(undefined)}>{sharing==='formal'?<BusinessDashboardShareForm key={host+sharing} scope="SOC" api={hosts[host].dashboard} share={hosts[host].share} draftKey={'test-business-share/'+namespace+'/'+host+'/SOC/formal'} openMarket={()=>{}}/>:<BusinessShareForm key={host+sharing} scope="SOC" api={hosts[host].share} draftKey={'test-business-share/'+namespace+'/'+host+'/SOC/legacy'} openMarket={()=>{}}/>}</ContextDrawer>}</main></I18nProvider>}
createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-business-more-'));await writeFile(join(temp,'entry.tsx'),entry)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'entry.tsx'),name:'BusinessMoreFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(x=>x.type==='chunk')!.code;styles=bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

for(const mode of ['business-desktop','business-narrow-dark','general'] as const)test(mode+' 更多顺序、全部动作范围、关闭和草稿保留',async t=>{
 const page=await browser.newPage({viewport:{width:mode==='business-narrow-dark'?430:1400,height:700}});page.setDefaultTimeout(5000);t.after(()=>page.close())
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(r:any)=>r.abort())
 await page.route('http://127.0.0.1:3269/more-fixture',(r:any)=>r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'}));await page.goto('http://127.0.0.1:3269/more-fixture');await page.addStyleTag({content:styles+'body{margin:0;background:var(--teloa-background);color:var(--teloa-text);font-family:var(--teloa-design-font)}main{padding:20px}*{box-sizing:border-box}'});await page.addScriptTag({content:script})
 await page.evaluate((mode:string)=>{const f=(window as any).moreFixture;f.theme(mode==='business-narrow-dark');if(mode==='general')f.general()},mode)
 const summary=page.locator('summary').first(),group=page.getByRole('group',{name:'更多业务功能',exact:true})
 await summary.click();await group.waitFor()
 const actions=businessMoreActions(mode==='general'?'general':'SOC')
 if(mode==='business-narrow-dark')assert.equal(await group.getByRole('button').first().evaluate((el:HTMLElement)=>getComputedStyle(el).color),await page.locator('main').evaluate((el:HTMLElement)=>getComputedStyle(el).color),'菜单动作文字须在深色下可读')
 assert.equal(await group.getByRole('button').count(),actions.length)
 if(mode!=='general')assert.deepEqual(await group.getByRole('button').allTextContents(),['调整业务定义','数据连接','业务资源','手动定义','分享业务配置','已完成任务','当前业务任务','变更集复核','业务团队'])
 const bounds=await group.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=(mode==='business-narrow-dark'?430:1400)&&bounds.y+bounds.height<=700)
 if(process.env.TELOA_MORE_EVIDENCE)await page.screenshot({path:process.env.TELOA_MORE_EVIDENCE+'/more-'+mode+'.png',fullPage:true})
 await page.getByRole('button',{name:'菜单外面',exact:true}).click();assert.equal(await group.isVisible(),false)
 await summary.click();await page.keyboard.press('Escape');assert.equal(await group.isVisible(),false)
 assert.equal(await page.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'关闭菜单后仍保留')
 assert.deepEqual(await page.evaluate(()=>(window as any).moreFixture.calls),[])
 for(let index=0;index<actions.length;index++){
  await summary.click();await group.getByRole('button').nth(index).click();assert.equal(await group.isVisible(),false)
 }
 assert.deepEqual(await page.evaluate(()=>(window as any).moreFixture.calls),actions.map(action=>({action,scope:mode==='general'?'general':'SOC'})))
 if(mode!=='general'){
  await page.evaluate(()=>(window as any).moreFixture.block());await summary.click()
  const disabled=group.getByRole('button',{name:'变更集复核',exact:true});assert.equal(await disabled.isDisabled(),true);assert.equal(await disabled.getAttribute('title'),'当前连接正在核对')
 }
 if(mode==='business-desktop'){
  await page.keyboard.press('Escape');await page.evaluate(()=>(window as any).moreFixture.compact());await summary.click();await group.waitFor()
  const panel=await group.boundingBox(),clip=await page.locator('[data-menu-clip]').boundingBox();assert.ok(panel&&clip&&panel.y>=clip.y&&panel.y+panel.height<=clip.y+clip.height,'菜单必须落在业务滚动区域内，不能被父容器裁掉')
  await group.getByRole('button',{name:'业务团队',exact:true}).click()
 }
 assert.deepEqual(errors,[])
})


for(const variant of ['正式','旧业务'])test(variant+'分享关闭、切换本人和刷新后恢复独立草稿，不自动生成或下载',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close());await page.route('**/*',(r:any)=>r.abort())
 await page.route('http://127.0.0.1:3269/share-fixture',(r:any)=>r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'}));await page.goto('http://127.0.0.1:3269/share-fixture');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const open=()=>page.getByRole('button',{name:'打开'+variant+'分享',exact:true}).click()
 await open();const dialog=page.getByRole('dialog'),fields=dialog.getByRole('textbox');await fields.nth(2).waitFor();await fields.nth(2).fill('未提交的名称');await fields.nth(1).fill('2.3.4');await fields.nth(3).fill('未提交的说明')
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});await open()
 assert.equal(await fields.nth(2).inputValue(),'未提交的名称');assert.equal(await fields.nth(1).inputValue(),'2.3.4');assert.equal(await fields.nth(3).inputValue(),'未提交的说明')
 await page.evaluate(()=>{const f=(window as any).moreFixture;f.storageSet=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new DOMException('quota','QuotaExceededError')}})
 await fields.nth(2).fill('存储额度耗尽后的新名称');await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});await open()
 assert.equal(await fields.nth(2).inputValue(),'存储额度耗尽后的新名称','存储写失败后不能用旧持久值覆盖较新的内存草稿')
 await page.evaluate(()=>{Storage.prototype.setItem=(window as any).moreFixture.storageSet});await fields.nth(2).fill('未提交的名称')
 await page.evaluate(()=>(window as any).moreFixture.host());await page.waitForFunction(()=>(window as any).moreFixture.currentHost===1);await fields.nth(2).waitFor();assert.notEqual(await fields.nth(2).inputValue(),'未提交的名称')
 await page.evaluate(()=>(window as any).moreFixture.host());await page.waitForFunction(()=>(window as any).moreFixture.currentHost===0);await fields.nth(2).waitFor();assert.equal(await fields.nth(2).inputValue(),'未提交的名称')
 await page.evaluate(()=>(window as any).moreFixture.namespace());await page.waitForFunction(()=>(window as any).moreFixture.currentNamespace===1);await fields.nth(2).waitFor();assert.notEqual(await fields.nth(2).inputValue(),'未提交的名称','同一API对象切换本人命名空间时不能读旧草稿')
 await page.evaluate(()=>(window as any).moreFixture.namespace());await page.waitForFunction(()=>(window as any).moreFixture.currentNamespace===0);await fields.nth(2).waitFor();assert.equal(await fields.nth(2).inputValue(),'未提交的名称')
 await page.reload();await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await open();await fields.nth(2).waitFor();assert.equal(await fields.nth(2).inputValue(),'未提交的名称')
 assert.deepEqual(await page.evaluate(()=>(window as any).moreFixture.calls),[])
})
