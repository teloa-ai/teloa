import {after,before,test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const require=createRequire(new URL('../package.json',import.meta.url))
const conversationRoot=dirname(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json'))
const sidebarRoot=dirname(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/package.json'))
let browser:any,temp:string,script:string,styles:string
const evidence=process.env.TELOA_NATIVE_HEADER_EVIDENCE

/** 仅在临时浏览器夹具中导出原官方闭包组件；不改 npm 包或替写 renderer。 */
function expose(source:string,exports:string):string{
 const end='\t\texports.apply = apply;'
 assert.equal(source.split(end).length,2)
 return source.replace(end,exports+'\n'+end)
}

async function patchedConversationSource(){
 const basename='dsh-client-ui-conversation-0.2.1-alpha.1-empty-header-utilities',compat=join(root,'packages/harness-dsh/compat')
 const metadata=JSON.parse(await readFile(join(conversationRoot,'package.json'),'utf8')),manifest=JSON.parse(await readFile(join(compat,basename+'.json'),'utf8'))
 const original=await readFile(join(conversationRoot,'lib/client.js')),patch=await readFile(join(compat,basename+'.patch')),digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
 assert.equal(metadata.version,'0.2.1-alpha.1');assert.equal(manifest.schema,'teloa.dsh-compat-patch/v1');assert.equal(manifest.package,metadata.name);assert.equal(manifest.version,metadata.version)
 assert.equal(manifest.upstreamCommit,'5badb15009ae1756c3afe0ae0cef1faafc290ccc');assert.equal(digest(patch),manifest.patchSha256)
 assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].path,'lib/client.js');assert.equal(digest(original),manifest.files[0].beforeSha256)
 const target=join(temp,'official-conversation');await mkdir(join(target,'lib'),{recursive:true});await writeFile(join(target,'lib/client.js'),original)
 const patchPath=join(temp,'header.patch');await writeFile(patchPath,patch)
 execFileSync('/usr/bin/git',['apply','--no-index','--check',patchPath],{cwd:target});execFileSync('/usr/bin/git',['apply','--no-index','--whitespace=nowarn',patchPath],{cwd:target})
 const result=await readFile(join(target,'lib/client.js'));assert.equal(digest(result),manifest.files[0].afterSha256)
 assert.equal(digest(await readFile(join(conversationRoot,'lib/client.js'))),manifest.files[0].beforeSha256,'不得修改安装依赖')
 return result.toString('utf8')
}

before(async()=>{
 temp=await mkdtemp(join(tmpdir(),'teloa-native-header-'))
 if(evidence)await mkdir(evidence,{recursive:true})
 const conversation=expose(await patchedConversationSource(),'\t\texports.headerFixture={ConversationHeader,ConversationSessionHeader};')
 assert.equal(JSON.parse(await readFile(join(sidebarRoot,'package.json'),'utf8')).version,'0.2.1-alpha.1')
 const sidebar=expose(await readFile(join(sidebarRoot,'lib/client.js'),'utf8'),'\t\texports.headerFixture={ExpandButton};')
 const officialRequire=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const frontend=join(dirname(officialRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets')
 const main=join(frontend,(await readdir(frontend)).find(name=>/^index-.*\.js$/.test(name))!)
 const frontendSource=await readFile(main,'utf8'),seedFactory=frontendSource.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1]
 const bootStart=frontendSource.indexOf('const fo=globalThis.dshDesktopBoot,');assert.ok(seedFactory&&bootStart>0)
 // 复用官方网页已经打包的真实 React/atoms seeds，避免 npm atom 未发布 devDependencies 或两份 React。
 const seedSource=frontendSource.slice(0,bootStart)+'\nexport const staticSeeds='+seedFactory+'();'
 const entry=`
import {staticSeeds as seeds} from 'official-static-seeds';
import {ConversationOverviewEntry} from '${client}ConversationOverviewTab.tsx';
import {ResourceHistory} from '${client}ResourceHistory.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';
import {translateMessage} from '${client}i18n/messages.ts';
import workbenchCss from '${client}WorkbenchFrame.module.css';
const React=seeds.react.default??seeds.react,{createElement:h}=React,{createRoot}=seeds['react-dom/client'],{flushSync}=seeds['react-dom'],factories=new Map();
window.__ModuleLoader__={load:row=>factories.set(row.id,row.factory)};
new Function(${JSON.stringify(conversation)})();new Function(${JSON.stringify(sidebar)})();
const resolve=id=>{if(!(id in seeds))throw Error('未授权的官方fixture依赖 '+id);return seeds[id]};
const {ConversationHeader,ConversationSessionHeader}=factories.get('@deepseek-ai/dsh-client-ui-conversation')(resolve).headerFixture;
const {ExpandButton}=factories.get('@deepseek-ai/dsh-client-ui-sidebar-right')(resolve).headerFixture;
const view=createRoot(document.getElementById('root')),calls=[];
let current={sessionId:'owned',blank:true,expanded:false},utilityCount=1;
const dictionary={'chrome.expand':'打开右侧边栏','chrome.expandAria':'打开右侧边栏','session.hierarchy':'会话层级'};
const t=key=>dictionary[key]??key;
const i18nSnapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>i18nSnapshot};
const bindingSnapshot={status:'ready',sessionId:'owned'},work={subscribe:()=>()=>{},getSnapshot:()=>bindingSnapshot},api={history:()=>{throw Error('布局夹具不读取本人记录')}};
const renderSlot=(name,owner)=>{
 if(name==='conversation.session.header')return h('span',{'data-slot':name,style:{display:'contents'}},h(ConversationSessionHeader,{sessionId:current.sessionId,...owner,useSessions:selector=>selector({byId:{owned:{id:'owned',displayTitle:'已有真实会话',origin:'user'}}}),useConversationViews:selector=>selector([]),useStore:selector=>selector({view:null}),renderSlot,open:()=>{},selectView:()=>{},t}));
 if(name==='conversation.session.header.utilities')return h('span',{'data-slot':name,style:{display:'contents'}},h(ConversationOverviewEntry,{sessionId:current.sessionId,open:id=>calls.push(['overview',id])}),utilityCount>1&&h(ResourceHistory,{sessionId:current.sessionId,api,work}),...Array.from({length:Math.max(0,utilityCount-2)},(_,i)=>h('button',{key:i,type:'button','aria-label':'本人会话工具'+(i+1),style:{width:28,height:28,flex:'none'}},'工')));
 if(name==='conversation.session.header.corner')return h('span',{'data-slot':name,style:{display:'contents'}},h(ExpandButton,{sessionId:current.sessionId,useStore:selector=>selector({bySession:{[current.sessionId]:{layout:{expanded:current.expanded}}}}),actions:{setExpanded:(id,value)=>{calls.push(['expand',id,value]);current.expanded=value;render()}},useShortcuts:selector=>selector([]),t}));
 if(name==='conversation.session.header.actions')return h('span',{'data-slot':name},h('button',{type:'button'},'已有会话操作'));
 return null;
};
function render(){flushSync(()=>view.render(h(I18nProvider,{runtime},h('div',{className:workbenchCss.nativeConversation},h(ConversationHeader,{sessionId:current.sessionId,useSession:selector=>selector({blank:current.blank,awaitingFirstTurn:false,running:false,promptAttempted:false}),useConversation:selector=>selector({activeTargets:new Set(),input:{queue:[],prompt:''},view:'chat'}),renderSlot}),h('textarea',{'aria-label':'未提交草稿',defaultValue:'保留的原任务草稿'})))))}
window.headerFixture={calls,mount:value=>{current={...current,...value};utilityCount=value.utilityCount??1;render()},settle:()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))};
`
 await writeFile(join(temp,'fixture.mjs'),entry)
 const seedId='\0official-static-seeds',reactId='\0official-react',jsxId='\0official-jsx-runtime'
 const reactSource="import {staticSeeds} from 'official-static-seeds';const value=staticSeeds.react;export default value.default??value;export const {Children,cloneElement,createContext,createElement,createRef,forwardRef,Fragment,isValidElement,memo,startTransition,useCallback,useContext,useEffect,useId,useImperativeHandle,useLayoutEffect,useMemo,useReducer,useRef,useState,useSyncExternalStore,useTransition}=value;"
 const jsxSource="import {staticSeeds} from 'official-static-seeds';export const {Fragment,jsx,jsxs}=staticSeeds['react/jsx-runtime'];"
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'official-header-seeds',enforce:'pre',resolveId:(id,importer)=>id==='official-static-seeds'?seedId:id==='react'?reactId:id==='react/jsx-runtime'?jsxId:importer===seedId&&id.startsWith('.')?resolve(frontend,id):null,load:id=>id===seedId?seedSource:id===reactId?reactSource:id===jsxId?jsxSource:null}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.mjs'),name:'NativeHeaderFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(row=>row.type==='chunk')!.code
 styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

async function pageFor(t:any,width=1100){
 const page=await browser.newPage({viewport:{width,height:760}}),errors:string[]=[],requests:string[]=[]
 page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="zh-CN" data-platform="darwin"><body style="margin:0"><main id="root"></main></body></html>')
 await page.addStyleTag({content:':root{--dsh-frame-leading-clearance:0px;--teloa-text:#18202b;--teloa-muted:#657080;--teloa-border:#dce1e8;--teloa-surface:#fff;--teloa-background:#fff;--teloa-subtle:#f5f6f8;--teloa-hover:#eef0f3;--teloa-focus:#2c6bed;--teloa-font-control:13px;--teloa-font-caption:12px;}'+styles})
 await page.addScriptTag({content:script});await page.evaluate(()=>(window as any).headerFixture.mount({blank:true}))
 return page
}

test('真实官方空会话header保留概览utilities与原生展开入口，已有会话仍显示标题及actions',async t=>{
 const page=await pageFor(t),overview=page.getByRole('button',{name:'工作概览',exact:true}),expand=page.getByRole('button',{name:'打开右侧边栏',exact:true})
 assert.equal(await overview.isVisible(),true,'空会话的utilities必须有原生outlet')
 assert.equal(await expand.isVisible(),true,'原生corner single仍由ExpandButton承载')
 assert.equal(await page.getByRole('navigation',{name:'会话层级'}).count(),0)
 assert.equal(await page.getByRole('button',{name:'已有会话操作',exact:true}).count(),0)
 if(evidence)await page.screenshot({path:join(evidence,'01-official-empty-header.png')})
 await overview.click();await expand.click()
 assert.deepEqual(await page.evaluate(()=>(window as any).headerFixture.calls),[['overview','owned'],['expand','owned',true]])
 assert.equal(await page.getByLabel('未提交草稿').inputValue(),'保留的原任务草稿')
 await page.evaluate(()=>(window as any).headerFixture.mount({blank:false,expanded:false}))
 assert.equal(await overview.isVisible(),true);assert.equal(await expand.isVisible(),true)
 assert.equal(await page.getByRole('navigation',{name:'会话层级'}).isVisible(),true)
 assert.equal(await page.getByRole('button',{name:'已有会话操作',exact:true}).isVisible(),true)
 if(evidence)await page.screenshot({path:join(evidence,'02-official-existing-header.png')})
})

test('真实官方空会话utilities在原生展开按钮旁，390px多工具不越界或遮挡；无会话不授予入口',async t=>{
 const page=await pageFor(t),overview=page.getByRole('button',{name:'工作概览',exact:true}),expand=page.getByRole('button',{name:'打开右侧边栏',exact:true})
 await overview.waitFor()
 const first=await overview.boundingBox(),corner=await expand.boundingBox();assert.ok(first&&corner)
 assert.ok(corner.x-first.x-first.width<=32,'空会话的utilities与原生corner保持相邻')
 await page.setViewportSize({width:390,height:760});await page.evaluate(()=>(window as any).headerFixture.mount({utilityCount:4}))
 const controls=page.locator('header button');assert.equal(await controls.count(),5)
 for(const control of await controls.all()){
  const box=await control.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=390)
  assert.equal(await control.evaluate((node:any)=>{const box=node.getBoundingClientRect();return node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))}),true,'原生工具可实际点击')
 }
 if(evidence)await page.screenshot({path:join(evidence,'03-official-390px-utilities.png')})
 await page.evaluate(()=>(window as any).headerFixture.mount({sessionId:undefined}))
 assert.equal(await overview.count(),0);assert.equal(await expand.count(),0)
})
