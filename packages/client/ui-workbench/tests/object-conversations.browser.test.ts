import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('关联会话：图标动作、名称直接打开、紧凑搜索关联，只读与恢复语义保留',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-object-conversations-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useEffect,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
 import {ObjectConversations} from ${JSON.stringify(join(client,'ObjectConversations.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};import taskCss from ${JSON.stringify(join(client,'TaskPage.module.css'))};import {prototypeThemes} from ${JSON.stringify(join(root,'packages/client/ui-workbench/src/brand/prototype-theme.ts'))};
 document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const evidence=window.objectConversationsFixture={calls:[],failNext:false};
 const uuid=index=>'3f2a9c1e-0000-4000-8000-'+String(index).padStart(12,'0');
 const row=(index,title,createdAt='2026-10-14T08:00:00Z')=>({id:uuid(index),ownerId:'owner',title,scopeIds:['general'],version:1,status:'ready',requestedSessionId:'session-'+index,sessionId:'session-'+index,createdAt});
 const rows=[row(1,'原聊天'),row(2,'执行聊天'),row(3,'客户访谈','2026-10-12T08:00:00Z'),row(4,'客户访谈','2026-10-14T09:30:00Z'),row(5,'周报草稿'),row(6,'旧会话')];
 const directory={rows,error:undefined},work={subscribe:()=>()=>{},getDirectorySnapshot:()=>directory,refreshDirectory:async()=>{evidence.calls.push(['refresh'])}};
 const managed={archived:['session-6']},management={subscribe:()=>()=>{},getSnapshot:()=>managed};
 const useSessions=select=>select({byId:{}});
 const initial=[{kind:'task',objectId:'task',objectVersion:1,conversationId:uuid(1),sessionId:'session-1',sourceOnly:true},{kind:'task',objectId:'task',objectVersion:1,conversationId:uuid(2),sessionId:'session-2'}];
 function App(){
  const dialog=useRef(null),[links,setLinks]=useState(initial),[canStart,setCanStart]=useState(true),[pending,setPending]=useState(false),[objectId,setObjectId]=useState('task');
  useEffect(()=>{dialog.current.showModal();Object.assign(evidence,{setPending,setCanStart,setObjectId})},[]);
  const persistence={load:async()=>{},recover:async()=>{evidence.calls.push(['recover'])},pending,error:undefined};
  const link=conversation=>new Promise((resolve,reject)=>{evidence.calls.push(['link',conversation.id]);setTimeout(()=>{if(evidence.failNext){evidence.failNext=false;reject(Object.assign(Error('unavailable'),{code:'teloa/source-unavailable'}))}else{setLinks(value=>[...value,{kind:'task',objectId,objectVersion:1,conversationId:conversation.id,sessionId:conversation.sessionId}]);resolve()}},150)});
  return <I18nProvider runtime={i18n}><dialog ref={dialog} className={taskCss.dialog} aria-label="任务详情" style={{width:440}}><div className={taskCss.page}><h2>任务详情</h2>
   <button type="button" onClick={()=>setCanStart(value=>!value)}>切换只读</button><button type="button" onClick={()=>setPending(value=>!value)}>切换待核对</button><input aria-label="备注"/>
   <ObjectConversations object={{kind:'task',id:objectId,title:'任务',version:1,canStart}} links={links} work={work} management={management} useSessions={useSessions} persistence={persistence}
    prepare={async conversation=>{evidence.calls.push(['prepare',conversation.id])}} open={async id=>{evidence.calls.push(['open',id])}} unlink={async id=>{evidence.calls.push(['unlink',id]);setLinks(value=>value.filter(item=>item.conversationId!==id))}} link={link} create={()=>evidence.calls.push(['create'])}/>
  </div></dialog></I18nProvider>
 }
 createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ObjectConversationsTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/object-conversations'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/object-conversations');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const calls=():Promise<unknown[][]>=>page.evaluate(()=>(window as any).objectConversationsFixture.calls)
 const modal=page.getByRole('dialog',{name:'任务详情'});await modal.waitFor()
 const create=page.getByRole('button',{name:'新建关联会话',exact:true}),linkButton=page.getByRole('button',{name:'关联会话',exact:true})
 for(const action of [create,linkButton,page.getByRole('button',{name:'刷新会话',exact:true})])assert.equal((await action.innerText()).trim(),'','次要动作是带名称与提示的图标，不是大文字按钮')
 assert.equal(await page.getByRole('combobox').count(),0,'不再用整行下拉表单选择会话')
 // 真实任务页 .page/.dialog 的 button 规则不能把名称撑成带框按钮，图标保持 32px
 const nameStyle=await page.getByRole('button',{name:'原聊天',exact:true}).evaluate((node:HTMLElement)=>{const style=getComputedStyle(node);return [style.borderTopWidth,style.paddingTop,style.paddingLeft,style.textAlign].join(' ')})
 assert.equal(nameStyle,'0px 0px 0px left','名称是可点文本，不被任务页按钮样式覆盖')
 for(const action of [create,linkButton])assert.deepEqual(await action.evaluate((node:HTMLElement)=>[node.getBoundingClientRect().width,node.getBoundingClientRect().height]),[32,32])
 assert.equal(await page.getByRole('button',{name:'打开会话',exact:true}).count(),0,'名称本身就是打开入口')

 // 名称直接打开，键盘同样可用；原路由按会话标识
 await page.getByRole('button',{name:'原聊天',exact:true}).click()
 await page.getByRole('button',{name:'执行聊天',exact:true}).focus();await page.keyboard.press('Enter')
 assert.deepEqual((await calls()).filter(row=>row[0]==='open'),[['open','session-1'],['open','session-2']])
 const unlinkButtons=page.getByRole('button',{name:'解除关联',exact:true});assert.equal(await unlinkButtons.count(),2);assert.equal((await unlinkButtons.first().innerText()).trim(),'')
 const prepare=page.getByRole('button',{name:'准备任务上下文',exact:true});assert.equal(await prepare.count(),1,'创建来源只能打开或解除');assert.equal((await prepare.innerText()).trim(),'')
 await prepare.click();assert.deepEqual((await calls()).filter(row=>row[0]==='prepare'),[['prepare','3f2a9c1e-0000-4000-8000-000000000002']])

 // 权限边界按需展开，不删除
 assert.equal(await page.getByText('关联不会复制私人资料',{exact:false}).isVisible().catch(()=>false),false,'大段说明默认收起')
 const info=page.getByRole('button',{name:/不会授予员工执行权限/});assert.equal(await info.getAttribute('aria-expanded'),'false')
 await info.click();assert.equal(await info.getAttribute('aria-expanded'),'true');await page.getByText(/对象关联保存到本机.*不会授予员工执行权限/).waitFor()

 // 紧凑搜索弹层：真实标题+时间，无 UUID；排除已关联与已归档
 await linkButton.click();const popover=page.getByRole('dialog',{name:'关联会话',exact:true});await popover.waitFor()
 // 详情可能是窄并栏；浮层跟随当前组件宽度，不能沿浏览器宽度向相邻会话溢出。
 for(const width of [429,320]){
  await modal.evaluate((element:HTMLDialogElement,width:number)=>{element.style.width=width+'px'},width)
  const panel=await page.getByRole('region',{name:'关联会话',exact:true}).boundingBox(),popup=await popover.boundingBox()
  assert.ok(panel&&popup&&popup.x>=panel.x-1&&popup.x+popup.width<=panel.x+panel.width+1,'关联选择器必须完整留在当前详情栏内')
 }
 await modal.evaluate((element:HTMLDialogElement)=>{element.style.width='440px'})
 assert.equal(await page.evaluate(()=>(document.activeElement as HTMLInputElement|null)?.type),'search','打开后可直接输入查找')
 assert.equal(await page.getByRole('listbox').count()+await page.getByRole('option').count(),0,'候选是普通列表与原生按钮，不挂未实现键盘的 listbox')
 const options=popover.getByRole('list').getByRole('button');assert.equal(await options.count(),3)
 const texts:string[]=await options.allInnerTexts();assert.ok(texts.every(text=>!/3f2a9c1e|[0-9a-f]{8}-/.test(text)),texts.join('|'))
 assert.ok(!texts.some(text=>/原聊天|执行聊天|旧会话/.test(text)),'已关联与已归档不作为候选')
 const duplicates=texts.filter(text=>text.includes('客户访谈'));assert.equal(duplicates.length,2);assert.notEqual(duplicates[0],duplicates[1],'同名会话需要可区分的上下文')
 await page.keyboard.type('周报');assert.equal(await options.count(),1)
 await page.keyboard.press('Escape');assert.equal(await popover.count(),0);assert.ok(await modal.isVisible(),'Escape 只关闭弹层，不关闭所在详情')
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'关联会话','关闭后焦点回到入口')
 await linkButton.click();await popover.waitFor();assert.equal(await popover.getByRole('searchbox').inputValue(),'周报','未提交的查找词再次打开时保留')
 // 拖出与指针取消不误关；外点关闭并保留点击目标焦点
 const heading=page.getByRole('heading',{name:'任务详情'}),searchBox=await popover.getByRole('searchbox').boundingBox(),headingBox=await heading.boundingBox()
 await page.mouse.move(searchBox!.x+10,searchBox!.y+10);await page.mouse.down();await page.mouse.move(headingBox!.x+5,headingBox!.y+5);await page.mouse.up()
 assert.equal(await popover.count(),1,'在弹层内按下、拖到外面松开不关闭')
 await heading.evaluate((node:HTMLElement)=>{const init={bubbles:true,composed:true,pointerId:7};node.dispatchEvent(new PointerEvent('pointerdown',init));node.dispatchEvent(new PointerEvent('pointercancel',init));node.dispatchEvent(new PointerEvent('pointerup',init))})
 assert.equal(await popover.count(),1,'指针取消后不关闭')
 await page.getByRole('textbox',{name:'备注'}).click();assert.equal(await popover.count(),0,'点击外部关闭');assert.ok(await modal.isVisible())
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'备注','外点关闭保留点击目标的焦点')

 // 弹层打开时转为待核对或只读：候选同步禁用，不越界关联
 await linkButton.click();await popover.waitFor()
 for(const setter of ['setPending','setCanStart']){
  await page.evaluate((name:string)=>(window as any).objectConversationsFixture[name]((value:boolean)=>!value),setter)
  await page.waitForFunction(()=>{const buttons=[...document.querySelectorAll<HTMLButtonElement>('[aria-label="关联会话"][role="dialog"] li button')];return buttons.length>0&&buttons.every(button=>button.disabled)},undefined,{timeout:2000}).catch(()=>assert.fail(setter+' 后候选不可再关联'))
  await page.evaluate(()=>document.querySelectorAll<HTMLButtonElement>('[aria-label="关联会话"][role="dialog"] li button').forEach(button=>button.click()))
  assert.equal((await calls()).filter(row=>row[0]==='link').length,0)
  await page.evaluate((name:string)=>(window as any).objectConversationsFixture[name]((value:boolean)=>!value),setter)
 }
 await page.getByRole('textbox',{name:'备注'}).click();assert.equal(await popover.count(),0)

 // 关联失败保留选择并报错；在途防重复；成功后直接关联并关闭
 await linkButton.click();await popover.waitFor()
 await page.evaluate(()=>{(window as any).objectConversationsFixture.failNext=true})
 const weekly=popover.getByRole('button',{name:/周报草稿/});await weekly.click();await weekly.click({force:true}).catch(()=>{})
 await popover.getByRole('alert').waitFor();assert.ok(await popover.isVisible(),'失败不关闭弹层')
 assert.equal((await calls()).filter(row=>row[0]==='link').length,1,'在途期间不重复关联')
 assert.equal(await weekly.getAttribute('aria-current'),'true','失败后保留原选择');assert.equal(await popover.getByRole('searchbox').inputValue(),'周报')
 await weekly.click();await popover.waitFor({state:'detached'})
 assert.equal((await calls()).filter(row=>row[0]==='link').length,2)
 await page.getByRole('button',{name:'周报草稿',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'关联会话','关联完成后焦点回到入口')

 // 退役/只读：可打开历史与解除创建来源，不能新建、关联、准备或解除其他会话
 await page.getByRole('button',{name:'切换只读',exact:true}).click()
 for(const action of [create,linkButton])assert.ok(await action.isDisabled())
 for(const action of await prepare.all())assert.ok(await action.isDisabled(),'只读时不能准备任务上下文')
 assert.ok(await page.getByRole('button',{name:'原聊天',exact:true}).isEnabled());assert.ok(await page.getByRole('button',{name:'执行聊天',exact:true}).isEnabled())
 const sourceRow=page.getByRole('listitem').filter({hasText:'原聊天'}),contextRow=page.getByRole('listitem').filter({hasText:'执行聊天'})
 assert.ok(await sourceRow.getByRole('button',{name:'解除关联',exact:true}).isEnabled());assert.ok(await contextRow.getByRole('button',{name:'解除关联',exact:true}).isDisabled())
 await page.getByText('当前状态只能查看已有会话，不能新增关联。',{exact:true}).waitFor()
 await page.getByRole('button',{name:'切换只读',exact:true}).click()

 // 待核对的持久化：保留核对入口，并阻止新建
 await page.getByRole('button',{name:'切换待核对',exact:true}).click()
 assert.ok(await create.isDisabled());await page.getByRole('button',{name:'核对未完成会话关联',exact:true}).click()
 assert.ok((await calls()).some(row=>row[0]==='recover'))
 await page.getByRole('button',{name:'切换待核对',exact:true}).click()

 // 在途回包跨对象：旧回包不还原焦点、不关新弹层、不把错误写到新对象
 for(const fail of [false,true]){
  await page.evaluate((value:boolean)=>{(window as any).objectConversationsFixture.failNext=value},fail)
  await linkButton.click();await popover.waitFor();await popover.getByRole('searchbox').fill('')
  await popover.getByRole('list').getByRole('button').first().click()
  await page.evaluate((id:string)=>(window as any).objectConversationsFixture.setObjectId(id),fail?'task':'task-b')
  await page.getByRole('textbox',{name:'备注'}).focus();await page.waitForTimeout(300)
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'备注',`旧回包（${fail?'失败':'成功'}）不抢焦点`)
  assert.equal(await page.getByRole('alert').count(),0,`旧回包（${fail?'失败':'成功'}）不污染新对象`)
  assert.ok(await linkButton.isEnabled(),'在途结束后新对象可继续操作')
 }

 // Escape 先关弹层，再关外层详情
 await linkButton.click();await popover.waitFor();await page.keyboard.press('Escape');assert.equal(await popover.count(),0);assert.ok(await modal.isVisible())
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'})
 assert.deepEqual(errors,[])
})
