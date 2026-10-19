import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeProjects,ProjectService} from '../src/work/projects.ts'
import {initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeProjectContext,ProjectContextService} from '../src/work/project-context.ts'
// @ts-expect-error 复用工作台既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from '../../client/ui-workbench/tests/fixtures/load-playwright.mjs'

test('真实 PG + 工作台抽屉：草稿往返、显式记忆、固定分享、来源撤回和浏览器重载',{timeout:60000},async t=>{
 const cleanup:Array<()=>Promise<unknown>>=[];t.after(async()=>{for(const close of cleanup.reverse())await close()})
 const root=fileURLToPath(new URL('../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client/'),temp=await mkdtemp(join(root,'.runtime-project-context-'))
 cleanup.push(()=>rm(temp,{recursive:true,force:true}))
 const container=await new PostgreSqlContainer('postgres:17-alpine').start();cleanup.push(()=>container.stop())
 const pool=new Pool({connectionString:container.getConnectionUri()});cleanup.push(()=>pool.end())
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool)
 const identity={id:randomUUID,now:()=>new Date().toISOString()},owner=randomUUID(),projects=new ProjectService(pool,identity),context=new ProjectContextService(pool,identity)
 const rows=await Promise.all(['来源项目','接收项目'].map(title=>projects.create(owner,{requestId:randomUUID(),fields:{scope:'general',title,goal:'测试项目',dueDate:null,state:'planning',links:[],references:[]}})))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ProjectContextPanel} from '${client}ProjectContextPanel.tsx';import {createProjectApi} from '${client}project-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import tokens from '${client}theme-tokens.module.css';
 import {ThemePresenter} from '${client}theme-presenter.ts';new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});
 const rows=${JSON.stringify(rows)},snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const api=createProjectApi(async(endpoint,input)=>{const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint,input})});const result=await response.json();if(!response.ok)throw Object.assign(Error(result.message),{code:result.code,rejected:true});return result},undefined,{read:()=>localStorage.getItem('context'),write:value=>localStorage.setItem('context',value),clear:()=>localStorage.removeItem('context')});
 function App(){const [selected,setSelected]=useState(0),[open,setOpen]=useState(false);return <I18nProvider runtime={runtime}><main className={tokens.tokens}><textarea aria-label="会话草稿" defaultValue="未发送的任务"/>{rows.map((p,i)=><button key={p.id} onClick={()=>{setSelected(i);setOpen(true)}}>{p.title}</button>)}<ProjectContextPanel key={rows[selected].id} project={rows[selected]} api={api} open={open} close={()=>setOpen(false)}/></main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器不应执行宿主摘要或签名算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'ProjectContextTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const server=createServer(async(req,res)=>{
  if(req.url==='/rpc'){
   try{let body='';for await(const chunk of req)body+=chunk;const {endpoint,input}=JSON.parse(body);let value:unknown
    if(endpoint==='project-context/get')value=await context.get(owner,input)
    else if(endpoint==='project-context/mutate')value=await context.mutate(owner,input)
    else if(endpoint==='projects/overview')value=await projects.overview(owner,input)
    else throw Error('unexpected endpoint')
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))
   }catch(error:any){res.statusCode=400;res.end(JSON.stringify({code:error.code,message:error.message}))}
  }else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html lang="zh-CN"><head><style>'+styles+'</style></head><body><div id="root"></div><script>'+script+'</script></body></html>')}
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const address=server.address();assert.ok(address&&typeof address!=='string')
 const browser=await loadPlaywright().chromium.launch(launchOptions());cleanup.push(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));page.setDefaultTimeout(4000)
 // 记忆条目按标题折叠；验证正文和动作前先由本人展开原条目，不放宽正文可见性断言。
 const openEntry=async(region:string,topic:string,content?:string)=>{
  const entry=page.getByRole('region',{name:region,exact:true}).locator('details').filter({has:page.locator('summary').getByText(topic,{exact:true})})
  await entry.waitFor()
  if(content)await entry.getByText(content,{exact:true}).waitFor({state:'attached'})
  if(await entry.getAttribute('open')===null)await entry.locator(':scope > summary').click()
  return entry
 }
 await page.goto('http://127.0.0.1:'+address.port)
 assert.deepEqual(errors,[],'浏览器启动应无脚本异常')
 try{await page.getByRole('button',{name:'来源项目',exact:true}).click()}catch(error){throw new Error(JSON.stringify({errors,body:(await page.locator('body').innerText()).slice(0,1000)}),{cause:error})}
 await page.getByRole('button',{name:'添加记忆',exact:true}).click();await page.getByLabel('主题',{exact:true}).fill('构建经验');await page.getByLabel('正文',{exact:true}).fill('固定第一版')
 const validDraft=await page.evaluate(()=>localStorage.getItem('context'))
 await page.getByLabel('正文',{exact:true}).fill('第一行\u000b第二行')
 await page.getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>localStorage.getItem('context')),validDraft,'无效粘贴不能破坏已持久化草稿')
 assert.equal(await page.getByRole('button',{name:'清除损坏的恢复记录与本地草稿（不修改已保存内容）',exact:true}).count(),0)
 assert.equal(await page.getByLabel('正文',{exact:true}).inputValue(),'第一行\u000b第二行','无效输入保留在表单内，允许本人就地修正')
 await page.getByLabel('正文',{exact:true}).fill('固定第一版');await page.getByRole('alert').waitFor({state:'hidden'})
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 assert.equal(await page.getByLabel('会话草稿').inputValue(),'未发送的任务')
 await page.getByRole('button',{name:'接收项目',exact:true}).click();await page.getByRole('button',{name:'添加记忆',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'正文',exact:true}).count(),0)
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'来源项目',exact:true}).click()
 try{assert.equal(await page.getByLabel('正文',{exact:true}).inputValue(),'固定第一版')}catch(error){throw new Error(JSON.stringify({errors,body:(await page.locator('body').innerText()).slice(0,1200),journal:await page.evaluate(()=>localStorage.getItem('context'))}),{cause:error})}
 await page.reload();await page.getByRole('button',{name:'来源项目',exact:true}).click();assert.equal(await page.getByLabel('正文',{exact:true}).inputValue(),'固定第一版')
 await page.getByRole('button',{name:'保存',exact:true}).click();await openEntry('已保存记忆','构建经验');await page.getByRole('region',{name:'已保存记忆',exact:true}).getByText('固定第一版',{exact:true}).waitFor()
 await page.getByRole('button',{name:'分享',exact:true}).click();await page.getByLabel('目标项目',{exact:true}).selectOption(rows[1]!.id);await page.locator('form').getByRole('button',{name:'分享',exact:true}).click()
 await openEntry('共享记忆','构建经验');await page.getByRole('region',{name:'共享记忆',exact:true}).getByText('固定第一版',{exact:true}).waitFor()
 if(process.env.TELOA_PROJECT_CONTEXT_SCREENSHOT)await page.screenshot({path:process.env.TELOA_PROJECT_CONTEXT_SCREENSHOT,fullPage:true})
 await openEntry('已保存记忆','构建经验');await page.getByRole('region',{name:'已保存记忆',exact:true}).getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('正文',{exact:true}).fill('更新第二版');await page.getByRole('button',{name:'保存',exact:true}).click()
 await openEntry('已保存记忆','构建经验','更新第二版');await page.getByRole('region',{name:'已保存记忆',exact:true}).getByText('更新第二版',{exact:true}).waitFor()
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'接收项目',exact:true}).click();await openEntry('共享记忆','构建经验');await page.getByText('固定第一版',{exact:true}).waitFor();assert.equal(await page.getByText('更新第二版',{exact:true}).count(),0)
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'来源项目',exact:true}).click();await openEntry('已保存记忆','构建经验');await page.getByRole('button',{name:'撤回',exact:true}).click();await page.getByRole('button',{name:'确认撤回',exact:true}).click();await page.getByText('来源已撤回',{exact:true}).first().waitFor()
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'接收项目',exact:true}).click();await page.getByText('来源已撤回',{exact:true}).first().waitFor();assert.equal(await page.getByText('固定第一版',{exact:true}).count(),0)
 assert.equal((await context.get(owner,{projectId:rows[1]!.id})).shares[0]!.markdown,null)
 // 模拟另一标签页撤回：接收方正在编辑，也必须移除已撤回共享，且保留编辑焦点。
 const sourceId=rows[0]!.id
 let source=await context.get(owner,{projectId:sourceId})
 await context.mutate(owner,{requestId:randomUUID(),projectId:sourceId,expectedVersion:source.version,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'后台核对',markdown:'编辑期间撤回的正文'}})
 source=await context.get(owner,{projectId:sourceId});const active=source.entries.find(e=>e.state==='active')!
 await context.mutate(owner,{requestId:randomUUID(),projectId:sourceId,expectedVersion:source.version,change:{kind:'share',entryId:active.id,entryVersion:active.version,targetProjectId:rows[1]!.id}})
 await page.getByRole('button',{name:'刷新',exact:true}).click();await openEntry('共享记忆','后台核对');await page.getByText('编辑期间撤回的正文',{exact:true}).waitFor()
 await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('简报',{exact:true}).fill('本人仍在编辑的草稿')
 await context.mutate(owner,{requestId:randomUUID(),projectId:sourceId,expectedVersion:source.version+1,change:{kind:'withdraw-entry',entryId:active.id}})
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
 await page.getByText('编辑期间撤回的正文',{exact:true}).waitFor({state:'hidden'})
 assert.equal(await page.getByLabel('简报',{exact:true}).inputValue(),'本人仍在编辑的草稿')
 assert.equal(await page.getByLabel('简报',{exact:true}).evaluate((e:HTMLElement)=>e===document.activeElement),true)
 assert.deepEqual(errors,[])
})
