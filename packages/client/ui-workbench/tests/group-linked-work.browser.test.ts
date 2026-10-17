import {test,before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用当前工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),legacyScopes=fileURLToPath(new URL('./fixtures/legacy-security-scopes.ts',import.meta.url))
let browser:any,script:string,styles:string
declare global {interface Window {groupWorkSeed?:boolean;groupWorkFixture:{hold:boolean;waiting:boolean;release:()=>void;switchGroup:(key:'a'|'b',replaceSource?:boolean)=>void;unlinkProject:()=>void;refreshGroup:()=>void;state:()=>{calls:Array<{groupId:string;expectedVersion:number;links:Array<{id:string}>}>;reads:Record<string,number>;versions:Record<string,number>;opened:Array<{id:string}>}}}}
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {GroupLinkedWork} from '${client}GroupLinkedWork.tsx';
import {createGroupWorkLinkApi} from '${client}group-work-links-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {legacySecurityLabels} from '${legacyScopes}';
const ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222'};
const projects={a:{kind:'project',scope:'general',id:'33333333-3333-4333-8333-333333333333',title:'Project A',state:'planning',available:true,objectVersion:1},b:{kind:'project',scope:'general',id:'44444444-4444-4444-8444-444444444444',title:'Project B',state:'planning',available:true,objectVersion:1}};
const details=Object.fromEntries(Object.values(ids).map(groupId=>[groupId,{groupId,groupVersion:1,version:0,items:[]}]));
const calls=[],reads={},opened=[],receipts=new Map(),projectLinks={[ids.a]:window.groupWorkSeed?[projects.a]:[]};let serial=0;
const f=window.groupWorkFixture={hold:false,waiting:false,release:()=>{},switchGroup:()=>{},refreshGroup:()=>{},unlinkProject:()=>{projectLinks[ids.a]=[]},state:()=>({calls:structuredClone(calls),reads:{...reads},opened:structuredClone(opened),versions:Object.fromEntries(Object.entries(details).map(([id,row])=>[id,row.version]))})};
const io=async(endpoint,request)=>{
 if(endpoint==='groups/work/get'){reads[request.groupId]=(reads[request.groupId]??0)+1;return structuredClone({...details[request.groupId],projectLinks:projectLinks[request.groupId]??[]});}
 if(endpoint==='groups/work/candidates')return request.kind==='project'&&request.scope==='general'?[projects[request.groupId===ids.a?'a':'b']].filter(item=>item.title.toLowerCase().includes(request.query.toLowerCase())):[];
 if(endpoint!=='groups/work/change')throw Error('Unexpected endpoint');
 calls.push(structuredClone(request));
 if(f.hold){f.waiting=true;await new Promise(resolve=>f.release=resolve);f.waiting=false;}
 const prior=receipts.get(request.requestId);if(prior){if(JSON.stringify(prior.request)!==JSON.stringify(request))throw Object.assign(Error('Request changed'),{rejected:true,code:'teloa/conflict'});return structuredClone(prior.result);}
 const current=details[request.groupId];
 if(request.expectedGroupVersion!==current.groupVersion||request.expectedVersion!==current.version)throw Object.assign(Error('Version changed'),{rejected:true,code:'teloa/version-conflict'});
 const next={groupId:request.groupId,groupVersion:current.groupVersion,version:current.version+1,items:request.links.map(link=>({...Object.values(projects).find(item=>item.id===link.id),...link}))};
 details[request.groupId]=next;receipts.set(request.requestId,{request:structuredClone(request),result:structuredClone(next)});return structuredClone(next);
};
const newApi=()=>createGroupWorkLinkApi(io,undefined,()=> '90000000-0000-4000-8000-'+String(++serial).padStart(12,'0'));
const primaryApi=newApi(),replacementApi=newApi();
const group=key=>({id:ids[key],ownerId:'owner',version:1,name:'Group '+key.toUpperCase(),scope:'general',archived:false});
function App(){
 const [,refresh]=useState(0);f.refreshGroup=()=>refresh(value=>value+1);
 const [key,setKey]=useState('a'),[replaced,setReplaced]=useState(false);f.switchGroup=(key,replaceSource=false)=>{setKey(key);setReplaced(replaceSource)};
 return <><div data-view="primary"><GroupLinkedWork group={group(key)} api={replaced?replacementApi:primaryApi} tasks={[]} open={item=>opened.push(item)} openTask={()=>{}}/></div><div data-view="secondary"><GroupLinkedWork group={group('a')} api={primaryApi} tasks={[]} open={()=>{}} openTask={()=>{}}/></div></>;
}
const snapshot={locale:'en',dshLocale:'en',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:key=>key};
// 业务空间下拉只在目录有多个空间时出现；新目录只预置通用工作（6f7346a），这里显式给出存量多空间目录。
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><BusinessScopeProvider labels={legacySecurityLabels()}><App/></BusinessScopeProvider></I18nProvider>);
`
before(async()=>{
 const virtual=root+'__group_linked_work_browser_fixture.tsx'
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'group-linked-work-fixture',resolveId:id=>id.endsWith('group-linked-work-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-linked-work-fixture',name:'GroupLinkedWorkFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function mount(t:TestContext,projectLinks=false){
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors:string[]=[]
 page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:':root{--teloa-surface:#fff;--teloa-border:#ddd;--teloa-text:#242823;--teloa-muted:#63695f;--teloa-accent:#9e4226;--teloa-on-accent:#fff}body{margin:0;font-family:system-ui}'+styles})
 if(projectLinks)await page.addScriptTag({content:'window.groupWorkSeed=true'})
 await page.addScriptTag({content:script})
 await page.locator('[data-view="primary"]').getByRole('button',{name:'Link work',exact:true}).waitFor()
 await page.waitForFunction(()=>{const buttons=[...document.querySelectorAll('[aria-label="Link work"]')];return buttons.length===2&&buttons.every(button=>button instanceof HTMLButtonElement&&!button.disabled)})
 return page
}
async function chooseProject(view:any,name:string){
 await view.getByRole('button',{name:'Link work',exact:true}).click()
 const drawer=view.getByRole('dialog')
 // N15：类型为紧凑切换而非下拉；夹具的业务范围上下文有多个空间，业务空间下拉按需保留。
 assert.equal(await drawer.getByRole('combobox',{name:'Type',exact:true}).count(),0)
 assert.equal(await drawer.getByRole('combobox',{name:'Business space',exact:true}).count(),1)
 await drawer.getByRole('button',{name:'Project',exact:true}).click()
 await drawer.getByRole('checkbox',{name:new RegExp(name)}).check()
 return drawer
}
test('保存成功关闭自身抽屉并清除旧版本；重开移除使用新的真实base',async t=>{
 const page=await mount(t),view=page.locator('[data-view="primary"]'),drawer=await chooseProject(view,'Project A')
 await drawer.getByRole('button',{name:'Save links',exact:true}).click()
 await drawer.waitFor({state:'detached'})
 assert.equal(await view.getByRole('button',{name:'Project A',exact:true}).count(),1)
 await view.getByRole('button',{name:'Link work',exact:true}).click()
 const reopened=view.getByRole('dialog')
 await reopened.getByRole('button',{name:'Unlink: Project A',exact:true}).click()
 await reopened.getByRole('button',{name:'Save links',exact:true}).click();await reopened.waitFor({state:'detached'})
 const state=await page.evaluate(()=>window.groupWorkFixture.state())
 assert.deepEqual(state.calls.map((call:{expectedVersion:number})=>call.expectedVersion),[0,1])
 assert.deepEqual(state.calls.map((call:{links:unknown[]})=>call.links.length),[1,0])
})
test('真实API发布保存通知同时刷新群消息与目录视图',async t=>{
 const page=await mount(t),primary=page.locator('[data-view="primary"]'),secondary=page.locator('[data-view="secondary"]')
 const before=await page.evaluate(()=>window.groupWorkFixture.state())
 const drawer=await chooseProject(primary,'Project A');await drawer.getByRole('button',{name:'Save links',exact:true}).click()
 await secondary.getByRole('button',{name:'Project A',exact:true}).waitFor();await drawer.waitFor({state:'detached'})
 assert.equal(await primary.getByRole('button',{name:'Project A',exact:true}).count(),1)
 const after=await page.evaluate(()=>window.groupWorkFixture.state())
 assert.equal(after.calls.length,1)
 const id='11111111-1111-4111-8111-111111111111'
 assert.ok(after.reads[id]>=before.reads[id]+2,'两个真实订阅视图均重新读取保存结果')
})
test('跨群与订阅来源切换后的lateSave不关闭新抽屉、不覆盖新选择',async t=>{
 const page=await mount(t),view=page.locator('[data-view="primary"]'),drawer=await chooseProject(view,'Project A')
 await page.evaluate(()=>window.groupWorkFixture.hold=true)
 await drawer.getByRole('button',{name:'Save links',exact:true}).click();await page.waitForFunction(()=>window.groupWorkFixture.waiting)
 // 更换公共api来源代表新视图的订阅生命周期；旧api保存继续等待真实IO，不改组件私有状态。
 await page.evaluate(()=>window.groupWorkFixture.switchGroup('b',true))
 await page.waitForFunction(()=>document.querySelector('[data-view="primary"] dialog')===null)
 const next=await chooseProject(view,'Project B');await next.getByRole('textbox',{name:'Search original work'}).fill('Project B')
 await page.evaluate(()=>{window.groupWorkFixture.hold=false;window.groupWorkFixture.release()})
 await page.locator('[data-view="secondary"]').getByRole('button',{name:'Project A',exact:true}).waitFor()
 assert.equal(await next.count(),1)
 assert.equal(await next.getByRole('textbox',{name:'Search original work'}).inputValue(),'Project B')
 assert.equal(await next.getByRole('button',{name:'Unlink: Project B',exact:true}).count(),1)
 assert.equal(await next.getByRole('button',{name:'Unlink: Project A',exact:true}).count(),0)
 await next.getByRole('button',{name:'Save links',exact:true}).click();await next.waitFor({state:'detached'})
 const state=await page.evaluate(()=>window.groupWorkFixture.state())
 assert.deepEqual(state.calls.map((call:{groupId:string})=>call.groupId),['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'])
 assert.equal(state.calls[1].links[0].id,'44444444-4444-4444-8444-444444444444')
})
test('取消仅收起抽屉，重开保留选择与搜索草稿，不发保存请求',async t=>{
 const page=await mount(t),view=page.locator('[data-view="primary"]'),drawer=await chooseProject(view,'Project A')
 await drawer.getByRole('textbox',{name:'Search original work'}).fill('Project A')
 await drawer.getByRole('button',{name:'collaboration.form.cancel',exact:true}).click();await drawer.waitFor({state:'detached'})
 assert.equal((await page.evaluate(()=>window.groupWorkFixture.state())).calls.length,0)
 await view.getByRole('button',{name:'Link work',exact:true}).click()
 const reopened=view.getByRole('dialog')
 assert.equal(await reopened.getByRole('textbox',{name:'Search original work'}).inputValue(),'Project A')
 assert.equal(await reopened.getByRole('button',{name:'Unlink: Project A',exact:true}).count(),1)
 assert.equal((await page.evaluate(()=>window.groupWorkFixture.state())).calls.length,0)
})

test('项目侧关联在群中显示并直接导航原项目，不能在群抽屉重复保存或伪造移除',async t=>{
 const page=await mount(t,true),view=page.locator('[data-view="primary"]')
 await view.getByRole('button',{name:'Project A',exact:true}).click()
 assert.equal((await page.evaluate(()=>window.groupWorkFixture.state())).opened[0].id,'33333333-3333-4333-8333-333333333333')
 await view.getByRole('button',{name:'Link work',exact:true}).click()
 const drawer=view.getByRole('dialog');await drawer.getByRole('button',{name:'Project',exact:true}).click()
 const candidate=drawer.getByRole('checkbox',{name:/Project A/});await candidate.waitFor();assert.equal(await candidate.isChecked(),true);assert.equal(await candidate.isDisabled(),true)
 assert.equal(await drawer.getByRole('button',{name:'Unlink: Project A',exact:true}).count(),0)
 await drawer.getByRole('button',{name:'Save links',exact:true}).click();await drawer.waitFor({state:'detached'})
 await view.getByRole('button',{name:'Project A',exact:true}).waitFor()
 assert.equal(await view.getByRole('button',{name:'Project A',exact:true}).count(),1)
 assert.deepEqual((await page.evaluate(()=>window.groupWorkFixture.state())).calls.map((call:{links:Array<{id:string}>})=>call.links),[[]])
 await page.evaluate(()=>{window.groupWorkFixture.unlinkProject();window.groupWorkFixture.switchGroup('b',true)})
 await view.getByRole('button',{name:'Project A',exact:true}).waitFor({state:'detached'})
 await page.evaluate(()=>window.groupWorkFixture.switchGroup('a',true))
 await page.waitForFunction(()=>document.querySelector('[data-view="primary"] [aria-label="Link work"]')?.hasAttribute('disabled')===false)
 assert.equal(await view.getByRole('button',{name:'Project A',exact:true}).count(),0,'原项目解除关系后原群读取同步反映，无第二份群关联遗留')
})

test('原群版本未变的真实刷新仍重新读取项目关联，解除后无需切群或重载浏览器',async t=>{
 const page=await mount(t,true),view=page.locator('[data-view="primary"]')
 await view.getByRole('button',{name:'Project A',exact:true}).waitFor()
 const before=await page.evaluate(()=>window.groupWorkFixture.state())
 await page.evaluate(()=>{window.groupWorkFixture.unlinkProject();window.groupWorkFixture.refreshGroup()})
 await view.getByRole('button',{name:'Project A',exact:true}).waitFor({state:'detached'})
 const after=await page.evaluate(()=>window.groupWorkFixture.state()),id='11111111-1111-4111-8111-111111111111'
 assert.ok(after.reads[id]>before.reads[id]);assert.deepEqual(after.calls,[]);assert.equal(after.versions[id],before.versions[id])
})
