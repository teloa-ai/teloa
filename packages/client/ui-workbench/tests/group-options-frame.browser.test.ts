import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
before(async()=>{
 const source=await readFile(root+'/packages/client/ui-workbench/tests/business-builder-frame.test.ts','utf8'),ast=ts.createSourceFile('fixture.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let item:ts.Expression|undefined;const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='entry')item=n.initializer;ts.forEachChild(n,visit)};visit(ast);assert.ok(item)
 let entry=new Function('client','return '+item.getText(ast))(client) as string
 const setup="f.groupReads=0;f.groupItems=[];f.holdGroups=!!startup.holdGroups;f.releaseGroups=items=>{f.groupItems=items;f.holdGroups=false;f.groupRelease?.()};props.groupApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>{f.groupReads++;if(f.holdGroups)await new Promise(resolve=>f.groupRelease=resolve);return {items:f.groupItems}}:key==='directorySnapshot'?()=>({items:f.groupItems}):target[key]});"
 entry=entry.replace("const frameRoot=",setup+"const frameRoot=")
 temp=await mkdtemp(join(root,'.runtime-group-options-frame-'));await writeFile(join(temp,'entry.tsx'),entry)
 const isolated=['WorkDirectory','TaskPage','TeamPage','BusinessPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage'],stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'group-options-frame',enforce:'pre',load:async id=>{
  if(!stubbed.has(id))return
  if(id===join(client,'WorkDirectory.tsx'))return "export function WorkDirectory(props){(window as any).frameFixture.groupDirectory=props.groups;return null}"
  const source=await readFile(id,'utf8');return [...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>'export const '+m[1]+'=()=>null;').join('\n')
 }}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'entry.tsx'),name:'GroupOptionsFrame',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(r:any)=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}):r.abort());await page.goto('https://fixture.invalid');await page.evaluate(()=>(window as any).frameStartup={holdGroups:true,withRole:true});await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready');await page.evaluate(()=>(window as any).frameFixture.navigate('plans'));await page.getByRole('button',{name:'按表单创建',exact:true}).click();return page}
const group=(id:string,name:string,archived=false)=>({id,name,scope:'general',archived})
test('真实Frame直接计划入口读取群目录，迟到目录完成即更新汇报群而无需访问对话',async t=>{
 const page=await mount(t),select=page.getByRole('dialog').getByRole('combobox',{name:'汇报群',exact:true});await select.waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.groupReads),1,'直接计划入口必须主动读目录')
 await page.evaluate((items:any)=>(window as any).frameFixture.releaseGroups(items),[group('g-main','真实general群'),group('g-archived','已归档群',true)])
 await select.locator('option[value="g-main"]').waitFor({state:'attached'});assert.equal(await select.locator('option[value="g-archived"]').count(),0)
 await select.selectOption('g-main');assert.equal(await select.inputValue(),'g-main')
})
test('真实Frame群目录显式刷新后更新已开计划候选，归档或失效群不留旧选项',async t=>{
 const page=await mount(t);await page.evaluate((items:any)=>(window as any).frameFixture.releaseGroups(items),[group('g-old','旧群')]);const select=page.getByRole('dialog').getByRole('combobox',{name:'汇报群',exact:true});await select.locator('option[value="g-old"]').waitFor({state:'attached'})
 await page.evaluate(async(items:any)=>{const f=(window as any).frameFixture;f.groupItems=items;await f.groupDirectory.refresh()},[group('g-old','旧群',true),group('g-new','新群')])
 await select.locator('option[value="g-new"]').waitFor({state:'attached'});assert.equal(await select.locator('option[value="g-old"]').count(),0)
})
