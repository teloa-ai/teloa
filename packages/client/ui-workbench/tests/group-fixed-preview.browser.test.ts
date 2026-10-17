import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('实际群消息和概况共用固定版本抽屉，原文、迟到切群和关闭保留草稿',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-group-fixed-preview-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';import {createGroupAttachmentApi} from '${client}group-attachment-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.className=tokens.tokens;document.body.style.margin='0';document.getElementById('root').style.height='100dvh';
 const view=createRoot(document.getElementById('root')),locale='zh-CN',snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},at='2026-10-12T02:00:00Z';
 const groupId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222',report='77777777-7777-4777-8777-777777777777',roleId='33333333-3333-4333-8333-333333333333',resourceId='44444444-4444-4444-8444-444444444444',attachmentId='55555555-5555-4555-8555-555555555555';
 let groupName='共享成果群',groupVersion=1;
 const group=(id)=>({id,ownerId:'self',version:id===groupId?groupVersion:1,name:id===groupId?groupName:'另一群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:at,updatedAt:at});
 const members=id=>[{groupId:id,roleId:null,createdAt:at},{groupId:id,roleId,createdAt:at}],roles=[{id:roleId,name:'资料核对员工',kind:'employee',state:'active',scopes:['general'],version:3,duty:'核对明确提供的资料',dataScope:'仅已获准资料',executionScope:'只读核对',skills:[],knowledge:[],memories:[],history:[]}],resource={id:resourceId,ownerId:'self',groupId,title:'群核对资料',version:2,withdrawnAt:null,createdAt:at,updatedAt:at};
 const msg=(id,version,rootId=null)=>({id,groupId,rootId,authorId:'self',text:'原始来源消息 '+id,references:[{kind:'artifact',id:report,version}],mentions:[],createdAt:at});
 const rows=[msg('old',1),msg('current',2),{...msg('duplicate',2),text:'原始来源消息 duplicate '+('长讨论记录，保留原阅读位置。'.repeat(150))}],reply=msg('reply',2,'current');
 const api={list:async()=>({items:[group(groupId),group(otherId)]}),get:async(id)=>({group:group(id),members:members(id)}),agentGrant:async(id,worker)=>({groupId:id,roleId:worker,status:'not-granted'}),messages:async(id,rootId)=>({items:id===groupId?(rootId?[rows.find(row=>row.id===rootId),reply].filter(Boolean):rows):[]}),resources:async(id)=>({items:id===groupId?[resource]:[]}),change:async(id,version,fields)=>{f.writes.push(['change',id,version,fields]);groupName=fields.name;groupVersion++;return {group:group(id),members:members(id)}},send:async(id,version,text,rootId,references,mentions)=>{f.writes.push(['send',id,version,text,rootId??null,references??[],mentions??[]]);const saved={id:'sent',groupId:id,rootId:rootId??null,authorId:'self',text,references:references??[],mentions:mentions??[],createdAt:at};rows.push(saved);return saved},pending:()=>undefined,recoveryMessage:()=>undefined};
 const f=window.fixedPreviewFixture={calls:[],writes:[],uploads:[],openedTasks:[],groupId,otherId,report,roleId,resourceId,attachmentId,target:{groupId,rootId:''},hold:false,release:null,visible:true,render:()=>render()};
 const work={tasks:[{id:'original-task',storage:'persistent',groupId,title:'原群核对任务',state:'ready',assigneeId:'self',need:null},{id:'other-task',storage:'persistent',groupId:otherId,title:'另一群任务',state:'ready',assigneeId:'self',need:null}],openTask:id=>f.openedTasks.push(id),openRole:()=>{}};
 const previews=createGroupAttachmentApi(async(endpoint,payload)=>{f.calls.push([endpoint,payload]);
 if(endpoint==='groups/attachments/list')return {items:[]};
 if(endpoint==='artifacts/versions'){if(f.hold)await new Promise(resolve=>{f.release=resolve});return [1,2,3].map(number=>({artifactId:report,ownerId:'self',number,source:{kind:'session',id:'original-session',scope:'general',version:'v1',title:'原会话'},content:{title:number===3?'未共享私人v3':'调查报告',sections:[{id:'body',title:'摘要',text:number===3?'私人草稿 A3':'固定正文 v'+number}],snapshotIds:[],messageSnapshotIds:number===2?['a'.repeat(64)]:[],note:'固定版本'},createdAt:at}))}
 if(endpoint==='artifacts/message/snapshot')return {sessionId:'original-session',messageId:'original-message',seq:1,role:'assistant',at,text:'已共享原消息快照',interrupted:false,omittedBlocks:0,images:[]};
 throw Error('不得读取来源全目录/私人草稿/反馈');
 });
 const attachments={...previews,upload:async(id,version,file,requestId)=>{f.uploads.push([id,version,file.name,file.type,file.size,requestId]);return {attachmentId,ownerId:'self',version:1,kind:'file',mime:file.type,bytes:file.size,sha256:'b'.repeat(64),name:file.name,width:null,height:null,uploadedInGroupId:id,state:'active',createdAt:at,withdrawnAt:null}}};
 function render(){flushSync(()=>view.render(<I18nProvider runtime={runtime}><SavedCollaborationPage visible={f.visible} api={api} work={work} attachments={attachments} target={f.target} roles={roles} profileName="验收本人"/></I18nProvider>))}render();`)
 // DSH 消息正文解析由宿主注入；只透传原消息文字，群页面/抽屉/成果 MarkdownPreview 均用真实组件。
 await writeFile(join(temp,'unused-node-crypto.ts'),'export function createHash(){throw Error("不应执行服务器摘要")};export function randomUUID(){return crypto.randomUUID()};export function createPublicKey(){throw Error("不应执行服务签名")};export function verify(){throw Error("不应执行服务签名")}')
 await writeFile(join(temp,'host-markdown.ts'),'export const MarkdownText=({text})=>text')
 const result=await build({configFile:false,root,resolve:{alias:{'@deepseek-ai/dsh-client-ui-primitives':join(temp,'host-markdown.ts'),'node:crypto':join(temp,'unused-node-crypto.ts')}}, logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'GroupFixedPreviewTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(4000);const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 // 只由本测试路由提供页面；localhost 安全上下文保留真实 UUID API，其他请求继续拒绝。
 await page.route('http://127.0.0.1:49319/group-fixed-preview-test',async(route:any)=>route.fulfill({status:200,contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}))
 await page.goto('http://127.0.0.1:49319/group-fixed-preview-test');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByText('原始来源消息 current',{exact:true}).waitFor()
 const draft=page.locator('textarea').first();await draft.fill('保留原群草稿')
 const discussion=page.getByRole('region',{name:'讨论',exact:true}),composer=discussion.locator('form'),settings=page.getByRole('dialog',{name:'群设置',exact:true})
 assert.equal(await composer.getByRole('toolbar',{name:'Markdown 格式工具',exact:true}).count(),0,'默认正文专注输入，格式工具按需打开')
 await page.getByRole('button',{name:'群设置',exact:true}).click();await settings.waitFor()
 assert.equal(await settings.getByRole('textbox',{name:'群名称',exact:true}).inputValue(),'共享成果群','头像进入当前群设置')
 await settings.getByRole('textbox',{name:'群名称',exact:true}).fill('保留的群名草稿');await settings.getByRole('button',{name:'取消',exact:true}).click()
 assert.equal(await draft.inputValue(),'保留原群草稿');assert.deepEqual(await page.evaluate(()=>(window as any).fixedPreviewFixture.writes),[],'关闭设置不保存或发送')
 await page.getByRole('heading',{name:'共享成果群',exact:true}).getByRole('button',{name:'共享成果群',exact:true}).click();await settings.waitFor()
 assert.equal(await settings.getByRole('textbox',{name:'群名称',exact:true}).inputValue(),'保留的群名草稿','群名入口重开同一原群设置并恢复草稿')
 await settings.getByRole('textbox',{name:'群名称',exact:true}).fill('共享成果群已改名');await settings.getByRole('button',{name:'保存群设置',exact:true}).click();await settings.waitFor({state:'hidden'})
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture,change=f.writes[0];return {kind:change[0],groupId:change[1],version:change[2],fields:change[3]}}),{kind:'change',groupId:'11111111-1111-4111-8111-111111111111',version:1,fields:{name:'共享成果群已改名',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:['33333333-3333-4333-8333-333333333333'],pinned:false,archived:false}},'改名使用原群版本，不丢成员与规则')
 assert.equal(await draft.inputValue(),'保留原群草稿')
 const preview=page.getByRole('button',{name:'预览调查报告',exact:true});await preview.nth(1).click()
 const dialog=page.getByRole('dialog');await dialog.waitFor();assert.match(await dialog.innerText(),/固定正文 v2/);assert.match(await dialog.innerText(),/已共享原消息快照/);assert.doesNotMatch(await dialog.innerText(),/未共享私人v3|私人草稿 A3|历史稿件|操作未完成/)
 const transcript=page.locator('[data-teloa-message]').first().locator('..'),scroll=await transcript.evaluate((element:HTMLElement)=>({top:element.scrollTop,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight}))
 assert.ok(scroll.scrollHeight>scroll.clientHeight,'真实讨论区应可滚动')
 await page.screenshot({path:'/tmp/teloa-group-fixed-preview.png'});await dialog.getByRole('button',{name:'返回群讨论',exact:true}).click();assert.equal(await draft.inputValue(),'保留原群草稿');assert.equal(await transcript.evaluate((element:HTMLElement)=>element.scrollTop),scroll.top,'关闭预览恢复原讨论滚动')
 // 1440 宽屏且此前无本人偏好：进入群即并栏显示工作概览，入口按钮反映已展开。
 assert.equal(await page.getByRole('button',{name:'工作概览',exact:true}).getAttribute('aria-expanded'),'true')
 const overview=page.getByRole('complementary',{name:'工作概览',exact:true}),current=overview.getByRole('button',{name:'预览调查报告',exact:true});assert.equal(await current.count(),1,'重复共享同一版本只显示一行')
 const associated=page.getByRole('tab',{name:/^关联工作( \d+)?$/});assert.equal(await associated.isVisible(),true)
 assert.equal(await associated.evaluate((node:HTMLElement)=>node.closest('aside')?.getAttribute('aria-label')),'工作概览','关联工作只在右侧同一工作概览中承载')
 assert.equal(await discussion.locator('..').getByRole('button',{name:'关联工作',exact:true}).count(),0,'正文不再提供重复的关联工作页签')
 assert.equal(await overview.getByRole('button',{name:'另一群任务',exact:true}).count(),0,'关联工作仍按原群隔离')
 await overview.getByRole('button',{name:'原群核对任务',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixedPreviewFixture.openedTasks),['original-task'])
 assert.equal(await draft.inputValue(),'保留原群草稿','打开原关联任务不移动当前群草稿')
 await current.click();await dialog.waitFor();assert.match(await dialog.innerText(),/固定正文 v2/)
 await dialog.getByRole('button',{name:'关闭',exact:true}).click()
 const history=page.locator('details').filter({has:page.locator('summary').filter({hasText:'版本记录'})});await history.locator('summary').click()
 await overview.getByRole('button',{name:'预览调查报告',exact:true}).nth(1).click();await dialog.waitFor();assert.match(await dialog.innerText(),/固定正文 v1/);assert.doesNotMatch(await dialog.innerText(),/固定正文 v2|原消息快照/)
 await dialog.getByRole('button',{name:'返回群讨论',exact:true}).click()
 await page.getByRole('button',{name:'来源消息',exact:true}).first().click();await page.getByText('原始来源消息 reply',{exact:true}).waitFor()
 const topicDraft=page.locator('textarea').last();await topicDraft.fill('保留话题草稿')
 await page.getByRole('button',{name:'预览调查报告',exact:true}).last().click();await dialog.waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await topicDraft.inputValue(),'保留话题草稿')
 await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture;f.hold=true})
 await page.getByRole('button',{name:'预览调查报告',exact:true}).last().click();await dialog.waitFor()
 await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture;f.target={groupId:f.otherId,rootId:''};f.render();f.hold=false;f.release?.()})
 await page.getByRole('heading',{name:'另一群',exact:true}).waitFor();await dialog.waitFor({state:'detached'});assert.equal(await dialog.count(),0,'旧群迟到回包不能揭示')
 await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture;f.target={groupId:f.groupId,rootId:''};f.render()})
 await page.getByText('原始来源消息 current',{exact:true}).waitFor();assert.equal(await page.locator('textarea').first().inputValue(),'保留原群草稿')
 // 关闭准备中的预览后，迟到读回不能重开；同群另一个话题也会取消旧预览。
 await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture;f.hold=true;f.release=null})
 await page.getByRole('button',{name:'预览调查报告',exact:true}).nth(1).click();await dialog.waitFor()
 await page.waitForFunction(()=>typeof (window as any).fixedPreviewFixture.release==='function')
 await dialog.getByRole('button',{name:'关闭',exact:true}).click()
 await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture;f.hold=false;f.release?.()})
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal(await dialog.count(),0,'关闭后的迟到回包不得重开')
 await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture;f.hold=true;f.release=null})
 await page.getByRole('button',{name:'预览调查报告',exact:true}).nth(1).click();await dialog.waitFor()
 await page.waitForFunction(()=>typeof (window as any).fixedPreviewFixture.release==='function')
 await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture;f.target={groupId:f.groupId,rootId:'old'};f.render();f.hold=false;f.release?.()})
 await dialog.waitFor({state:'detached'})
 assert.equal(await page.locator('textarea').first().inputValue(),'保留原群草稿')
 assert.equal(await dialog.count(),0,'同群话题导航不得消费旧预览')
 // 收起格式栏不会移除原发送链路：实际编辑、选择员工与固定资料、上传后只由本人点击发送。
 await page.evaluate(()=>{const f=(window as any).fixedPreviewFixture;f.target={groupId:f.groupId,rootId:''};f.render()})
 await page.getByText('原始来源消息 current',{exact:true}).waitFor();await draft.fill('核对资料')
 await composer.getByRole('button',{name:'Markdown 格式工具',exact:true}).click()
 await draft.focus();await draft.press('Home');await draft.press('Shift+End');await composer.getByRole('button',{name:'粗体',exact:true}).click()
 assert.equal(await draft.inputValue(),'**核对资料**')
 await composer.getByRole('button',{name:'Markdown 格式工具',exact:true}).click();assert.equal(await composer.getByRole('toolbar').count(),0)
 await draft.focus()
 const focus=await draft.evaluate((input:HTMLTextAreaElement)=>({active:input===document.activeElement,innerOutline:getComputedStyle(input).outlineStyle,innerShadow:getComputedStyle(input).boxShadow,innerBorder:getComputedStyle(input).borderTopWidth,outerShadow:getComputedStyle(input.closest('form')!).boxShadow}))
 assert.equal(focus.active,true);assert.equal(focus.innerOutline,'none');assert.equal(focus.innerShadow,'none');assert.equal(focus.innerBorder,'0px');assert.notEqual(focus.outerShadow,'none','群输入只在外框显示一处焦点提示')
 await draft.press('End');await composer.getByRole('button',{name:'提及员工',exact:true}).click();await page.getByRole('option',{name:'资料核对员工',exact:true}).click();assert.match(await draft.inputValue(),/@资料核对员工/)
 await composer.getByRole('button',{name:'引用资料',exact:true}).click();const references=page.getByRole('listbox',{name:'引用资料',exact:true})
 await references.getByRole('option',{name:/群核对资料/}).click();await references.waitFor({state:'hidden'});assert.equal(await composer.getByRole('button',{name:'移除 群核对资料',exact:true}).count(),1,'一次选择后引用标签可移除')
 const chooserPromise=page.waitForEvent('filechooser');await composer.getByRole('button',{name:'附件',exact:true}).click();const chooser=await chooserPromise;await chooser.setFiles({name:'群核对.txt',mimeType:'text/plain',buffer:Buffer.from('固定附件')})
 await composer.getByRole('button',{name:'移除 群核对.txt',exact:true}).waitFor();await page.waitForFunction(()=>(window as any).fixedPreviewFixture.uploads.length===1)
 assert.deepEqual((await page.evaluate(()=>(window as any).fixedPreviewFixture.uploads))[0].slice(0,5),['11111111-1111-4111-8111-111111111111',2,'群核对.txt','text/plain',12],'附件仍使用原群与当前版本')
 assert.deepEqual(await page.evaluate(()=>(window as any).fixedPreviewFixture.writes.map((row:any[])=>row[0])),['change'],'格式、提及、引用和选附件不会自行发送')
 const sentText=await draft.inputValue();await composer.getByRole('button',{name:'发送群消息',exact:true}).click()
 await page.waitForFunction(()=>(window as any).fixedPreviewFixture.writes.some((row:any[])=>row[0]==='send'))
 const sent=await page.evaluate(()=>(window as any).fixedPreviewFixture.writes.find((row:any[])=>row[0]==='send'))
 assert.deepEqual(sent.slice(0,5),['send','11111111-1111-4111-8111-111111111111',2,sentText,null],'真实发送仍提交原群与版本，正文保持所选格式')
 assert.deepEqual(sent[5],[{kind:'group-resource',id:'44444444-4444-4444-8444-444444444444',version:2},{kind:'attachment',id:'55555555-5555-4555-8555-555555555555',version:1}],'发送锁定所选资料和附件版本')
 assert.deepEqual(sent[6],[{roleId:'33333333-3333-4333-8333-333333333333',expectedVersion:3}],'提及仍核对原成员版本，不由 UI 简化增加授权')
 assert.equal(await draft.inputValue(),'','核对发送回执后清空已发送草稿')
 assert.deepEqual(errors,[])
 assert.ok((await page.evaluate(()=>(window as any).fixedPreviewFixture.calls)).every(([endpoint]:[string])=>!['artifacts/list','artifacts/feedback'].includes(endpoint)))
})
