import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile,readdir} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用工作树的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
import {DSH_VERSION,dshFrontendBootStart} from './fixtures/dsh-official.ts'

test('原生过程摘要仅在工具成功时显示写入完成，错误和原调用检查保留',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const require=createRequire(join(root,'package.json')),officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
 const chat=dirname(officialRequire.resolve('@deepseek-ai/dsh-client-ui-chat/package.json'))
 assert.equal(JSON.parse(await readFile(join(chat,'package.json'),'utf8')).version,DSH_VERSION)
 const original=await readFile(join(chat,'lib/client.js'),'utf8'),marker='\t\texports.apply = apply;'
 assert.equal(original.split(marker).length,2)
 // 仅在内存夹具暴露固定官方 flow；安装依赖、原生标题、折叠和成员行均未修改。
 const module=original.replace(marker,'\t\texports.outcomeFixture={ChatFlow,zh};\n'+marker)
 const frontend=join(dirname(officialRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets')
 const source=await readFile(join(frontend,(await readdir(frontend)).find(name=>/^index-.*\.js$/.test(name))!),'utf8')
 const seedFactory=source.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1],boot=dshFrontendBootStart(source)
 assert.ok(seedFactory&&boot>0)
 const seeds=source.slice(0,boot)+'\nexport const staticSeeds='+seedFactory+'();'
 const failure=JSON.parse(await readFile(new URL('./fixtures/native-process-write-failures.json',import.meta.url),'utf8'))
 const baseline=process.env.TELOA_TEST_NATIVE_PROCESS_BASELINE==='1'
 const entry=[
  "import {staticSeeds as seeds} from 'official-static-seeds';",
  baseline?'':"import {registerNativeProcessOutcomes} from '"+client+"NativeProcessOutcomeFlow.tsx';",
  "const React=seeds.react.default??seeds.react,{createElement:h,useRef,useSyncExternalStore}=React,modules=new Map();",
  "window.__ModuleLoader__={load:row=>modules.set(row.id,row.factory)};new Function("+JSON.stringify(module)+")();",
  "const resolve=id=>{if(!(id in seeds))throw Error('Unapproved fixture module '+id);return seeds[id]};",
  "const {ChatFlow,zh}=modules.get('@deepseek-ai/dsh-client-ui-chat')(resolve).outcomeFixture;",
  "async function boot(){",
  "const slots=new seeds['@deepseek-ai/dsh-client-ui-slots'].SlotCore();slots.register({name:'root',children:{'conversation.chat.flow':{kind:'single',scope:'session'}}},()=>null);",
  baseline?'':"const offWaiting=registerNativeProcessOutcomes(slots);",
  "const nativeOptions={name:'conversation.chat.flow',locale:'chat',store:{create:()=>({})},inject:()=>({}),children:{'conversation.chat.node':{kind:'keyed',scope:'session'}}};let offNative=slots.register(nativeOptions,ChatFlow);",
  "await Promise.resolve();",
  "const firstEntry=slots.entries('conversation.chat.flow').find(entry=>(entry.options.priority??0)===0);",
  baseline?'':"window.processLateEntryWrapped=firstEntry.component!==ChatFlow;offNative();offNative=slots.register(nativeOptions,ChatFlow);await Promise.resolve();",
  "const originalEntry=slots.entries('conversation.chat.flow').find(entry=>(entry.options.priority??0)===0);",
  baseline?'':"window.processReloadWrapped=originalEntry!==firstEntry&&originalEntry.component!==ChatFlow&&firstEntry.component===ChatFlow;offWaiting();const offA=registerNativeProcessOutcomes(slots),offB=registerNativeProcessOutcomes(slots);offA();offA();offB();window.processLeaseRestored=originalEntry.component===ChatFlow&&slots.entries('conversation.chat.flow').length===1;registerNativeProcessOutcomes(slots);",
  "const adaptedEntry=slots.entries('conversation.chat.flow')[0],Flow=adaptedEntry.component;",
  "window.processRegistration={storeSame:adaptedEntry.store===originalEntry.store,injectSame:adaptedEntry.inject===originalEntry.inject,childrenSame:adaptedEntry.children===originalEntry.children,locale:adaptedEntry.locale};",
  "const events="+JSON.stringify(failure.events)+",calls=events.filter(e=>e.type==='tool/call'),results=events.filter(e=>e.type==='tool/result');",
  "const settled=i=>({kind:'tool-result',seq:results[i].seq,time:results[i].time,callId:calls[i].data.callId,name:'write',turn:1,step:i+1,args:{},call:{name:'write',argsRaw:calls[i].data.arguments},callTime:calls[i].time,content:results[i].data.message.content,isError:results[i].data.message.isError,...(results[i].data.error?{error:results[i].data.error}:{}),subCalls:[]});",
  "const success={...settled(0),callId:'success',isError:false,error:undefined,content:[{type:'text',text:'File written successfully'}]};",
  "const unknown={phase:'start',callId:'unknown',name:'write',turn:1,step:1,time:1,args:{},argsRaw:'{}',subCalls:[]};",
  "const denied={...settled(1),callId:'rejected',content:[{type:'text',text:'Error: the user rejected tool write'}]};",
  "const samples=[['failed',settled(0)],['guard-denied',settled(1)],['success',success],['rejected',denied],['unknown',unknown],['nested-failed',{...success,callId:'parent',subCalls:[settled(1)]}]];",
  "window.processOutcomeFixture={inspected:[],samples};",
  "const nodes=new Map(samples.map(([id,root],i)=>[id,{target:'chat',key:id,kind:'tool-call',anchorSeq:root.seq??i,data:{root},visibility:'visible',location:{kind:'step',turn:{turn:1,status:'closed',end:{data:{reason:{kind:'aborted'}}}},step:i+1}}]));",
  "const groups=new Map(samples.map(([id])=>[id,{key:id,members:[{kind:'node',key:id}],data:{turn:1,closed:true,summary:{counts:[{kind:'write',count:1}],running:undefined,runningDetail:''}}}]));",
  "let snapshot={nodes:{get:key=>nodes.get(key)},navigation:{items:()=>[]},revision:0};const listeners=new Set(),subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};",
  "window.processOutcomeFixture.replace=(id,value)=>{samples.find(x=>x[0]===id)[1]=value;nodes.set(id,{...nodes.get(id),data:{root:value}});snapshot={...snapshot,revision:snapshot.revision+1};for(const listener of listeners)listener()};",
  "const useGroup=(id,selector)=>selector(groups.get(id)),useChat=selector=>useSyncExternalStore(subscribe,()=>selector(snapshot)),useNode=(id,selector)=>useSyncExternalStore(subscribe,()=>selector?selector(nodes.get(id)):nodes.get(id));",
  "const translate=(key,params={})=>(zh[key]??key).replace(/\\{(\\w+)\\}/g,(_,name)=>params[name]??'');",
  "function App(){",
  "return h(Flow,{entries:samples.map(([key])=>({kind:'group',key})),pendingInputs:[],lastInputTurn:1,deferCollapse:false,useSession:select=>select({running:false}),useChat,useChatGroup:useGroup,useChatNode:useNode,useChatNodeBottom:()=>false,useChatNodeProcess:()=>undefined,usePresentation:select=>select({foldCompletedTurns:false,stepGrouping:'collapsed',collapseTiming:'immediate',liveProcessDetail:true}),useStore:select=>select({}),actions:{setTurnProcessOpen:()=>{}},useGroupAction:()=>useRef(null),useGroupHeaderAction:()=>{},t:translate,renderFactorySlot:()=>null,inspectCall:id=>window.processOutcomeFixture.inspected.push(id),forkAt:()=>{},openFile:()=>{},fileMentions:()=>undefined,loadImage:()=>{},renderSlot:(name,owner)=>{const call=owner.node.data.root;return h('section',null,h('button',{onClick:()=>owner.inspectCall(call.callId)},'检查原调用'),h('pre',null,call.content?.filter(x=>x.type==='text').map(x=>x.text).join('\\n')??'结果未知'))}});",
  "}seeds['react-dom/client'].createRoot(document.getElementById('root')).render(h(App));",
  "}boot().catch(error=>{setTimeout(()=>{throw error})});",
 ].join('\n')
 const virtual=root+'__native_process_outcome.tsx',seedId='\0official-static-seeds',reactId='\0official-react',jsxId='\0official-jsx'
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'native-process-outcome',enforce:'pre',resolveId:(id,importer)=>id.endsWith('native-process-outcome-fixture')?virtual:id==='official-static-seeds'?seedId:id==='react'?reactId:id==='react/jsx-runtime'?jsxId:importer===seedId&&id.startsWith('.')?resolve(frontend,id):null,load:id=>id===virtual?entry:id===seedId?seeds:id===reactId?"import {staticSeeds} from 'official-static-seeds';const r=staticSeeds.react;export default r.default??r;export const {createElement,useMemo,useCallback,useSyncExternalStore}=r;":id===jsxId?"import {staticSeeds} from 'official-static-seeds';export const {jsx,jsxs,Fragment}=staticSeeds['react/jsx-runtime'];":null}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:'native-process-outcome-fixture',name:'NativeProcessOutcomeFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk');assert.ok(script&&script.type==='chunk')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1100,height:900}});t.after(()=>page.close());page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 const url='http://127.0.0.1:49329/native-process-outcome'
 await page.route('**/*',(route:any)=>route.request().url()===url?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto(url);await page.addScriptTag({content:script.code})
 await page.locator('[data-chat-group-key="failed"]').waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error})
 assert.deepEqual(errors,[])
 if(!baseline)assert.equal(await page.evaluate(()=>Reflect.get(window,'processLateEntryWrapped')),true,'slot声明先到、原生entry后到仍须生效')
 if(!baseline)assert.equal(await page.evaluate(()=>Reflect.get(window,'processReloadWrapped')),true,'原生entry卸载重载后仍须生效并释放旧包装')
 if(!baseline)assert.equal(await page.evaluate(()=>Reflect.get(window,'processLeaseRestored')),true,'重叠租约任意顺序及重复释放后必须恢复原生组件')
 assert.deepEqual(await page.evaluate(()=>Reflect.get(window,'processRegistration')),{storeSame:true,injectSame:true,childrenSame:true,locale:'chat'})
 if(process.env.TELOA_TEST_ARTIFACT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_ARTIFACT_DIR,baseline?'native-process-red.png':'native-process-green.png'),fullPage:true})
 for(const id of ['failed','guard-denied','rejected','unknown','nested-failed']){
  const header=page.locator('[data-chat-group-key="'+id+'"]').locator('button[aria-expanded]').first()
  assert.equal(await header.innerText(),'已调用工具',id+'不能把关闭当作写入成功')
 }
 const failed=page.locator('[data-chat-group-key="failed"]')
 await failed.locator('button[aria-expanded]').first().click()
 assert.equal(await failed.locator('button[aria-expanded]').first().getAttribute('aria-expanded'),'true')
 await failed.getByRole('button',{name:'检查原调用',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>Reflect.get(window,'processOutcomeFixture').inspected),['frozen-write-call-1'])
 assert.match(await failed.locator('pre').innerText(),/sandbox: file access denied/)
 assert.equal(await page.locator('[data-chat-group-key="success"]').locator('button[aria-expanded]').first().innerText(),'已写入文件')
 await page.evaluate(()=>{const f=Reflect.get(window,'processOutcomeFixture');f.replace('unknown',{...f.samples.find((x:any)=>x[0]==='success')[1],callId:'unknown'})})
 await page.waitForFunction(()=>document.querySelector('[data-chat-group-key="unknown"] button[aria-expanded]')?.textContent==='已写入文件')
 await page.evaluate(()=>{const f=Reflect.get(window,'processOutcomeFixture');f.replace('unknown',{...f.samples.find((x:any)=>x[0]==='failed')[1],callId:'unknown'})})
 await page.waitForFunction(()=>document.querySelector('[data-chat-group-key="unknown"] button[aria-expanded]')?.textContent==='已调用工具')
 assert.deepEqual(errors,[])
})
