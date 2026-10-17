import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const evidence=process.env.TELOA_ASSISTANT_COMPANION_EVIDENCE
const screenshotPath=(name:string)=>join(evidence??temp,name)
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {AssistantCompanion} from '${client}AssistantCompanion.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale==='en'?'en':'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.companionFixture={conversations:0,attention:0,fail:false,hold:false,release:null};
// 小窗端口夹具只模拟 assistant-mini-chat 公开快照；桥接到 DSH 原会话的行为由 assistant-mini-chat.test.ts 覆盖。
const chatListeners=new Set();let chatSnapshot={phase:'closed',messages:[],running:false,waiting:false,hasMore:false,loadingOlder:false,agentFailed:false,draft:'',sending:false,sendFailed:false};
f.chat={opens:0,closes:0,sends:[],handoffs:0,handoff:'applied',older:0,seed:{}};f.setChat=patch=>{chatSnapshot={...chatSnapshot,...patch};for(const listener of [...chatListeners])listener()};
const chatPort={subscribe:listener=>{chatListeners.add(listener);return()=>chatListeners.delete(listener)},getSnapshot:()=>chatSnapshot,
 open(){f.chat.opens++;f.setChat({phase:'ready',sessionId:'assistant',...f.chat.seed})},close(){f.chat.closes++;f.setChat({phase:'closed'})},setDraft(text){f.setChat({draft:text})},
 async send(){const text=chatSnapshot.draft.trim();f.chat.sends.push(text);f.setChat({sending:true});await new Promise(resolve=>{if(f.chat.holdSend)f.chat.releaseSend=resolve;else setTimeout(resolve,20)});if(f.chat.failSend){f.setChat({sending:false,sendFailed:true});return false}f.setChat({sending:false,sendFailed:false,draft:'',messages:[...chatSnapshot.messages,{key:'sent-'+f.chat.sends.length,role:'user',text,state:'sending',images:0}]});return true},
 async loadOlder(){f.chat.older++},handoffDraft(){f.chat.handoffs++;const result=chatSnapshot.draft.trim()?f.chat.handoff:'empty';if(result==='applied')f.setChat({draft:''});return result}};
const prefs=new Map();const storage={getItem:key=>prefs.get(key)??null,setItem:(key,value)=>prefs.set(key,value)};f.presentation=()=>JSON.parse(prefs.get('teloa.personal-assistant-presentation/v1')??'null');
function App(){const [activity,setActivity]=useState({status:"idle",pose:"standing"});f.updateActivity=status=>setActivity({status,pose:status==="processing"?"reading":status==="completed"?"celebrating":"standing"});const [generation,setGeneration]=useState(0);f.remount=()=>setGeneration(value=>value+1);const [active,setActive]=useState(false),[known,setKnown]=useState(true),[count,setCount]=useState(3);f.updateAttention=(known,count)=>{setKnown(known);setCount(count)};return <><button id="origin" onClick={()=>setActive(true)}>启用助手</button><AssistantCompanion key={generation} activity={activity} storage={storage} active={active} setActive={setActive} needCount={count} attentionKnown={known} openConversation={async()=>{f.conversations++;if(f.hold)await new Promise(resolve=>f.release=resolve);if(f.fail)throw Error('private diagnostic')}} chat={window.disableChat?undefined:chatPort} openAttention={()=>f.attention++} {...(window.enableVoice?{startCall:async()=>{f.calls=(f.calls||0)+1},voiceMessage:<button onClick={()=>f.messages=(f.messages||0)+1}>录制留言</button>}:{})}/></>}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-companion-'));if(evidence)await mkdir(evidence,{recursive:true});await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'CompanionFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,locale='zh-CN'){
 const page=await browser.newPage({viewport:{width:1000,height:700}}),errors:string[]=[]
 page.setDefaultTimeout(3000);page.on('pageerror',(e:Error)=>errors.push(e.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="'+locale+'"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:':root{--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-border:#ddd;--teloa-text:#242823;--teloa-muted:#63695f;--teloa-accent:#9e4226;--teloa-on-accent:#fff;--teloa-focus:#9e4226;--teloa-hover:#eee;--teloa-shadow:0 8px 28px #1b231a1f}body{margin:0;font-family:system-ui}'+styles})
 await page.addScriptTag({content:script});await page.locator('#origin').waitFor();return page
}
test('默认隐藏；显式开启和展开不抢焦点、不提供另一个输入框或模态界面',async t=>{
 const page=await mount(t)
 assert.equal(await page.locator('[data-assistant-companion]').count(),0)
 await page.locator('#origin').click()
 assert.equal(await page.locator('[data-assistant-companion]').count(),1)
 assert.equal(await page.locator('#origin').evaluate((el:HTMLElement)=>el===document.activeElement),true)
 await page.getByRole('button',{name:'折叠助手',exact:true}).click()
 await page.getByRole('button',{name:'展开助手',exact:true}).click()
 assert.equal(await page.getByRole('button',{name:'折叠助手',exact:true}).count(),1)
 assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.getByRole('textbox').count(),0)
 assert.equal(await page.getByRole('button',{name:'语音留言',exact:true}).count(),1)
 await page.screenshot({path:screenshotPath('expanded.png')})
})
for(const [locale,chat,attention,hide,dialog,input] of [
 ['zh-CN','继续对话','待你处理 · 3','隐藏助手','Teloa · 小窗对话','给 Teloa 发消息'],
 ['zh-Hant','繼續對話','待你處理 · 3','隱藏助理','Teloa · 小窗對話','給 Teloa 傳訊息'],
 ['en','Continue conversation','Needs you · 3','Hide assistant','Teloa · Quick chat','Message Teloa'],
] as const)test(locale+' 会话图标打开原主聊小窗而非跳转完整会话；待处理入口不变，隐藏只释放小窗',async t=>{
 const page=await mount(t,locale);await page.locator('#origin').click()
 await page.getByRole('button',{name:chat,exact:true}).click()
 const quick=page.getByRole('dialog',{name:dialog,exact:true});await quick.waitFor()
 assert.equal(await quick.getAttribute('aria-modal'),'false')
 assert.equal(await page.getByRole('button',{name:chat,exact:true}).getAttribute('aria-expanded'),'true')
 assert.equal(await quick.getByRole('textbox',{name:input,exact:true}).isEditable(),true)
 await page.getByRole('button',{name:attention,exact:true}).click()
 await page.getByRole('button',{name:hide,exact:true}).click()
 assert.equal(await page.locator('[data-assistant-companion]').count(),0)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).companionFixture;return [f.conversations,f.attention,f.chat.opens,f.chat.closes]}),[0,1,1,1])
})
test('待处理未知不显示假零；打开完整会话失败在小窗内提示，忙时防止重复打开且可隐藏',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 await page.evaluate(()=>(window as any).companionFixture.updateAttention(false,0))
 await page.getByRole('button',{name:'正在核对待处理',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'正在核对待处理',exact:true}).isDisabled(),true)
 await page.getByRole('button',{name:'继续对话',exact:true}).click()
 const quick=page.getByRole('dialog',{name:'Teloa · 小窗对话'}),full=quick.getByRole('button',{name:'打开完整会话',exact:true})
 await page.evaluate(()=>(window as any).companionFixture.fail=true)
 await full.click();await quick.getByRole('alert').waitFor()
 assert.equal(await quick.getByRole('alert').innerText(),'暂时无法打开原会话，请再试一次。')
 assert.equal(await quick.count(),1,'失败后小窗与草稿保留')
 await page.evaluate(()=>{const f=(window as any).companionFixture;f.fail=false;f.hold=true})
 await full.click()
 assert.equal(await full.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'继续对话',exact:true}).isDisabled(),true)
 await page.getByRole('button',{name:'隐藏助手',exact:true}).click()
 await page.evaluate(()=>(window as any).companionFixture.release())
 assert.equal(await page.locator('[data-assistant-companion]').count(),0)
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.conversations),2)
})
test('独立手柄支持键盘和指针移动；拖动、展开及缩小视口均保持可操作范围',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 const box=page.locator('[data-assistant-companion]'),handle=page.getByRole('button',{name:'移动小松鼠，点击发消息',exact:true})
 await handle.focus();const before=await box.boundingBox();await page.keyboard.press('ArrowLeft')
 await page.waitForFunction((x:number)=>document.querySelector('[data-assistant-companion]')!.getBoundingClientRect().x<x,before.x)
 const origin=await handle.boundingBox();await page.mouse.move(origin.x+origin.width/2,origin.y+origin.height/2);await page.mouse.down();await page.mouse.move(20,20,{steps:4});await page.mouse.up()
 const moved=await box.boundingBox();assert.ok(moved.x<before.x-100);assert.ok(moved.y<before.y-100)
 await page.setViewportSize({width:260,height:220})
 await page.waitForFunction(()=>{const r=document.querySelector('[data-assistant-companion]')!.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:screenshotPath('small.png')})
 await page.getByRole('button',{name:'继续对话',exact:true}).click()
 const quick=page.getByRole('dialog',{name:'Teloa · 小窗对话'}),rect=await quick.boundingBox()
 assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=260&&rect.y+rect.height<=220,'窄视口小窗完整可见')
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.conversations),0)
 await quick.getByRole('button',{name:'关闭小窗',exact:true}).click()
 await page.getByRole('button',{name:'隐藏助手',exact:true}).click()
})

test('定稿是透明120px全身宠物；直接拖拽角色不打开小窗，点击角色打开原主聊小窗',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 const pet=page.getByRole('button',{name:'移动小松鼠，点击发消息',exact:true}),box=page.locator('[data-assistant-companion]')
 assert.equal(await box.evaluate((el:HTMLElement)=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)')
 assert.equal(Math.round((await pet.boundingBox()).width),120)
 const rect=await pet.boundingBox()
 await page.mouse.move(rect.x+60,rect.y+60);await page.mouse.down();await page.mouse.move(rect.x-160,rect.y-120,{steps:6});await page.mouse.up()
 assert.equal(await page.getByRole('dialog').count(),0)
 await pet.click()
 await page.getByRole('dialog',{name:'Teloa · 小窗对话'}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.conversations),0)
})

test('既有表情图可选择，媒体未接通明确告知且不启动麦克风、不伪造工作状态',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 await page.getByRole('button',{name:'选择小松鼠表情',exact:true}).click()
 const before=await page.locator('[data-assistant-pet]').getAttribute('src')
 await page.getByRole('button',{name:'眨眼',exact:true}).click()
 assert.notEqual(await page.locator('[data-assistant-pet]').getAttribute('src'),before)
 await page.getByRole('button',{name:'语音留言',exact:true}).click()
 await page.getByRole('status').filter({hasText:'语音留言暂不可用'}).waitFor()
 await page.getByRole('button',{name:'实时通话',exact:true}).click()
 await page.getByRole('status').filter({hasText:'实时通话暂不可用'}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.conversations),0)
 assert.equal(await page.getByText('正在聆听',{exact:true}).count(),0)
})


test('位置、表情和收起偏好恢复；窄视口的表情页可达且Escape只关闭自身',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 const pet=page.getByRole('button',{name:'移动小松鼠，点击发消息',exact:true})
 await pet.press('ArrowLeft');await pet.press('ArrowUp')
 const original=await page.locator('[data-assistant-companion]').boundingBox()
 await page.getByRole('button',{name:'选择小松鼠表情',exact:true}).click()
 await page.getByRole('button',{name:'吃瓜',exact:true}).click()
 const image=await page.locator('[data-assistant-pet]').getAttribute('src')
 await page.getByRole('button',{name:'折叠助手',exact:true}).click()
 await page.evaluate(()=>(window as any).companionFixture.remount())
 await page.getByRole('button',{name:'展开助手',exact:true}).waitFor()
 await page.getByRole('button',{name:'展开助手',exact:true}).click()
 assert.equal(await page.locator('[data-assistant-pet]').getAttribute('src'),image)
 const restored=await page.locator('[data-assistant-companion]').boundingBox()
 assert.equal(restored.x,original.x);assert.equal(restored.y,original.y)
 await page.setViewportSize({width:260,height:220})
 await page.getByRole('button',{name:'选择小松鼠表情',exact:true}).click()
 const region=page.getByRole('region',{name:'小松鼠表情',exact:true})
 const rect=await region.boundingBox();assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=260&&rect.y+rect.height<=220)
 await region.getByRole('button',{name:'眨眼',exact:true}).focus();await page.keyboard.press('Escape')
 assert.equal(await region.count(),0)
 assert.equal(await page.locator('[data-assistant-companion]').count(),1)
})

test('打开面板后直接Escape只关闭小松鼠面板，焦点回到实际发起按钮',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 await page.evaluate(()=>{(window as any).escaped=0;document.addEventListener('keydown',event=>{if(event.key==='Escape')(window as any).escaped++})})
 for(const name of ['选择小松鼠表情','语音留言','实时通话']){
  const trigger=page.getByRole('button',{name,exact:true});await trigger.click()
  assert.equal(await page.locator('[data-assistant-companion] [role=region]').count(),1)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('[data-assistant-companion] [role=region]').count(),0)
  assert.equal(await trigger.evaluate((el:HTMLElement)=>el===document.activeElement),true)
 }
 assert.equal(await page.evaluate(()=>(window as any).escaped),0)
 await page.getByRole('button',{name:'实时通话',exact:true}).click()
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 assert.equal(await page.getByRole('button',{name:'实时通话',exact:true}).evaluate((el:HTMLElement)=>el===document.activeElement),true)
})

async function installComposer(page:any,right=28){
 await page.evaluate((right:number)=>{const main=document.createElement('main');main.innerHTML='<div id="review-composer" style="position:fixed;bottom:28px;left:240px;right:'+right+'px;padding:12px;box-sizing:border-box;background:white"><textarea aria-label="Original draft" style="width:100%;height:50px;box-sizing:border-box">原输入草稿</textarea><div style="display:flex;justify-content:flex-end"><button id="review-send" style="width:40px;height:40px" type="button">Send</button></div></div>';document.body.append(main);document.querySelector('#review-send')!.addEventListener('click',()=>{(window as any).sent=((window as any).sent??0)+1})},right)
}
const sendReachable=()=>{const send=document.querySelector('#review-send')!,r=send.getBoundingClientRect();return send.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}
test('默认浮动助手避开原输入框及发送按钮，点击发送不被助手截获',async t=>{
 const page=await mount(t);await installComposer(page);await page.locator('#origin').click()
 assert.equal(await page.evaluate(sendReachable),true,'发送按钮中心必须命中原控件')
 await page.locator('#review-send').click();assert.equal(await page.evaluate(()=>(window as any).sent),1)
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.conversations),0)
 assert.equal(await page.getByRole('textbox',{name:'Original draft'}).inputValue(),'原输入草稿')
})
test('并栏布局变化临时避让原输入，恢复后回到用户位置且不改其已保存偏好',async t=>{
 const page=await mount(t);await installComposer(page,300);await page.locator('#origin').click()
 const pet=page.getByRole('button',{name:'移动小松鼠，点击发消息',exact:true});await pet.press('ArrowUp')
 const position=await page.locator('[data-assistant-companion]').boundingBox(),preference=await page.evaluate(()=>(window as any).companionFixture.presentation().position)
 await page.evaluate(()=>{(document.querySelector('#review-composer') as HTMLElement).style.right='28px'})
 await page.waitForFunction(sendReachable)
 assert.deepEqual(await page.evaluate(()=>(window as any).companionFixture.presentation().position),preference,'布局临时避让不能覆盖用户拖拽偏好')
 await page.evaluate(()=>{(document.querySelector('#review-composer') as HTMLElement).style.right='300px'})
 await page.waitForFunction((point:{x:number;y:number})=>{const r=document.querySelector('[data-assistant-companion]')!.getBoundingClientRect();return r.x===point.x&&r.y===point.y},position)
 assert.equal(await page.getByRole('textbox',{name:'Original draft'}).inputValue(),'原输入草稿')
})

 test('自动姿态跟随真实状态呈现，手动表情可回自动，减少动态效果保留状态',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 const pet=page.locator('[data-assistant-pet]'),root=page.locator('[data-assistant-companion]')
 for(const [status,pose] of [['idle','站立'],['processing','阅读'],['completed','庆祝'],['stopped','站立'],['failed','站立'],['unknown','站立']]){
  await page.evaluate((status:string)=>(window as any).companionFixture.updateActivity(status),status)
  await page.waitForFunction((status:string)=>document.querySelector('[data-assistant-companion]')?.getAttribute('data-activity')===status,status)
  assert.equal(await pet.getAttribute('alt'),pose)
  if(status==='processing'||status==='completed')await page.screenshot({path:screenshotPath('assistant-'+status+'.png')})
 }
 await page.getByRole('button',{name:'选择小松鼠表情',exact:true}).click();await page.getByRole('button',{name:'眨眼',exact:true}).click()
 await page.evaluate(()=>(window as any).companionFixture.updateActivity('processing'))
 assert.equal(await pet.getAttribute('alt'),'眨眼');assert.equal(await root.getAttribute('data-pose-mode'),'manual')
 await page.getByRole('button',{name:'选择小松鼠表情',exact:true}).click();await page.getByRole('button',{name:'自动跟随工作',exact:true}).click()
 assert.equal(await pet.getAttribute('alt'),'阅读');assert.equal(await root.getAttribute('data-pose-mode'),'auto')
 await page.emulateMedia({reducedMotion:'reduce'})
 assert.equal(await pet.evaluate((el:HTMLElement)=>getComputedStyle(el).animationName),'none')
 assert.equal(await page.getByRole('status').innerText(),'正在处理')
 })

test('语音入口连接实际客户端端口，关闭与隐藏面板不挂断持续通话',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{(window as any).enableVoice=true;(window as any).companionFixture.remount()})
 await page.getByRole('button',{name:'启用助手',exact:true}).click()
 await page.getByRole('button',{name:'实时通话',exact:true}).click()
 await page.waitForFunction(()=>(window as any).companionFixture.calls===1)
 await page.getByRole('button',{name:'语音留言',exact:true}).click()
 await page.getByRole('button',{name:'录制留言',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.messages),1)
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.calls),1)
})

const seedHistory=[{key:'u1',role:'user',text:'帮我整理今天的待办',state:'sent',images:0},{key:'a1',role:'assistant',text:'已整理三项：回复客户、核对报价、准备周会。\n\n**优先**处理报价 ![跟踪](https://tracker.invalid/pixel.png)',state:'sent',images:0}]
test('小窗读取同一原主聊历史；Enter 发送、Shift+Enter 换行、输入法组合不误发，回复进入同一窗口',async t=>{
 const page=await mount(t)
 await page.evaluate((messages:unknown)=>{(window as any).companionFixture.chat.seed={messages}},seedHistory)
 await page.locator('#origin').click();await page.getByRole('button',{name:'继续对话',exact:true}).click()
 const quick=page.getByRole('dialog',{name:'Teloa · 小窗对话'}),input=quick.getByRole('textbox',{name:'给 Teloa 发消息',exact:true})
 await quick.getByText('已整理三项：回复客户、核对报价、准备周会。').waitFor()
 assert.equal(await quick.locator('strong').filter({hasText:'优先'}).count(),1,'助手回复按 Markdown 呈现');assert.equal(await quick.locator('img[src*="tracker.invalid"]').count(),0,'模型回复中的远程图片不加载')
 assert.equal(await input.evaluate((el:HTMLElement)=>el===document.activeElement),true,'打开小窗后焦点进入输入框')
 assert.equal(await quick.getByRole('button',{name:'发送',exact:true}).isDisabled(),true,'空草稿不能发送')
 await input.fill('第一行');await input.press('Shift+Enter');await input.pressSequentially('第二行')
 assert.equal(await input.inputValue(),'第一行\n第二行')
 await input.evaluate((el:HTMLElement)=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})))
 assert.deepEqual(await page.evaluate(()=>(window as any).companionFixture.chat.sends),[],'输入法组合中的回车不发送')
 await page.evaluate(()=>(window as any).companionFixture.chat.holdSend=true)
 await input.press('Enter')
 await page.waitForFunction(()=>document.querySelector('[data-assistant-mini-chat] textarea')?.hasAttribute('disabled'))
 await page.waitForFunction(()=>(window as any).companionFixture.chat.sends.length===1)
 assert.equal(await input.isDisabled(),true,'宿主回执前锁定草稿')
 await page.evaluate(()=>(window as any).companionFixture.chat.releaseSend())
 await quick.locator('[data-state=sending]').waitFor();assert.equal(await input.inputValue(),'')
 assert.deepEqual(await page.evaluate(()=>(window as any).companionFixture.chat.sends),['第一行\n第二行'])
 await page.evaluate((messages:unknown[])=>(window as any).companionFixture.setChat({running:true,messages:[...messages,{key:'u2',role:'user',text:'第一行\n第二行',state:'sent',images:0}]}),seedHistory)
 await quick.getByText('正在处理…').waitFor()
 await page.evaluate((messages:unknown[])=>(window as any).companionFixture.setChat({running:true,messages:[...messages,{key:'u2',role:'user',text:'第一行\n第二行',state:'sent',images:0},{key:'live',role:'assistant',text:'收到，正在',state:'streaming',images:0}]}),seedHistory)
 await quick.getByText('收到，正在').waitFor();assert.equal(await quick.getByText('正在处理…').count(),0);assert.equal(await quick.getByRole('log').getAttribute('aria-busy'),'true')
 await page.evaluate((messages:unknown[])=>(window as any).companionFixture.setChat({running:false,messages:[...messages,{key:'u2',role:'user',text:'第一行\n第二行',state:'sent',images:0},{key:'a2',role:'assistant',text:'收到，正在处理这两项。',state:'sent',images:0}]}),seedHistory)
 await quick.getByText('收到，正在处理这两项。').waitFor()
 await page.screenshot({path:screenshotPath('mini-chat-zh-CN.png')})
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.conversations),0,'小窗发送不跳完整会话')
})
test('关闭小窗只释放读取并保留草稿；外部点击不关闭，Escape 与关闭按钮回到入口；拖动角色时小窗跟随',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 const trigger=page.getByRole('button',{name:'继续对话',exact:true});await trigger.click()
 const quick=page.getByRole('dialog',{name:'Teloa · 小窗对话'}),input=quick.getByRole('textbox',{name:'给 Teloa 发消息',exact:true})
 await input.fill('还没想好怎么说')
 await page.mouse.click(400,300);assert.equal(await quick.count(),1,'等待回复时页面操作不关闭小窗')
 await input.press('Escape');assert.equal(await quick.count(),0)
 assert.equal(await trigger.evaluate((el:HTMLElement)=>el===document.activeElement),true)
 await trigger.click();assert.equal(await input.inputValue(),'还没想好怎么说','重开后保留原草稿')
 await quick.getByRole('button',{name:'关闭小窗',exact:true}).click();assert.equal(await quick.count(),0)
 assert.equal(await trigger.evaluate((el:HTMLElement)=>el===document.activeElement),true)
 await trigger.click();const before=await quick.boundingBox()
 const pet=page.getByRole('button',{name:'移动小松鼠，点击发消息',exact:true}),rect=await pet.boundingBox()
 await page.mouse.move(rect.x+60,rect.y+60);await page.mouse.down();await page.mouse.move(rect.x-200,rect.y+60,{steps:5});await page.mouse.up()
 assert.equal(await quick.count(),1,'拖动角色不关闭小窗');assert.ok((await quick.boundingBox()).x<before.x-100,'小窗跟随角色')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).companionFixture;return [f.chat.opens,f.chat.closes,f.conversations,f.chat.sends.length]}),[3,2,0,0])
})
test('打开完整会话：成功后由原生输入接管草稿并关闭小窗；原生已有草稿时保留小窗草稿并说明',async t=>{
 const page=await mount(t);await page.locator('#origin').click()
 await page.getByRole('button',{name:'继续对话',exact:true}).click()
 const quick=page.getByRole('dialog',{name:'Teloa · 小窗对话'}),input=quick.getByRole('textbox',{name:'给 Teloa 发消息',exact:true})
 await input.fill('转到完整会话继续');await quick.getByRole('button',{name:'打开完整会话',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[data-assistant-mini-chat]')===null)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).companionFixture;return [f.conversations,f.chat.handoffs,f.chat.sends.length]}),[1,1,0])
 await page.evaluate(()=>(window as any).companionFixture.chat.handoff='preserved')
 await page.getByRole('button',{name:'继续对话',exact:true}).click();await input.fill('原生已有另一份草稿')
 await quick.getByRole('button',{name:'打开完整会话',exact:true}).click()
 await quick.getByText('完整会话已有草稿，这里的草稿已保留。').waitFor()
 assert.equal(await input.inputValue(),'原生已有另一份草稿')
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.conversations),2)
})
test('核对、载入、尚无主聊、断线、读取失败、等待确认、输入阻断与发送失败均给出准确状态',async t=>{
 const page=await mount(t);await page.locator('#origin').click();await page.getByRole('button',{name:'继续对话',exact:true}).click()
 const quick=page.getByRole('dialog',{name:'Teloa · 小窗对话'}),input=quick.getByRole('textbox',{name:'给 Teloa 发消息',exact:true}),send=quick.getByRole('button',{name:'发送',exact:true})
 const set=(patch:object)=>page.evaluate((value:object)=>(window as any).companionFixture.setChat(value),patch)
 await set({phase:'checking',sessionId:null});await quick.getByText('正在核对原助手会话…').waitFor();assert.equal(await input.isDisabled(),true)
 await set({phase:'missing'});await quick.getByText('还没有和 Teloa 的主聊。打开完整会话开始第一次对话。').waitFor()
 assert.equal(await quick.getByRole('button',{name:'打开完整会话',exact:true}).count(),2);assert.equal(await input.isDisabled(),true)
 await set({phase:'loading',sessionId:'assistant'});await quick.getByText('正在载入原对话…').waitFor();assert.equal(await input.isEditable(),true,'载入期间可先写草稿')
 await input.fill('先写下');assert.equal(await send.isDisabled(),true,'未就绪不能发送')
 await set({phase:'offline'});await quick.getByText('本机服务未连接，恢复后会继续显示。草稿已保留。').waitFor();assert.equal(await input.inputValue(),'先写下')
 await set({phase:'unavailable'});await quick.getByRole('alert').filter({hasText:'暂时无法读取原对话。'}).waitFor()
 await quick.getByRole('button',{name:'重试',exact:true}).click();assert.equal(await page.evaluate(()=>(window as any).companionFixture.chat.opens),2)
 await set({phase:'ready',messages:[]});await quick.getByText('这是你和 Teloa 的主聊，发条消息开始吧。').waitFor();assert.equal(await send.isDisabled(),false)
 await set({waiting:true});await quick.getByText('需要你确认后才能继续，请在完整会话中处理。').waitFor()
 await set({waiting:false,block:'原生输入暂不可用：能力核对中'});await quick.getByText('原生输入暂不可用：能力核对中').waitFor();assert.equal(await send.isDisabled(),true)
 await set({block:null});await page.evaluate(()=>(window as any).companionFixture.chat.failSend=true)
 await send.click();await quick.getByRole('alert').filter({hasText:'未发送，草稿已保留，请重试。'}).waitFor();assert.equal(await input.inputValue(),'先写下')
 await set({sendFailed:false,agentFailed:true});await quick.getByText('上一轮未能完成，可在完整会话查看详情。').waitFor()
 await set({agentFailed:false,hasMore:true,messages:seedHistory});await quick.getByRole('button',{name:'加载更早消息',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.chat.older),1)
 await set({messages:[{key:'img',role:'user',text:'看这张图',state:'queued',images:2}]});await quick.getByText('含 2 张图片，可在完整会话查看').waitFor();await quick.getByText('排队中，当前回复结束后处理').waitFor()
})
test('未接入小窗端口时会话图标保留原完整会话行为，不出现空壳小窗',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{(window as any).disableChat=true;(window as any).companionFixture.remount()})
 await page.locator('#origin').click();await page.getByRole('button',{name:'继续对话',exact:true}).click()
 assert.equal(await page.getByRole('dialog').count(),0)
 assert.equal(await page.evaluate(()=>(window as any).companionFixture.conversations),1)
})
