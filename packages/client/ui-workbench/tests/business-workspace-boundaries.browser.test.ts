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
import {BusinessWorkspace} from '${client}BusinessWorkspace.tsx';import {BusinessDashboardList} from '${client}BusinessDashboardList.tsx';import {BusinessSyncControls} from '${client}BusinessSyncControls.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const evidence=window.boundaryFixture={calls:[],failure:'forbidden'};
const read=async(kind,scope)=>{evidence.calls.push(kind+':'+scope);if(evidence.failure==='forbidden')throw {code:'teloa/forbidden',message:'private-internal-path'};if(evidence.failure==='network')throw Error('private-network-details');return []};
const api={list:({scope})=>read('list',scope),syncStatus:({scope})=>read('status',scope),syncRules:({scope})=>read('rules',scope),syncRuntime:async({scope})=>{await read('runtime',scope);return {scope,managed:false,syncEnabled:false,revision:0}}};
const groups={list:async()=>({items:[]})},customization={directory:async()=>({drafts:[]})};
const responsibility={api:{read:async({scope})=>{evidence.calls.push('responsibility:'+scope);return null}},roles:{list:async()=>[]}};
const services={responsibility,groups,attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:true,tasksFailed:false,attentionKnown:true,attentionFailed:false,refresh:()=>{},openGroup:()=>{},createGroup:()=>{},talkRole:async()=>{},openAttention:()=>{},renderRole:()=>null};
const state={tasks:[],roles:[{id:'same-employee',storage:'persistent',kind:'employee',state:'active',scopes:['sales'],name:'Analyst',duty:'Analyze'}]};
function App(){const [mode,setMode]=useState('general'),[section,setSection]=useState('dashboards');const scope=mode==='general'?'general':'sales';return <I18nProvider runtime={runtime}><aside><button onClick={()=>{setSection('dashboards');setMode('general')}}>测试通用</button><button onClick={()=>{setSection('dashboards');setMode('sales')}}>测试具体业务</button><button onClick={()=>{evidence.failure='network';setMode('sync-network')}}>测试同步断线</button><button onClick={()=>{evidence.failure='forbidden';setMode('sync-forbidden')}}>测试同步拒绝</button><button onClick={()=>{evidence.failure='ready'}}>恢复读取</button></aside>{mode.startsWith('sync')?<BusinessSyncControls key={mode} scope="sales" api={api}/>:<BusinessWorkspace key={scope} scope={scope} title={scope==='general'?'通用工作':'销售工作'} target={{scope,section}} state={state} services={services} dashboardApi={api} go={target=>setSection(target.section)} back={()=>{}} start={()=>evidence.calls.push('start')} configure={()=>{}} staff={()=>{}} openTask={()=>{}} openWork={()=>{}} colorScheme="light"><BusinessDashboardList scope={scope} api={api} customization={customization} open={()=>{}} openDrafts={()=>{}}/></BusinessWorkspace>}</I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
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
  assert.deepEqual(errors,[]);assert.deepEqual(external,[])
 }finally{await browser?.close();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(temp,{recursive:true,force:true})}
})
