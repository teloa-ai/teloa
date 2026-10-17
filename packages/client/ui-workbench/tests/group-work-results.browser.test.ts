import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('群概况复用原会话成果行，固定版本预览与来源不丢讨论草稿',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-group-results-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {GroupWorkResults} from '${client}GroupWorkResults.tsx';import {groupSharedResults} from '${client}group-result-index.ts';import {ConversationWorkOverview} from '${client}ConversationWorkOverview.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const view=createRoot(document.getElementById('root')),locale='zh-CN',snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const message=(id,groupId,version,createdAt)=>({id,groupId,rootId:null,authorId:'self',text:'测试成果',references:[{kind:'artifact',id:'report',version}],mentions:[],createdAt});
 const old=message('old','one',1,'2026-10-12T01:00:00Z'),current=message('current','one',2,'2026-10-12T02:00:00Z'),privateResult=message('private','two',9,'2026-10-12T03:00:00Z');
 const f=window.resultFixture={calls:[],groupId:'one',fail:false,messages:[old,current,privateResult],summaries:{'artifact:report:1':{state:'ready',title:'调查报告.md',files:[]},'artifact:report:2':{state:'ready',title:'调查报告.md',files:[]},'artifact:report:9':{state:'ready',title:'私人结果',files:[]}},render:()=>render()};
 const native={sessionId:'original',status:'completed',progress:{current:[],earlier:[]},running:[],ended:[],usageGroups:[],artifacts:[{id:'native',sessionId:'original',label:'原会话报告.md',kind:'Markdown',status:'final',version:'v2'}]};
 function render(){flushSync(()=>view.render(<I18nProvider runtime={runtime}><main style={{display:'flex',gap:24}}><textarea aria-label="群讨论草稿" defaultValue="未发送的群讨论"/><aside aria-label="群工作概况" style={{width:360}}><GroupWorkResults groupId={f.groupId} rows={groupSharedResults(f.groupId,f.messages)} summaries={f.summaries} roleNames={{}} openArtifact={async(id,version)=>{if(f.fail)throw Error('read failed');f.calls.push(['preview',id,version])}} openMessage={message=>f.calls.push(['source',message.id])}/></aside><aside aria-label="原会话概况" style={{width:360}}><ConversationWorkOverview snapshot={native} onOpenRecord={()=>{}} onStopWork={()=>{}} onPreviewArtifact={row=>f.calls.push(['native',row.id])}/></aside></main></I18nProvider>))}render();`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'GroupResultsTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors:string[]=[];t.after(()=>page.close());page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const group=page.getByRole('complementary',{name:'群工作概况'}),nativeView=page.getByRole('complementary',{name:'原会话概况'})
 const current=group.getByRole('button',{name:'预览调查报告.md',exact:true})
 await current.waitFor()
 assert.equal(await group.getByText('私人结果',{exact:true}).count(),0)
 assert.equal(await current.count(),1,'只显示群内最新共享版；旧版折叠')
 assert.equal(await current.getAttribute('class'),await nativeView.getByRole('button',{name:'预览原会话报告.md',exact:true}).getAttribute('class'),'实际复用同一成果行与样式')
 await current.click();await group.getByRole('button',{name:'来源消息',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).resultFixture.calls),[['preview','report',2],['source','current']])
 const versions=group.locator('details');assert.equal(await versions.getAttribute('open'),null);await versions.locator('summary').click()
 await group.getByRole('button',{name:'预览调查报告.md',exact:true}).nth(1).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).resultFixture.calls.at(-1)),['preview','report',1])
 assert.equal(await page.getByLabel('群讨论草稿').inputValue(),'未发送的群讨论')
 await page.evaluate(()=>{const f=(window as any).resultFixture;f.groupId='two';f.render()})
 assert.equal(await group.getByRole('button',{name:'预览调查报告.md',exact:true}).count(),0,'切群不能显示原群成果')
 await group.getByRole('button',{name:'预览私人结果',exact:true}).waitFor()
 assert.equal(await group.locator('details').count(),0)
 await page.evaluate(()=>{const f=(window as any).resultFixture;f.groupId='one';f.fail=true;f.render()})
 await group.getByRole('button',{name:'预览调查报告.md',exact:true}).click()
 await group.getByRole('alert').waitFor();assert.doesNotMatch(await group.innerText(),/read failed/)
 assert.deepEqual(errors,[])
})
