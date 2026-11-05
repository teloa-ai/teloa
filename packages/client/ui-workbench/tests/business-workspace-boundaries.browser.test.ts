import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

/** 真组件、真实 effect 与只读 API 夹具；检查入口边界，不接运行实例或外部系统。 */
test('通用工作不触发业务数据请求；拒绝不重试，读取未知不伪报零，连接恢复后可重读',{timeout:60000},async()=>{
 const client=fileURLToPath(new URL('../src/client/',import.meta.url)),root=fileURLToPath(new URL('../../../../',import.meta.url))
 await mkdir(join(client,'../../.runtime'),{recursive:true})
 const temp=await mkdtemp(join(client,'../../.runtime/workspace-boundaries-'))
 let browser:any
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<html lang="zh-CN"><body><div id="root"></div></body></html>')})
 try{
  await writeFile(join(temp,'fixture.tsx'),`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {BusinessWorkspace} from '${client}BusinessWorkspace.tsx';import {emptyTaskPreview} from '${client}task-preview.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';document.body.classList.add(tokens.tokens);document.body.dataset.teloaUiFont='14';Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));evidenceThemes();function evidenceThemes(){window.workspaceThemes=prototypeThemes;}import {BusinessDashboardList} from '${client}BusinessDashboardList.tsx';import {BusinessSyncControls} from '${client}BusinessSyncControls.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const evidence=window.boundaryFixture={calls:[],failure:'forbidden'};
const read=async(kind,scope)=>{evidence.calls.push(kind+':'+scope);if(evidence.failure==='forbidden')throw {code:'teloa/forbidden',message:'private-internal-path'};if(evidence.failure==='network')throw Error('private-network-details');return []};
const api={list:({scope})=>read('list',scope),syncStatus:({scope})=>read('status',scope),syncRules:({scope})=>read('rules',scope),syncRuntime:async({scope})=>{await read('runtime',scope);return {scope,managed:false,syncEnabled:false,revision:0}}};
const groups={list:async()=>({items:[]})},customization={directory:async()=>({drafts:[]})};
const responsibility={api:{read:async({scope})=>{evidence.calls.push('responsibility:'+scope);return null}},roles:{list:async()=>[]}};
function Profile({visible}){const [draft,setDraft]=useState('');return visible?<label>业务员工草稿<input value={draft} onChange={event=>setDraft(event.target.value)}/></label>:null}
const services={responsibility,groups,attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:true,tasksFailed:false,attentionKnown:true,attentionFailed:false,refresh:()=>{},openGroup:()=>{},createGroup:()=>{},talkRole:async()=>{},openAttention:()=>{},renderRole:(id,close,visible=true)=><Profile visible={visible}/>};
const state={...emptyTaskPreview(),tasks:[],roles:[{id:'same-employee',storage:'persistent',kind:'employee',state:'active',scopes:['sales'],name:'Analyst',duty:'Analyze'}]};
function App(){const [mode,setMode]=useState('general'),[section,setSection]=useState('dashboards');const scope=mode==='general'?'general':'sales';evidence.overview=()=>{setMode('sales');setSection('overview')};return <I18nProvider runtime={runtime}><aside><button onClick={()=>{setSection('dashboards');setMode('general')}}>测试通用</button><button onClick={()=>{setSection('dashboards');setMode('sales')}}>测试具体业务</button><button onClick={()=>{evidence.failure='network';setMode('sync-network')}}>测试同步断线</button><button onClick={()=>{evidence.failure='forbidden';setMode('sync-forbidden')}}>测试同步拒绝</button><button onClick={()=>{evidence.failure='ready'}}>恢复读取</button></aside>{mode.startsWith('sync')?<BusinessSyncControls key={mode} scope="sales" api={api}/>:<BusinessWorkspace key={scope} scope={scope} title={scope==='general'?'通用工作':'销售工作'} target={{scope,section}} state={state} services={services} dashboardApi={api} go={target=>setSection(target.section)} back={()=>{}} start={()=>evidence.calls.push('start')} configure={()=>{}} staff={()=>{}} openTask={()=>{}} openWork={()=>{}} colorScheme="light"><BusinessDashboardList scope={scope} api={api} customization={customization} open={()=>{}} openDrafts={()=>{}}/></BusinessWorkspace>}</I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`)
  const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'WorkspaceBoundariesFixture',formats:['iife']}}})
  const output=Array.isArray(result)?result[0]:result;assert.ok(output&&'output' in output)
  const script=output.output.find(item=>item.type==='chunk')!.code,styles=output.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
  browser=await loadPlaywright().chromium.launch(launchOptions())
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors:string[]=[],external:string[]=[]
  page.setDefaultTimeout(6000)
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port
  page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.route('**/*',(route:any)=>route.request().url().startsWith(url+'/')?route.continue():(external.push(route.request().url()),route.abort()))
  await page.goto(url);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
  await page.getByRole('heading',{name:'通用工作',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'统计看板',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'业务内容',exact:true}).count(),0)
  await page.getByRole('button',{name:'AI 员工',exact:true}).click()
  await page.getByRole('button',{name:'Analyst Analyze',exact:true}).waitFor()
  await page.getByRole('button',{name:'Analyst Analyze',exact:true}).click()
  const profile=page.getByRole('dialog',{name:'Analyst',exact:true});await profile.waitFor()
  assert.equal(Math.round((await profile.boundingBox())!.width),432)
  assert.equal(await profile.locator(':scope > header h2').count(),0,'业务入口采用单一身份区')
  await profile.getByRole('textbox',{name:'业务员工草稿',exact:true}).fill('保留业务来源的输入')
  await page.keyboard.press('Escape')
  await page.getByRole('button',{name:'Analyst Analyze',exact:true}).click()
  assert.equal(await profile.getByRole('textbox',{name:'业务员工草稿',exact:true}).inputValue(),'保留业务来源的输入')
  await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(()=>(window as any).boundaryFixture.calls),[],'general 不读取业务数据、看板或业务负责人')
  await page.getByRole('button',{name:'测试具体业务',exact:true}).click()
  await page.getByRole('alert').waitFor()
  assert.match(await page.getByRole('alert').innerText(),/无权查看此看板/)
  assert.equal(await page.getByRole('button',{name:'重新读取',exact:true}).count(),0)
  assert.doesNotMatch(await page.locator('body').innerText(),/private-internal-path|暂时无法加载/)
  assert.deepEqual(await page.evaluate(()=>(window as any).boundaryFixture.calls),['list:sales'],'拒绝后不继续挂载同步或调用 general 数据接口')
  await page.getByRole('button',{name:'测试同步拒绝',exact:true}).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByRole('button',{name:'重新读取',exact:true}).count(),0)
  assert.doesNotMatch(await page.locator('body').innerText(),/0 个数据源映射/)
  await page.getByRole('button',{name:'测试同步断线',exact:true}).click()
  await page.getByRole('alert').waitFor()
  assert.match(await page.getByRole('alert').innerText(),/暂不可读/)
  assert.equal(await page.getByRole('button',{name:'重新读取',exact:true}).count(),1)
  assert.doesNotMatch(await page.locator('body').innerText(),/0 个数据源映射|private-network-details/)
  await page.getByRole('button',{name:'恢复读取',exact:true}).click()
  await page.getByRole('button',{name:'重新读取',exact:true}).click()
  await page.getByRole('alert').waitFor({state:'hidden'})
  await page.evaluate(()=>(window as any).boundaryFixture.overview());const pane=page.locator('[data-teloa-business-workspace]');await pane.locator('[class*=metrics]').waitFor();await page.setViewportSize({width:2560,height:1000})
  for(const width of [320,420,640,900,1200])for(const size of [14,28])for(const theme of ['light','dark']){
   await pane.evaluate((el:HTMLElement,width:number)=>{el.style.width=width+'px';el.style.height='850px'},width)
   await page.evaluate(({size,theme}:any)=>{for(const [key,value]of Object.entries((window as any).workspaceThemes[theme]))document.body.style.setProperty(key,value as string);document.body.style.setProperty('--teloa-design-text-base',size/16+'rem')},{size,theme});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
   const result:{width:boolean;lines:boolean;font:number}[]=await pane.locator('[class*=metrics] button>span').evaluateAll((nodes:HTMLElement[])=>nodes.map(el=>({width:el.scrollWidth<=el.clientWidth+1,lines:el.getBoundingClientRect().height<=parseFloat(getComputedStyle(el).lineHeight)*2+1,font:parseFloat(getComputedStyle(el).fontSize)})))
   assert.equal(result.length,4);assert.ok(result.every(value=>value.width&&value.lines&&Math.abs(value.font-size*12/14)<.1),JSON.stringify({width,size,theme,result}));assert.equal(await pane.evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth+1),true)
   if(process.env.TELOA_UI_SCREENSHOT_DIR&&theme==='dark'&&((width===640&&size===14)||(width===320&&size===28))){await mkdir(process.env.TELOA_UI_SCREENSHOT_DIR,{recursive:true});await pane.screenshot({path:join(process.env.TELOA_UI_SCREENSHOT_DIR,'business-'+width+'-'+size+'.png')})}
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[])
 }finally{await browser?.close();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(temp,{recursive:true,force:true})}
})
