import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用本工作树无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

for(const industry of [false,true])test(industry?'行业技能显示固定资源名，分享仍使用原生名与选中安装身份':'已安装技能同时具有本人保存内容时仍按选中安装身份分享，同名旧来源不会替换本次选择',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-installed-share-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 const selected='22222222-2222-4222-8222-222222222222',old='11111111-1111-4111-8111-111111111111'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketAppsDirectoryView} from '${client}/MarketAppsDirectory.tsx';import {appsDirectoryRows} from '${client}/market-apps-presentation.ts';import {TemplateShareProvider} from '${client}/EmployeeTemplateShare.tsx';import {I18nProvider} from '${client}/i18n/provider.tsx';import {translateMessage} from '${client}/i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(k,p)=>translateMessage('zh-CN',k,p),getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
 const industry=${industry},loadId='33333333-3333-4333-8333-333333333333',instanceId='44444444-4444-4444-8444-444444444444',contentId='55555555-5555-4555-8555-555555555555';
 const record=(id,updatedAt)=>({id,ownerId:'self',source:industry?{kind:'industry-local',loadId,itemInstanceId:instanceId,contentId,contentHash:'a'.repeat(64),resourceId:'summary',resourceVersion:'1.0.0'}:{kind:'atomic',contentId:id,contentHash:'a'.repeat(64),resourceId:'summary',resourceVersion:'1.0.0'},native:{name:'meeting-summary',description:'原会议方法',bodyHash:'b'.repeat(64),modelInvocable:true,userInvocable:true},bundleHash:'c'.repeat(64),state:'installed',version:1,createdAt:'2026-10-16T00:00:00.000Z',updatedAt});
 const resource={id:'summary',kind:'skill',title:'会议纪要工作方法',localized:{title:{original:'会议纪要工作方法',defaultLocale:'zh-CN',locales:{'zh-CN':'会议纪要工作方法',en:'Meeting summary method'}}},version:'1.0.0',required:true,source:{kind:'local',path:'skills/summary/SKILL.md'}},manifest={format:'teloa.business-package/v2',id:'meeting-team',title:'会议团队',version:'1.0.0',domain:'general',scope:'general',description:'原团队',resources:[resource,{id:'lead',kind:'role',title:'记录员',version:'1.0.0',required:true,source:{kind:'local',path:'roles/lead.json'}}],relations:[],entrypoints:[]};
 const rows=appsDirectoryRows({packages:industry?[{id:'stored-'+contentId,manifest,source:{contentId,contentHash:'a'.repeat(64)}}]:[],loads:industry?[{id:loadId,ownerId:'self',contentId,contentHash:'a'.repeat(64),templateId:manifest.id,templateVersion:manifest.version,items:[{instanceId,localId:resource.id,kind:'skill',title:resource.title,version:resource.version}]}]:[],items:[],connections:{status:'ready',records:[]},installations:[record('${old}','2026-10-16T00:00:00.000Z'),record('${selected}','2026-10-16T01:00:00.000Z')],storedContents:industry?[]:[{itemId:'stored-${selected}',contentId:'${selected}',contentHash:'a'.repeat(64),kind:'skill',title:'meeting-summary',summary:'原会议方法',version:'1.0.0',publisher:'本人'}],locale:'zh-CN'}),storage=new Map();
 const shared={publisher:'验收',storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},receive:()=>{},openDraft:()=>{},sources:{skills:async(names,selection)=>{document.getElementById('calls').textContent=JSON.stringify({names,selection});return [{name:'meeting-summary',title:'原会议方法',resourceId:'summary',version:'1.0.0',text:'---\\nname: meeting-summary\\ndescription: 原会议方法\\n---\\n只使用给定的资料。\\n',license:'MIT'}]}}};
 function App(){const [view,setView]=React.useState({query:'',category:'all',mine:true});return <I18nProvider runtime={runtime}><TemplateShareProvider value={shared}><output id='calls'/><MarketAppsDirectoryView rows={rows} ranking={new Map()} catalog={{status:'ready'}} connections={{status:'ready',records:[]}} view={view} onViewChange={setView} runAction={()=>{}} errors={{}} busy={undefined}/></TemplateShareProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 await writeFile(join(temp,'entry.tsx'),entry)
 const result=await build({root,configFile:false,logLevel:'error',resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.tsx'),formats:['iife'],name:'InstalledShare'},rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:industry?/^会议纪要工作方法/:/^meeting-summary/}).click()
 await page.getByRole('heading',{name:industry?'会议纪要工作方法':'meeting-summary',exact:true}).waitFor()
 await page.getByRole('button',{name:'分享技能',exact:true}).click()
 await page.getByRole('button',{name:'导出离线模板',exact:true}).waitFor()
 assert.deepEqual(JSON.parse(await page.locator('#calls').textContent()),{names:['meeting-summary'],selection:{installationId:selected}})
 assert.deepEqual(errors,[])
})
