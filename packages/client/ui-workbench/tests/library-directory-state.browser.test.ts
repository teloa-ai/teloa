import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('资料库初次加载、持续失败与正常重试不冒充空态；warm草稿和身份边界保持',async t=>{
 const fixture=fileURLToPath(new URL('./fixtures/library.tsx',import.meta.url))
 let entry=await readFile(fixture,'utf8')
 const control=`
const loadState=window.libraryLoadState={pending:[],reads:0,hold:true,empty:false,writes:calls,resolve(){this.hold=false;this.pending.shift().resolve()},reject(){this.pending.shift().reject(Object.assign(Error('内部地址不可展示'),{code:'teloa/dependency-unavailable'}))}};
for(const current of [api,otherApi]){const directory=current.directory,sources=current.sources,knowledgeTree=current.knowledgeTree;current.directory=async()=>{loadState.reads++;if(loadState.hold)await new Promise((resolve,reject)=>loadState.pending.push({resolve,reject}));return loadState.empty?{drafts:[],resources:[]}:directory()};current.sources=async()=>loadState.empty?[]:sources();current.knowledgeTree=async()=>{const value=await knowledgeTree();return loadState.empty?{...value,nodes:value.nodes.filter(node=>node.type==='space')}:value}};
`
 assert.ok(entry.includes('function App(){const [dark'))
 entry=entry.replace('function App(){const [dark','function App(){const [visible,setVisible]=useState(true),[dark')
 entry=entry.replace('<ResourceManager openUsage=','<button onClick={()=>setVisible(value=>!value)}>仅切换资料可见</button><ResourceManager openUsage=')
 entry=entry.replace(' visible selectedDraftId=',' visible={visible} selectedDraftId=')
 entry=entry.replace('createRoot(document.getElementById(\'root\')!).render',control+'\ncreateRoot(document.getElementById(\'root\')!).render')
 const built=await build({configFile:false,root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'library-directory-async-fixture',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0blocked-crypto'},load(id){if(id===fixture)return entry;if(id==='\0blocked-crypto')return "function blocked(){throw Error('本测试不执行宿主摘要')}export{blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],build:{write:false,minify:false,lib:{entry:fixture,name:'LibraryDirectoryState',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const chunk=bundle.output.find(x=>x.type==='chunk'&&x.isEntry);assert.ok(chunk?.type==='chunk')
 const html='<html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')+'</style><body><div id="root"></div><script>'+chunk.code.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000)
 const errors:string[]=[],unexpected:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message))
 await page.route('**/*',(r:any)=>{const u=new URL(r.request().url());if(u.origin==='http://127.0.0.1:3197'&&u.pathname==='/library-test'&&r.request().isNavigationRequest())return r.fulfill({contentType:'text/html',body:html});unexpected.push(r.request().url());return r.abort()})
 const status=page.locator('[data-library-directory-status]')
 const capture=async(name:string)=>{const out=process.env.TELOA_LIBRARY_DIRECTORY_EVIDENCE;if(out){await mkdir(out,{recursive:true});await page.screenshot({path:join(out,name+'.png'),fullPage:true})}}
 await page.goto('http://127.0.0.1:3197/library-test')
 await status.getByText('正在加载资料库…',{exact:true}).waitFor();assert.equal(await status.getAttribute('role'),'status');assert.equal(await status.getAttribute('aria-busy'),'true')
 assert.equal(await page.getByText('还没有资料',{exact:true}).count(),0);await capture('01-loading')
 await page.evaluate(()=>(window as any).libraryLoadState.reject())
 await status.getByRole('heading',{name:'暂时无法加载资料库',exact:true}).waitFor();assert.equal(await status.getAttribute('aria-busy'),'false');assert.equal(await page.getByRole('alert').count(),1,'读取失败不再复制到顶部toast')
 assert.doesNotMatch(await status.innerText(),/内部地址/);await capture('02-failed')
 await status.getByRole('button',{name:'重试',exact:true}).click();await status.getByText('正在加载资料库…',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).libraryLoadState.resolve());await status.waitFor({state:'detached'})
 await page.getByRole('navigation',{name:'浏览资料'}).getByRole('button',{name:'全部资料',exact:true}).click();await page.locator('[data-teloa-pane="detail"]').getByRole('button',{name:'产品定位',exact:true}).waitFor();await capture('03-recovered')
 // 打开原本机资料草稿，刷新失败及重试均不得清空其文字或自动保存。
 const search=page.getByRole('searchbox',{name:'搜索资料名称或所在位置',exact:true});await search.fill('产品')
 await page.getByLabel('添加资料',{exact:true}).click();await page.getByRole('button',{name:'跟踪本机文件',exact:true}).click()
 const name=page.getByRole('textbox',{name:'名称',exact:true}),path=page.getByRole('textbox',{name:'工作文件夹内的相对路径',exact:true})
 await name.fill('尚未提交的资料草稿');await path.fill('synthetic/unsent.md')
 await page.evaluate(()=>(window as any).libraryLoadState.hold=true)
 await page.getByRole('button',{name:'仅切换资料可见',exact:true}).click();await page.getByRole('button',{name:'仅切换资料可见',exact:true}).click()
 await status.getByText('正在加载资料库…',{exact:true}).waitFor();assert.equal(await name.inputValue(),'尚未提交的资料草稿')
 await page.evaluate(()=>(window as any).libraryLoadState.reject());await status.getByRole('button',{name:'重试',exact:true}).waitFor();assert.equal(await path.inputValue(),'synthetic/unsent.md');assert.equal(await search.inputValue(),'产品');await capture('04-warm-failed-draft')
 await status.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>(window as any).libraryLoadState.pending.length===1)
 await page.evaluate(()=>(window as any).libraryLoadState.resolve());await status.waitFor({state:'detached'});assert.equal(await name.inputValue(),'尚未提交的资料草稿');assert.deepEqual(await page.evaluate(()=>(window as any).libraryLoadState.writes),[])
 // 同一组件切换API时旧请求迟到失败不应污染新身份；新身份成功空目录才呈现空态。
 await page.evaluate(()=>(window as any).libraryLoadState.hold=true)
 await page.getByRole('button',{name:'仅切换资料可见',exact:true}).click();await page.getByRole('button',{name:'仅切换资料可见',exact:true}).click();await page.waitForFunction(()=>(window as any).libraryLoadState.pending.length===1)
 await page.getByRole('button',{name:'切换验收身份',exact:true}).click();await page.waitForFunction(()=>(window as any).libraryLoadState.pending.length===2)
 await page.evaluate(()=>(window as any).libraryLoadState.reject());assert.equal(await status.getAttribute('role'),'status');assert.equal(await page.getByRole('alert').count(),0)
 await page.evaluate(()=>{(window as any).libraryLoadState.empty=true;(window as any).libraryLoadState.resolve()});await status.waitFor({state:'detached'})
 await page.getByRole('navigation',{name:'浏览资料'}).getByRole('button',{name:'全部资料',exact:true}).click();await page.getByText('还没有资料',{exact:true}).waitFor();assert.equal(await page.getByText('产品定位',{exact:true}).count(),0);await capture('05-real-empty')
 assert.deepEqual(await page.evaluate(()=>(window as any).libraryLoadState.writes),[]);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[])
})
