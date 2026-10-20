import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

// B8 读取三态接市场目录：0–1 秒不显示、1 秒后与真实卡片同尺寸的骨架、10 秒「读取较慢」可取消、30 秒超时失败可重试；
// 取消与失败分开表达，取消后迟到的回包不再覆盖界面。时间用 Playwright 假时钟推进，目录读取由夹具手动放行。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),tests=fileURLToPath(new URL('./',import.meta.url)),virtual=root+'__market_read_state_fixture.tsx'
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
import {MarketCatalogSection} from '${client}MarketCatalogSection.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {roleEntry} from '${tests}market-catalog-fixture.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const items=['a','b','c','d'].map(id=>({entry:{...roleEntry(),id:'teloa.role.'+id},artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}));
const listing={catalogVersion:'2026.10.20',items,nextCursor:null,counts:{dashboard:0,skill:0,connector:0,model:0,solution:0,role:4},skipped:{unknownKind:0,newerApp:0}};
const reads=[];window.readFixture={reads,resolve:()=>reads.at(-1).resolve(listing),reject:()=>reads.at(-1).reject(Object.assign(Error('offline'),{code:'teloa/source-unavailable'}))};
const api={list:()=>new Promise((resolve,reject)=>reads.push({resolve,reject})),ranking:async()=>new Map(),add:async()=>({contentId:''})};
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><main className={tokens.tokens} style={{width:1180,padding:24}}><MarketCatalogSection api={api} query="" search={<input aria-label="搜索市场"/>} cardLayout openContent={()=>{}}/></main></I18nProvider>);`

test('市场目录读取：1 秒骨架、10 秒较慢可取消、30 秒超时可重试，取消与失败分开表达',async t=>{
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'market-read-state-fixture',resolveId:(id:string)=>id.endsWith('market-read-state-fixture')?virtual:null,load:(id:string)=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'market-read-state-fixture',name:'MarketReadStateFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const server=createServer((_,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()))})
 const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(4000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
 await page.clock.install({time:new Date('2026-10-20T08:00:00Z')});await page.clock.pauseAt(new Date('2026-10-20T08:00:01Z'))
 await page.goto(origin);await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
 const phase=page.locator('[data-read-phase]'),skeletonCards=page.locator('[aria-hidden="true"] li')
 await phase.waitFor({state:'attached'});assert.equal(await phase.getAttribute('data-read-phase'),'waiting')
 assert.equal(await skeletonCards.count(),0,'1 秒内不显示骨架');assert.equal(await page.getByRole('status').filter({hasText:'正在读取官方目录…'}).count(),1,'读屏仍有具体读取文案')
 await page.clock.runFor(1_000);assert.equal(await phase.getAttribute('data-read-phase'),'skeleton');assert.equal(await skeletonCards.count(),4)
 const skeletonBox=await skeletonCards.first().boundingBox()
 await page.clock.runFor(9_000)
 const slow=page.getByRole('status').filter({hasText:'读取较慢，仍在尝试…'});await slow.waitFor();await page.getByText('已用 10 秒',{exact:true}).waitFor()
 await page.clock.runFor(3_000);await page.getByText('已用 13 秒',{exact:true}).waitFor()
 await page.getByRole('button',{name:'取消',exact:true}).click()
 const cancelled=page.getByRole('status').filter({hasText:'已取消读取官方目录'});await cancelled.waitFor()
 assert.equal(await page.getByRole('alert').count(),0,'取消不当作错误')
 await page.evaluate(()=>(window as any).readFixture.resolve());await page.clock.runFor(100)
 assert.equal(await cancelled.count(),1,'取消后迟到的回包不覆盖界面');assert.equal(await page.locator('[data-catalog-row]').count(),0)
 await page.getByRole('button',{name:'重新读取',exact:true}).click();await phase.waitFor({state:'attached'})
 await page.clock.runFor(30_000)
 const timeout=page.getByRole('alert').filter({hasText:'没能读取官方目录'});await timeout.waitFor()
 await timeout.getByText('30 秒内没有响应，其他内容不受影响。').waitFor()
 await timeout.getByRole('button',{name:'重试',exact:true}).click();await phase.waitFor({state:'attached'});await page.waitForFunction(()=>(window as any).readFixture.reads.length===3)
 await page.evaluate(()=>(window as any).readFixture.reject());await page.clock.runFor(100)
 const failed=page.getByRole('alert').filter({hasText:'没能读取官方目录'});await failed.waitFor()
 assert.equal(await failed.getByText(/秒内没有响应/).count(),0,'读取出错与超时分开写原因')
 await failed.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>(window as any).readFixture.reads.length===4);await page.clock.runFor(1_000)
 await page.evaluate(()=>(window as any).readFixture.resolve())
 await page.locator('[data-catalog-row]').first().waitFor()
 assert.equal(await phase.count(),0,'读到后立即换成内容');assert.equal(await page.locator('[data-catalog-row]').count(),4)
 const cardBox=await page.locator('[data-catalog-row]').first().boundingBox()
 assert.ok(skeletonBox&&cardBox,'骨架与真实卡片都可测量')
 assert.equal(Math.round(skeletonBox.width),Math.round(cardBox.width),'骨架卡与真实卡同宽')
 assert.ok(Math.abs(skeletonBox.height-cardBox.height)<=1,`骨架卡与真实卡同高：${skeletonBox.height} / ${cardBox.height}`)
 assert.equal(await page.evaluate(()=>(window as any).readFixture.reads.length),4,'首次读取加三次重读，每次重试只读一次')
 assert.deepEqual(errors,[])
})
