import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('群回复入口空白起草、关闭刷新保留；Quota与迟到unknown不覆盖另一来源，恢复不重复创建',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-group-twin-draft-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {GroupTwinDraftComposer} from ${JSON.stringify(join(client,'GroupTwinDraftComposer.tsx'))};
 import {createTwinDraftApi} from ${JSON.stringify(join(client,'twin-drafts-api.ts'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};
 import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};
 import {prototypeThemes} from ${JSON.stringify(join(root,'packages/client/ui-workbench/src/brand/prototype-theme.ts'))};
 document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([k,v])=>document.body.style.setProperty(k,v));document.body.style.fontFamily='sans-serif';
 const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
 const role={id:'10000000-0000-4000-8000-000000000001',version:1},group={id:'20000000-0000-4000-8000-000000000001',name:'研发周同步'},ids=['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'],evidence=window.groupTwinEvidence={creates:0,quota:false,hold:true,lose:true,opened:[],release:()=>{}},saved=new Map();
 const call=async(endpoint,input)=>{if(endpoint!=='twin-drafts/create')throw Error('unexpected '+endpoint);if(!saved.has(input.requestId)){evidence.creates++;saved.set(input.requestId,{schema:'teloa.twin-draft/v1',id:crypto.randomUUID(),ownerId:'owner',roleId:role.id,roleVersion:1,revision:1,state:'draft',title:input.title,body:input.body,bodyHash:await hash(input.body),source:{kind:'group',groupId:group.id,messageId:input.source.messageId,groupVersion:1,rootId:null,label:group.name,text:'原群进度询问，不是默认回复',bodyHash:await hash('原群进度询问，不是默认回复')},basis:[],createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'})}
 if(evidence.hold){evidence.hold=false;await new Promise(resolve=>evidence.release=resolve)}if(evidence.lose){evidence.lose=false;throw Error('lost response')}return saved.get(input.requestId)};
 const api=createTwinDraftApi(call,{ownerId:'owner',namespace:'space',storage:{getItem:k=>localStorage.getItem(k),setItem:(k,v)=>{if(evidence.quota)throw Error('QuotaExceededError');localStorage.setItem(k,v)},removeItem:k=>localStorage.removeItem(k)}}),snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const [open,setOpen]=useState(true),[index,setIndex]=useState(0);return <I18nProvider runtime={i18n}><button onClick={()=>{setIndex(0);setOpen(true)}}>打开原消息</button><button onClick={()=>{setIndex(1);setOpen(true)}}>打开另一消息</button>{open&&<GroupTwinDraftComposer key={index} api={api} role={role} group={group} message={{id:ids[index],text:'原群进度询问，不是默认回复'}} close={()=>setOpen(false)} openWorkspace={(roleId,draftId)=>evidence.opened.push({roleId,draftId})}/>}</I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'GroupTwinComposerFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/group-twin-draft'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 const load=async()=>{await page.goto('http://127.0.0.1/group-twin-draft');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})}
 await load();const input=()=>page.getByRole('textbox',{name:'回复正文（Markdown）',exact:true})
 await input().waitFor();assert.equal(await input().inputValue(),'','来源原文绝不能默认成为回复')
 await input().fill('我准备的 Markdown 回复');await page.getByRole('button',{name:'关闭并保留输入',exact:true}).click()
 await page.getByRole('button',{name:'打开原消息',exact:true}).click();assert.equal(await input().inputValue(),'我准备的 Markdown 回复')
 await load();assert.equal(await input().inputValue(),'我准备的 Markdown 回复','刷新从来源隔离日志恢复正文')
 await page.evaluate(()=>{(window as any).groupTwinEvidence.quota=true});await input().fill('Quota 时的新输入')
 await page.getByText('浏览器未能持久保存新输入，请保留当前页面；切换稿件或收起编辑不会丢失本页输入。',{exact:true}).waitFor()
 await page.getByRole('button',{name:'关闭并保留输入',exact:true}).click();await page.getByRole('button',{name:'打开原消息',exact:true}).click();assert.equal(await input().inputValue(),'Quota 时的新输入')
 await page.evaluate(()=>{(window as any).groupTwinEvidence.quota=false});await input().fill('最终明确保存的回复')
 await page.getByRole('button',{name:'保存到分身待审',exact:true}).click()
 await page.waitForFunction(()=>(window as any).groupTwinEvidence.creates===1)
 await page.getByRole('button',{name:'关闭并保留输入',exact:true}).click();await page.getByRole('button',{name:'打开另一消息',exact:true}).click()
 assert.equal(await input().inputValue(),'');await input().fill('另一来源保留输入')
 await page.evaluate(()=>{(window as any).groupTwinEvidence.release()})
 await page.waitForTimeout(50)
 assert.equal(await input().inputValue(),'另一来源保留输入')
 assert.equal(await page.getByRole('button',{name:'打开分身工作区',exact:true}).count(),0,'旧入口迟答不把新来源标为已保存')
 await page.getByRole('button',{name:'关闭并保留输入',exact:true}).click();await page.getByRole('button',{name:'打开原消息',exact:true}).click()
 await page.getByRole('button',{name:'核对上次结果',exact:true}).click()
 await page.getByRole('button',{name:'打开分身工作区',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).groupTwinEvidence.creates),1)
 assert.equal(await page.getByRole('button',{name:'保存到分身待审',exact:true}).isDisabled(),true)
 await page.getByRole('button',{name:'打开分身工作区',exact:true}).click();assert.equal((await page.evaluate(()=>(window as any).groupTwinEvidence.opened)).length,1)
 await page.screenshot({path:join(temp,'group-twin-draft-composer.png'),fullPage:true})
 assert.deepEqual(errors,[])
})

test('群草稿入口核对唯一分身和完整原文，关闭迟答不污染新来源，错误可重试且窄屏可用',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-group-twin-entry-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {GroupTwinDraftEntry} from ${JSON.stringify(join(client,'GroupTwinDraftEntry.tsx'))};
 import {createTwinDraftApi} from ${JSON.stringify(join(client,'twin-drafts-api.ts'))};
 import {createRoleApi} from ${JSON.stringify(join(client,'role-api.ts'))};import {createGroupApi} from ${JSON.stringify(join(client,'group-api.ts'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};import {prototypeThemes} from ${JSON.stringify(join(root,'packages/client/ui-workbench/src/brand/prototype-theme.ts'))};
 document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([k,v])=>document.body.style.setProperty(k,v));document.body.style.fontFamily='sans-serif';
 const group={id:'20000000-0000-4000-8000-000000000001',ownerId:'owner',version:1,name:'研发周同步',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:false,mentionAllAllowed:false},pinned:false,archived:false,createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z'},role={id:'10000000-0000-4000-8000-000000000001',ownerId:'owner',version:1,state:'active',kind:'twin',name:'我的分身',scopes:['general'],duty:'准备回复',dataScope:'仅本人资料',executionScope:'仅起草',skills:[],knowledge:[],createdAt:group.createdAt,updatedAt:group.updatedAt},ids=['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'];
 const full='这是经过可信全文接口读取的完整原消息。'+'原文'.repeat(4001),hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join(''),evidence=window.groupTwinEntryEvidence={roleCalls:0,bodies:0,writes:0,duplicate:false,release:()=>{}};
 const roles=createRoleApi(async()=>{evidence.roleCalls++;if(evidence.roleCalls===1)await new Promise(resolve=>evidence.release=resolve);return evidence.duplicate?[role,{...role,id:'10000000-0000-4000-8000-000000000002'}]:[role]});
 const groups=createGroupApi(async(endpoint,input)=>{if(endpoint!=='groups/messages/body')throw Error('unexpected group call');evidence.bodies++;return {groupId:group.id,messageId:input.messageId,chars:full.length,sha256:await hash(full),text:full}},undefined,undefined,'owner');
 const api=createTwinDraftApi(async()=>{evidence.writes++;throw Error('must not write')},{ownerId:'owner',namespace:'entry',storage:localStorage}),snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const [open,setOpen]=useState(true),[index,setIndex]=useState(0),[summary,setSummary]=useState(null);React.useEffect(()=>{hash(full).then(sha256=>setSummary({chars:full.length,sha256}))},[]);return <I18nProvider runtime={i18n}><button onClick={()=>{setIndex(0);setOpen(true)}}>打开完整原消息</button><button onClick={()=>{setIndex(1);setOpen(true)}}>打开另一原消息</button>{open&&summary&&<GroupTwinDraftEntry api={api} roles={roles} groups={groups} group={group} message={{id:ids[index],groupId:group.id,rootId:null,authorId:'employee',taskId:'40000000-0000-4000-8000-000000000001',runId:'50000000-0000-4000-8000-000000000001',text:index?'另一原消息':'被截断的预览',references:[],createdAt:group.createdAt,...(index?{}:{fullText:summary})}} close={()=>setOpen(false)} openWorkspace={()=>{}}/>}</I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'GroupTwinEntryFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(6000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/group-twin-entry'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/group-twin-entry');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByText('正在核对分身与来源原文…',{exact:true}).waitFor().catch(async(error:Error)=>{throw Error(error.message+'; page='+await page.locator('body').innerText()+'; errors='+JSON.stringify(errors))})
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'打开另一原消息',exact:true}).click()
 const input=page.getByRole('textbox',{name:'回复正文（Markdown）',exact:true});await input.waitFor().catch(async(error:Error)=>{throw Error(error.message+'; page='+await page.locator('body').innerText()+'; errors='+JSON.stringify(errors))});await input.fill('另一来源的未提交输入')
 await page.evaluate(()=>{(window as any).groupTwinEntryEvidence.release()});await page.waitForTimeout(50)
 assert.equal(await input.inputValue(),'另一来源的未提交输入');assert.equal(await page.getByText('被截断的预览',{exact:true}).count(),0)
 await page.getByRole('button',{name:'关闭并保留输入',exact:true}).click();await page.evaluate(()=>{(window as any).groupTwinEntryEvidence.duplicate=true})
 await page.getByRole('button',{name:'打开完整原消息',exact:true}).click();await page.getByText('无法确定唯一可用的本人分身，请检查团队身份后重试。',{exact:true}).waitFor()
 assert.equal(await input.count(),0);await page.evaluate(()=>{(window as any).groupTwinEntryEvidence.duplicate=false});await page.getByRole('button',{name:'重新核对来源',exact:true}).click()
 await input.waitFor();assert.equal(await input.inputValue(),'');await page.getByText('来源消息预览',{exact:true}).click();assert.ok((await page.locator('blockquote').textContent())!.startsWith('这是经过可信全文接口读取的完整原消息。'));assert.ok((await page.locator('blockquote').textContent())!.length>8000)
 assert.equal(await page.evaluate(()=>(window as any).groupTwinEntryEvidence.writes),0,'仅加载与重试不得创建草稿')
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'390px抽屉不能横向溢出')
 await page.getByText('来源消息预览',{exact:true}).click();await page.screenshot({path:join(temp,'group-twin-draft-entry-narrow.png'),fullPage:true});assert.deepEqual(errors,[])
})
