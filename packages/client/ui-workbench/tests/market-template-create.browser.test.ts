import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('市场自然语言创建使用真实员工和团队草案，关闭保留输入，预览不自动发布或实例化',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-market-create-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {MarketTemplateCreator} from ${JSON.stringify(join(client,'MarketTemplateCreator.tsx'))};import {TemplateShareProvider} from ${JSON.stringify(join(client,'EmployeeTemplateShare.tsx'))};import {buildSharePlan} from ${JSON.stringify(join(client,'share-package-plan.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import {ThemePresenter} from ${JSON.stringify(join(client,'theme-presenter.ts'))};
 new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});
 const role={id:'research',kind:'employee',name:'研究员',duty:'核实来源',dataScope:'提供的资料',executionScope:'外部写入需确认',skills:[],knowledge:[]};
 const employee=buildSharePlan({subject:'employee',title:'研究员工模板',publisher:'测试作者',license:'MIT',roles:[role],skills:[]});
 const team=buildSharePlan({subject:'team',title:'研究团队模板',publisher:'测试作者',license:'MIT',roles:[role,{...role,id:'writer',name:'写作员'}],coordinatorRoleId:'research',skills:[]});
 const drafts=[employee,team].map((pkg,index)=>({id:'draft-'+index,entity:'share',body:JSON.stringify({package:pkg}),bodyHash:'a'.repeat(64),title:pkg.title,status:'draft',ownerId:'fixture',requestId:'request-'+index,createdAt:'2026-10-15T00:00:00Z',updatedAt:'2026-10-15T00:00:00Z'}));
 const evidence=window.marketCreate={prepared:[],previewed:[],settled:[],appendEmployee:()=>drafts.push({...drafts[0],id:'new-draft',title:'新生成的员工模板',body:JSON.stringify({package:buildSharePlan({subject:'employee',title:'新生成的员工模板',publisher:'测试作者',roles:[role],skills:[]})})})},api={directory:async()=>({schema:'teloa.page-create-drafts/v1',entity:'share',readAt:'2026-10-15T00:00:00Z',drafts}),preview:async({draftId})=>({schema:'teloa.page-create-draft-preview/v1',draft:drafts.find(d=>d.id===draftId),fields:[],fieldsTruncated:false,consequences:[],next:{endpoint:'template-share/preview',consentKeys:[]},computedAt:'2026-10-15T00:00:00Z'}),settle:async input=>{evidence.settled.push(input)}};
 const creation={api,prepare:prompt=>evidence.prepared.push(prompt)},shared={storage:localStorage,publisher:'测试作者',receive:()=>{},openDraft:pkg=>evidence.previewed.push(pkg)};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(k,p)=>translateMessage('zh-CN',k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const [kind,setKind]=useState(null);return <I18nProvider runtime={runtime}><TemplateShareProvider value={shared}><button onClick={()=>setKind('employee')}>员工入口</button><button onClick={()=>setKind('team')}>团队入口</button>{['employee','team'].map(item=><MarketTemplateCreator key={item} kind={item} open={kind===item} close={()=>setKind(null)} creation={creation}/>)}</TemplateShareProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'MarketTemplateCreate',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/market-create'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/market-create');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'员工入口',exact:true}).click();const employee=page.getByRole('dialog',{name:'创建 AI 员工',exact:true});await employee.waitFor()
 const sentence=employee.getByRole('textbox');assert.equal(await sentence.isVisible(),true,'直接进入输入，无需多点一次描述')
 assert.ok((await sentence.boundingBox())!.height>=132,'Markdown说明应有足够的多行输入空间')
 assert.match(await sentence.getAttribute('placeholder')??'',/^# 资料研究员\n/)
 const employeeDescription='# 资料研究员\n\n- 核实我提供的资料\n- 标注来源与待确认问题'
 await sentence.fill(employeeDescription);await page.keyboard.press('Escape');await employee.waitFor({state:'hidden'})
 await page.evaluate(()=>(window as any).marketCreate.appendEmployee())
 await page.getByRole('button',{name:'员工入口',exact:true}).click();assert.equal(await sentence.inputValue(),employeeDescription)
 await employee.locator('summary').filter({hasText:'新生成的员工模板'}).waitFor()
 assert.match(await employee.innerText(),/研究员工模板/)
 assert.equal(await employee.getByText('研究团队模板',{exact:true}).count(),0,'员工创建不混入团队草案')
 await employee.locator('summary').filter({hasText:'研究员工模板'}).click();await employee.getByRole('button',{name:'预览并分享',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).marketCreate.previewed.map((pkg:any)=>({subject:pkg.subject,title:pkg.title}))),[{subject:'employee',title:'研究员工模板'}])
 assert.deepEqual(await page.evaluate(()=>(window as any).marketCreate.prepared),[],'浏览和预览不发起模型')
 assert.deepEqual(await page.evaluate(()=>(window as any).marketCreate.settled),[],'打开分享预览不提前落定或发布')
 await employee.getByRole('button',{name:'查看其他模板（1）',exact:true}).click();await employee.locator('summary').filter({hasText:'研究团队模板'}).click()
 await employee.getByText('可在这里查看或丢弃；请从对应分类分享。',{exact:true}).waitFor()
 assert.equal(await employee.getByRole('textbox').count(),0,'管理其他模板不混入当前类别的新建输入')
 assert.equal(await employee.getByRole('button',{name:'预览并分享',exact:true}).count(),0,'不能从员工分类分享团队草案')
 await employee.getByRole('button',{name:'丢弃',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).marketCreate.settled.map(({draftId,outcome,expectedBodyHash}:any)=>({draftId,outcome,expectedBodyHash}))),[{draftId:'draft-1',outcome:'discarded',expectedBodyHash:'a'.repeat(64)}],'共享上限中的其他草稿仍有原身份的丢弃路径')
 await employee.getByRole('button',{name:'返回当前分类',exact:true}).click();assert.equal(await sentence.inputValue(),employeeDescription)
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'团队入口',exact:true}).click();const team=page.getByRole('dialog',{name:'创建 AI 团队',exact:true});await team.waitFor()
 assert.equal(await team.getByText('研究员工模板',{exact:true}).count(),0,'团队创建不混入员工草案')
 assert.match(await team.getByRole('textbox').getAttribute('placeholder')??'',/^# 内容团队\n/)
 const teamDescription='# 研究与写作团队\n\n- 研究员核实资料\n- 写作伙伴整理成稿'
 await team.getByRole('textbox').fill(teamDescription);await team.getByRole('textbox').press('Enter');assert.deepEqual(await page.evaluate(()=>(window as any).marketCreate.prepared),[],'Enter换行，不提前提交')
 await team.getByRole('button',{name:'继续',exact:true}).click()
 const prepared=await page.evaluate(()=>(window as any).marketCreate.prepared);assert.equal(prepared.length,1);assert.equal(prepared[0].sourceId,'market-template:team');assert.match(prepared[0].text,/AI 团队模板/);assert.match(prepared[0].text,/不创建实际团队，不自动安装、授权、排程或发布/);assert.doesNotMatch(prepared[0].text,/subject=|share 草案工具/);assert.ok(prepared[0].text.includes(teamDescription),'完整Markdown说明应带入会话');await team.waitFor({state:'hidden'})
 assert.deepEqual(errors,[])
})
