import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ConversationWorkOverview} from '${client}ConversationWorkOverview.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const view=createRoot(document.getElementById('root')),locale='zh-CN',snapshot={locale,dshLocale:locale,revision:1};
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const state=window.overviewFixture={calls:[],deferred:{},mount:value=>{state.snapshot=value;render()},resolveStop:()=>state.deferred.resolve?.(),rejectStop:()=>state.deferred.reject?.(Error('connection unavailable'))};
function render(){flushSync(()=>view.render(<I18nProvider runtime={runtime}><div style={{display:'flex',height:600}}><div><textarea aria-label="原任务输入" defaultValue="保留的任务草稿"/></div><aside style={{width:360,height:'100%'}}><ConversationWorkOverview snapshot={state.snapshot} onOpenRecord={item=>state.calls.push(['record',item])} onStopWork={item=>{state.calls.push(['stop',item]);return new Promise((resolve,reject)=>{state.deferred={resolve,reject}})}} onReconcileWork={item=>state.calls.push(['reconcile',item])} onPreviewArtifact={item=>state.calls.push(['preview',item])} onDownloadArtifact={item=>state.calls.push(['download',item])}/></aside></div></I18nProvider>))}
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-conversation-overview-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'ConversationOverviewFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

const empty=()=>({sessionId:'parent',status:'idle',progress:{current:[],earlier:[]},running:[],ended:[],artifacts:[],usageGroups:[]})
const work=(overrides:Record<string,unknown>={})=>({id:'job:formatter',kind:'job',label:'核对表格格式',status:'running',sessionId:'parent',jobId:'formatter',canStop:true,canOpenRecord:true,...overrides})
async function pageFor(t:any,value:any){
 const page=await browser.newPage({viewport:{width:1100,height:760}}),errors:string[]=[],requests:string[]=[]
 page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="zh-CN"><head></head><body style="margin:0"><main id="root"></main></body></html>')
 await page.addStyleTag({content:':root{--teloa-text:#18202b;--teloa-muted:#657080;--teloa-border:#dce1e8;--teloa-surface:#fff;--teloa-background:#fff;--teloa-subtle:#f5f6f8;--teloa-hover:#eef0f3;--teloa-focus:#2c6bed;--teloa-info:#2766c4;--teloa-good:#208045;--teloa-warn:#925b0b;--teloa-font-caption:12px;--teloa-font-control:13px;--teloa-font-body:14px;--teloa-font-section:16px;--teloa-weight-medium:500;--teloa-weight-heading:600;--teloa-leading-body:1.6;--teloa-leading-label:1.5}'+styles})
 await page.addScriptTag({content:script});await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),value)
 return page
}

test('空会话没有虚构步骤、后台工作或成果，真实较早记录默认折叠并跨快照更新保留选择',async t=>{
 const value=empty(),page=await pageFor(t,value)
 assert.equal(await page.locator('aside article').count(),0)
 assert.equal(await page.locator('aside [data-work-status]').count(),0)
 assert.equal(await page.locator('aside [role="progressbar"]').count(),0)
 value.progress.earlier=[{id:'todo:old',content:'已核对资料',status:'completed',source:'todo',sessionId:'parent',seq:1}] as never[]
 value.ended=[work({id:'agent:reviewer',kind:'subagent',label:'复核旧稿',status:'completed',canStop:false,childSessionId:'reviewer'})] as never[]
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),value)
 const history=page.locator('details').filter({has:page.getByText('已核对资料',{exact:true})})
 assert.equal(await history.getAttribute('open'),null)
 await history.locator('summary').click();assert.notEqual(await history.getAttribute('open'),null)
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount({...value,status:'running'}),value)
 assert.notEqual(await history.getAttribute('open'),null)
 const current={id:'report:v2',sessionId:'parent',path:'output/report.md',label:'报告.md',kind:'Markdown',status:'final',version:'v2',seq:20}
 const old={id:'report:v1',sessionId:'parent',path:'output/report.md',label:'报告.md',kind:'Markdown',status:'draft',version:'v1',seq:10,isHistorical:true}
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),{...value,artifacts:[current,old],running:[work(),work({id:'job:stopping',status:'stopping'}),work({id:'job:waiting',status:'waiting'}),work({id:'job:unknown',status:'unknown',canStop:false})]})
 const running=page.getByRole('region',{name:'运行中',exact:true})
 assert.equal((await running.getByRole('heading').innerText()).replace(/\s+/g,''),'运行中2','等待和未知状态保留卡片，但不冒充运行数量')
 assert.equal(await page.getByRole('button',{name:'预览报告.md',exact:true}).count(),1,'历史成果默认折叠')
 const versions=page.locator('details').filter({has:page.getByText('版本记录',{exact:false})})
 assert.equal(await versions.getAttribute('open'),null)
 await versions.locator('summary').click()
 assert.match(await versions.innerText(),/v1/)
 await versions.getByRole('button',{name:'预览报告.md',exact:true}).click();await versions.getByRole('button',{name:'下载报告.md',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).overviewFixture.calls),[['preview',old],['download',old]],'历史预览和下载保留版本及来源身份')
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount({...value,status:'completed'}),{...value,artifacts:[current,old]})
 assert.notEqual(await versions.getAttribute('open'),null,'快照刷新保留历史展开选择')
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
})

test('后台停止仅传递明确对象，请求期间保留运行事实且禁止重复；未知状态提供核对并保留成果',async t=>{
 const item=work(),artifact={id:'result:one',sessionId:'parent',path:'output/report.md',label:'报告.md',kind:'markdown',status:'draft',version:'v1'}
 const value={...empty(),status:'running',running:[item],artifacts:[artifact]},page=await pageFor(t,value)
 await page.getByRole('button',{name:'查看记录',exact:true}).click()
 await page.getByRole('button',{name:'停止核对表格格式',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).overviewFixture.calls),[['record',item],['stop',item]])
 assert.equal(await page.locator('[data-work-status="running"]').count(),1)
 assert.equal(await page.getByRole('button',{name:'停止核对表格格式',exact:true}).isDisabled(),true)
 assert.equal(await page.getByText('已停止',{exact:true}).count(),0)
 await page.evaluate(()=>(window as any).overviewFixture.resolveStop())
 assert.equal(await page.locator('[data-work-status="running"]').count(),1,'请求回执不是终态事实')
 assert.equal(await page.getByRole('button',{name:'停止核对表格格式',exact:true}).isDisabled(),true)
 const unknown=work({status:'unknown',canStop:false})
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),{...value,status:'unknown',running:[unknown]})
 await page.getByRole('button',{name:'核对状态',exact:true}).click()
 await page.getByRole('button',{name:'预览报告.md',exact:true}).click();await page.getByRole('button',{name:'下载报告.md',exact:true}).click()
 assert.deepEqual((await page.evaluate(()=>(window as any).overviewFixture.calls)).slice(2),[['reconcile',unknown],['preview',artifact],['download',artifact]])
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
 const disconnected=work({id:'job:offline',jobId:'offline'})
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),{...value,running:[disconnected]})
 await page.getByRole('button',{name:'停止核对表格格式',exact:true}).click();await page.evaluate(()=>(window as any).overviewFixture.rejectStop())
 await page.getByText('状态未知',{exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'停止核对表格格式',exact:true}).count(),0,'失联后不重复发送停止')
 assert.equal(await page.getByRole('button',{name:'核对状态',exact:true}).isVisible(),true)
 assert.equal(await page.getByText('已停止',{exact:true}).count(),0)
})

test('资源详情使用当前轮次真实执行者、查询与来源，拒绝主动链接并在返回后恢复触发处焦点及输入',async t=>{
 const value={...empty(),artifacts:Array.from({length:12},(_,index)=>({id:'file:'+index,sessionId:'parent',path:'output/'+index+'.md',label:'记录'+index+'.md',kind:'markdown',status:'draft'})),usageGroups:[{id:'search',kind:'search',name:'网页搜索',evidence:[{id:'search:1',sessionId:'researcher',executorId:'researcher',executorName:'资料研究员',seq:3,callId:'call-1',timestamp:1791360000000,status:'completed',queries:['产品交付清单规范'],sources:[{url:'https://example.test/guide',title:'交付清单规范'},{url:'javascript:alert(1)',title:'不可信主动地址'}]}]}]},page=await pageFor(t,value)
 const builtin=[['bash','命令执行'],['fs','文件操作'],['present','成果交付']] as const
 const groups=builtin.map(([module])=>({id:module,kind:'plugin',provider:'@deepseek-ai/dsh-tool-'+module,name:'tool-'+module,evidence:[{id:module+':1',sessionId:'parent',executorId:'parent',seq:30,timestamp:1791360000000,status:'completed',toolName:module}]}))
 const custom={...groups[0],id:'custom',provider:'@vendor/custom',name:'tool-bash'}
 const mcp={...groups[1],id:'mcp',kind:'mcp',name:'本人文件连接'}
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),{...value,usageGroups:[...value.usageGroups,...groups,custom,mcp]})
 for(const [,label] of builtin)assert.equal(await page.getByRole('button',{name:new RegExp('^'+label+' ')}).count(),1)
 assert.equal(await page.getByRole('button',{name:/^tool-bash /}).count(),1,'同名第三方插件保留其真实名称，不冒充内置来源')
 assert.equal(await page.getByRole('button',{name:/^本人文件连接 /}).count(),1,'MCP 不按相似 provider 字符串被改成文件操作')
 await page.getByRole('button',{name:/^文件操作 /}).click()
 assert.equal(await page.getByRole('heading',{name:'文件操作',exact:true}).count(),1)
 await page.getByRole('button',{name:'返回工作概览',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).overviewFixture.snapshot.usageGroups),[...value.usageGroups,...groups,custom,mcp],'显示名称不改原始来源、分组或执行证据')
 const resource=page.getByRole('button',{name:/网页搜索/})
 await resource.scrollIntoViewIfNeeded()
 const scroll=await page.locator('aside > section > div').first().evaluate((node:any)=>node.scrollTop)
 assert.ok(scroll>0,'打开来源前概览已滚到真实资源入口')
 await resource.click()
 assert.equal(await page.getByText('资料研究员',{exact:true}).isVisible(),true)
 assert.equal(await page.getByText('产品交付清单规范',{exact:true}).isVisible(),true)
 assert.equal(await page.getByRole('link',{name:'交付清单规范',exact:true}).getAttribute('href'),'https://example.test/guide')
 assert.equal(await page.getByRole('link',{name:'不可信主动地址',exact:true}).count(),0)
 await page.getByRole('button',{name:'返回工作概览',exact:true}).press('Escape')
 assert.equal(await resource.evaluate((node:any)=>node===document.activeElement),true)
 assert.equal(await page.locator('aside > section > div').first().evaluate((node:any)=>node.scrollTop),scroll)
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
 await resource.click();await page.getByRole('button',{name:'返回工作概览',exact:true}).click()
 assert.equal(await resource.evaluate((node:any)=>node===document.activeElement),true)
})
