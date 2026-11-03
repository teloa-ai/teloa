import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用本工作树已有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const isolated=['WorkDirectory','WorkHome','TaskPage','TeamPage','BusinessPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
let browser:any,script:string,styles:string,temp:string
const patch=(source:string,from:string,to:string)=>{assert.equal(source.split(from).length,2,from);return source.replace(from,to)}
before(async()=>{
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('fixture.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined;const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let entry=new Function('client','return '+node.getText(ast))(client) as string
 entry=patch(entry,"create:async p=>{const prior=","create:async p=>{(f.assignmentRequests??=[]).push({...p});const prior=")
 const setup=`
 import {readTaskCreation} from '${client}task-creation-receipt.ts';
 f.scopeRows=[{scope:'general',title:'通用工作',kind:'general'},{scope:'sales',title:'验收业务',kind:'domain'},{scope:'design-review',title:'第二验收业务',kind:'domain'}];
 f.creationPrompts=[];props.preparation={prepare:prompt=>f.creationPrompts.push(prompt),invalidate:noop};
 f.assignmentWrites=[];for(const name of ['taskApi','taskRunApi']){const original=props[name];props[name]=new Proxy(original,{get:(target,key)=>['create','createConfirmed','prepare','start','recoverCreate'].includes(key)?async()=>{f.assignmentWrites.push(name+'.'+key);throw Error('Unexpected execution write')}:Reflect.get(target,key)})}
 inputs.set('old-employee-session',{...emptyInput,draft:'旧会话尚未提交草稿'});f.oldAssignmentDraft=()=>inputs.get('old-employee-session').draft;
 f.assignmentMarker=id=>readTaskCreation(sessionStorage,id);
 `
 entry=patch(entry,'const frameRoot=',setup+'const frameRoot=')
 temp=await mkdtemp(join(root,'.runtime-employee-assignment-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'assignment-frame-boundary',enforce:'pre',load:async id=>{
  if(!stubbed.has(id))return
  if(id===join(client,'TeamPage.tsx'))return 'export const RoleForm=()=>null;export const TeamPage=props=>{window.frameFixture.teamProps=props;return null};'
  return [...(await readFile(id,'utf8')).matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>'export const '+m[1]+'=()=>null;').join('\n')
 }}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'EmployeeAssignmentFrame',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(x=>x.type==='chunk')!.code;styles=bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,startup:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(r:any)=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}):r.abort())
 await page.goto('https://fixture.invalid');await page.evaluate((value:Record<string,unknown>)=>{(window as any).frameStartup=value},{withRole:true,roleSession:true,sessionId:'old-employee-session',roleScopes:['sales'],...startup});await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps?.state.roles.some((r:any)=>r.id==='r-profile'))
 return page
}
async function begin(page:any,scope?:string,goal='# 新工作\n仅核对本次资料。'){
 assert.equal(await page.evaluate(()=>typeof(window as any).frameFixture.teamProps.assignConversation),'function','Frame必须提供独立交办入口，而不是打开历史会话')
 await page.evaluate(({scope,goal}:{scope?:string;goal:string})=>{const f=(window as any).frameFixture;f.assignmentOutcome='pending';f.assignmentPromise=Promise.resolve().then(()=>f.teamProps.assignConversation('r-profile',3,scope,goal)).then(()=>{f.assignmentOutcome='prepared'},(error:Error&{code?:string})=>{f.assignmentOutcome='rejected';f.assignmentError={code:error.code,message:error.message}})},{scope,goal})
}
const outcome=(page:any)=>page.waitForFunction(()=>(window as any).frameFixture.assignmentOutcome!=='pending')
const facts=(page:any)=>page.evaluate(()=>{const f=(window as any).frameFixture;return {outcome:f.assignmentOutcome,error:f.assignmentError,creates:f.creates,current:f.current(),requests:f.assignmentRequests??[],prompts:f.creationPrompts,links:f.links,rows:f.rows(),sent:f.sent,writes:f.assignmentWrites,oldDraft:f.oldAssignmentDraft(),marker:f.assignmentMarker(f.current())}})

test('新交办每次创建独立员工会话并只准备草稿，既有历史和草稿保留',async t=>{
 const page=await mount(t);await begin(page,'sales');await outcome(page);const first=await facts(page)
 assert.equal(first.outcome,'prepared');assert.equal(first.creates,1);assert.notEqual(first.current,'old-employee-session');assert.equal(first.requests[0].roleId,'r-profile');assert.equal(first.prompts.length,1);assert.equal(first.prompts[0].sessionId,first.current);assert.match(first.prompts[0].text,/# 新工作/);assert.deepEqual(first.marker,{scope:'sales'})
 assert.ok(first.links.some((l:any)=>l.sessionId===first.current&&l.objectId==='r-profile'&&l.objectVersion===3&&l.scopeId==='sales'))
 await begin(page,'sales','# 另一件工作');await outcome(page);const second=await facts(page)
 assert.equal(second.creates,2);assert.notEqual(second.current,first.current);assert.equal(second.prompts.length,2);assert.equal(second.oldDraft,'旧会话尚未提交草稿');assert.deepEqual(second.sent,[]);assert.deepEqual(second.writes,[])
})

test('新交办从真实业务上下文直接带入，不弹多范围选择或默认其他业务',async t=>{
 const page=await mount(t,{roleScopes:['sales','design-review']});await page.evaluate(()=>(window as any).frameFixture.openFormal());await begin(page);await outcome(page);const f=await facts(page)
 assert.equal(f.outcome,'prepared');assert.deepEqual(f.marker,{scope:'sales'});assert.ok(f.links.some((l:any)=>l.sessionId===f.current&&l.scopeId==='sales'));assert.equal(await page.getByRole('dialog').count(),0);assert.deepEqual(f.sent,[])
})

test('缺业务上下文的多范围交办保留taskCreation标记，取消不创建也不当作已准备',async t=>{
 const page=await mount(t,{roleScopes:['sales','design-review']});await begin(page)
 const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal((await facts(page)).creates,0);await dialog.getByRole('button',{name:'取消',exact:true}).click();await outcome(page);let f=await facts(page);assert.equal(f.outcome,'rejected');assert.equal(f.error.code,'teloa/cancelled');assert.equal(f.current,'old-employee-session')
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'));await begin(page);await dialog.waitFor();await dialog.getByRole('combobox').selectOption('design-review');await dialog.getByRole('button',{name:'开始会话',exact:true}).click();await outcome(page);f=await facts(page)
 assert.equal(f.outcome,'prepared');assert.deepEqual(f.marker,{scope:'design-review'});assert.equal(f.prompts.length,1);assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[])
})

test('当前员工版本变化、停岗离岗、分身及不支持的明确业务都拒绝新交办',async t=>{
 for(const change of [{version:4},{state:'paused'},{state:'retired'},{kind:'twin'},{scopes:['design-review']}]){
  const page=await mount(t);await page.evaluate((value:Record<string,unknown>)=>{const f=(window as any).frameFixture;f.employee={...f.employee,...value}},change);await begin(page,'sales');await outcome(page);const f=await facts(page)
  assert.equal(f.outcome,'rejected',JSON.stringify(change));assert.equal(f.creates,0);assert.deepEqual(f.prompts,[]);assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[])
 }
})

test('业务选择等待期间员工版本变化，在创建新会话前再次拒绝',async t=>{
 const page=await mount(t,{roleScopes:['sales','design-review']});await page.evaluate(()=>(window as any).frameFixture.navigate('team'));await begin(page);const dialog=page.getByRole('dialog');await dialog.waitFor()
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.employee={...f.employee,version:4}});await dialog.getByRole('button',{name:'开始会话',exact:true}).click();await outcome(page);const f=await facts(page)
 assert.equal(f.outcome,'rejected');assert.equal(f.creates,0);assert.deepEqual(f.prompts,[]);assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[])
})

test('已有未决会话创建时保持原请求，不借新交办恢复或发送',async t=>{
 const page=await mount(t);await page.evaluate(async()=>{const f=(window as any).frameFixture;await f.pending('sales')});const count=(await facts(page)).creates;await begin(page,'sales');await outcome(page);const f=await facts(page)
 assert.equal(f.outcome,'rejected');assert.equal(f.creates,count);assert.deepEqual(f.prompts,[]);assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[])
})

test('交办创建期间离开原入口不抢回导航，也不回执已准备或清除旧稿',async t=>{
 const page=await mount(t,{holdCreate:true});await begin(page,'sales');await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('tasks');f.releaseCreate()});await outcome(page);const f=await facts(page)
 assert.equal(f.outcome,'rejected');assert.equal(f.error.code,'teloa/cancelled');assert.equal(f.current,'old-employee-session');assert.equal(f.oldDraft,'旧会话尚未提交草稿');assert.deepEqual(f.prompts,[]);assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[])
})
