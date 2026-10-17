import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),origin='http://127.0.0.1:31119'
let browser:any,html:string,script:string,temp:string
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-employee-computer-'))
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {EmployeeComputerPage} from '${client}EmployeeComputerPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const role={id:'r1',name:'小研',kind:'employee',storage:'persistent',avatarKey:'security-analyst',scopes:['SOC','sales'],state:'active',duty:'核对业务证据'};
 window.computerFixture={opened:[],talks:[]};function App(){return <I18nProvider runtime={runtime}><EmployeeComputerPage role={role} loading={false} scopes={{SOC:'安全运营',sales:'销售'}} retry={()=>{}} back={()=>window.computerFixture.opened.push('back')} openEmployee={id=>window.computerFixture.opened.push(id)} talk={async id=>{window.computerFixture.talks.push(id);return false}}/></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`
 await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'EmployeeComputerFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 const styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${styles}</style></head><body style="--teloa-design-bg:#f7f7f6;--teloa-design-surface:white;--teloa-design-text:#222;--teloa-design-muted:#666;--teloa-design-border:#ddd;--teloa-design-font:system-ui;--teloa-design-text-base:14px"><div id="root"></div><script src="/fixture.js"></script></body></html>`
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,detached=false){
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors:string[]=[]
 context.on('page',(page:any)=>page.on('pageerror',(e:Error)=>errors.push(e.message)))
 await context.route('**/*',(route:any)=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(url.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript; charset=utf-8',body:script});if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:html});return route.abort()})
 const page=await context.newPage();page.setDefaultTimeout(3000)
 await page.goto(origin+'/?employeeComputer=r1'+(detached?'&computerWindow=1':'')+'&auth=do-not-copy#original')
 t.after(async()=>{await context.close();assert.deepEqual(errors,[])})
 await page.getByRole('heading',{name:'还没有可查看的桌面'}).waitFor()
 return {page,context}
}
test('云电脑保留员工归属；放大和 Esc 还原，不生成在线或控制权状态',async t=>{
 const {page}=await mount(t)
 const back=page.getByRole('button',{name:'员工目录',exact:true}),chat=page.getByRole('button',{name:'对话',exact:true})
 for(const button of [back,chat]){
  assert.equal(await button.innerText(),'','辅助动作使用图标及可访问名称，不占用文字按钮空间')
  assert.equal(await button.getAttribute('data-teloa-toolbar-icon'),'true')
 }
 assert.equal(await page.getByText('安全运营',{exact:true}).isVisible(),true)
 assert.equal(await page.getByText('销售',{exact:true}).isVisible(),true)
 assert.equal(await page.getByRole('button',{name:'申请接管',exact:true}).isDisabled(),true)
 await page.getByRole('button',{name:'在页面中放大',exact:true}).click()
 assert.equal(await page.getByRole('heading',{name:'小研',exact:true}).count(),0)
 await page.keyboard.press('Escape')
 assert.equal(await page.getByRole('heading',{name:'小研',exact:true}).isVisible(),true)
 assert.equal(await page.getByRole('button',{name:'在页面中放大',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await page.getByRole('button',{name:'对话',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).computerFixture.talks),['r1'])
 assert.equal(await page.getByRole('alert').innerText(),'未能打开原会话，请重试。')
 await back.click();assert.deepEqual(await page.evaluate(()=>(window as any).computerFixture.opened),['back'])
})
test('弹出同一员工独立窗口，隔离 opener 和认证参数，原页面不离开',async t=>{
 const {page,context}=await mount(t),original=page.url()
 const popupPromise=context.waitForEvent('page')
 await page.getByRole('button',{name:'弹出独立窗口',exact:true}).click()
 const popup=await popupPromise;await popup.waitForLoadState()
 assert.equal(popup.url(),origin+'/?employeeComputer=r1&computerWindow=1')
 assert.equal(await popup.evaluate(()=>window.opener),null)
 assert.equal(page.url(),original)
 assert.equal(await popup.getByRole('button',{name:'恢复页面布局',exact:true}).isVisible(),true)
 await popup.keyboard.press('Escape')
 assert.equal(await popup.getByRole('heading',{name:'小研',exact:true}).isVisible(),true)
})
