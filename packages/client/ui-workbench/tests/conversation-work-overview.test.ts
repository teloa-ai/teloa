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
 await history.evaluate((node:any)=>{(window as any).historyToggle=new Promise<void>(resolve=>node.addEventListener('toggle',()=>resolve(),{once:true}))})
 await history.locator('summary').click();await page.evaluate(()=>(window as any).historyToggle)
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount({...value,status:'completed'}),value)
 assert.notEqual(await history.getAttribute('open'),null,'展开状态已进入组件，正常同会话刷新仍保持选择')
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

test('较早真实轮次默认折叠，分别回看实际资源并保留来源、草稿与返回焦点',async t=>{
 const first={sessionId:'parent',turn:1,turns:[1],startSeq:1,startedAt:1791360000000,userMessageId:'first',userMessageSeq:2,endSeq:10,endedAt:1791360030000,status:'completed'}
 const second={sessionId:'parent',turn:1,turns:[1],startSeq:11,startedAt:1791360060000,userMessageId:'second',userMessageSeq:12,status:'unknown'}
 const current={sessionId:'parent',turn:2,turns:[2],startSeq:21,startedAt:1791360120000,userMessageId:'current',userMessageSeq:22,status:'running'}
 const usageHistory=[
  {round:first,usageGroups:[
   {id:'shared',kind:'mcp',name:'资料连接',provider:'test-mcp',evidence:[{id:'first:1',sessionId:'researcher',executorId:'researcher',executorName:'资料研究员',seq:3,resultSeq:4,callId:'first-call',timestamp:1791360010000,status:'completed',toolName:'mcp_search_documents'}]},
   {id:'skill',kind:'skill',name:'项目复盘',evidence:[{id:'first:skill',sessionId:'parent',executorId:'parent',executorName:'本机助理',seq:5,timestamp:1791360020000,status:'read',toolName:'read'}]},
  ]},
  {round:second,usageGroups:[
   {id:'shared',kind:'search',name:'网页搜索',provider:'test-web',evidence:[{id:'second:1',sessionId:'parent',executorId:'parent',executorName:'本机助理',seq:13,resultSeq:14,callId:'second-call',timestamp:1791360070000,status:'completed',toolName:'web_search',queries:['第二次工作的公开来源'],sources:[{url:'https://example.test/second',title:'第二次工作参考'}]}]},
   {id:'plugin',kind:'plugin',name:'表格校验',provider:'test-plugin',evidence:[{id:'second:plugin',sessionId:'parent',executorId:'parent',executorName:'本机助理',seq:15,resultSeq:16,callId:'plugin-call',timestamp:1791360080000,status:'completed',toolName:'validate_csv'}]},
  ]},
 ]
 const value={...empty(),status:'running',currentRound:current,artifacts:Array.from({length:12},(_,index)=>({id:'file:'+index,sessionId:'parent',path:'output/'+index+'.md',label:'记录'+index+'.md',kind:'markdown',status:'draft'})),usageGroups:[{id:'shared',kind:'plugin',name:'当前连接',provider:'current-plugin',evidence:[{id:'current:1',sessionId:'parent',executorId:'parent',executorName:'当前执行者',seq:23,timestamp:1791360130000,status:'completed',toolName:'current_tool'}]}],usageHistory}
 const page=await pageFor(t,value),history=page.locator('details').filter({has:page.getByText('资料连接',{exact:true})})
 assert.equal(await history.count(),1,'较早真实工作轮次必须有独立可展开入口')
 assert.equal(await history.getAttribute('open'),null)
 assert.equal(await page.getByRole('button',{name:/^资料连接 /}).isVisible(),false)
 assert.equal(await page.getByRole('button',{name:/^当前连接 /}).isVisible(),true)
 await history.locator('summary').click()
 assert.equal(await history.getByRole('heading',{name:'工作轮次 1',exact:true}).count(),2,'同一个真实宿主 turn 可有两个不同 human 工作范围')
 assert.deepEqual(await history.locator('time').evaluateAll((nodes:any[])=>nodes.map(node=>node.getAttribute('datetime'))),['2026-10-07T08:00:00.000Z','2026-10-07T08:01:00.000Z'])
 for(const name of ['项目复盘','表格校验'])assert.equal(await history.getByRole('button',{name:new RegExp('^'+name+' ')}).isVisible(),true)
 const resource=history.getByRole('button',{name:/^资料连接 /})
 await resource.scrollIntoViewIfNeeded()
 const scroll=await page.locator('aside > section > div').first().evaluate((node:any)=>node.scrollTop)
 await resource.click()
 assert.equal(await page.getByText('资料研究员',{exact:true}).isVisible(),true)
 assert.equal(await page.getByText('mcp_search_documents',{exact:true}).isVisible(),true)
 assert.equal(await page.getByText('子助手记录按启动轮次归档',{exact:true}).isVisible(),true)
 assert.equal(await page.getByText('当前执行者',{exact:true}).isVisible(),false,'相同分组身份不能取成当前轮的证据')
 assert.equal(await page.getByText(/^工作轮次 1 ·/).isVisible(),true)
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount({...value,status:'completed'}),value)
 assert.equal(await page.getByText('资料研究员',{exact:true}).isVisible(),true,'事实刷新不退出正在查看的历史详情')
 await page.getByRole('button',{name:'返回工作概览',exact:true}).press('Escape')
 assert.equal(await resource.evaluate((node:any)=>node===document.activeElement),true)
 assert.equal(await page.locator('aside > section > div').first().evaluate((node:any)=>node.scrollTop),scroll)
 assert.notEqual(await history.getAttribute('open'),null)
 await history.getByRole('button',{name:/^网页搜索 /}).click()
 assert.equal(await page.getByText('第二次工作的公开来源',{exact:true}).isVisible(),true)
 assert.equal(await page.getByText('子助手记录按启动轮次归档',{exact:true}).isVisible(),false,'父会话资源不重复展示子助手归档说明')
 assert.equal(await page.getByRole('link',{name:'第二次工作参考',exact:true}).getAttribute('href'),'https://example.test/second')
 assert.equal(await page.getByText('mcp_search_documents',{exact:true}).isVisible(),false)
 await page.getByRole('button',{name:'返回工作概览',exact:true}).click()
 assert.equal(await history.getByRole('button',{name:/^网页搜索 /}).evaluate((node:any)=>node===document.activeElement),true)
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
})

test('新增历史不抢开或夺取输入焦点，切换会话关闭旧详情并重新折叠历史',async t=>{
 const value=empty(),page=await pageFor(t,value),input=page.getByLabel('原任务输入')
 await input.fill('继续准备，尚未发送');await input.focus()
 const round={sessionId:'parent',turn:1,turns:[1],startSeq:1,startedAt:1791360000000,userMessageId:'first',userMessageSeq:2,endSeq:5,endedAt:1791360030000,status:'completed'}
 const group={id:'shared',kind:'plugin',name:'历史工具',provider:'past-plugin',evidence:[{id:'first:1',sessionId:'parent',executorId:'parent',executorName:'旧执行者',seq:3,resultSeq:4,callId:'first-call',timestamp:1791360010000,status:'completed',toolName:'old_tool'}]}
 const withHistory={...value,usageHistory:[{round,usageGroups:[group]}]}
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),withHistory)
 const history=page.locator('details').filter({has:page.getByText('历史工具',{exact:true})})
 assert.equal(await history.count(),1,'只有历史资源时仍能访问其真实工作记录')
 assert.equal(await history.getAttribute('open'),null)
 assert.equal(await input.evaluate((node:any)=>node===document.activeElement),true)
 await history.locator('summary').click();await history.getByRole('button',{name:/^历史工具 /}).click()
 assert.equal(await page.getByText('旧执行者',{exact:true}).isVisible(),true)
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),{...empty(),sessionId:'other',usageHistory:[{round:{...round,sessionId:'other',userMessageId:'other-first'},usageGroups:[{...group,evidence:[{...group.evidence[0],sessionId:'other',executorId:'other',executorName:'另一会话执行者',toolName:'other_tool'}]}]}]})
 assert.equal(await page.getByRole('button',{name:'返回工作概览',exact:true}).isVisible(),false)
 assert.equal(await page.getByText('旧执行者',{exact:true}).count(),0)
 assert.equal(await history.getAttribute('open'),null,'切会话不继承历史展开状态')
 await history.locator('summary').click();await history.getByRole('button',{name:/^历史工具 /}).click()
 assert.equal(await page.getByText('另一会话执行者',{exact:true}).isVisible(),true)
 assert.equal(await page.getByText('other_tool',{exact:true}).isVisible(),true)
 assert.equal(await input.inputValue(),'继续准备，尚未发送')
})

test('切换会话时复用资源行不能把焦点从输入移到另一会话',async t=>{
 const round={sessionId:'parent',turn:1,turns:[1],startSeq:1,startedAt:1791360000000,userMessageId:'first',userMessageSeq:2,status:'running'}
 const group={id:'shared',kind:'plugin',name:'文件连接',provider:'file-plugin',evidence:[{id:'first:1',sessionId:'parent',executorId:'parent',executorName:'旧执行者',seq:3,resultSeq:4,callId:'first-call',timestamp:1791360010000,status:'completed',toolName:'read'}]}
 const page=await pageFor(t,{...empty(),currentRound:round,usageGroups:[group]}),resource=page.getByRole('button',{name:/^文件连接 /}),trigger=await resource.elementHandle()
 await resource.click()
 const input=page.getByLabel('原任务输入');await input.fill('新会话准备中的输入');await input.focus()
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),{...empty(),sessionId:'other',currentRound:{...round,sessionId:'other',userMessageId:'other-first'},usageGroups:[{...group,evidence:[{...group.evidence[0],id:'other:1',sessionId:'other',executorId:'other',executorName:'新执行者'}]}]})
 assert.equal(await trigger!.evaluate((node:any)=>node.isConnected),true,'同group.id的当前资源行确实复用了真实DOM')
 assert.equal(await page.getByRole('button',{name:'返回工作概览',exact:true}).isVisible(),false)
 assert.equal(await input.evaluate((node:any)=>node===document.activeElement),true,'切会话只清旧详情，不能把焦点恢复到已复用的新会话资源按钮')
 assert.equal(await input.inputValue(),'新会话准备中的输入')
})

test('展开历史后经过空历史会话，返回原会话仍默认折叠',async t=>{
 const round={sessionId:'parent',turn:1,turns:[1],startSeq:1,startedAt:1791360000000,userMessageId:'first',userMessageSeq:2,endSeq:5,endedAt:1791360030000,status:'completed'}
 const group={id:'shared',kind:'plugin',name:'历史工具',provider:'past-plugin',evidence:[{id:'first:1',sessionId:'parent',executorId:'parent',executorName:'旧执行者',seq:3,resultSeq:4,callId:'first-call',timestamp:1791360010000,status:'completed',toolName:'old_tool'}]}
 const value={...empty(),usageHistory:[{round,usageGroups:[group]}]},page=await pageFor(t,value),history=page.locator('details').filter({has:page.getByText('历史工具',{exact:true})})
 await history.locator('summary').click();assert.notEqual(await history.getAttribute('open'),null)
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),{...empty(),sessionId:'other'})
 assert.equal(await page.locator('details').count(),0,'另一会话没有历史节点，不依赖其toggle事件清除旧选择')
 await page.evaluate((value:any)=>(window as any).overviewFixture.mount(value),value)
 assert.equal(await history.getAttribute('open'),null,'返回原会话不能恢复之前会话切换前的展开状态')
})
