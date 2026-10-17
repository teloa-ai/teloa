import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('分身档案使用有名称的图标动作，代拟保存与页签草稿保持原路径',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-twin-actions-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {ObjectConversations} from ${JSON.stringify(join(client,'ObjectConversations.tsx'))};import {TwinProfile} from ${JSON.stringify(join(client,'TwinProfile.tsx'))};import {ContextDrawer} from ${JSON.stringify(join(client,'ContextDrawer.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};import pageCss from ${JSON.stringify(join(client,'TaskPage.module.css'))};import teamCss from ${JSON.stringify(join(client,'TeamPage.module.css'))};import {prototypeThemes} from ${JSON.stringify(join(root,'packages/client/ui-workbench/src/brand/prototype-theme.ts'))};
 document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const rows=Array.from({length:14},(_,index)=>({id:'30000000-0000-4000-8000-'+String(index).padStart(12,'0'),ownerId:'preview',title:index===0?'原会话':'待关联会话 '+index,scopeIds:['general'],version:1,status:'ready',sessionId:'preview-'+index,requestedSessionId:'preview-'+index,createdAt:'2026-10-14T08:00:00Z'})),directory={rows},managed={archived:[]},work={subscribe:()=>()=>{},getDirectorySnapshot:()=>directory,refreshDirectory:async()=>{}},management={subscribe:()=>()=>{},getSnapshot:()=>managed},useSessions=select=>select({byId:{}});
 const evidence=window.twinActions={calls:[],fail:true};function App(){const [draft,update]=useState(),[role,setRole]=useState({id:'account-twin',name:'我的分身',kind:'twin',state:'active',version:3,scopes:['general'],skills:[],knowledge:[],memories:[],history:[]});return <I18nProvider runtime={i18n}><ContextDrawer title="Max 的分身" close={()=>{}}><div className={pageCss.page+' '+teamCss.teamPage}><article className={pageCss.detail+' '+teamCss.roleDetail}><TwinProfile profileName="Max" profileInitials="ML" role={role} draft={draft} update={update} save={command=>{evidence.calls.push(command);setRole({...role,version:4,draft:{body:command.body,version:4,editorId:'self',updatedAt:'2026-10-15T00:00:00Z'}});return true}} talk={async()=>{evidence.calls.push({type:'talk',roleId:role.id});if(evidence.fail)throw {code:'teloa/source-unavailable'}}} conversations={<ObjectConversations object={{kind:'role',id:role.id,title:'Max 的分身',version:role.version,canStart:true}} links={[{kind:'role',objectId:role.id,objectVersion:role.version,conversationId:rows[0].id,sessionId:rows[0].sessionId}]} work={work} management={management} useSessions={useSessions} open={async()=>{}} link={async()=>{}} unlink={async()=>{}} create={()=>{}}/>} samples={<p>已确认样本</p>} habits={<p>习惯日志</p>}/></article></div></ContextDrawer></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'TwinActions',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/twin-actions'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/twin-actions');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const talk=page.getByRole('button',{name:'找它说话',exact:true});await talk.waitFor()
 assert.equal(await talk.innerText(),'','对话是带名称与提示的图标，不再占一整行文字按钮')
 assert.equal(await talk.getAttribute('title'),'找它说话');assert.equal((await talk.boundingBox())!.width,32,'沿用统一图标命中尺寸，父页面样式不能污染')
 assert.equal(await page.getByRole('heading',{name:/^Max 的分身/}).count(),2,'只保留抽屉标题与身份标题，不伪装成一条重复身份的聊天消息')
 assert.equal(await page.getByRole('region',{name:'关联会话',exact:true}).isVisible(),true,'关联列表直接显示，不再多套一层同名折叠')
 assert.deepEqual(await page.evaluate(()=>(window as any).twinActions.calls),[],'查看档案不发起会话或保存')
 await page.getByRole('button',{name:'关联会话',exact:true}).click()
 const picker=page.getByRole('dialog',{name:'关联会话',exact:true});await picker.waitFor()
 assert.equal(await picker.evaluate((element:HTMLElement)=>{const r=element.getBoundingClientRect(),target=document.elementFromPoint(r.x+20,r.bottom-10);return !!target&&element.contains(target)}),true,'选择器底部不能被档案正文的重复滚动容器裁切')
 await page.keyboard.press('Escape')
 await talk.click();await page.getByRole('alert').waitFor();await page.evaluate(()=>{(window as any).twinActions.fail=false});await talk.click();await page.getByRole('alert').waitFor({state:'detached'})
 await page.getByText('编辑代拟内容',{exact:true}).click();const input=page.getByRole('textbox',{name:'草稿内容',exact:true});await input.fill('请核对今天的交班事项。')
 await page.getByRole('tab',{name:'代拟工作',exact:true}).focus();await page.keyboard.press('ArrowRight');await page.getByText('已确认样本',{exact:true}).waitFor();await page.keyboard.press('ArrowLeft');assert.equal(await input.inputValue(),'请核对今天的交班事项。')
 await page.getByRole('button',{name:'保存',exact:true}).click()
 const calls=await page.evaluate(()=>(window as any).twinActions.calls);assert.deepEqual(calls.slice(0,2),[{type:'talk',roleId:'account-twin'},{type:'talk',roleId:'account-twin'}]);assert.equal(calls[2].type,'draft');assert.equal(calls[2].roleId,'account-twin');assert.equal(calls[2].expectedVersion,3);assert.equal(calls[2].body,'请核对今天的交班事项。')
 assert.deepEqual(errors,[])
})
