import assert from 'node:assert/strict'
import {before,after,test,type TestContext} from 'node:test'
import {fileURLToPath} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {build} from 'vite'
import {ollamaPreparationDetails} from '../../../local-embedding/src/ollama.ts'
import {retrievalPreparationDetails} from '../../../local-embedding/src/preparation-details.ts'
// @ts-expect-error 复用既有独立无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__retrieval_ollama_guide_fixture.tsx'
let browser:any,script:string,styles:string
before(async()=>{
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {LocalRetrievalModelPanel} from '${client}LocalRetrievalModelPanel.tsx';import {LocalRetrievalResources} from '${client}LocalRetrievalResources.tsx';import {createLocalRetrievalApi} from '${client}local-retrieval-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {ThemePresenter} from '${client}theme-presenter.ts';import tokens from '${client}theme-tokens.module.css';new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});
 const config=document.getElementById('root').dataset,gemma=config.provider!=='qwen',locale=config.locale||'zh-CN',id=gemma?'embeddinggemma-2':'qwen3-embedding-0.6b';
 const f=window.ollamaGuide={calls:[],backs:0,activationWrites:0,afterPrepare:'failed',nextRead:null};let preparation={phase:config.phase||'unprepared'},selected='qwen3-embedding-0.6b';
 const provider=()=>({id,location:'host-local',catalogId:gemma?'teloa.model.embeddinggemma-2':'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash:(gemma?'b':'a').repeat(64),variant:gemma?'ollama':'fp32',totalMemoryBytes:16*1024**3,memoryRisk:false,preparation,preparationDetails:gemma?${JSON.stringify(ollamaPreparationDetails())}:${JSON.stringify(retrievalPreparationDetails('fp32','/test/models','/test/runtime'))}});
 const status=()=>({enabled:true,provider:provider(),selectedProviderId:selected,building:false,guidance:null});const index={items:[],enrolled:0,chunks:0,building:false};
 const api=createLocalRetrievalApi(async(endpoint,payload)=>{f.calls.push({endpoint,payload});if(endpoint==='retrieval/status')return index;if(endpoint==='retrieval-model/status'){if(f.nextRead){preparation=f.nextRead;f.nextRead=null}return status()}if(endpoint==='retrieval-model/prepare'){preparation=f.afterPrepare==='downloading'?{phase:'downloading',stage:'assets',resource:'embeddinggemma-2',completedBytes:64,totalBytes:128}:{phase:'failed',message:'本机 Ollama 服务尚未就绪，请先打开 Ollama，再重新准备模型。'};return status()}if(endpoint==='retrieval-model/cancel'){preparation={phase:'cancelled'};return status()}if(endpoint==='retrieval-model/select'){selected=payload.providerId;return status()}throw Error('本夹具禁止其他写操作')});
 const activationApi={list:async()=>[{id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.4',state:'active',configuredChannels:0}],set:async()=>{f.activationWrites++;throw Error('本夹具禁止自动启停扩展')}};
 const snapshot={locale,dshLocale:locale,revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage(locale,key,params)};
 function App(){const [mounted,setMounted]=React.useState(true);f.reopen=()=>setMounted(true);return <I18nProvider runtime={runtime}><main id="teloa-main" className={tokens.tokens}><textarea aria-label="原资料草稿" defaultValue="保留原资料说明"/>{mounted&&(config.mode==='resources'?<LocalRetrievalResources api={api} activationApi={activationApi} visible/>:<LocalRetrievalModelPanel api={api} catalogId={provider().catalogId} catalogVersion="1.0.0" compact={config.mode==='compact'} onBack={()=>{f.backs++;setMounted(false)}} onExtensions={()=>{throw Error('本夹具无启用变更')}}/>)}</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'ollama-guide-fixture',resolveId:id=>id.endsWith('ollama-guide-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'ollama-guide-fixture',name:'OllamaGuideFixture',formats:['iife']}}}),bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output'in bundle);script=bundle.output.find(row=>row.type==='chunk')!.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function open(t:TestContext,config:{mode?:string;locale?:string;phase?:string;provider?:string}={}){
 const page=await browser.newPage({viewport:{width:430,height:1000}}),errors:string[]=[],requests:string[]=[];page.setDefaultTimeout(2500);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()});await page.setContent('<!doctype html><html><meta charset="utf-8"><body><div id="root"></div></body></html>');await page.locator('#root').evaluate((node:HTMLElement,config:Record<string,string>)=>Object.assign(node.dataset,config),config);await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.waitForFunction(()=>(window as any).ollamaGuide.calls.length>0);return page
}
const writes=(page:any)=>page.evaluate(()=>(window as any).ollamaGuide.calls.filter((row:any)=>!['retrieval/status','retrieval-model/status'].includes(row.endpoint)))

for(const mode of ['full','compact'])for(const [locale,install,requirement] of [['zh-CN','安装 Ollama',/安装并启动 Ollama/],['zh-TW','安裝 Ollama',/安裝並啟動 Ollama/],['en','Install Ollama',/Install and start Ollama/]] as const)test(`${mode}/${locale}：准备前可见真实运行要求和官方安装入口，未确认零下载`,async t=>{
 const page=await open(t,{mode,locale});const guide=page.locator('[data-retrieval-ollama-guide]');await guide.waitFor();assert.match(await guide.innerText(),requirement);assert.match(await guide.innerText(),/0\.40\.0/)
 const link=guide.getByRole('link',{name:install,exact:true});assert.equal(await link.getAttribute('href'),'https://ollama.com/download');assert.equal(await link.getAttribute('target'),'_blank');assert.deepEqual(await writes(page),[])
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 if(locale==='zh-CN'&&process.env.TELOA_RETRIEVAL_GUIDE_ARTIFACTS){await mkdir(process.env.TELOA_RETRIEVAL_GUIDE_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.TELOA_RETRIEVAL_GUIDE_ARTIFACTS,'local-retrieval-ollama-'+mode+'.png'),fullPage:true})}
})

for(const mode of ['full','compact'])test(`${mode}：无download失败指向服务/版本/模型；刷新只读，重试仍须原确认`,async t=>{
 const page=await open(t,{mode});if(mode==='full')await page.getByRole('button',{name:'准备检索模型',exact:true}).click();await page.getByRole('button',{name:'确认下载并准备',exact:true}).click()
 await page.getByRole('button',{name:'重试准备',exact:true}).waitFor();const alert=page.getByRole('alert');assert.match(await alert.innerText(),/Ollama.*版本.*模型/);assert.doesNotMatch(await alert.innerText(),/已检测.*未安装|准备未完成。请重试/)
 await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.waitForFunction(()=>(window as any).ollamaGuide.calls.filter((row:any)=>row.endpoint==='retrieval-model/status').length>=3);assert.equal((await writes(page)).length,1)
 await page.getByRole('button',{name:'重试准备',exact:true}).click();assert.equal((await writes(page)).length,1,'打开重试确认不下载')
 await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await writes(page)).length,1);assert.equal(await page.getByRole('textbox',{name:'原资料草稿',exact:true}).inputValue(),'保留原资料说明')
})

test('明确重试保留下载进度/取消；已就绪模型选用不再下载',async t=>{
 const page=await open(t);await page.getByRole('button',{name:'准备检索模型',exact:true}).click();await page.evaluate(()=>(window as any).ollamaGuide.afterPrepare='downloading');await page.getByRole('button',{name:'确认下载并准备',exact:true}).click();await page.getByRole('progressbar').waitFor();assert.equal(await page.getByRole('progressbar').getAttribute('value'),'64');assert.equal(await page.getByRole('button',{name:'刷新状态',exact:true}).isDisabled(),true)
 await page.getByRole('button',{name:'取消准备',exact:true}).click();await page.getByRole('button',{name:'准备检索模型',exact:true}).waitFor();assert.deepEqual((await writes(page)).map((row:any)=>row.endpoint),['retrieval-model/prepare','retrieval-model/cancel'])
 const ready=await open(t,{phase:'ready'});await ready.getByRole('button',{name:'使用此模型',exact:true}).click();await ready.locator('[data-retrieval-selected=true]').waitFor();assert.deepEqual((await writes(ready)).map((row:any)=>row.endpoint),['retrieval-model/select'])
})

test('首次无资料直接打开同一检索设置，模型选择说明不伪称已准备或改变默认',async t=>{
 const page=await open(t,{mode:'resources'});const button=page.getByRole('button',{name:'打开检索设置',exact:true});await button.waitFor();assert.match(await page.locator('[data-retrieval-resources]').innerText(),/Qwen3.*Google.*EmbeddingGemma 2/)
 assert.equal(await page.locator('[data-retrieval-more]').getAttribute('open'),null)
 if(process.env.TELOA_RETRIEVAL_GUIDE_ARTIFACTS)await page.screenshot({path:join(process.env.TELOA_RETRIEVAL_GUIDE_ARTIFACTS,'local-retrieval-empty-entry.png'),fullPage:true})
 await button.click();await page.getByRole('dialog',{name:'本地检索',exact:true}).waitFor();await page.locator('[data-retrieval-model]').waitFor();await page.getByRole('button',{name:'停用',exact:true}).waitFor();assert.deepEqual(await writes(page),[]);assert.equal(await page.evaluate(()=>(window as any).ollamaGuide.activationWrites),0)
 if(process.env.TELOA_RETRIEVAL_GUIDE_ARTIFACTS)await page.screenshot({path:join(process.env.TELOA_RETRIEVAL_GUIDE_ARTIFACTS,'local-retrieval-empty-settings.png'),fullPage:true})
})

test('Qwen原准备路径不展示Ollama要求或安装链接',async t=>{
 const page=await open(t,{provider:'qwen'});await page.getByRole('button',{name:'准备检索模型',exact:true}).waitFor();assert.equal(await page.locator('[data-retrieval-ollama-guide]').count(),0);assert.equal(await page.getByRole('link',{name:'安装 Ollama',exact:true}).count(),0);assert.deepEqual(await writes(page),[])
})
