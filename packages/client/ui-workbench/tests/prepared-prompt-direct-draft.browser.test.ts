import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {PreparedPromptCard} from '${client}PreparedPromptCard.tsx';import {PromptPreparation} from '${client}prompt-preparation.ts';import {nativePreparedInput} from '${client}native-prepared-input.ts';import {I18nProvider} from '${client}i18n/provider.tsx';
const preparation=new PromptPreparation(),listeners=new Set(),resource={id:'11111111-1111-4111-8111-111111111111',title:'原资料',version:2},skill={name:'summarize',source:'local/SKILL.md',provider:'teloa',userInvocable:true},sessionId='session-original';
let input={draft:'',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]},counter=0;
const fixture={calls:[],running:false,failReference:false,failRead:false,rows:()=>preparation.getSnapshot(),setInput:value=>{input={...input,...value,draftRev:input.draftRev+1};listeners.forEach(fn=>fn())}};window.directDraftFixture=fixture;
const state={getSnapshot:()=>input,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:key=>key};
const port=nativePreparedInput(()=>({state,running:fixture.running,text:request=>{fixture.calls.push(['text',request.span.draftRev]);if(request.span.draftRev!==input.draftRev)throw Error('CAS');fixture.setInput({draft:request.text});return true},reference:request=>{fixture.calls.push(['reference',request.span.draftRev]);if(fixture.failReference)return undefined;fixture.setInput({draft:'[资料]'+input.draft,occurrences:[...input.occurrences,{...request.reference,invalid:false}]});return true}}));
const binding={sessionId,status:'ready',catalogStatus:'ready',capabilities:{skills:[skill]}},work={subscribe:()=>()=>{},getSnapshot:()=>binding,readCatalog:async()=>{fixture.calls.push(['skills'])}},resourceApi={candidates:async()=>{fixture.calls.push(['resources',sessionId]);if(fixture.failRead)throw Error('unavailable');return [resource]}},validateTask=async row=>{fixture.calls.push(['task',row.sourceId,row.sessionId,row.sourceVersion])};
const prepare=(complex=false)=>preparation.prepare({id:'p'+(++counter),sourceId:'task-original',sourceVersion:3,sessionId,title:'明确选择的目标',text:'核对原记录',...(complex?{sourceKind:'task',taskSnapshot:'original-snapshot',resources:[resource],skills:[skill]}:{})});
function App(){const value=React.useSyncExternalStore(state.subscribe,state.getSnapshot),[visible,setVisible]=React.useState(true);return <I18nProvider runtime={runtime}><button onClick={()=>prepare()}>选择纯文字预设</button><button onClick={()=>prepare(true)}>选择任务资料技能</button><button onClick={()=>setVisible(!visible)}>切换准备卡片</button><textarea aria-label="原会话草稿" value={value.draft} onChange={event=>fixture.setInput({draft:event.target.value})}/><div data-prepared-card>{visible&&<PreparedPromptCard sessionId={sessionId} session={{running:fixture.running}} input={value} inputActions={{setDraft:()=>{throw Error('不得绕过CAS')}}} preparation={preparation} resourceApi={resourceApi} resourceInput={port} work={work} validateTask={validateTask} openSource={()=>{}}/>}</div></I18nProvider>};
if(document.getElementById('root').dataset.restore==='yes')prepare();createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-prepared-direct-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'PreparedDirectFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,restore=false){const page=await browser.newPage({viewport:{width:1000,height:700}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body><div id="root" data-restore="'+(restore?'yes':'no')+'"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('textbox',{name:'原会话草稿'}).waitFor();return page}

test('真实React效果和原生CAS端口：一次选择核验全部来源并带入，StrictMode恢复也仅一次',async t=>{
 const page=await mount(t);await page.getByRole('button',{name:'选择任务资料技能'}).click()
 await page.waitForFunction(()=>document.querySelector('textarea')?.value==='[资料]/summarize \n核对原记录')
 assert.deepEqual(await page.evaluate(()=>(window as any).directDraftFixture.calls),[['task','task-original','session-original',3],['resources','session-original'],['skills'],['text',1],['reference',2]])
 assert.equal(await page.locator('[data-prepared-card] section').count(),0)
 const restored=await mount(t,true);await restored.waitForFunction(()=>document.querySelector('textarea')?.value==='核对原记录')
 assert.deepEqual(await restored.evaluate(()=>(window as any).directDraftFixture.calls),[['text',1]])
 await restored.getByRole('textbox',{name:'原会话草稿'}).fill('');await restored.getByRole('button',{name:'切换准备卡片'}).click();await restored.getByRole('button',{name:'切换准备卡片'}).click()
 assert.equal(await restored.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'');assert.deepEqual(await restored.evaluate(()=>(window as any).directDraftFixture.calls),[['text',1]])
})

test('原草稿冲突和partial真实回执保留，清空或重挂载不自动回填，手动仅继续未完成引用',async t=>{
 const occupied=await mount(t);await occupied.getByRole('textbox',{name:'原会话草稿'}).fill('本人草稿');await occupied.getByRole('button',{name:'选择纯文字预设'}).click();await occupied.locator('[data-prepared-card] section').waitFor()
 assert.equal(await occupied.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'本人草稿');assert.deepEqual(await occupied.evaluate(()=>(window as any).directDraftFixture.calls),[])
 await occupied.getByRole('textbox',{name:'原会话草稿'}).fill('');await occupied.getByRole('button',{name:'切换准备卡片'}).click();await occupied.getByRole('button',{name:'切换准备卡片'}).click()
 assert.equal(await occupied.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'');assert.deepEqual(await occupied.evaluate(()=>(window as any).directDraftFixture.calls),[])
 const page=await mount(t);await page.evaluate(()=>(window as any).directDraftFixture.failReference=true);await page.getByRole('button',{name:'选择任务资料技能'}).click();await page.getByRole('alert').waitFor()
 assert.equal(await page.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'/summarize \n核对原记录')
 const before=await page.evaluate(()=>(window as any).directDraftFixture.calls);await page.getByRole('button',{name:'切换准备卡片'}).click();await page.getByRole('button',{name:'切换准备卡片'}).click();await page.getByRole('alert').waitFor();assert.deepEqual(await page.evaluate(()=>(window as any).directDraftFixture.calls),before)
 await page.evaluate(()=>(window as any).directDraftFixture.failReference=false);await page.getByRole('button',{name:'p6.preparedPrompt.insert',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea')?.value==='[资料]/summarize \n核对原记录')
 const calls=await page.evaluate(()=>(window as any).directDraftFixture.calls);assert.equal(calls.filter((row:any)=>row[0]==='text').length,1);assert.equal(calls.filter((row:any)=>row[0]==='reference').length,2)
})
