import assert from 'node:assert/strict'
import {before,after,test,type TestContext} from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用既有独立无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__retrieval_settings_state_fixture.tsx'
let browser:ReturnType<typeof loadPlaywright> extends {chromium:{launch:()=>Promise<infer B>}}?B:never,script:string,styles:string
declare global{interface Window{retrievalSettingsState:{lists:number;sets:unknown[];modelReads:number;changes:number;changeApi:()=>void;refreshRead:()=>void;unmount:()=>void;resolveSet:()=>void;rejectSet:()=>void;resolve:(kind:'available'|'missing')=>void;reject:()=>void;lateResolve?:(kind:'available'|'missing')=>void;lateReject?:()=>void}}}

before(async()=>{
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {LocalRetrievalSettings} from '${client}LocalRetrievalSettings.tsx';import {BundledExtensionsSection} from '${client}BundledExtensionsSection.tsx';import {createLocalRetrievalApi} from '${client}local-retrieval-api.ts';import {createBundledExtensionsApi} from '${client}bundled-extensions-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtimes=[0,1].map(()=>({getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)})),f=window.retrievalSettingsState={lists:0,sets:[],modelReads:0,changes:0};
 const api=createLocalRetrievalApi(async endpoint=>{if(endpoint==='retrieval/status')return {items:[],enrolled:0,chunks:0,building:false};if(endpoint==='retrieval-model/status'){f.modelReads++;return {enabled:false,provider:null,building:false,guidance:null}}throw Error('No retrieval mutation permitted')});
 const activationApis=[0,1].map(()=>createBundledExtensionsApi(async(endpoint,payload)=>{if(endpoint==='bundled-extensions/list'){f.lists++;return new Promise((resolve,reject)=>{f.reject=()=>reject(Error('Previous connection read failed'));f.resolve=kind=>resolve(kind==='available'?[{id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.0-alpha.6',state:'available',configuredChannels:0}]:[{id:'im-gateway',packageName:'@teloa/im-gateway',version:'0.2.0-alpha.6',state:'active',configuredChannels:0}])})}f.sets.push(payload);return new Promise((resolve,reject)=>{f.resolveSet=()=>resolve({id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.0-alpha.6',state:'active',configuredChannels:0});f.rejectSet=()=>reject(Error('Set failed after unmount'))})}));
 function App(){const [owner,setOwner]=React.useState(0),[translation,setTranslation]=React.useState(0),[mounted,setMounted]=React.useState(true);f.changeApi=()=>setOwner(1);f.refreshRead=()=>setTranslation(1);f.unmount=()=>setMounted(false);return <I18nProvider runtime={runtimes[translation]}><main id="teloa-main"><textarea aria-label="原资料草稿" defaultValue="原资料内容"/><button type="button" onClick={()=>setMounted(false)}>关闭本地模型设置</button>{mounted&&(document.getElementById('root').dataset.mode==='section'?<BundledExtensionsSection api={activationApis[owner]} embedded onChanged={()=>f.changes++}/>:<LocalRetrievalSettings api={api} activation={activationApis[owner]}/>)}</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'retrieval-settings-state-fixture',resolveId:id=>id.endsWith('retrieval-settings-state-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'retrieval-settings-state-fixture',name:'RetrievalSettingsStateFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(row=>row.type==='chunk')!.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})

async function open(t:TestContext,directSection=false){
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.setContent(`<!doctype html><html><body><div id="root" data-mode="${directSection?'section':'resources'}"></div></body></html>`);await page.addStyleTag({content:styles});await page.addScriptTag({content:script});const trigger=page.getByRole('button',{name:'关闭本地模型设置',exact:true});const drawer=directSection?page.getByRole('region',{name:'本地中文检索',exact:true}):page.getByRole('region',{name:'检索模型',exact:true});await drawer.waitFor();await page.waitForFunction(()=>window.retrievalSettingsState.lists===1);return {page,drawer,trigger}
}

test('统一本地模型设置等列表时显示读取状态，关闭不启用且原资料草稿保留',async t=>{
 const {page,drawer,trigger}=await open(t)
 assert.equal(await drawer.getByRole('status').count(),1,'列表未回时不能只剩空白标题')
 assert.match(await drawer.getByRole('status').innerText(),/正在检查/)
 assert.equal(await drawer.getByRole('button',{name:'启用',exact:true}).count(),0)
 await trigger.click();await drawer.waitFor({state:'hidden'});assert.equal(await trigger.evaluate((node:HTMLElement)=>document.activeElement===node),true)
 await page.evaluate(()=>window.retrievalSettingsState.resolve('available'));assert.equal(await drawer.isVisible(),false,'迟到只读回包不能重开抽屉');assert.deepEqual(await page.evaluate(()=>window.retrievalSettingsState.sets),[]);assert.equal(await page.getByRole('textbox',{name:'原资料草稿',exact:true}).inputValue(),'原资料内容')
})

test('列表成功但无本地检索条目时明确不可用，可只读重试且启用仍需确认',async t=>{
 const {page,drawer}=await open(t);await page.evaluate(()=>window.retrievalSettingsState.resolve('missing'));await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.match(await drawer.innerText(),/本地检索暂不可配置/,'成功空列表不能永久空白或误称读取中')
 assert.equal(await drawer.getByRole('button',{name:'启用',exact:true}).count(),0)
 await drawer.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>window.retrievalSettingsState.lists===2);assert.match(await drawer.getByRole('status').innerText(),/正在检查/)
 await page.evaluate(()=>window.retrievalSettingsState.resolve('available'));await drawer.getByText('未启用',{exact:true}).waitFor();await drawer.getByRole('button',{name:'启用',exact:true}).click();await drawer.getByRole('button',{name:'取消',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>window.retrievalSettingsState.sets),[],'读取、重试、启用预览及取消都不提交启用')
 assert.equal(await drawer.getByRole('button',{name:'启用',exact:true}).count(),1);await page.getByRole('button',{name:'关闭本地模型设置',exact:true}).click();await drawer.waitFor({state:'hidden'})
})

for(const late of ['resolve','reject'] as const)test(`同挂载切换状态 API 后，旧读取${late}不能覆盖新连接状态`,async t=>{
 const {page,drawer}=await open(t);await page.evaluate(()=>{const f=window.retrievalSettingsState;f.lateResolve=f.resolve;f.lateReject=f.reject;f.changeApi()});await page.waitForFunction(()=>window.retrievalSettingsState.lists===2)
 if(late==='reject'){
  await page.evaluate(()=>window.retrievalSettingsState.lateReject!());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
  assert.equal(await drawer.getByRole('alert').count(),0,'旧读取错误不能带入新连接');assert.match(await drawer.getByRole('status').innerText(),/正在检查/,'旧读取收尾不能结束新连接读取状态')
 }
 await page.evaluate(()=>window.retrievalSettingsState.resolve('available'));await drawer.getByText('未启用',{exact:true}).waitFor()
 if(late==='resolve'){await page.evaluate(()=>window.retrievalSettingsState.lateResolve!('missing'));await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))}
 assert.equal(await drawer.getByRole('button',{name:'启用',exact:true}).count(),1,'旧列表不能覆盖新连接已读状态');assert.equal(await drawer.getByRole('alert').count(),0);assert.deepEqual(await page.evaluate(()=>window.retrievalSettingsState.sets),[])
})

for(const connection of ['same-api','same-api-read-error','replacement-api'] as const)test(`${connection}：重读不误丢本人启用 ACK，替换 API 仍拒旧 ACK`,async t=>{
 const {page,drawer}=await open(t);await page.evaluate(()=>window.retrievalSettingsState.resolve('available'));await drawer.getByRole('button',{name:'启用',exact:true}).click();await drawer.getByRole('button',{name:'确认',exact:true}).click();await page.waitForFunction(()=>window.retrievalSettingsState.sets.length===1)
 const before=await page.evaluate(()=>window.retrievalSettingsState.modelReads)
 // 同一 API 换翻译上下文会触发正式 load；另一分支直接替换 API，均保持真实组件挂载。
 await page.evaluate((connection:'same-api'|'same-api-read-error'|'replacement-api')=>{const f=window.retrievalSettingsState;if(connection==='replacement-api')f.changeApi();else f.refreshRead()},connection);await page.waitForFunction(()=>window.retrievalSettingsState.lists===2)
 if(connection==='same-api-read-error'){await page.evaluate(()=>window.retrievalSettingsState.reject());await drawer.getByRole('alert').waitFor()}else{await page.evaluate(()=>window.retrievalSettingsState.resolve('available'));await drawer.getByText('未启用',{exact:true}).waitFor()}
 await page.evaluate(()=>window.retrievalSettingsState.resolveSet());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 if(connection!=='replacement-api'){
  assert.equal(await drawer.getByRole('button',{name:'停用',exact:true}).count(),1,'同 API 当前启用 ACK 必须更新为已启用')
  assert.equal(await page.evaluate(()=>window.retrievalSettingsState.modelReads),before+1,'当前 ACK 必须通知父设置重读')
  assert.equal(await drawer.getByRole('alert').count(),0,'有效启用 ACK 后不能保留被取代的读取错误')
 }else{
  assert.equal(await drawer.getByRole('button',{name:'启用',exact:true}).count(),1,'旧 API ACK 不得改新 API 状态')
  assert.equal(await page.evaluate(()=>window.retrievalSettingsState.modelReads),before,'旧 API ACK 不触发新本人设置重读')
 }
 assert.deepEqual(await page.evaluate(()=>window.retrievalSettingsState.sets),[{extensionId:'local-embedding',enabled:true}],'仅本人一次确认的启用请求')
})

for(const outcome of ['resolve','reject'] as const)test(`真实设置组件卸载后，启用 ${outcome} 不派发外部反馈`,async t=>{
 const {page,drawer}=await open(t,true);await page.evaluate(()=>window.retrievalSettingsState.resolve('available'));await drawer.getByRole('button',{name:'启用',exact:true}).click();await drawer.getByRole('button',{name:'确认',exact:true}).click();await page.waitForFunction(()=>window.retrievalSettingsState.sets.length===1)
 await page.evaluate(()=>window.retrievalSettingsState.unmount());await drawer.waitFor({state:'detached'})
 await page.evaluate((outcome:'resolve'|'reject')=>{const f=window.retrievalSettingsState;if(outcome==='resolve')f.resolveSet();else f.rejectSet()},outcome);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.equal(await page.evaluate(()=>window.retrievalSettingsState.changes),0,'真实卸载必须撤销写回执的界面与外部反馈归属')
 assert.deepEqual(await page.evaluate(()=>window.retrievalSettingsState.sets),[{extensionId:'local-embedding',enabled:true}],'不取消或重发已确认的启用请求')
})
