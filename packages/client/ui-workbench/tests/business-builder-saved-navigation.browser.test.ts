import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const isolated=['WorkDirectory','TaskPage','TeamPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
before(async()=>{
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('frame.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined;const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let entry=new Function('client','return '+node.getText(ast))(client) as string
 const setup=`
 api.preview=async input=>({draftId:draft.id,revision:input.expectedRevision,candidateHash:draft.hash,baseVersion:draft.baseVersion,dependencyHash:draft.hash,receipt:draft.hash,changes:{rows:[],truncated:false},issues:[]});
 const savedPage=api.page;api.page=async input=>input.draftId?{mode:'preview',scope:draft.scope,configurationHash:draft.hash,draftId:draft.id,revision:input.expectedRevision,page:{kind:'records',definition:pageDefinition,objectType,emptyState:'no-records'}}:savedPage(input);
 api.apply=async input=>{f.applies=(f.applies||0)+1;draft={...draft,status:'applied'};f.formal=true;return {scope:draft.scope,version:input.expectedBaseVersion+1,configurationHash:draft.hash,requestId:input.requestId}};
 api.list=async()=>({items:[...reservations.values()].filter(binding=>binding.kind==='builder').map(binding=>({binding,draft:{id:draft.id,scope:draft.scope,title:draft.candidate.title,revision:draft.revision,status:draft.status,updatedAt:stamp}}))});
 f.reviseBuilder=async()=>{draft={...draft,revision:2,hash:'b'.repeat(64),candidate:{...formal.manifest,definitions:[{kind:'object-type',definition:objectType}]}};const flow=controller.getSnapshot().flow;await flow.refreshDraft();await flow.preview();await flow.page('records')};
 f.returnBuilder=()=>store.actions.openMessages('native');
 `
 assert.equal(entry.split('const frameRoot=').length,2);entry=entry.replace('const frameRoot=',setup+'const frameRoot=')
 temp=await mkdtemp(join(root,'.runtime-builder-saved-navigation-'));await writeFile(join(temp,'entry.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubbed.has(id))return;const content=await readFile(id,'utf8');return [...content.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(match=>'export const '+match[1]+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'entry.tsx'),name:'BuilderSavedNavigation',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(row=>row.type==='chunk')!.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><div id="root"></div></html>'}):route.abort())
 await page.goto('https://fixture.invalid');await page.evaluate(()=>{(window as any).frameStartup={}});await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'新建业务',exact:true}).click();await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
 await page.evaluate(()=>(window as any).frameFixture.reviseBuilder())
 return page
}
const view=(page:any)=>page.evaluate(()=>(window as any).frameFixture.state().view)
const navigation=(page:any)=>page.locator('aside').filter({has:page.locator('nav[aria-label]')}).first()

test('真实Frame业务保存后无需刷新即可打开业务及员工/资料库/市场，保持原builder会话',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'保存业务',exact:true}).click();await page.getByRole('button',{name:'打开业务',exact:true}).waitFor()
 const session=await page.evaluate(()=>(window as any).frameFixture.current())
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.controller.getSnapshot().flow.getSnapshot().draft.status),'applied')
 await page.getByRole('button',{name:'打开业务',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.state().view==='spaces')
 for(const [target,label] of [['team','员工'],['resources','资料'],['market','市场']]){
  await page.evaluate(()=>(window as any).frameFixture.returnBuilder());await page.getByRole('button',{name:'打开业务',exact:true}).waitFor()
  await navigation(page).getByRole('button',{name:label,exact:true}).click()
  await page.waitForFunction((expected:string)=>(window as any).frameFixture.state().view===expected,target)
  assert.equal(await view(page),target);assert.equal(await page.getByRole('dialog',{name:'业务还在搭建中',exact:true}).count(),0)
 }
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),session)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.applies),1)
})

test('真实Frame未采用的修订仍需确认离开，取消不导航，批准后才进目标页',async t=>{
 const page=await mount(t)
 await navigation(page).getByRole('button',{name:'员工',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'业务还在搭建中',exact:true});await dialog.waitFor()
 assert.equal(await view(page),'messages')
 await dialog.getByRole('button',{name:'继续搭建',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(await view(page),'messages')
 await navigation(page).getByRole('button',{name:'资料',exact:true}).click();await dialog.waitFor()
 await dialog.getByRole('button',{name:'保留草案离开',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.state().view==='resources')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.controller.getSnapshot().flow.getSnapshot().draft.status),'draft')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.applies||0),0)
})


test('真实Frame已保存草案的迟到离开判断不能导航重连后的新Flow',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'保存业务',exact:true}).click();await page.getByRole('button',{name:'打开业务',exact:true}).waitFor()
 await page.evaluate(async()=>{
  const f=(window as any).frameFixture,button=Array.from(document.querySelectorAll('aside button')).find(node=>node.textContent==='员工') as HTMLButtonElement
  button.click();await f.reconnect()
 })
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready')
 assert.equal(await view(page),'messages','旧Flow已允许离开的微任务不得跳转到新Flow的页面')
 await navigation(page).getByRole('button',{name:'员工',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.state().view==='team')
})
