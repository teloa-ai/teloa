import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用工作树的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,temp:string,script:string,styles:string
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-hardware-settings-'))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';
 import {HardwareDevicesSettings} from '${client}HardwareDevicesSettings.tsx';
 import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 import {ThemePresenter} from '${client}theme-presenter.ts';import '${client}theme-tokens.module.css';
 const locale=document.documentElement.lang,snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const theme=new ThemePresenter();theme.apply({active:{colorScheme:document.body.dataset.scheme||'light',tokens:{}},preference:'light',fontSizes:{text:14,code:11,terminal:13},fontFamilies:{text:'',code:'',terminal:''}});
 let status={available:true,configured:false,writable:true,state:'idle',authorization:{enabled:false,grantVersion:0,scopes:[],assistantName:'小松鼠'}};
 window.hardwareFixture={saves:0,enables:0,failSave:false};const state=()=>structuredClone(status);
 const api={status:async()=>{if(window.hardwareFixture.failStatus)throw Error('offline');return state()},save:async()=>{window.hardwareFixture.saves++;if(window.hardwareFixture.failSave)throw Error('save failed');status={...status,configured:true,authorization:{...status.authorization,enabled:false}};return state()},enable:async()=>{window.hardwareFixture.enables++;status={...status,state:'ready',authorization:{...status.authorization,enabled:true}};return state()},revoke:async()=>{status={...status,state:'stopped',authorization:{...status.authorization,enabled:false}};return state()},test:async()=>state()};
 let pairing=null;window.hardwareFixture.pairingBegins=[];window.hardwareFixture.pairingCancels=0;api.direct={status:async()=>({enabled:true,devices:[],helper:{script:'/local/pair.py',socket:'/local/host.sock'}}),pairing:async()=>pairing,begin:async(allowApprovals)=>{window.hardwareFixture.pairingBegins.push(allowApprovals);return pairing={id:'1d87a6f2-51e2-4cec-a865-eb1245678901',state:'awaiting-device',allowApprovals,expiresAt:Date.now()+300000,host:'192.168.2.10',serverName:'teloa.test'}},cancel:async()=>{window.hardwareFixture.pairingCancels++;return pairing={...pairing,state:'cancelled'}},revoke:async()=>{}};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><HardwareDevicesSettings api={api}/></I18nProvider>);`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'HardwareSettingsFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,locale='zh-CN',width=1440,scheme='light'){
 const page=await browser.newPage({viewport:{width,height:900}}),errors:string[]=[]
 page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent(`<!doctype html><html lang="${locale}"><body data-scheme="${scheme}"><div id="root"></div></body></html>`)
 await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 return page
}

test('连接草稿关闭恢复；保存失败不丢输入，保存成功不隐式授权',async t=>{
 const page=await mount(t),configure=page.getByRole('button',{name:'配置连接',exact:true})
 await configure.click();let drawer=page.getByRole('dialog',{name:'小智 MCP',exact:true})
 await drawer.getByLabel('官方 MCP 接入点',{exact:true}).fill('wss://api.xiaozhi.me/mcp/?token=fixture')
 await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0)
 assert.equal(await configure.evaluate((element:HTMLElement)=>element===document.activeElement),true)
 await configure.click();drawer=page.getByRole('dialog',{name:'小智 MCP',exact:true})
 assert.match(await drawer.getByLabel('官方 MCP 接入点',{exact:true}).inputValue(),/token=fixture$/)
 await page.mouse.click(20,100);assert.equal(await page.locator('dialog[open]').count(),0)
 assert.deepEqual(await page.evaluate(()=>[(window as any).hardwareFixture.saves,(window as any).hardwareFixture.enables]),[0,0])
 await configure.click();await page.evaluate(()=>(window as any).hardwareFixture.failSave=true)
 await drawer.getByRole('button',{name:'保存接入点',exact:true}).click();await drawer.getByRole('alert').waitFor()
 assert.match(await drawer.getByLabel('官方 MCP 接入点',{exact:true}).inputValue(),/token=fixture$/)
 await page.evaluate(()=>(window as any).hardwareFixture.failSave=false)
 await drawer.getByRole('button',{name:'保存接入点',exact:true}).click();await drawer.getByText('接入点已保存',{exact:true}).waitFor()
 assert.equal(await drawer.getByLabel('官方 MCP 接入点',{exact:true}).inputValue(),'')
 const enable=drawer.getByRole('button',{name:'授权并启用',exact:true})
 assert.equal(await enable.isEnabled(),false);assert.equal(await page.evaluate(()=>(window as any).hardwareFixture.enables),0)
 await drawer.getByRole('checkbox',{name:'允许提交工作与查询结果',exact:true}).check()
 await enable.click();await drawer.getByText('MCP 已连接',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).hardwareFixture.enables),1)
 await page.keyboard.press('Escape');await page.evaluate(()=>(window as any).hardwareFixture.failStatus=true)
 await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByRole('alert').waitFor()
 await page.evaluate(()=>(window as any).hardwareFixture.failStatus=false)
 await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByRole('alert').waitFor({state:'hidden'})
})

test('三类语言与深浅主题在窄窗口仍能读完说明并操作，抽屉内容不贴边或横向溢出',async t=>{
 for(const [locale,configure,endpoint,details,width,scheme] of [
  ['zh-CN','配置连接','官方 MCP 接入点','连接与数据说明',1440,'light'],
  ['zh-Hant','設定連接','官方 MCP 接入點','連接與資料說明',560,'dark'],
  ['en','Configure','Official MCP endpoint','Connection and data details',390,'light'],
 ] as const){
  const page=await mount(t,locale,width,scheme)
  await page.getByRole('button',{name:configure,exact:true}).click()
  const drawer=page.getByRole('dialog',{name:'小智 MCP',exact:true}).or(page.getByRole('dialog',{name:'Xiaozhi MCP',exact:true}))
  await drawer.getByText(details,{exact:true}).click()
  const input=drawer.getByLabel(endpoint,{exact:true});await input.scrollIntoViewIfNeeded()
  const bounds=await drawer.evaluate((dialog:HTMLElement)=>{const field=dialog.querySelector('input')!.getBoundingClientRect(),box=dialog.getBoundingClientRect();return {inset:field.left-box.left,right:box.right-field.right,overflow:[dialog,...dialog.querySelectorAll('section,form,details')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>({tag:el.tagName,client:el.clientWidth,scroll:el.scrollWidth}))}})
  assert.ok(bounds.inset>=20&&bounds.right>=20,`${locale}: 正文须有可读留白`)
  assert.deepEqual(bounds.overflow,[],`${locale}: 不得横向溢出`)
  await input.fill('wss://api.xiaozhi.me/mcp/?token=fixture')
  await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0)
 }
})


test('USB 配对独立同意与可选审批；关闭恢复原作业且不执行 USB 写入',async t=>{
 const page=await mount(t);await page.getByRole('button',{name:'管理设备',exact:true}).click()
 const drawer=page.getByRole('dialog',{name:'Teloa 设备',exact:true}),begin=drawer.getByRole('button',{name:'授权并开始配对',exact:true})
 assert.equal(await begin.isEnabled(),false)
 const approvals=drawer.getByRole('checkbox',{name:'允许在设备屏幕批准或拒绝本次操作',exact:true});assert.equal(await approvals.isChecked(),false)
 await drawer.getByRole('checkbox',{name:'允许设备向原助手提交工作并读取回答',exact:true}).check();await approvals.check();await begin.click()
 await drawer.getByText('本次包含触屏审批权限',{exact:true}).waitFor()
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'管理设备',exact:true}).click()
 await drawer.getByText('本次包含触屏审批权限',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).hardwareFixture.pairingBegins),[true])
 assert.equal(await page.evaluate(()=>(window as any).hardwareFixture.pairingCancels),0)
 await drawer.getByRole('button',{name:'取消配对',exact:true}).click();await begin.waitFor()
 assert.equal(await page.evaluate(()=>(window as any).hardwareFixture.pairingCancels),1)
})
