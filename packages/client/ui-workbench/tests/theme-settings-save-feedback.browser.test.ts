import assert from 'node:assert/strict'
import {test,type TestContext} from 'node:test'
import {createRequire} from 'node:module'
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用当前工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {DSH_VERSION,dshFrontendBootStart} from './fixtures/dsh-official.ts'

// 真实官方控件、SlotRegistry、ThemeRuntime、ConfigFormController 和镜像；只替代公开 Host 回执。
// wire 模式复用正式 Connection/Remote/generated descriptors，模拟提交后响应丢失，不替代其失败折叠逻辑。
async function fixtureScript(wire=false){
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const require=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const assets=join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets')
 const frontend=await readFile(join(assets,(await readdir(assets)).find(name=>/^index-.*\.js$/.test(name))!),'utf8')
 const seed=frontend.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1],boot=dshFrontendBootStart(frontend);assert.ok(seed&&boot>0)
 const seeds=frontend.slice(0,boot)+'\nexport const staticSeeds='+seed+'();',modules:string[]=[],base=createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'))
 const definitions=[['@deepseek-ai/dsh-client-ui-renderer','{createSlotRenderer}'],['@deepseek-ai/dsh-client-ui-settings','{ConfigFormController,SettingsDescribeMirror}'],['@deepseek-ai/dsh-client-ui-theme','{}'],...(wire?[['@deepseek-ai/dsh-client-connection','{}'],['@deepseek-ai/dsh-api-gateway','{}'],['@deepseek-ai/dsh-api-remotes','{}']]:[])]
 for(const [name,exposed]of definitions){
  let packageFile:string;try{packageFile=require.resolve(name+'/package.json')}catch{packageFile=base.resolve(name+'/package.json')}
  const folder=dirname(packageFile);assert.equal(JSON.parse(await readFile(packageFile,'utf8')).version,DSH_VERSION)
  const browser=['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-api-gateway'].includes(name!)
  const source=await readFile(join(folder,browser?'lib/client.browser.js':'lib/client.js'),'utf8'),marker=name!.endsWith('ui-renderer')?'\t\texports.SlotRegistry = SlotRegistry;':'\t\texports.apply = apply;'
  assert.equal(source.split(marker).length,2);modules.push(source.replace(marker,'\t\texports.saveFixture='+exposed+';\n'+marker))
 }
 const integration=await readFile(join(client,'settings-integration.ts'),'utf8'),ast=ts.createSourceFile('settings-integration.ts',integration,ts.ScriptTarget.Latest,true)
 let call='';const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='installThemeSettingsSaveFeedback')call=node.getText(ast);ts.forEachChild(node,visit)};visit(ast)
 const entry=`import {staticSeeds as seeds} from 'official-static-seeds';${call?`import {installThemeSettingsSaveFeedback} from '${client}ThemeSettingsSaveFeedback.tsx';`:''}
void(async()=>{const React=seeds.react.default??seeds.react,{createElement:h}=React,{createRoot}=seeds['react-dom/client'],factories=new Map();window.__ModuleLoader__={load:row=>factories.set(row.id,row.factory)};${modules.map(code=>`new Function(${JSON.stringify(code)})();`).join('\n')}
const cache=new Map(),resolve=id=>{if(cache.has(id))return cache.get(id);if(factories.has(id)){const value=factories.get(id)(resolve);cache.set(id,value);return value}if(!(id in seeds))throw Error('Unapproved fixture dependency '+id);return seeds[id]},renderer=resolve('@deepseek-ai/dsh-client-ui-renderer'),settings=resolve('@deepseek-ai/dsh-client-ui-settings').saveFixture,theme=resolve('@deepseek-ai/dsh-client-ui-theme');
const state={active:'en',revision:0},listeners=new Set(),dict=new Map();let snapshot={...state};const locale={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},bind:ns=>key=>dict.get(ns+':'+state.active)?.[key]??dict.get(ns+':en')?.[key]??key,register:(ns,copies)=>{for(const[id,copy]of Object.entries(copies))dict.set(ns+':'+id,copy);return()=>{for(const id of Object.keys(copies))dict.delete(ns+':'+id)}}};
let value={preference:'system',fontSize:14,codeFontSize:11,terminalFontSize:13,textFontFamily:'',codeFontFamily:'',terminalFontFamily:''},revision=0,mode='accept',pending=[];
const view=()=>({ns:'ui-theme',autoGenerate:false,applies:'live',secrets:[],value:{...value},base:{...value},user:{},revision,schema:{}}),f=window.themeSaveFixture={calls:[],wire:[],formOutcomes:[],committed:0,settled:0,unhandled:[],mode:next=>{mode=next},locale:id=>{state.active=id;snapshot={...state,revision:++state.revision};listeners.forEach(fn=>fn())},value:()=>({...value}),release:outcome=>{const next=pending.shift();if(!next)throw Error('No pending write');next(outcome)},priorities:()=>slots.entries('settings.general.item').map(row=>({id:row.options.id,priority:row.options.priority??0}))};
window.addEventListener('unhandledrejection',event=>{f.unhandled.push(String(event.reason));event.preventDefault()});
const host={settings:{describe:async()=>({ok:true,value:{namespaces:[view()],writable:true,hasDocument:false}}),mutate:async(ns,ops,expected)=>{f.calls.push({ns,ops,expected});const settle=outcome=>{f.settled++;if(outcome==='reject')throw Error('synthetic transport outcome unknown');if(outcome==='false')return {ok:false,error:{code:'settings/conflict',message:'synthetic refusal',details:{}}};if(expected!==revision)throw Error('Unexpected revision');for(const op of ops){if(op.op!=='set'||op.path.length!==1)throw Error('Unexpected mutation');value={...value,[op.path[0]]:op.value}}revision++;f.committed++;if(outcome==='lost-ack')throw TypeError('Synthetic response loss after commit');return {ok:true,value:view()}};if(mode==='defer')return new Promise((resolve,reject)=>pending.push(outcome=>{try{resolve(settle(outcome))}catch(error){reject(error)}}));return settle(mode)}}};
const ctx=new seeds['@deepseek-ai/cordis'].Context(),slots=new renderer.SlotRegistry(ctx);slots.install(renderer.saveFixture.createSlotRenderer());slots.installLocale(locale);slots.provideRoot({hooks:{},keyedHooks:{},props:{}});ctx.provide('locale',locale);
if(${wire}){
 const connection=resolve('@deepseek-ai/dsh-client-connection'),gateway=resolve('@deepseek-ai/dsh-api-gateway'),generated=resolve('@deepseek-ai/dsh-api-remotes');
 connection.installConnection(ctx,{interactions:'none',transport:{openStream:()=>{throw Error('No fixture streams')},fetch:async(input,init)=>{const message=JSON.parse(init.body),method=message.method,args=message.payload.args;f.wire.push(method);let result;if(method==='settings/describe')result=await host.settings.describe();else if(method==='settings/mutate')result=await host.settings.mutate(args.ns,args.ops,args.expectedRevision);else throw Error('Unexpected fixture endpoint');return Response.json({type:'server-response',rpcId:message.rpcId,result})}}});
 // 注册目录只承接公开descriptor挂载；失败折叠、信封、调用、解码均使用固定SDK原实现。
 ctx.provide('typert',{remotes:{register:()=>()=>{}},contexts:{getClient:()=>undefined}});gateway.apply(ctx);await generated.apply(ctx);
}else ctx.provide('remote',host);
const remote=ctx.remote;
const emptyScope=seeds['@deepseek-ai/dsh-client-store'].createSnapshotStore({hooks:{},keyedHooks:{},props:{}});slots.installScope('session',{current:emptyScope,bindingSource:()=>emptyScope});
const mirror=new settings.SettingsDescribeMirror({remote});await mirror.load();const form=new settings.ConfigFormController({remote},{namespace:'ui-theme',decode:value=>value},mirror,{}),set=form.set.bind(form);form.set=async(...args)=>{const result=await set(...args);f.formOutcomes.push(result);return result};ctx.provide('configForms',{get:ns=>{if(ns!=='ui-theme')throw Error('Wrong namespace');return form}});
function Root({renderSlot}){return h('main',null,h('h1',null,'General settings'),renderSlot('settings.general.item',{}))}
slots.register({name:'root',children:{'settings.general.item':{kind:'list',scope:'root'}}},Root);
theme.apply(ctx);const child=ctx;let uninstall=${call||'()=>{}'};
f.uninstall=()=>uninstall();f.reinstall=()=>{uninstall=${call||'()=>{}'}};
f.shadow=()=>slots.register({name:'settings.general.item',id:'font-size',priority:-200,order:11},()=>h('p',null,'Other explicit shadow'));
f.removeOther=()=>{};f.installOther=()=>{f.removeOther=f.shadow()};
createRoot(document.getElementById('root')).render(slots.renderSlot('root',{}));f.ready=true;})().catch(error=>{window.fixtureFailure=String(error);console.error(error)});
`
 const virtual=join(root,'theme-save.fixture.ts')
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'theme-save-fixture',enforce:'pre',resolveId:(id,importer)=>id===virtual||id==='official-static-seeds'?id:id==='react'?'\0theme-save-react':id==='@deepseek-ai/dsh-client-store'?'\0theme-save-store':importer==='official-static-seeds'&&id.startsWith('.')?resolve(assets,id):undefined,load:id=>id==='official-static-seeds'?seeds:id===virtual?entry:id==='\0theme-save-react'?"import {staticSeeds} from 'official-static-seeds';export const {Fragment,createElement,useSyncExternalStore}=staticSeeds.react;":id==='\0theme-save-store'?"import {staticSeeds} from 'official-static-seeds';export const {createSnapshotStore}=staticSeeds['@deepseek-ai/dsh-client-store'];":undefined}],build:{write:false,minify:false,lib:{entry:virtual,name:'ThemeSave',formats:['iife']}}})
 const output=Array.isArray(result)?result[0]:result;assert.ok(output&&'output'in output);return output.output.find(row=>row.type==='chunk')!.code
}

test('原生主题设置的保存反馈与公开slot生命周期',{timeout:60000},async t=>{
 const script=await fixtureScript(),browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const open=async(t:TestContext)=>{const page=await browser.newPage({viewport:{width:1100,height:900}});t.after(()=>page.close());const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><body><div id="root"></div></body>');await page.addScriptTag({content:script});await page.waitForFunction(()=>!!(window as any).themeSaveFixture?.ready||!!(window as any).fixtureFailure,{},{timeout:5000}).catch((error:unknown)=>{t.diagnostic(JSON.stringify({errors}));throw error});assert.equal(await page.evaluate(()=>(window as any).fixtureFailure),undefined,JSON.stringify(errors));await page.getByRole('button',{name:'Increase font size',exact:true}).waitFor({timeout:1500}).catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText(),rows:await page.evaluate(()=>(window as any).themeSaveFixture.priorities())}));throw error});return page}
 const settle=async(page:any,n=1)=>{await page.waitForFunction((n:number)=>(window as any).themeSaveFixture.settled>=n,n);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
 const evidence=async(page:any,name:string)=>{const dir=process.env.F23_THEME_SAVE_EVIDENCE_DIR;if(!dir)return;await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,name+'.png'),fullPage:true});await writeFile(join(dir,name+'.aria.txt'),await page.locator('body').ariaSnapshot())}
 await t.test('布尔false给出保守可见反馈；原值、展开状态和失败字体输入保留，0自动重发',async t=>{
  const page=await open(t);await page.getByRole('button',{name:'More font settings',exact:true}).click();await page.evaluate(()=>(window as any).themeSaveFixture.mode('false'))
  await page.getByRole('textbox',{name:'Text font',exact:true}).fill('Unsent font draft');await page.getByRole('textbox',{name:'Text font',exact:true}).press('Tab');await settle(page)
  await evidence(page,'unconfirmed');assert.equal(await page.getByRole('alert').count(),1,'未确认保存必须可见，不能仅静默恢复旧字号');assert.match(await page.getByRole('alert').innerText(),/cannot confirm.*current value/is)
  assert.equal(await page.getByRole('textbox',{name:'Text font',exact:true}).inputValue(),'"Unsent font draft"');assert.equal(await page.getByRole('button',{name:'More font settings',exact:true}).getAttribute('aria-expanded'),'true');assert.equal((await page.evaluate(()=>(window as any).themeSaveFixture.value())).textFontFamily,'');assert.equal((await page.evaluate(()=>(window as any).themeSaveFixture.value())).fontSize,14);assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),1)
 })
 await t.test('传输reject显示结果未知，明确再次操作才重试，成功清除原错误',async t=>{
  const page=await open(t);await page.evaluate(()=>(window as any).themeSaveFixture.mode('reject'));await page.getByRole('button',{name:'Dark',exact:true}).click();await settle(page)
  await evidence(page,'unknown');assert.equal(await page.getByRole('alert').count(),1,'未知结果必须可见');assert.match(await page.getByRole('alert').innerText(),/cannot confirm/);assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),1)
  await page.evaluate(()=>(window as any).themeSaveFixture.mode('accept'));await page.getByRole('button',{name:'Dark',exact:true}).click();await settle(page,2);assert.equal(await page.getByRole('alert').count(),0);assert.equal((await page.evaluate(()=>(window as any).themeSaveFixture.value())).preference,'dark');assert.equal(await page.getByRole('button',{name:'Dark',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),2);assert.deepEqual(await page.evaluate(()=>(window as any).themeSaveFixture.unhandled),[])
 })
 await t.test('同id优先级可撤销，晚答不污染重新挂载入口',async t=>{
  const page=await open(t);const rows=await page.evaluate(()=>(window as any).themeSaveFixture.priorities());assert.equal(rows.filter((row:any)=>row.id==='font-size').length,2)
  await page.evaluate(()=>(window as any).themeSaveFixture.mode('defer'));await page.getByRole('button',{name:'Increase font size',exact:true}).click();await page.waitForFunction(()=>(window as any).themeSaveFixture.calls.length===1)
  await page.evaluate(()=>{(window as any).themeSaveFixture.uninstall();(window as any).themeSaveFixture.reinstall()});await page.evaluate(()=>(window as any).themeSaveFixture.release('false'));await settle(page);assert.equal(await page.getByRole('alert').count(),0)
  await page.evaluate(()=>(window as any).themeSaveFixture.installOther());await page.getByText('Other explicit shadow',{exact:true}).waitFor();await page.evaluate(()=>(window as any).themeSaveFixture.removeOther());await page.getByRole('button',{name:'Increase font size',exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),1)
  await page.evaluate(()=>(window as any).themeSaveFixture.uninstall());assert.deepEqual((await page.evaluate(()=>(window as any).themeSaveFixture.priorities())).map((row:any)=>row.priority),[0,0]);assert.equal(await page.getByRole('button',{name:'Increase font size',exact:true}).count(),1)
 })
 await t.test('首次挂载、语言切换与反馈展示不保存；三语含繁体地区回退',async t=>{
  const page=await open(t);assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),0)
  for(const [locale,text]of [['zh','暂时无法确认是否已保存，请核对当前值后再试'],['zh-TW','暫時無法確認是否已儲存，請核對目前的設定值後再試'],['en','Check the current value before trying again']]){await page.evaluate((locale:string)=>{(window as any).themeSaveFixture.locale(locale);(window as any).themeSaveFixture.mode('false')},locale);await page.getByRole('button',{name:/Increase font size|增大字号/,exact:true}).click();await settle(page);assert.equal(await page.getByRole('alert').count(),1);assert.ok((await page.getByRole('alert').innerText()).includes(text));await evidence(page,'locale-'+locale)}
  assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),3)
 })
 await t.test('原生字体输入归一化持久化，相同值再次blur和当前主题点击均不写',async t=>{
  const page=await open(t);await page.getByRole('button',{name:'More font settings',exact:true}).click()
  const font=page.getByRole('textbox',{name:'Text font',exact:true});await font.fill('  Arial , monospace  ');await font.press('Tab');await settle(page)
  assert.equal((await page.evaluate(()=>(window as any).themeSaveFixture.value())).textFontFamily,'"Arial", monospace','持久值须沿原生归一化契约')
  assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),1)
  await font.focus();await font.press('Tab');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),1,'相同字体值blur不能变成新写入')
  await page.getByRole('button',{name:'System',exact:true}).click();assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),1,'已选主题不能重复保存')
 })
 await t.test('延迟回执期间快速双点不能静默折叠增量：共享控件禁用并显示保存中',async t=>{
  const page=await open(t),increase=page.getByRole('button',{name:'Increase font size',exact:true})
  await page.evaluate(()=>(window as any).themeSaveFixture.mode('defer'));await increase.evaluate((button:HTMLButtonElement)=>{button.click();button.click()})
  await page.waitForFunction(()=>(window as any).themeSaveFixture.calls.length>=1)
  assert.equal(await increase.isDisabled(),true,'未回执期间必须明确阻止第二次冲突编辑')
  assert.equal(await page.getByRole('button',{name:'Dark',exact:true}).isDisabled(),true,'外观和字体复用同一form，不能并发覆盖')
  assert.equal(await page.getByRole('status').count(),1);assert.match(await page.getByRole('status').innerText(),/Saving/)
  assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),1)
  await evidence(page,'saving');await page.evaluate(()=>(window as any).themeSaveFixture.release('accept'));await settle(page)
  assert.equal((await page.evaluate(()=>(window as any).themeSaveFixture.value())).fontSize,15);assert.equal(await increase.isEnabled(),true)
  await page.evaluate(()=>(window as any).themeSaveFixture.mode('accept'));await increase.click();await settle(page,2)
  assert.equal((await page.evaluate(()=>(window as any).themeSaveFixture.value())).fontSize,16);assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),2)
 })
})

test('固定SDK Remote→ConfigForm：服务端已写入但ACK丢失，恢复成功仍false，不能声称拒绝',{timeout:60000},async t=>{
 const script=await fixtureScript(true),browser=await loadPlaywright().chromium.launch({...launchOptions(),headless:true});t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1100,height:900}});await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><body><div id="root"></div></body>');await page.addScriptTag({content:script})
 await page.waitForFunction(()=>!!(window as any).themeSaveFixture?.ready||!!(window as any).fixtureFailure,{},{timeout:10000});assert.equal(await page.evaluate(()=>(window as any).fixtureFailure),undefined)
 await page.evaluate(()=>(window as any).themeSaveFixture.mode('lost-ack'));await page.getByRole('button',{name:'Increase font size',exact:true}).click()
 await page.waitForFunction(()=>(window as any).themeSaveFixture.formOutcomes.length===1);await page.getByRole('alert').waitFor()
 const actual=await page.evaluate(()=>{const f=(window as any).themeSaveFixture;return {committed:f.committed,value:f.value(),outcomes:f.formOutcomes,wire:f.wire,calls:f.calls.length}})
 assert.equal(actual.committed,1);assert.equal(actual.value.fontSize,15);assert.deepEqual(actual.outcomes,[false]);assert.equal(actual.calls,1)
 assert.deepEqual(actual.wire,['settings/describe','settings/mutate','settings/describe'],'必须实际经过SDK网络异常折叠与ConfigForm恢复读取')
 const evidence=process.env.F23_THEME_SAVE_EVIDENCE_DIR;if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'real-sdk-lost-ack.png'),fullPage:true});await writeFile(join(evidence,'real-sdk-lost-ack.aria.txt'),await page.locator('body').ariaSnapshot());await writeFile(join(evidence,'real-sdk-lost-ack.json'),JSON.stringify(actual,null,2)+'\n')}
 assert.match(await page.getByRole('alert').innerText(),/cannot confirm.*saved.*current value/is,'已提交而回执丢失时，布尔false不能显示明确拒绝')
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),1,'禁止自动重发原修改')
 await page.evaluate(()=>(window as any).themeSaveFixture.mode('accept'));await page.getByRole('button',{name:'Increase font size',exact:true}).click();await page.waitForFunction(()=>(window as any).themeSaveFixture.formOutcomes.length===2)
 assert.deepEqual(await page.evaluate(()=>(window as any).themeSaveFixture.formOutcomes),[false,true]);assert.equal((await page.evaluate(()=>(window as any).themeSaveFixture.value())).fontSize,16);assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.evaluate(()=>(window as any).themeSaveFixture.calls.length),2)
})
