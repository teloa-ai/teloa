import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('市场技能与应用创建保留草稿、刷新待办、分开历史，并使用实际可保存的应用模板',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-market-resource-create-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {MarketResourceCreator} from ${JSON.stringify(join(client,'MarketResourceCreator.tsx'))};import {MarketAppsDirectoryView} from ${JSON.stringify(join(client,'MarketAppsDirectory.tsx'))};import {TemplateShareProvider} from ${JSON.stringify(join(client,'EmployeeTemplateShare.tsx'))};import {buildSharePlan} from ${JSON.stringify(join(client,'share-package-plan.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import {ThemePresenter} from ${JSON.stringify(join(client,'theme-presenter.ts'))};
 new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14,code:13,terminal:13}});
 const stamp='2026-10-15T00:00:00Z',make=(id,entity,title,status='draft',body='{}')=>({id,entity,title,status,body,bodyHash:'a'.repeat(64),ownerId:'fixture',requestId:id,createdAt:stamp,updatedAt:stamp});
 const pkg=buildSharePlan({subject:'app',title:'事实核对应用',publisher:'测试作者',license:'MIT',roles:[],skills:[{name:'fact-check',text:'---\\nname: fact-check\\ndescription: 核对提供的资料\\n---\\n只核对提供的资料。',license:'MIT'}]});
 const drafts=[make('skill-pending','skill','待确认技能'),make('skill-old','skill','已丢弃技能','discarded'),make('app-pending','share',pkg.title,'draft',JSON.stringify({package:pkg}))];
 const evidence=window.creatorEvidence={prepared:[],previewed:[],writes:[],failPrepare:false,deferPrepare:false,finishPrepare:null,append:()=>drafts.push(make('skill-new','skill','新生成技能'))};
 const api={directory:async({entity})=>({schema:'teloa.page-create-drafts/v1',entity,readAt:stamp,drafts:drafts.filter(d=>d.entity===entity)}),preview:async({draftId})=>({schema:'teloa.page-create-draft-preview/v1',draft:drafts.find(d=>d.id===draftId),fields:[],fieldsTruncated:false,consequences:[],next:{endpoint:'template-share/preview',consentKeys:[]},computedAt:stamp}),settle:async input=>{evidence.writes.push(input)}};
 const creation={api,prepare:async prompt=>{if(evidence.failPrepare)throw Error('temporary');if(evidence.deferPrepare)await new Promise(resolve=>evidence.finishPrepare=resolve);evidence.prepared.push(prompt)},confirmSkill:async()=>{evidence.writes.push('confirm');return 'content-id'},marketPluginInstallApi:{}};
 const shared={storage:localStorage,publisher:'测试作者',receive:()=>{},openDraft:pkg=>evidence.previewed.push(pkg)},snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const [kind,setKind]=useState(null);return <I18nProvider runtime={runtime}><TemplateShareProvider value={shared}><MarketAppsDirectoryView rows={[]} ranking={new Map()} catalog={{status:'ready'}} connections={{status:'ready',records:[]}} view={{query:'',category:'all',mine:false}} onViewChange={()=>{}} runAction={()=>{}} busy={undefined} errors={{}} onCreateSkill={()=>setKind('skill')} onCreateApp={()=>setKind('app')}/><button onClick={()=>setKind('skill')}>技能入口</button><button onClick={()=>setKind('app')}>应用入口</button>{['skill','app'].map(value=><MarketResourceCreator key={value} kind={value} open={kind===value} close={()=>setKind(null)} creation={creation} browse={()=>{}}/>)}</TemplateShareProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ResourceCreate',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/creator'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/creator');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'技能入口',exact:true}).click();const skill=page.getByRole('dialog',{name:'创建技能',exact:true});await skill.waitFor()
 assert.equal(await skill.locator('h2').count(),1,'抽屉不能重复套一层新建标题')
 await skill.locator('summary').filter({hasText:'待确认技能'}).waitFor();assert.equal(await skill.getByText('已丢弃技能',{exact:true}).isVisible(),false,'终态草稿收进历史')
 const field=skill.getByRole('textbox');assert.ok((await field.boundingBox())!.height>=132,'Markdown说明应有足够的多行输入空间');assert.match(await field.getAttribute('placeholder')??'',/^# 事实核对\n/);await field.fill('把合成资料整理为事实与待确认。')
 const margins=await field.evaluate((el:HTMLElement)=>{const field=el.getBoundingClientRect(),dialog=el.closest('dialog')!.getBoundingClientRect();return {left:field.left-dialog.left,right:dialog.right-field.right}});assert.ok(margins.left>=20&&margins.right>=20,'创建表单不能贴抽屉边缘')
 await page.keyboard.press('Escape');await page.evaluate(()=>(window as any).creatorEvidence.append());await page.getByRole('button',{name:'技能入口',exact:true}).click();assert.equal(await field.inputValue(),'把合成资料整理为事实与待确认。');await skill.locator('summary').filter({hasText:'新生成技能'}).waitFor()
 await page.evaluate(()=>(window as any).creatorEvidence.failPrepare=true);await skill.getByRole('button',{name:'继续',exact:true}).click();await skill.getByRole('alert').waitFor();assert.equal(await field.inputValue(),'把合成资料整理为事实与待确认。','创建会话失败不能清掉原稿或关闭')
 await page.evaluate(()=>{(window as any).creatorEvidence.failPrepare=false;(window as any).creatorEvidence.deferPrepare=true});await skill.getByRole('button',{name:'继续',exact:true}).click();
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'应用入口',exact:true}).click();const app=page.getByRole('dialog',{name:'创建应用',exact:true});await app.waitFor()
 assert.match(await app.getByRole('textbox').getAttribute('placeholder')??'',/^# 客户反馈\n/)
 await app.getByRole('textbox').fill('当前应用草稿');await page.evaluate(()=>{(window as any).creatorEvidence.deferPrepare=false;(window as any).creatorEvidence.finishPrepare()});await app.getByRole('textbox').press('End');assert.equal(await app.isVisible(),true,'旧技能迟到结果不得关闭新应用');assert.equal(await app.getByRole('textbox').inputValue(),'当前应用草稿');
 await app.locator('summary').filter({hasText:'事实核对应用'}).click();await app.getByRole('button',{name:'预览并分享',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).creatorEvidence.previewed.map((pkg:any)=>pkg.subject)),['app'])
 await page.evaluate(()=>(window as any).creatorEvidence.failPrepare=false);const appDescription='# 客户反馈\n\n- 核实提供的资料\n- 整理事实和待确认问题';await app.getByRole('textbox').fill(appDescription);await app.getByRole('button',{name:'继续',exact:true}).click();await app.waitFor({state:'hidden'})
 const evidence=await page.evaluate(()=>(window as any).creatorEvidence);assert.equal(evidence.prepared.length,2);assert.ok(evidence.prepared[1].text.includes(appDescription),'完整Markdown说明应带入应用创建');assert.match(evidence.prepared[1].text,/应用模板/);assert.match(evidence.prepared[1].text,/不自动安装/);assert.doesNotMatch(evidence.prepared[1].text,/扩展|extension/);assert.deepEqual(evidence.writes,[]);
 await page.getByRole('button',{name:'技能入口',exact:true}).click();await skill.getByRole('textbox').fill('刷新后保留的技能需求');await page.reload();await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('button',{name:'技能入口',exact:true}).click();assert.equal(await skill.getByRole('textbox').inputValue(),'刷新后保留的技能需求');await page.keyboard.press('Escape');await page.getByRole('button',{name:'应用入口',exact:true}).click();assert.equal(await app.getByRole('textbox').inputValue(),appDescription,'不同创建类型不串草稿；应用保留自己的已预备说明');assert.deepEqual(errors,[])
 await page.keyboard.press('Escape')
 for(const title of ['创建技能','创建应用']){
  await page.getByLabel('添加应用或技能',{exact:true}).click();await page.getByRole('button',{name:title,exact:true}).click()
  const drawer=page.getByRole('dialog',{name:title,exact:true});await drawer.waitFor();await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'})
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'添加应用或技能','关闭从菜单打开的创建页后应回到仍可见的加号，不能落到隐藏菜单项或页面根部')
 }
})
