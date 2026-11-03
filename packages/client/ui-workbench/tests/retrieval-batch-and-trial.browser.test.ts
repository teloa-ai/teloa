import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {retrievalLimits} from '@teloa/contract'
import {retrievalPreparationDetails} from '../../../local-embedding/src/preparation-details.ts'
// @ts-expect-error 复用项目的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('检索批量选择按来源提交，冷启动不丢试搜，窄屏及大字号下操作可达',{timeout:180000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-retrieval-batch-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {WorkError} from '${root}packages/contract/src/index.ts';import {LocalRetrievalResources} from '${client}/LocalRetrievalResources.tsx';import {LocalRetrievalModelPresentation} from '${client}/LocalRetrievalModelPanel.tsx';import {I18nProvider} from '${client}/i18n/provider.tsx';import {translateMessage} from '${client}/i18n/messages.ts';import {prototypeThemes} from '${client}/../brand/prototype-theme.ts';import tokens from '${client}/theme-tokens.module.css';
 const config=window.retrievalCase,stamp='2026-10-31T00:00:00.000Z',resources=Array.from({length:600},(_,i)=>({id:'resource-'+i,version:1,ownerId:'self',title:'资料'+String(i).padStart(4,'0')+(i===599?' '+('超长标题和关联业务'.repeat(20)):''),status:'active',sourceId:'source-'+i,sourceVersion:'b'.repeat(64),scopeIds:['general'],createdAt:stamp,updatedAt:stamp}));resources.push({...resources[0],id:'resource-duplicate'});if(config.duplicates)resources[11]={...resources[11],title:resources[10].title};const resourceContext=config.duplicates?new Map([['resource-10','业务甲 · 员工甲 · v1'],['resource-11','业务乙 · 员工乙 · v1']]):undefined;
 const f=window.retrievalFixture={phase:'ready',profile:'a'.repeat(64),enrolled:new Set(['source-0','source-1']),calls:[],polls:0,capacityExtra:0,aborted:0,indexCancel:0,fail:false,hold:false,release:null,resolveSearch:null};
 const index=()=>({enrolled:f.enrolled.size+f.capacityExtra,chunks:f.enrolled.size,building:false,items:resources.filter(r=>f.enrolled.has(r.sourceId)).map(r=>({sourceId:r.sourceId,resourceId:r.id,title:r.title,version:1,state:'ready',chunkCount:1}))});
 const model=()=>({enabled:true,selectedProviderId:'qwen3-embedding-0.6b',provider:{id:'qwen3-embedding-0.6b',location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash:f.profile,variant:'fp32',totalMemoryBytes:32*1024**3,memoryRisk:false,preparation:{phase:f.phase},preparationDetails:${JSON.stringify(retrievalPreparationDetails('fp32','/fixture/models','/fixture/runtime'))}},building:false,guidance:null});
 const result={coverage:{searched:[{resourceId:'resource-0',title:'资料0000',version:1}],pending:[{resourceId:'resource-1',title:'资料0001',version:1,reason:'stale'}],note:'已检索当前就绪资料'},results:[{resourceId:'resource-0',resourceVersion:1,title:'资料0000',sourceId:'source-0',sourceVersion:'b'.repeat(64),lines:[4,6],chars:[10,60],heading:'处置流程',score:0.9,excerpt:'核查设备来源。\\n保留原始证据。\\n'+('long-identifier-'.repeat(60))}]};
 const apply=async(action,ids)=>{f.calls.push({action,ids});if(f.hold)await new Promise(resolve=>f.release=resolve);if(f.fail)throw new WorkError('teloa/conflict','fixture conflict');for(const id of ids)if(action==='enroll')f.enrolled.add(id);else f.enrolled.delete(id);return index()};
 const api={status:async()=>{f.polls++;return index()},modelStatus:async()=>model(),enrollSources:(ids)=>apply('enroll',ids),removeSources:ids=>apply('remove',ids),enroll:id=>apply('enroll',[id]),remove:id=>apply('remove',[id]),cancel:async()=>{f.indexCancel++;return index()},reindex:async()=>index(),search:(query,signal)=>new Promise((resolve,reject)=>{f.calls.push({action:'search',query});f.resolveSearch=()=>resolve(result);signal.addEventListener('abort',()=>{f.aborted++;reject(new DOMException('Cancelled','AbortError'))},{once:true})})};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},noop=()=>{};
 function App(){const [visible,setVisible]=useState(true);f.hide=()=>setVisible(false);return <I18nProvider runtime={runtime}><main className={tokens.tokens} style={{...prototypeThemes[config.theme],'--teloa-design-text-base':config.font/16+'rem',minHeight:'100dvh',padding:config.width<600?12:24,fontFamily:'system-ui'}}><LocalRetrievalModelPresentation status={model()} catalogId='teloa.model.qwen3-embedding-0-6b' catalogVersion='1.0.0' compact embedded confirming={false} busy={false} error='' t={runtime.t} onAsk={noop} onConfirm={noop} onDismiss={noop} onCancel={noop} onBack={noop} onExtensions={noop} onProviderChange={noop}/><LocalRetrievalResources api={api} resources={resources} resourceContext={resourceContext} visible={visible} onModelSettings={noop}/><label>普通筛选<select aria-label='普通筛选'><option>全部资料</option></select></label></main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
 `)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'RetrievalBatch',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const errors:string[]=[]
 const mount=async(width=1440,font=14,theme='light',duplicates=false)=>{
  const page=await browser.newPage({viewport:{width,height:width<600?640:900}});page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.route('**/*',(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1:3199/retrieval-batch')
  await page.evaluate((config:{width:number;font:number;theme:string;duplicates:boolean})=>{(window as any).retrievalCase=config;document.body.dataset.teloaUiFont=String(config.font)},{width,font,theme,duplicates})
  await page.addStyleTag({content:bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
  await page.getByRole('button',{name:'管理检索资料',exact:true}).waitFor();return page
 }
 await t.test('模型冷启动轮询保留查询与请求，取消只取消本次试搜，身份变更丢弃旧结果',async()=>{
  const page=await mount();try{
   await page.getByText('语义试搜与命中片段',{exact:true}).click();const input=page.getByRole('textbox',{name:'试搜内容',exact:true});await input.fill('FortiGate 设备 查询');await page.getByRole('button',{name:'开始试搜',exact:true}).click()
   await page.evaluate(()=>{(window as any).retrievalFixture.phase='loading'});await page.getByText('正在完成本次试搜，模型加载期间会保留查询。',{exact:true}).waitFor()
   assert.equal(await input.count(),1);assert.equal(await input.inputValue(),'FortiGate 设备 查询');assert.equal(await page.evaluate(()=>(window as any).retrievalFixture.aborted),0)
   await page.evaluate(()=>{const f=(window as any).retrievalFixture;f.phase='ready';f.resolveSearch()});await page.getByText('已检索 1 项，另有 1 项尚未就绪。',{exact:true}).waitFor()
   assert.equal(await page.locator('article pre').innerText(),'核查设备来源。\n保留原始证据。\n'+'long-identifier-'.repeat(60));await page.getByText('第 5–7 行 · 处置流程',{exact:true}).waitFor()
   await page.getByText('查看未就绪资料（1）',{exact:true}).click();await page.getByText('资料0001 · 等待整理',{exact:true}).waitFor()
   await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('form button[type=submit]')?.disabled);await input.fill('第二个查询');await page.getByRole('button',{name:'开始试搜',exact:true}).click();await page.getByRole('button',{name:'取消试搜',exact:true}).click()
   assert.equal(await input.inputValue(),'第二个查询');await page.waitForFunction(()=>document.activeElement?.getAttribute('maxlength')==='500');assert.equal(await input.evaluate((node:HTMLElement)=>document.activeElement===node),true);assert.equal(await page.evaluate(()=>(window as any).retrievalFixture.aborted),1);assert.equal(await page.evaluate(()=>(window as any).retrievalFixture.indexCancel),0)
   await page.getByRole('button',{name:'开始试搜',exact:true}).click();await page.evaluate(()=>{(window as any).retrievalFixture.profile='c'.repeat(64)});await page.waitForFunction(()=>(window as any).retrievalFixture.aborted===2)
   await page.evaluate(()=>(window as any).retrievalFixture.resolveSearch());assert.equal(await page.locator('article').count(),0);assert.equal(await input.inputValue(),'第二个查询')
  }finally{await page.close()}
 })
 await t.test('全量筛选及来源去重，原子失败保留选择，重试/双击不重复提交，移出保留原资料',async()=>{
  const page=await mount();try{
   const opener=page.getByRole('button',{name:'管理检索资料',exact:true});await opener.click();const drawer=page.getByRole('dialog',{name:'管理检索资料',exact:true}),search=drawer.getByRole('searchbox',{name:'搜索资料名称',exact:true})
   assert.equal(await search.evaluate((node:HTMLElement)=>document.activeElement===node),true);assert.equal(await drawer.getByRole('listitem').count(),50)
   await drawer.getByRole('button',{name:'显示更多（已显示 50 / 600）',exact:true}).click();assert.equal(await drawer.getByRole('listitem').count(),100)
   await search.fill('资料0599');assert.equal(await drawer.getByRole('listitem').count(),1);await drawer.getByRole('checkbox',{name:/^选择 资料0599/}).check();await search.fill('资料000')
   await drawer.getByRole('checkbox',{name:'全选当前结果（10）',exact:true}).check();await drawer.getByText('其中 1 项不在当前筛选中',{exact:false}).waitFor();assert.equal(await drawer.getByRole('checkbox',{name:'选择 资料0000',exact:true}).count(),1);await drawer.getByText('同一来源，共 2 份资料',{exact:false}).waitFor()
   await page.evaluate(()=>{(window as any).retrievalFixture.fail=true});await drawer.getByRole('button',{name:'加入检索（9）',exact:true}).click();await drawer.getByRole('alert').waitFor();await drawer.getByRole('button',{name:'加入检索（9）',exact:true}).waitFor();assert.equal(await drawer.getByRole('checkbox',{name:'全选当前结果（10）',exact:true}).isChecked(),true)
   await page.evaluate(()=>{const f=(window as any).retrievalFixture;f.fail=false;f.hold=true});await drawer.getByRole('button',{name:'加入检索（9）',exact:true}).dblclick();await page.keyboard.press('Escape');assert.equal(await drawer.isVisible(),true);assert.equal(await drawer.getByRole('button',{name:'关闭',exact:true}).isDisabled(),true)
   const calls=await page.evaluate(()=>(window as any).retrievalFixture.calls);assert.equal(calls.length,2);assert.deepEqual(calls[1],{action:'enroll',ids:['source-2','source-3','source-4','source-5','source-6','source-7','source-8','source-9','source-599']})
   await page.evaluate(()=>{const f=(window as any).retrievalFixture;f.hold=false;f.release()});await drawer.getByText('已加入 9 个来源，索引将在后台整理。',{exact:true}).waitFor();await drawer.getByRole('button',{name:'移出检索（2）',exact:true}).click();await drawer.getByText('已移出 2 个来源，原资料保留。',{exact:true}).waitFor()
   assert.equal(await drawer.getByRole('checkbox',{name:'选择 资料0000',exact:true}).count(),1);assert.equal(await page.evaluate(()=>(window as any).retrievalFixture.enrolled.size),9)
   await page.evaluate((limit:number)=>{const f=(window as any).retrievalFixture;f.capacityExtra=limit-500-f.enrolled.size},retrievalLimits.maxEnrollments);await search.fill('');await drawer.getByRole('checkbox',{name:'全选当前结果（600）',exact:true}).check();await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='加入检索（591）'&&button.disabled));assert.equal(await drawer.getByRole('button',{name:'加入检索（591）',exact:true}).isDisabled(),true);await drawer.getByText(`检索最多加入 ${retrievalLimits.maxEnrollments} 个来源，请减少选择或先移出部分资料。`,{exact:true}).waitFor()
   await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});assert.equal(await opener.evaluate((node:HTMLElement)=>document.activeElement===node),true)
  }finally{await page.close()}
 })
 await t.test('同名来源展示业务、员工和更新时间，选择及搜索不会混入另一份副本',async()=>{
  const page=await mount(390,28,'light',true);try{
   await page.getByRole('button',{name:'管理检索资料',exact:true}).click();const drawer=page.getByRole('dialog',{name:'管理检索资料',exact:true}),search=drawer.getByRole('searchbox',{name:'搜索资料名称',exact:true})
   await search.fill('资料0010');assert.equal(await drawer.getByRole('listitem').count(),2);await drawer.getByRole('checkbox',{name:/选择 资料0010 · 业务乙 · 员工乙 · v1 · 更新于 /}).check();assert.doesNotMatch(await drawer.innerText(),/source-10|source-11|resource-10|resource-11/)
   await search.fill('业务乙');assert.equal(await drawer.getByRole('listitem').count(),1);await drawer.getByRole('button',{name:'加入检索（1）',exact:true}).click();await drawer.getByText('已加入 1 个来源，索引将在后台整理。',{exact:true}).waitFor()
   assert.deepEqual(await page.evaluate(()=>(window as any).retrievalFixture.calls),[{action:'enroll',ids:['source-11']}])
  }finally{await page.close()}
 })
 await t.test('选择器只保留一个箭头，系统高对比度有原生箭头；响应式与字号矩阵',async()=>{
  for(const width of [320,390,768,1440])for(const font of [14,28])for(const theme of ['light','dark']){
   const page=await mount(width,font,theme),label=JSON.stringify({width,font,theme});try{
    const picker=page.getByRole('combobox',{name:'检索模型',exact:true});assert.equal(await picker.evaluate((node:HTMLElement)=>getComputedStyle(node).backgroundImage),'none',label)
    assert.equal(await picker.locator('..').locator('svg').count(),1);assert.match(await page.getByRole('combobox',{name:'普通筛选',exact:true}).evaluate((node:HTMLElement)=>getComputedStyle(node).backgroundImage),/^url\(/)
    assert.ok(await page.locator('main').evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth+1),label+' 页面不应水平溢出')
    if(width===390&&font===14&&theme==='light'){await page.emulateMedia({forcedColors:'active'});assert.equal(await picker.evaluate((node:HTMLElement)=>getComputedStyle(node).appearance),'auto');assert.equal(await picker.locator('..').locator('svg').isVisible(),false);await page.emulateMedia({forcedColors:'none'})}
    await page.getByRole('button',{name:'管理检索资料',exact:true}).click();const drawer=page.getByRole('dialog',{name:'管理检索资料',exact:true})
    await drawer.getByRole('checkbox',{name:'选择 资料0000',exact:true}).check();await drawer.getByRole('checkbox',{name:'选择 资料0002',exact:true}).check()
    const geometry=await drawer.evaluate((node:HTMLElement)=>{const d=node.getBoundingClientRect(),h=node.querySelector('header')!.getBoundingClientRect(),f=node.querySelector('footer')!.getBoundingClientRect();return {overflow:node.scrollWidth>node.clientWidth+1,left:d.left,right:d.right,top:h.top,bottom:f.bottom,width:innerWidth,height:innerHeight}})
    assert.ok(!geometry.overflow&&geometry.left>=-1&&geometry.right<=geometry.width+1&&geometry.top>=0&&geometry.bottom<=geometry.height+1,label+' 抽屉标题和批量操作须在视口内：'+JSON.stringify(geometry))
    for(const name of ['移出检索（1）','加入检索（1）']){const button=drawer.getByRole('button',{name,exact:true}),rect=await button.boundingBox();assert.ok(rect&&rect.x>=geometry.left&&rect.x+rect.width<=geometry.right+1,label+' '+name+' 应完整可见')}
    if(process.env.TELOA_UI_SCREENSHOT_DIR&&theme==='light'&&font===14&&[390,1440].includes(width)){await mkdir(process.env.TELOA_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.TELOA_UI_SCREENSHOT_DIR,'retrieval-batch-'+width+'.png')})}
    await page.keyboard.press('Escape');await page.getByText('语义试搜与命中片段',{exact:true}).click();await page.getByRole('textbox',{name:'试搜内容',exact:true}).fill('长片段响应式验收');await page.getByRole('button',{name:'开始试搜',exact:true}).click();await page.evaluate(()=>(window as any).retrievalFixture.resolveSearch())
    const excerpt=page.getByRole('region',{name:'命中片段：资料0000',exact:true});await excerpt.waitFor();assert.ok(await page.locator('main').evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth+1),label+' 长命中片段不得撑宽页面')
    await excerpt.focus();await page.keyboard.press('End');await page.waitForFunction(()=>{const node=document.querySelector<HTMLElement>('article pre');return node&&(node.scrollHeight<=node.clientHeight||node.scrollTop>0)});assert.ok(await excerpt.evaluate((node:HTMLElement)=>node.scrollHeight<=node.clientHeight||node.scrollTop>0),label+' 长片段可通过键盘滚动')
   }finally{await page.close()}
  }
 })
 assert.deepEqual(errors,[])
})
