import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

/**
 * 群引用资料改走会话式候选（2026-10-14）：真实 DOM 里核对正文 @ 与引用图标到达同一份分组候选（员工／资料／文件），
 * 外点与 Esc 收起、选一次即带入标签并把焦点还给输入框、键盘可选、中文输入法确认的回车不选不发、
 * 发送时复用 GroupResource 固定版本与已共享文件的原 attachment 引用。只用临时打包与本地夹具，不访问 3100。
 */
test('群输入框引用候选：分组、外点/Esc、键盘与 IME、选一次带入、复用原件引用',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_reference_candidates.tsx',markdown='\0group-reference-candidates-markdown'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import tokens from '${client}theme-tokens.module.css';
 const stamp='2026-10-14T00:00:00.000Z',groupId='11111111-1111-4111-8111-111111111111',otherGroupId='22222222-2222-4222-8222-222222222222',roleId='33333333-3333-4333-8333-333333333333';
 const resourceIds={plan:'44444444-4444-4444-8444-444444444444',sameName:'55555555-5555-4555-8555-555555555555',gone:'66666666-6666-4666-8666-666666666666'};
 const roles=[{id:roleId,kind:'employee',name:'林析',duty:'核对证据',state:'active',scopes:['general'],version:1}];
 const group={id:groupId,ownerId:'self',name:'采购核查群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,version:1,createdAt:stamp,updatedAt:stamp};
 const resource=(id,title,version,withdrawnAt=null)=>({id,groupId,ownerId:'self',version,title,withdrawnAt,createdAt:stamp,updatedAt:stamp});
 const file=(attachmentId,name,patch={})=>({attachmentId,ownerId:'self',version:1,kind:'file',mime:'application/pdf',bytes:2048,sha256:'b'.repeat(64),name,width:null,height:null,uploadedInGroupId:groupId,state:'active',createdAt:stamp,withdrawnAt:null,...patch});
 const f=window.referenceFixture={sent:[],messages:[],opened:[],uploads:0,grants:0,grantCalls:[]};
 const library=(id,title,patch={})=>({id,ownerId:'self',title,sourceId:'local_material_'+id,sourceVersion:'a'.repeat(64),scopeIds:['general'],status:'active',version:3,createdAt:stamp,updatedAt:stamp,...patch});
 const libraryRows=[library('88888888-8888-4888-8888-888888888888','资料库原件'),library('99999999-9999-4999-8999-999999999999','跨业务原件',{scopeIds:['other']}),library('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','已撤回原件',{status:'withdrawn'})];
 const workResources={api:{directory:async()=>({resources:libraryRows,drafts:[]})},open:ref=>f.opened.push(ref)};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>({items:[group]}),get:async()=>({group,members:[{groupId,roleId:null,createdAt:stamp},{groupId,roleId,createdAt:stamp}]}),messages:async()=>({items:[...f.messages]}),
  resources:async()=>({items:[resource(resourceIds.plan,'方案资料',2),resource(resourceIds.sameName,'林析',1),resource(resourceIds.gone,'已撤回资料',1,stamp)]}),
  agentGrant:async()=>({groupVersion:1,roleVersion:1,grant:null,status:'not-granted'}),changeAgentGrant:async(...args)=>{f.grants++;f.grantCalls.push(args);throw Error('本用例仅核对明确授权提交参数')},
  send:async(sendGroupId,expectedVersion,text,rootId,references,mentions)=>{f.sent.push({text,rootId,references,mentions});const message={id:'77777777-7777-4777-8777-'+String(f.sent.length).padStart(12,'0'),groupId:sendGroupId,rootId:rootId??null,authorId:'self',text,references:references??[],mentions:mentions??[],createdAt:stamp};f.messages.push(message);return message}};
 const attachments={upload:async()=>{f.uploads++;throw Error('本用例不上传')},list:async()=>[file('att-shared','合同扫描件.pdf'),file('att-foreign','别群带入.pdf',{uploadedInGroupId:otherGroupId}),file('att-gone','已撤回.pdf',{state:'withdrawn',withdrawnAt:stamp})],withdraw:async()=>{throw Error('未使用')},openReference:async()=>{throw Error('未使用')},describeArtifact:async()=>{throw Error('未使用')},openArtifactFile:async()=>{throw Error('未使用')}};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><div className={tokens.tokens} style={{...prototypeThemes.light,height:'100vh'}}><input aria-label="目录搜索" defaultValue=""/><div id="teloa-main" tabIndex={-1} aria-label="主工作区"/><SavedCollaborationPage workResources={workResources} api={api} attachments={attachments} visible={true} target={{groupId,rootId:''}} roles={roles} profileName="Max" directory={{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}/></div></I18nProvider>);`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'group-reference-candidates',resolveId:id=>id.endsWith('group-reference-candidates')?entryId:id===markdown?markdown:null,load:id=>id===entryId?entry:id===markdown?'import {createElement} from "react";export function MarkdownText({text}){return createElement("p",null,text)}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-reference-candidates',name:'GroupReferenceCandidates',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(r:any)=>r.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const message=page.getByRole('textbox',{name:'群讨论消息',exact:true}),icon=page.getByRole('button',{name:'引用资料',exact:true})
 const listbox=(name:string)=>page.getByRole('listbox',{name,exact:true})
 const sections=async()=>page.locator('li[role="presentation"]').allInnerTexts()
 const optionNames=async()=>page.locator('li[role="option"]').evaluateAll((nodes:Element[])=>nodes.map(node=>(node.querySelector('span')?.textContent??node.textContent??'').trim()))
 const focused=()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label'))
 const chips=async()=>page.locator('button[aria-label^="移除"]').evaluateAll((nodes:Element[])=>nodes.map(node=>node.getAttribute('aria-label')))
 await page.getByRole('heading',{name:'采购核查群',exact:true}).waitFor();await message.waitFor()

 // 正文 @：员工／资料／文件三组就地列出；同名资料与员工分属两组；别群带入、已撤回的不列。
 await message.click();await message.type('@')
 await listbox('提及员工或引用资料').waitFor()
 assert.deepEqual(await sections(),['员工','资料','资料库引用','文件'])
 assert.deepEqual(await optionNames(),['提及全员','林析','方案资料','林析','资料库原件','合同扫描件.pdf'])
 await page.locator('li[role="presentation"]').filter({hasText:/^资料$/}).click()
 assert.equal(await listbox('提及员工或引用资料').isVisible(),true,'候选内分组标题不算外点')
 assert.equal(await focused(),'群讨论消息','点击候选内标题保持输入焦点')
 await page.screenshot({path:process.env.GROUP_REFERENCE_SHOT??'/tmp/teloa-group-reference-candidates.png'})
 // 外点（输入框之外的目录搜索）收起，不发送、不带入。
 await page.getByRole('textbox',{name:'目录搜索',exact:true}).click()
 await listbox('提及员工或引用资料').waitFor({state:'hidden'})
 assert.deepEqual(await chips(),[])
 // 引用图标：只列资料／文件，Esc 收起且焦点回到输入框；再次打开后点选一次即带入并关闭。
 await icon.click();await listbox('引用资料').waitFor()
 assert.deepEqual(await sections(),['资料','资料库引用','文件'])
 assert.equal(await icon.getAttribute('aria-expanded'),'true')
 assert.equal(await focused(),'群讨论消息','图标打开候选后焦点回到输入框')
 await page.keyboard.press('Escape');await listbox('引用资料').waitFor({state:'hidden'})
 assert.equal(await focused(),'群讨论消息','Esc 收起后焦点仍在输入框')
 assert.equal(await icon.getAttribute('aria-expanded'),'false')
 assert.equal(await message.inputValue(),'@ @','Esc 只收起候选：此前敲的 @ 与图标插入的 @ 都原样保留，不偷删查询词')
 // 图标打开后继续输入关键词：只按本群资料/文件过滤、不列员工，菜单不关闭。
 await message.fill('');await icon.click();await listbox('引用资料').waitFor()
 await message.type('合');assert.deepEqual(await optionNames(),['合同扫描件.pdf']);assert.equal(await icon.getAttribute('aria-expanded'),'true')
 await message.type('x');assert.deepEqual(await optionNames(),[]);assert.deepEqual(await sections(),['没有匹配的资料'])
 await page.locator('li[role="presentation"]').click()
 assert.equal(await listbox('引用资料').isVisible(),true,'空态提示也是候选窗口内部')
 assert.equal(await focused(),'群讨论消息')
 await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>(window as any).referenceFixture.sent.length),0,'空态候选回车不发送')
 await page.keyboard.press('Escape');await listbox('引用资料').waitFor({state:'hidden'})
 // 中文输入法确认候选词：候选开着时 isComposing 的回车既不选也不发。
 await message.fill('');await message.type('@方');await listbox('引用资料').waitFor()
 await message.evaluate((node:HTMLElement)=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true})))
 assert.equal(await listbox('引用资料').isVisible(),true,'输入法回车不关闭候选')
 assert.deepEqual(await chips(),[]);assert.equal(await page.evaluate(()=>(window as any).referenceFixture.sent.length),0)
 // 普通回车选中当前项：去掉 @过滤词、出标签、候选关闭、焦点回输入框。
 await page.keyboard.press('Enter');await listbox('引用资料').waitFor({state:'hidden'})
 assert.deepEqual(await chips(),['移除 方案资料']);assert.equal(await message.inputValue(),'');assert.equal(await focused(),'群讨论消息')
 // 已引用项禁用，不能从候选撤销；移除走标签。
 await icon.click();await listbox('引用资料').waitFor()
 const picked=page.locator('li[role="option"]',{hasText:'方案资料'});assert.equal(await picked.getAttribute('aria-disabled'),'true')
 await picked.dispatchEvent('mousedown');assert.deepEqual(await chips(),['移除 方案资料'],'点已引用项不撤销')
 // 后台窗口的动画帧可能晚于下一次输入；旧引用选择不能在用户打字后重新移动光标。
 await page.evaluate(()=>{const w=window as any;w.referenceDeferredFrames=[];w.referencePreviousFrame=window.requestAnimationFrame;window.requestAnimationFrame=callback=>{w.referenceDeferredFrames.push(callback);return w.referenceDeferredFrames.length}})
 // 鼠标点选已共享文件：复用原 attachment，不上传。
 await page.locator('li[role="option"]',{hasText:'合同扫描件.pdf'}).dispatchEvent('mousedown')
 await listbox('引用资料').waitFor({state:'hidden'})
 assert.deepEqual(await chips(),['移除 方案资料','移除 合同扫描件.pdf'])
 assert.equal(await page.evaluate(()=>(window as any).referenceFixture.uploads),0,'已共享文件不重新上传')
 // 键盘：↓ 跨组移动并用 Tab 选中员工提及，证明两类候选共用一套键盘。
 await message.type('@')
 await page.evaluate(()=>{const w=window as any;window.requestAnimationFrame=w.referencePreviousFrame;for(const callback of w.referenceDeferredFrames)callback(performance.now());delete w.referencePreviousFrame;delete w.referenceDeferredFrames})
 await page.keyboard.type('林');assert.equal(await message.inputValue(),'@林','迟到动画帧不能把新输入插到旧光标处');await listbox('提及员工或引用资料').waitFor()
 assert.deepEqual(await sections(),['员工','资料'])
 await page.keyboard.press('ArrowDown');assert.equal(await page.locator('li[role="option"][aria-selected="true"]').getAttribute('id'),'resource-main-55555555-5555-4555-8555-555555555555')
 await page.keyboard.press('ArrowUp');await page.keyboard.press('Tab')
 assert.equal(await message.inputValue(),'@林析 ','选员工仍插入 @名字 标记')
 // 发送：引用只带 id 与固定版本（资料 v2、原附件 v1），没有任何授权请求。
 await message.fill('@林析 请核对合同与方案。');await page.keyboard.press('Enter')
 await page.waitForFunction(()=>(window as any).referenceFixture.sent.length===1)
 const sent=await page.evaluate(()=>(window as any).referenceFixture.sent[0])
 assert.deepEqual(sent.references,[{kind:'group-resource',id:'44444444-4444-4444-8444-444444444444',version:2},{kind:'attachment',id:'att-shared',version:1}])
 assert.equal(await page.evaluate(()=>(window as any).referenceFixture.grants),0,'选资料/文件不触发员工授权')
 assert.deepEqual(await chips(),[],'发送后标签随草稿清空')
 if(await page.getByRole('dialog').count()){await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'})}
 // 资料库原件通过同一显式候选加入原草稿；跨业务及撤回原件不出现，选择不触发发送或授权。
 await icon.click();await listbox('引用资料').waitFor();assert.ok(!(await optionNames()).includes('跨业务原件'));assert.ok(!(await optionNames()).includes('已撤回原件'))
 await page.locator('li[role="option"]',{hasText:'资料库原件'}).dispatchEvent('mousedown');await listbox('引用资料').waitFor({state:'hidden'})
 assert.deepEqual(await chips(),['移除 资料库原件']);assert.equal(await page.evaluate(()=>(window as any).referenceFixture.sent.length),1);assert.equal(await page.evaluate(()=>(window as any).referenceFixture.grants),0)
 await message.fill('请核对固定原件');await page.keyboard.press('Enter');await page.waitForFunction(()=>(window as any).referenceFixture.sent.length===2)
 assert.deepEqual((await page.evaluate(()=>(window as any).referenceFixture.sent))[1].references,[{kind:'work-resource',id:'88888888-8888-4888-8888-888888888888',version:3}])
 if(await page.getByRole('dialog').count()){await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'})}
 await page.getByRole('button',{name:/资料库原件/}).click();assert.deepEqual(await page.evaluate(()=>(window as any).referenceFixture.opened),[{kind:'work-resource',id:'88888888-8888-4888-8888-888888888888',version:3}])
 await page.screenshot({path:process.env.GROUP_REFERENCE_FINAL_SHOT??'/tmp/teloa-group-reference-final.png'})
 assert.equal(await page.evaluate(()=>(window as any).referenceFixture.uploads),0);assert.equal(await page.evaluate(()=>(window as any).referenceFixture.grants),0)
 // 授权另走本人明确提交；已发送的固定原件才成为候选，默认未勾选、不默认允许发言或自动运行。
 await page.getByRole('button',{name:'2 位成员',exact:true}).click();await page.getByRole('button',{name:'林析的本群授权',exact:true}).click()
 const grant=page.getByRole('dialog',{name:'配置授权',exact:true}),library=grant.getByRole('checkbox',{name:'资料库原件 v3',exact:true})
 await library.waitFor();assert.equal(await library.isChecked(),false);assert.equal(await grant.getByRole('checkbox',{checked:true}).count(),0)
 await library.check();assert.equal(await page.evaluate(()=>(window as any).referenceFixture.grants),0)
 await grant.getByRole('button',{name:'保存修改',exact:true}).click();await page.waitForFunction(()=>(window as any).referenceFixture.grants===1)
 assert.deepEqual((await page.evaluate(()=>(window as any).referenceFixture.grantCalls))[0],['11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',1,1,'save',[{kind:'work-resource',id:'88888888-8888-4888-8888-888888888888',version:3}],false,false])
 assert.deepEqual(errors,[])
})
