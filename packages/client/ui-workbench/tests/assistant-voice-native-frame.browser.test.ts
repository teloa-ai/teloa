import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {DSH_VERSION,dshFrontendBootStart} from './fixtures/dsh-official.ts'

test('官方 UiSession/Workspace 原助手入口不依赖打开后的目录刷新，原生子作用域取消留言',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),require=createRequire(new URL('../package.json',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-assistant-native-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const dshRequire=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const frontend=join(dirname(dshRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets')
 const frontendSource=await readFile(join(frontend,(await readdir(frontend)).find(name=>/^index-.*\.js$/.test(name))!),'utf8')
 const factory=frontendSource.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1],boot=dshFrontendBootStart(frontendSource);assert.ok(factory&&boot>0)
 const seedSource=frontendSource.slice(0,boot)+'\nexport const staticSeeds='+factory+'();'
 const modules=[]
 for(const name of ['@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-ui-session','@deepseek-ai/dsh-client-ui-layout','@deepseek-ai/dsh-client-ui-workspace']){
  const folder=dirname(require.resolve(name+'/package.json'));assert.equal(JSON.parse(await readFile(join(folder,'package.json'),'utf8')).version,DSH_VERSION)
  let code=await readFile(join(folder,'lib/client.js'),'utf8')
  if(name.endsWith('ui-workspace'))code=code.replace('\t\texports.apply = apply;','\t\texports.voiceFixture={UiWorkspaceService};\n\t\texports.apply = apply;')
  modules.push(code)
 }
 const fixtureSource=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('frame.ts',fixtureSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined;const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let frame=new Function('client','return '+node.getText(ast))(client) as string
 // 真 UiSession 持有主会话投影，真 UiWorkspace 通过 mainView retain 切换；没有同步 selected store。
 const native=`import {staticSeeds as seeds} from 'official-static-seeds';import {mainSessionSource,observeMainSessionBinding,isNativeChildSession} from '${client}main-session.ts';
 window.__ModuleLoader__={load:({id,factory})=>{seeds[id]=factory(id=>seeds[id])}};
 ${modules.join('\n')}
 const context=new seeds['@deepseek-ai/cordis'].Context();new seeds['@deepseek-ai/dsh-client-ui-renderer'].SlotRegistry(context);
 context.provide('remote',{$on:()=>()=>{}});let layoutStore;const layoutController=new seeds['@deepseek-ai/dsh-client-ui-layout'].LayoutController({selectPanel:id=>layoutStore?.actions.selectPanel(id)},()=>true,{getSnapshot:()=>layoutStore?.getSnapshot().panelInfo});context.provide('layout',layoutController);
 const nativeList=seeds['@deepseek-ai/dsh-client-store'].createSnapshotStore({ids:[],byId:{},phase:'ready',projectionsBySession:{}}),owners=new Map(),retentions=new Map();
 const ids=['assistant-original','business-original','native-child'];for(const id of ids){owners.set(id,{sessionId:id,ctx:new seeds['@deepseek-ai/cordis'].Context(),session:{projections:{faceOf:()=>seeds['@deepseek-ai/dsh-client-store'].createSnapshotStore({})}}});retentions.set(id,seeds['@deepseek-ai/dsh-client-store'].createSnapshotStore({retainedBy:{}}))}
 const publishNative=()=>nativeList.set({ids,byId:Object.fromEntries(ids.map(id=>[id,{id,displayTitle:id,running:false,blank:false,updatedAt:1,retainedBy:retentions.get(id).getSnapshot().retainedBy,...(id==='native-child'?{origin:'subagent',parentId:'assistant-original'}:{})}])),phase:'ready',projectionsBySession:{}});
 const nativeSessions={list:nativeList,binding:id=>owners.get(id),scope:id=>owners.get(id)?.ctx,subagentAddress:id=>id==='native-child'?{parentSessionId:'assistant-original',childSessionId:id,mode:'continuable'}:undefined,retainInfo:id=>retentions.get(id),retain:(target,{source})=>{const id=typeof target==='string'?target:target.childSessionId,binding=owners.get(id),retention=retentions.get(id),counts={...retention.getSnapshot().retainedBy};counts[source]=(counts[source]||0)+1;retention.set({retainedBy:counts});publishNative();return {sessionId:id,binding,release:()=>{const counts={...retention.getSnapshot().retainedBy};counts[source]--;retention.set({retainedBy:counts});publishNative()}}}};
 publishNative();const uiSession=new seeds['@deepseek-ai/dsh-client-ui-session'].UiSession(context,nativeSessions),nativeWorkspaceList=seeds['@deepseek-ai/dsh-client-store'].createSnapshotStore({items:[],phase:'pending',archivedSessionIds:[],pinnedSessionIds:[]});
 const uiWorkspace=new seeds['@deepseek-ai/dsh-client-ui-workspace'].voiceFixture.UiWorkspaceService(context,{}, {list:nativeWorkspaceList},nativeSessions,{},()=>{});
 `
 frame=frame.replace('const listeners=new Set(),main={getSnapshot:()=>selected,subscribe:l=>{listeners.add(l);return()=>listeners.delete(l)}};','const listeners=new Set(),main=mainSessionSource(uiSession);main.subscribe(()=>{selected=main.getSnapshot();for(const l of listeners)l()});')
 frame=frame.replace('beginNativeNavigation={beginNativeNavigation}','beginNativeNavigation={()=>{const signal=layoutController.beginNavigation();f.lastNativeNavigation=signal;return signal}}')
 frame=frame.replace('isNativeChild:()=>false','isNativeChild:id=>isNativeChildSession(nativeSessions,id)')
 frame=frame.replace("open:id=>{selected=id;if(f.nativeOpenView==='messages')store.actions.openMessages('native');else if(f.nativeOpenView)store.actions.navigate(f.nativeOpenView);for(const l of listeners)l()}","open:id=>{f.afterOpen=true;uiWorkspace.openSession(id)}")
 frame=frame.replace('list:async()=>{if(f.holdVoiceDirectory)',"list:async()=>{if(f.afterOpen){f.postOpenRefreshPending=true;await new Promise(resolve=>f.releasePostOpen=()=>{f.afterOpen=false;resolve()})}if(f.holdVoiceDirectory)")
 const setup=`f.native={cancelPending:()=>layoutController.beginNavigation(),main:()=>main.getSnapshot(),scope:()=>uiSession.adapter.current.getSnapshot().ctx===owners.get(main.getSnapshot()).ctx,child:()=>{uiWorkspace.openSession('native-child')},checkUnowned:()=>{try{uiSession.bindingSource({sessionId:'native-child',binding:owners.get('assistant-original')});return false}catch{return true}}};
 layoutStore=store;rows.get('assistant-original').purpose='assistant';byId['assistant-original'].displayTitle='模型修改过的原助手标题';uiWorkspace.openSession('business-original');observeMainSessionBinding(main,nativeSessions,work);f.voiceDirectory=()=>work.getDirectorySnapshot();
 `
 frame=frame.replace("createRoot(document.getElementById('root')).render",setup+"createRoot(document.getElementById('root')).render")
 await writeFile(join(temp,'fixture.tsx'),native+frame)
 const seedId='\0official-seeds',reactId='\0official-react',jsxId='\0official-jsx',domId='\0official-dom',domCoreId='\0official-dom-core'
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'native-seeds',enforce:'pre',resolveId:(id,importer)=>id==='official-static-seeds'?seedId:id==='react'?reactId:id==='react/jsx-runtime'?jsxId:id==='react-dom/client'?domId:id==='react-dom'?domCoreId:importer===seedId&&id.startsWith('.')?resolve(frontend,id):null,load:id=>id===seedId?seedSource:id===reactId?"import {staticSeeds} from 'official-static-seeds';const value=staticSeeds.react;export default value;export const {useImperativeHandle,useTransition,startTransition,createRef,useState,useEffect,useLayoutEffect,useRef,useMemo,useCallback,useSyncExternalStore,createContext,useContext,useId,useReducer,memo,cloneElement,Children,isValidElement,Suspense,forwardRef,createElement,Fragment}=value;":id===jsxId?"import {staticSeeds} from 'official-static-seeds';export const {jsx,jsxs,Fragment}=staticSeeds['react/jsx-runtime'];":id===domId?"import {staticSeeds} from 'official-static-seeds';export const {createRoot,hydrateRoot}=staticSeeds['react-dom/client'];":id===domCoreId?"import {staticSeeds} from 'official-static-seeds';const value=staticSeeds['react-dom'];export default value;export const {createPortal,flushSync}=value;":null},{name:'unrelated-pages',enforce:'pre',load:async id=>{const names=['WorkDirectory','WorkHome','TaskPage','TeamPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage'];if(!names.some(name=>id===join(client,name+'.tsx')))return;const source=await readFile(id,'utf8');return [...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>'export const '+m[1]+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'NativeAssistantFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 // node:test 超时只中止 t.signal 并立即运行已登记的 after，测试体仍继续：超时后不再启动浏览器，已启动的随中止关闭以结束挂起的页面调用。
 t.signal.throwIfAborted()
 const browser=await loadPlaywright().chromium.launch({...launchOptions(),args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']}),closeBrowser=()=>browser.close();t.after(closeBrowser);t.signal.addEventListener('abort',closeBrowser,{once:true})
 if(t.signal.aborted){await closeBrowser();t.signal.throwIfAborted()}
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(message:any)=>{if(message.type()==='error')errors.push(message.text())});page.setDefaultTimeout(5000)
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort());await page.goto('https://fixture.invalid')
 await page.evaluate(()=>{sessionStorage.setItem('teloa.assistant-visible/v1','true');(window as any).frameStartup={voice:true,sessionId:'business-original'}});await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture?.native.main()==='business-original').catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,...await page.evaluate(()=>({body:document.body.innerText,keys:Object.keys((window as any).frameFixture??{}),main:(window as any).frameFixture?.native?.main()}))}));throw error})
 await page.getByRole('button',{name:'实时通话',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.postOpenRefreshPending)
 // 假媒体流可能在监听瞬间触发 VAD 直接进入录音：监听或录音任一合法活动相位都证明通话已真实启动（employee-voice-copy 的 listening/recording）。
 await page.getByText(/^(正在听，请说话|正在听你说话…)$/).waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,...await page.evaluate(()=>{const f=(window as any).frameFixture;return {main:f.native.main(),sameScope:f.native.scope(),directory:f.voiceDirectory().status,navigationAborted:f.lastNativeNavigation?.aborted,text:document.body.innerText}})}));throw error})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.voiceStarts.length),1,'活动相位必须来自这一次真实启动')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.lastNativeNavigation.aborted),true,'官方Layout在自己的会话打开commit后中止导航信号，不等于本人取消留言')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.voiceDirectory().status),'loading')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.native.scope()),true)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.voiceStarts[0].sessionId),'assistant-original')
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).frameFixture.releasePostOpen());await page.waitForFunction(()=>(window as any).frameFixture.voiceDirectory().status==='ready')
 await page.getByRole('region',{name:'语音通话',exact:true}).getByRole('button',{name:'关闭',exact:true}).first().click()
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdAssistantOpen=true;f.assistantReading=false})
 await page.getByRole('button',{name:'实时通话',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.assistantReading)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.native.cancelPending();f.releaseAssistantOpen()})
 await page.getByText('暂时无法打开原会话，请再试一次。',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.native.main(),f.voiceMicrophones,f.voiceStarts.length,f.sent.length]}),['assistant-original',1,1,0],'同ID已选也必须尊重打开前被另一native导航取消，不能凭当前ID猜测本次已commit')
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdAssistantOpen=true;f.assistantReading=false})
 await page.getByRole('button',{name:'语音留言',exact:true}).click();await page.getByRole('button',{name:'开始录音',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.assistantReading)
 await page.getByRole('region',{name:'语音留言',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
 await page.evaluate(async()=>{(window as any).frameFixture.releaseAssistantOpen();await new Promise(resolve=>setTimeout(resolve,50))})
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.native.main(),f.voiceMicrophones,f.voiceInput().draft,f.sent.length]}),['assistant-original',1,'原正文',0],'真实Layout入口也保留准备取消，不借自己commit豁免调用方abort')
 await page.getByRole('button',{name:'语音留言',exact:true}).click();await page.getByRole('button',{name:'开始录音',exact:true}).click();await page.getByText('正在录音，最多 15 秒',{exact:true}).waitFor();await page.waitForTimeout(300)
 await page.getByRole('button',{name:'完成录音',exact:true}).click();await page.waitForFunction(()=>!!(window as any).frameFixture.releaseAsr)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.native.child();f.releaseAsr()})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.native.main()),'native-child')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.native.scope()),true)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.native.checkUnowned()),true)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.asr.signal.aborted,f.voiceInput().draft,f.sent.length,f.creates]}),[true,'原正文',0,0])
 assert.deepEqual(errors,[])
})
