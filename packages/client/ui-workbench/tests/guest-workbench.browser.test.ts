import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url))
const entry=fileURLToPath(new URL('../src/client/guest.tsx',import.meta.url))

test('访客复用工作导航、保留输入，浏览不读取本人存储或连接服务，使用时才请求准入',async t=>{
 const temp=await mkdtemp(join(root,'.runtime-guest-workbench-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'entry.ts'),`import {mountGuestWorkbench} from ${JSON.stringify(entry)}; const state=window.guestTest={calls:[],prompt:'原草稿'};state.handle=mountGuestWorkbench(document.getElementById('root'),{product:'Pro',initialPrompt:state.prompt,maxPromptLength:4000,onPromptChange:value=>{state.prompt=value},onStart:()=>state.calls.push('start'),onAccount:()=>state.calls.push('account')});`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.ts'),name:'GuestWorkbenchTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code
 const styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1400,height:900}});t.after(()=>page.close())
 const errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><main id="root"></main></body></html>')
 await page.evaluate(()=>{
  for(const property of ['localStorage','sessionStorage'])Object.defineProperty(window,property,{get(){throw Error('访客不能读取本人存储')}})
  for(const property of ['teloaApplication','teloaProWorkspace','__ModuleLoader__','dshDesktopBoot'])Object.defineProperty(window,property,{get(){throw Error('访客不能装配在线服务')}})
 })
 await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const navigation=page.getByRole('navigation',{name:'主导航',exact:true})
 await navigation.waitFor()
 for(const label of ['工作台','需要你','对话','任务','项目','自动化','员工','业务','资料','能力','市场'])assert.equal(await navigation.getByRole('button',{name:label,exact:true}).count(),1,label)
 assert.equal(await page.getByLabel('想完成什么工作？',{exact:true}).inputValue(),'原草稿')
 assert.equal(await page.getByLabel('想完成什么工作？',{exact:true}).getAttribute('maxlength'),'4000')
 const longPrompt='长'.repeat(4000)
 await page.getByLabel('想完成什么工作？',{exact:true}).fill(longPrompt+'额外')
 assert.equal(await page.getByLabel('想完成什么工作？',{exact:true}).inputValue(),longPrompt)
 assert.equal(await page.evaluate(()=>(window as any).guestTest.prompt),longPrompt)
 await navigation.getByRole('button',{name:'项目',exact:true}).click()
 await navigation.getByRole('button',{name:'工作台',exact:true}).click()
 assert.equal(await page.getByLabel('想完成什么工作？',{exact:true}).inputValue(),longPrompt)
 await page.getByLabel('想完成什么工作？',{exact:true}).fill('整理这一周反馈')
 await navigation.getByRole('button',{name:'项目',exact:true}).click()
 await page.getByText('登录后查看你的项目和相关工作。',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).guestTest.calls),[])
 await navigation.getByRole('button',{name:'工作台',exact:true}).click()
 assert.equal(await page.getByLabel('想完成什么工作？',{exact:true}).inputValue(),'整理这一周反馈')
 await page.getByRole('button',{name:'开始工作',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).guestTest.calls),['start'])
 await page.getByRole('button',{name:'登录',exact:true}).first().click()
 assert.deepEqual(await page.evaluate(()=>(window as any).guestTest.calls),['start','account'])
 await page.evaluate(()=>(window as any).guestTest.handle.update({account:{displayName:'Max Luo'}}))
 assert.equal(await page.getByRole('button',{name:'登录',exact:true}).count(),0)
 assert.equal(await page.getByText('ML',{exact:true}).count(),2)
 await page.getByRole('button',{name:'账号',exact:true}).first().click()
 assert.deepEqual(await page.evaluate(()=>(window as any).guestTest.calls),['start','account','account'])
 await page.evaluate(()=>(window as any).guestTest.handle.update({prompt:'',account:{displayName:'max@example.test'}}))
 assert.equal(await page.getByLabel('想完成什么工作？',{exact:true}).inputValue(),'')
 assert.equal(await page.getByText('max@example.test',{exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).guestTest.prompt),'整理这一周反馈','宿主更新草稿不回写为用户编辑')
 await page.evaluate(()=>(window as any).guestTest.handle.update({account:null}))
 await page.getByRole('button',{name:'切换深色主题',exact:true}).click()
 assert.equal(await page.locator('[data-guest-workbench]').getAttribute('data-theme'),'dark')
 await page.setViewportSize({width:390,height:844})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.evaluate(()=>(window as any).guestTest.handle.dispose())
 assert.equal(await page.locator('#root').textContent(),'')
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
