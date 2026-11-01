import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用工作树内的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
import {DSH_VERSION,dshFrontendBootStart} from './fixtures/dsh-official.ts'

test('首页输入区随窗口居中，原生斜杠菜单不被滚动容器裁切，切页保留草稿',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),require=createRequire(new URL('../package.json',import.meta.url))
 const temp=await mkdtemp(join(tmpdir(),'teloa-home-layout-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const expose=async(name:string,exports:string)=>{
  const dir=dirname(require.resolve(name+'/package.json')),end='\t\texports.apply = apply;'
  assert.equal(JSON.parse(await readFile(join(dir,'package.json'),'utf8')).version,DSH_VERSION)
  const source=await readFile(join(dir,'lib/client.js'),'utf8');assert.equal(source.split(end).length,2)
  return source.replace(end,'\t\texports.layoutFixture={'+exports+'};\n'+end)
 }
 // 临时导出固定版本的真实布局与菜单；不修改依赖，不用自制菜单替代回归对象。
 const conversation=await expose('@deepseek-ai/dsh-client-ui-conversation','ConversationMainPanel,ConversationContent,InputBarStyles:InputBar_module_css_default')
 const trigger=await expose('@deepseek-ai/dsh-client-ui-input-trigger','MenuView')
 const officialRequire=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const frontend=join(dirname(officialRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets'),files=await readdir(frontend)
 const frontendSource=await readFile(join(frontend,files.find(name=>/^index-.*\.js$/.test(name))!),'utf8'),seedFactory=frontendSource.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1],bootStart=dshFrontendBootStart(frontendSource)
 assert.ok(seedFactory&&bootStart>0)
 const seedSource=frontendSource.slice(0,bootStart)+'\nexport const staticSeeds='+seedFactory+'();'
 const nativeStyles=(await Promise.all(files.filter(name=>name.endsWith('.css')).map(name=>readFile(join(frontend,name),'utf8')))).join('\n')
 const entry=`import {staticSeeds as seeds} from 'official-static-seeds';
import {HomeNativeConversation} from '${client}HomeNativeConversation.tsx';import frame from '${client}WorkbenchFrame.module.css';import home from '${client}WorkHome.module.css';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
const React=seeds.react.default??seeds.react,{createElement:h,useState}=React,{createRoot}=seeds['react-dom/client'],factories=new Map();window.__ModuleLoader__={load:row=>factories.set(row.id,row.factory)};
new Function(${JSON.stringify(conversation)})();new Function(${JSON.stringify(trigger)})();
const resolve=id=>{if(!(id in seeds))throw Error('未授权夹具依赖 '+id);return seeds[id]},native=factories.get('@deepseek-ai/dsh-client-ui-conversation')(resolve).layoutFixture,{MenuView}=factories.get('@deepseek-ai/dsh-client-ui-input-trigger')(resolve).layoutFixture;
const listeners=new Set(),closed={open:false,hit:null,generation:0,groups:[],highlight:null};let menuState=closed;const headersState=new Map(),headers={getSnapshot:()=>headersState,subscribe:()=>()=>{}},menu={getSnapshot:()=>menuState,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
const notify=state=>{menuState=state;listeners.forEach(fn=>fn())},commands=Array.from({length:24},(_,i)=>({name:'command-'+(i+1),label:'命令 '+(i+1),description:'可用命令说明'})),calls=[];
const open=value=>notify(value.startsWith('/')?{...closed,open:true,generation:1,groups:[{source:'commands',status:'ready',showGroupTitle:false,items:commands}],highlight:{source:'commands',index:0}}:closed);
const dictionary={'hero.headline':'今天想完成什么？','hero.preview':'预览','workspace.defaultName':'默认工作区','suggestions.aria':'命令建议'};const tr=key=>dictionary[key]??key;
function Composer(){const [draft,setDraft]=useState('');return h('div',{className:native.InputBarStyles.root+' '+native.InputBarStyles.hero},h('div',{'data-composer-card':'',className:native.InputBarStyles.card},h('div',{'data-composer-overlay':'',className:native.InputBarStyles.overlayAnchor},h(MenuView,{menu,headers,t:tr,onHover:()=>{},onCrumb:()=>{},onDismiss:()=>notify(closed),onPick:(source,index)=>{calls.push(commands[index].name);setDraft('/'+commands[index].name+' ');notify(closed)}})),h('textarea',{'aria-label':'工作对话',value:draft,style:{height:64,resize:'none',border:0,background:'transparent',outline:'none',padding:14,color:'inherit',font:'inherit'},onChange:event=>{setDraft(event.target.value);open(event.target.value)},onKeyDown:event=>{if(event.key==='Escape')notify(closed)}}),h('div',{className:native.InputBarStyles.row},h('button',{type:'button',className:native.InputBarStyles.add,'aria-label':'添加附件'},'+'),h('span',null,'模型'),h('button',{type:'button',className:native.InputBarStyles.primary,'aria-label':'发送'},'↑'))))}
const session={blank:true,promptAttempted:false,pendingSubmissions:[],openState:'open'},conversationState={activeTargets:new Set(),input:{queue:[],prompt:''}},workspaces={phase:'ready',items:[{workspaceId:'workspace',title:'默认工作区',sessionIds:['owned']}]},input={draft:'',attachmentIds:[]};
const useSession=select=>select(session),useSessions=select=>select({byId:{owned:{blank:true,cwd:'/workspace'}}}),renderSlot=(name,owner)=>name==='conversation.composer.bar'?h(Composer):null;
const contentProps={sessionId:'owned',useSession,useSessions,useSessionStatus:select=>select(new Map()),useWorkspaces:select=>select(workspaces),useInput:select=>select(input),useComposerBlock:select=>select(undefined),renderSlot,renderSlotChain:(_name,_owner,options)=>options.fallback,selectWorkspace:async()=>{},t:tr,useFactorySlot:()=>()=>null};
const content=h(native.ConversationMainPanel,{...contentProps,useConversation:select=>select(conversationState),renderFactorySlot:(_name,owner)=>h(native.ConversationContent,{...contentProps,...owner})});
const overview=h('section',{className:home.page,'aria-label':'首页总览'},h('div',{className:home.content},h('section',{className:home.attentionStrip},h('strong',null,'暂无需要你处理的工作'),h('button',{className:home.secondaryButton},'一起处理')),h('section',{className:home.recent},h('header',{className:home.sectionHeading},h('h2',null,'继续工作')),h('ul',{className:home.rows},...Array.from({length:5},(_,i)=>h('li',{key:i},h('button',{className:home.row},h('span',{className:home.rowTitle},h('strong',null,'进行中的工作 '+(i+1))))))))));
function App(){const [isHome,setHome]=useState(true);window.homeLayout={calls,home:setHome,dark:value=>Object.entries(value?prototypeThemes.dark:prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value))};return h('div',{className:tokens.tokens+' '+frame.frame},h('aside',{className:frame.navigation,'aria-label':'主导航'},'Teloa'),h('div',{className:frame.workspace},h('header',{className:frame.topbar},'工作台'),h('nav',{className:frame.hubNavigation},h('span',{className:frame.hubTab},'总览')),h('main',{className:frame.main},h('div',{className:frame.nativeConversation},h(HomeNativeConversation,{home:isHome,ready:true,sessionId:'owned',useSession,isHomeDraft:()=>true,accept:()=>{},acceptance:{getSnapshot:()=>false,subscribe:()=>()=>{}},content,overview})))))}
Object.entries({...prototypeThemes.light,'--dsw-alias-bg-base':'var(--teloa-design-bg)','--dsw-specific-menu':'var(--teloa-design-surface)','--dsw-menu-surface-fill':'var(--teloa-design-surface)','--dsw-radius-lg':'12px','--dsw-elevation-prominent':'var(--teloa-design-shadow-menu)','--dsw-specific-input-major':'var(--teloa-design-surface)','--dsw-alias-label-primary':'var(--teloa-design-text)','--dsw-alias-button-info-fill':'var(--teloa-design-primary)'}).forEach(([key,value])=>document.body.style.setProperty(key,value));createRoot(document.getElementById('root')).render(h(App));`
 await writeFile(join(temp,'fixture.mjs'),entry)
 const seedId='\0official-seeds',reactId='\0official-react',jsxId='\0official-jsx',built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'official-home-seeds',enforce:'pre',resolveId:(id,importer)=>id==='official-static-seeds'?seedId:id==='react'?reactId:id==='react/jsx-runtime'?jsxId:importer===seedId&&id.startsWith('.')?resolve(frontend,id):null,load:id=>id===seedId?seedSource:id===reactId?"import {staticSeeds} from 'official-static-seeds';const value=staticSeeds.react;export default value;export const {useState,useEffect,useLayoutEffect,useRef,useSyncExternalStore}=value;":id===jsxId?"import {staticSeeds} from 'official-static-seeds';export const {Fragment,jsx,jsxs}=staticSeeds['react/jsx-runtime'];":null}],build:{write:false,minify:false,rollupOptions:{treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.mjs'),name:'HomeLayoutFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN" style="--dsh-frame-top-clearance:24px"><body style="margin:0"><div id="root"></div></body></html>')
 await page.addStyleTag({content:nativeStyles+'\n'+bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')})
 await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
 await page.waitForTimeout(50);assert.deepEqual(errors,[])
 const evidence=process.env.TELOA_HOME_LAYOUT_EVIDENCE;if(evidence)await mkdir(evidence,{recursive:true})
 const editor=page.getByRole('textbox',{name:'工作对话'}),menuPanel=page.locator('[data-trigger-menu]'),homeRoot=page.locator('[data-teloa-home]')
 await editor.waitFor()
 for(const [width,height] of [[1440,1000],[1280,720],[1024,576],[430,844],[390,600]] as const){
  await page.setViewportSize({width,height});await editor.fill('/');await menuPanel.waitFor()
  await page.waitForTimeout(80)
  if(evidence)await page.screenshot({path:join(evidence,'menu-'+width+'x'+height+'.png')})
  const bounds=await menuPanel.boundingBox(),homeBounds=await homeRoot.boundingBox();assert.ok(bounds&&homeBounds)
  assert.ok(bounds.y>=homeBounds.y,`菜单顶部 ${bounds.y} 不得被首页滚动边界 ${homeBounds.y} 裁切`)
  assert.equal(await menuPanel.evaluate((node:HTMLElement)=>{const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+8);return hit===node||hit!==null&&node.contains(hit)}),true,'菜单顶部必须真实可见，不能只验证首条选项')
  assert.equal(await menuPanel.evaluate((node:HTMLElement)=>{const menu=node.getBoundingClientRect();for(let parent=node.parentElement;parent;parent=parent.parentElement){if(['hidden','clip','auto','scroll'].includes(getComputedStyle(parent).overflowY)&&menu.top<parent.getBoundingClientRect().top-1)return parent.tagName;if(parent.hasAttribute('data-teloa-home'))break}return null}),null,'菜单顶部不能落在任一祖先的裁剪区域外')
  assert.equal(await page.getByRole('option').first().evaluate((node:HTMLElement)=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}),true,'首条命令可见且可直接点击')
  const card=await page.locator('[data-composer-card]').boundingBox();assert.ok(card)
  const attention=homeRoot.locator('[aria-label="首页总览"] > div > section').first(),strip=await attention.boundingBox();assert.ok(strip)
  const gap=strip.y-card.y-card.height;assert.ok(gap>=16&&gap<=(width===1440?100:64),`输入框与待办提示间距 ${gap}px 应比旧布局紧凑`)
  assert.equal(await attention.evaluate((node:HTMLElement)=>{const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===node||hit!==null&&node.contains(hit)}),true,'待办提示不能被欢迎区覆盖')
  assert.ok(Math.abs(card.x+card.width/2-(homeBounds.x+homeBounds.width/2))<12,'输入框水平居中')
  assert.ok(Math.abs(card.y+card.height/2-(homeBounds.y+homeBounds.height/2))<height*.2,'输入框接近主区垂直中心')
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'窄屏不横向溢出')
  if(width===1440){
   // 模拟真实首页的标题区占高：菜单会上探到原生 scrollBody 顶边之外。
   const scroll=homeRoot.locator('[data-conversation-scroll]').first()
   await scroll.evaluate((node:HTMLElement)=>{node.style.marginTop='100px';window.dispatchEvent(new Event('scroll'))})
   await page.waitForTimeout(30)
   const top=await menuPanel.evaluate((node:HTMLElement)=>{const menu=node.getBoundingClientRect(),scroll=node.closest('[data-conversation-scroll]')!.getBoundingClientRect(),hit=document.elementFromPoint(menu.left+menu.width/2,menu.top+8);return {extendsAboveScroll:menu.top<scroll.top,visible:hit===node||hit!==null&&node.contains(hit)}})
   assert.equal(top.extendsAboveScroll,true,'夹具应覆盖菜单上探到原生滚动区外的场景')
   assert.equal(top.visible,true,'上探的菜单顶部仍应可见')
   await scroll.evaluate((node:HTMLElement)=>{node.style.marginTop='';window.dispatchEvent(new Event('scroll'))})
  }
  await page.getByRole('option').first().click();assert.equal(await editor.inputValue(),'/command-1 ')
 }
 await editor.fill('保留尚未发送的草稿');const original=await editor.elementHandle()
 await page.evaluate(()=>(window as any).homeLayout.home(false));await page.waitForFunction(()=>document.documentElement.style.getPropertyValue('--dsh-frame-top-clearance')==='24px');assert.equal(await editor.inputValue(),'保留尚未发送的草稿')
 await page.evaluate(()=>(window as any).homeLayout.home(true));assert.equal(await editor.evaluate((node:HTMLElement,prior:HTMLElement)=>node===prior,original),true,'切页不重挂原输入器')
 await page.evaluate(()=>(window as any).homeLayout.dark(true));await editor.fill('/');await menuPanel.waitFor();assert.ok((await menuPanel.boundingBox())!.y>=(await homeRoot.boundingBox())!.y);if(evidence)await page.screenshot({path:join(evidence,'menu-dark-390.png')});await editor.press('Escape');assert.equal(await menuPanel.count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).homeLayout.calls),Array(5).fill('command-1'));assert.deepEqual(errors,[])
})
