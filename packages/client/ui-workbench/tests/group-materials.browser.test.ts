import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('群资料先查看锁定版本；并排引用不丢草稿，切群丢弃迟到的旧正文',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-group-materials-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {GroupMaterialsPanel} from '${client}GroupMaterialsPanel.tsx';import {GroupResourcePreview} from '${client}GroupResourcePreview.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.className=tokens.tokens;
 const view=createRoot(document.getElementById('root')),snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const f=window.materialFixture={calls:[],outerEscape:0,groupId:'one',selection:null,blocked:false,waiting:false,resolve:null,render:()=>render()};
 const resources=[{id:'note',groupId:'one',title:'采购调研',version:2,withdrawnAt:null,createdAt:'2026-10-13T00:00:00.000Z',updatedAt:'2026-10-13T00:00:00.000Z'}];
 const read=async(groupId,id,version)=>{f.calls.push(['read',groupId,id,version]);if(f.waiting)await new Promise(resolve=>f.resolve=resolve);return {groupId,resourceId:id,version,title:'采购调研',markdown:version===1?'# 锁定第一版':'# 当前第二版',createdAt:'2026-10-13T00:00:00.000Z'}};
 function render(){flushSync(()=>view.render(<I18nProvider runtime={runtime}><main style={{display:'flex',gap:24}}><textarea aria-label="主聊草稿" defaultValue="主聊未发送"/><textarea aria-label="话题草稿" defaultValue="话题未发送"/><aside onKeyDown={event=>{if(event.key==="Escape")f.outerEscape++}} style={{width:380}}><GroupMaterialsPanel groupId={f.groupId} resources={f.groupId==='one'?resources:[]} files={[]} blocked={f.blocked} references={[]} preview={r=>{f.selection={groupId:f.groupId,id:r.id,version:r.version};render()}} edit={r=>f.calls.push(['edit',r.id])} create={()=>f.calls.push(['create'])} openMembers={()=>f.calls.push(['members',f.groupId])} addAttachment={()=>f.calls.push(['attachment',f.groupId])} reference={r=>f.calls.push(['reference',r.id,r.version])} withdraw={r=>f.calls.push(['withdraw',r.id])}/><button onClick={()=>{f.selection={groupId:f.groupId,id:'note',version:1};render()}}>查看消息第一版</button></aside>{f.selection&&<GroupResourcePreview key={f.selection.groupId} groupId={f.selection.groupId} reference={{kind:'group-resource',id:f.selection.id,version:f.selection.version}} api={{resource:read}} isCurrent={()=>f.groupId===f.selection?.groupId} close={()=>{f.selection=null;render()}}/>}</main></I18nProvider>))}render();`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'GroupMaterialsTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000);await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByText('员工如何使用这些资料？',{exact:true}).click()
 await page.getByRole('button',{name:'查看成员与授权',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).materialFixture.calls.at(-1)),['members','one'],'资料帮助进入当前群成员与授权，不打开另一个资料管理页')
 await page.getByText('员工如何使用这些资料？',{exact:true}).click()
 assert.equal(await page.getByRole('button',{name:'查看成员与授权',exact:true}).isVisible(),false,'资料说明默认折叠，不常驻展开')
 const search=page.getByRole('textbox',{name:'搜索群资料',exact:true})
 await search.fill('未匹配的资料');assert.equal(await page.getByRole('button',{name:'预览采购调研',exact:true}).count(),0)
 const focus=await search.evaluate((input:HTMLInputElement)=>({active:input===document.activeElement,innerOutline:getComputedStyle(input).outlineStyle,innerShadow:getComputedStyle(input).boxShadow,outerShadow:getComputedStyle(input.parentElement!).boxShadow}))
 assert.equal(focus.active,true);assert.equal(focus.innerOutline,'none');assert.equal(focus.innerShadow,'none');assert.notEqual(focus.outerShadow,'none','键盘搜索只在整框显示一处焦点提示')
 await search.fill('采购');assert.equal(await page.getByRole('button',{name:'预览采购调研',exact:true}).isVisible(),true);await search.fill('')
 await page.getByRole('button',{name:'预览采购调研',exact:true}).click();await page.getByRole('heading',{name:'采购调研',exact:true}).waitFor()
 assert.equal(await page.getByRole('dialog').getByRole('textbox').count(),0,'名称进入只读查看，不进入编辑')
 assert.equal(await page.getByRole('dialog').getByText('当前第二版',{exact:true}).count(),1)
 await page.getByRole('button',{name:'返回群讨论',exact:true}).click()
 await page.getByLabel('添加群资料',{exact:true}).click()
 assert.equal(await page.getByRole('menuitem',{name:'新建群资料',exact:true}).isVisible(),true)
 await page.getByLabel('添加群资料',{exact:true}).press('Escape')
 assert.equal(await page.locator('details[open]').count(),0,'Esc 应先关闭资料菜单')
 assert.equal(await page.evaluate(()=>(window as any).materialFixture.outerEscape),0,'菜单消费 Esc，不关闭外层资料面板')
 await page.getByLabel('添加群资料',{exact:true}).click()
 await page.getByLabel('主聊草稿').click()
 assert.equal(await page.locator('details[open]').count(),0,'点击菜单外应收起菜单，不移动或覆盖草稿')
 assert.equal(await page.getByLabel('主聊草稿').inputValue(),'主聊未发送')
 await page.getByLabel('资料操作：采购调研',{exact:true}).click()
 const edit=page.getByRole('menuitem',{name:'修订采购调研',exact:true});await edit.focus();await edit.press('End')
 assert.equal(await page.getByRole('menuitem',{name:'撤回资料',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true,'资料菜单使用同一键盘导航')
 await page.keyboard.press('Escape')
 assert.equal(await page.locator('details[open]').count(),0,'资料行菜单也应支持 Esc')
 await page.getByRole('button',{name:'引用采购调研',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).materialFixture.calls.at(-1)),['reference','note',2])
 assert.equal(await page.getByLabel('主聊草稿').inputValue(),'主聊未发送');assert.equal(await page.getByLabel('话题草稿').inputValue(),'话题未发送')
 await page.getByRole('button',{name:'查看消息第一版',exact:true}).click();await page.getByRole('dialog').getByText('锁定第一版',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').getByText('当前第二版',{exact:true}).count(),0)
 await page.getByRole('button',{name:'源文本',exact:true}).click();assert.equal(await page.getByRole('dialog').locator('pre').innerText(),'# 锁定第一版')
 await page.getByRole('button',{name:'返回群讨论',exact:true}).click()
 await page.evaluate(()=>{const f=(window as any).materialFixture;f.blocked=true;f.render()})
 assert.equal(await page.getByRole('button',{name:'引用采购调研',exact:true}).isEnabled(),false);await page.getByLabel('资料操作：采购调研',{exact:true}).click();assert.equal(await page.getByRole('menuitem',{name:'修订采购调研',exact:true}).isEnabled(),false)
 assert.equal(await page.getByRole('button',{name:'预览采购调研',exact:true}).isEnabled(),true,'归档只阻止写，仍可读')
 await page.evaluate(()=>{const f=(window as any).materialFixture;f.waiting=true;f.render()});await page.getByRole('button',{name:'查看消息第一版',exact:true}).click()
 await page.evaluate(()=>{const f=(window as any).materialFixture;f.groupId='two';f.render();f.resolve()})
 assert.equal(await page.getByRole('dialog').getByText('锁定第一版',{exact:true}).count(),0,'迟到的旧群正文不能在新群显示')
 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
 await page.evaluate(()=>{const f=(window as any).materialFixture;f.blocked=false;f.render()})
 const materials=page.getByRole('region',{name:'资料与文件',exact:true}),scopeHint='这里只展示当前群共享的资料；引用会带入当前讨论，员工授权仍单独设置。'
 assert.equal(await materials.getAttribute('aria-description'),scopeHint,'共享范围和员工授权边界仍可被辅助技术读取')
 assert.equal(await materials.getByText(scopeHint,{exact:true}).count(),0,'权限说明不占空态正文')
 assert.equal(await materials.getByRole('button',{name:'附件',exact:true}).count(),0,'空态不重复提供附件按钮')
 await materials.getByLabel('添加群资料',{exact:true}).click()
 await materials.getByRole('menuitem',{name:'附件',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).materialFixture.calls.at(-1)),['attachment','two'],'顶部添加使用当前群身份')
 assert.equal(await page.locator('details[open]').count(),0,'选用顶部入口后收起菜单')
 await materials.getByLabel('添加群资料',{exact:true}).click()
 await materials.getByRole('menuitem',{name:'新建群资料',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).materialFixture.calls.at(-1)),['create'],'同一顶部入口仍可新建群资料')
 assert.equal(await page.getByLabel('主聊草稿').inputValue(),'主聊未发送');assert.equal(await page.getByLabel('话题草稿').inputValue(),'话题未发送')
})
