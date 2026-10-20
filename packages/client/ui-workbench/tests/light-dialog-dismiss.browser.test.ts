import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// 注：包住输入框的 label 会把已填内容算进可访问名，按标签名找控件会随草稿变化，这里直接取窗内首个输入框。
// B7 轻窗口补漏：移到分组、行业任务/自动化表单、业务表单、业务空间改名、能力停用理由统一外点关闭；
// 外点/Esc/关闭只收起并按原对象保留草稿，拖出不关，提交中不关，只有明确提交才写入。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
declare global {interface Window {lightFixture:{calls:string[];release:()=>void;tr:(key:string,params?:Record<string,unknown>)=>string;placements:()=>Record<string,string>}}}
const loadId='10000000-0000-4000-8000-000000000001',itemId='10000000-0000-4000-8000-000000000002'
const entry=`
import tokens from '${client}theme-tokens.module.css';import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {DialogueFolderMoveDialog} from '${client}DialogueOrganizationDialogs.tsx';import {createDialogueOrganization} from '${client}dialogue-organization.ts';
import {SavedIndustryTaskForm} from '${client}SavedIndustryTaskForm.tsx';import {SavedIndustryPlanForm} from '${client}SavedIndustryPlanForm.tsx';import {IndustryTaskForm} from '${client}IndustryTaskForm.tsx';
import {BusinessForm} from '${client}BusinessForms.tsx';import {BusinessSpaceForm} from '${client}BusinessSpaceForm.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
// setContent 页不是安全上下文，没有 crypto.randomUUID；补一个只供夹具用的 v4 生成。
if(!crypto.randomUUID)crypto.randomUUID=()=>'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.className=tokens.tokens;
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const memory=new Map([['teloa.dialogue-organization/v1',JSON.stringify({schema:'teloa.dialogue-organization/v1',assistantName:'Teloa',type:'all',folders:[{id:'first',name:'原分组',collapsed:false},{id:'second',name:'其他分组',collapsed:false}],placements:{}})]]);
const organization=createDialogueOrganization({getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)});
const f=window.lightFixture={calls:[],release:()=>{},tr:(key,params)=>translateMessage(locale,key,params),placements:()=>organization.getSnapshot().placements};
const hold=label=>new Promise(resolve=>{f.calls.push(label);f.release=resolve});
const work={loadId:'${loadId}',itemInstanceId:'${itemId}',title:'行业模板任务',method:'按步骤核对',requirements:['需求一'],output:'核对清单',skills:[],scope:'general'};
const load={id:'${loadId}',relations:[],items:[]};
const taskApi={preview:async()=>work},planApi={preview:async()=>({title:'行业模板自动化',work,dataScope:'只读资料',trigger:{cadence:'daily',time:'09:00',timezone:'UTC'},scope:'general'})};
const template={id:'${loadId}',resources:[{id:'r1',inspection:{definition:{kind:'work-template',manifest:{title:'旧行业任务',description:'说明',output:'清单',skills:[],requirements:['补充一']}}}}]};
const initialSpace={id:'space-1',name:'个人工作',description:'原说明',version:3,kind:'personal',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'};
function App(){
 const [open,setOpen]=useState(null),[space,setSpace]=useState(initialSpace),close=()=>setOpen(null);
 return <main>
  <button onClick={()=>setOpen('move')}>打开移动</button><button onClick={()=>setOpen('task')}>打开行业任务</button><button onClick={()=>setOpen('plan')}>打开行业自动化</button><button onClick={()=>setOpen('industry')}>打开旧行业任务</button><button onClick={()=>setOpen('business')}>打开业务任务</button><button onClick={()=>setOpen('space')}>打开业务空间</button>
  {open==='move'&&<DialogueFolderMoveDialog entry={{kind:'session',id:'s1'}} title="原会话" organization={organization} close={close}/>}
  {open==='task'&&<SavedIndustryTaskForm load={load} itemInstanceId="${itemId}" roles={[]} api={taskApi} close={close} create={()=>hold('task')}/>}
  {open==='plan'&&<SavedIndustryPlanForm load={load} itemInstanceId="${itemId}" roles={[]} api={planApi} close={close} create={()=>hold('plan')} openRole={async()=>{}}/>}
  {open==='industry'&&<IndustryTaskForm loads={[template]} source={{loadId:'${loadId}',resourceId:'r1'}} create={()=>{f.calls.push('industry');close()}} close={close}/>}
  {open==='business'&&<BusinessForm mode="task" refs={[{id:'o1',version:2,title:'原对象',scope:'general'}]} roles={[]} close={close} save={()=>{f.calls.push('business');close()}}/>}
  {open==='space'&&<BusinessSpaceForm initial={space} close={close} save={change=>hold('space').then(()=>{setSpace(current=>({...current,name:change.name+'（已保存）',version:current.version+1}));close()})}/>}
 </main>;
}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-light-dialog-dismiss-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'LightDialogFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

async function page(t:any){
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[]
 page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:'body{margin:0;font:14px system-ui}'+styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'打开移动',exact:true}).waitFor()
 return page
}
const tr=(p:any,key:string,params?:Record<string,unknown>)=>p.evaluate(([key,params]:[string,Record<string,unknown>|undefined])=>window.lightFixture.tr(key,params),[key,params])
const calls=(p:any)=>p.evaluate(()=>window.lightFixture.calls)
async function dragOut(p:any,dialog:any){const box=await dialog.boundingBox();assert.ok(box);await p.mouse.move(box.x+20,box.y+20);await p.mouse.down();await p.mouse.move(3,3);await p.mouse.up()}

test('移到分组：外点、Esc 只收起并保留所选分组，拖出不关，保存才移动',async t=>{
 const p=await page(t),open=p.getByRole('button',{name:'打开移动',exact:true}),dialog=p.getByRole('dialog',{name:'移到分组',exact:true}),select=dialog.getByRole('combobox')
 await open.click();await select.selectOption('second')
 await dragOut(p,dialog);assert.equal(await dialog.isVisible(),true,'窗内按下窗外松开不关闭')
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'});assert.deepEqual(await p.evaluate(()=>window.lightFixture.placements()),{},'外点不移动')
 await open.click();assert.equal(await select.inputValue(),'second','再打开恢复原会话的未保存选择');await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 await open.click();await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'})
 assert.equal(Object.values(await p.evaluate(()=>window.lightFixture.placements()))[0],'second')
})

test('行业任务表单：外点只收起并保留目标草稿，创建进行中外点与 Esc 都不关',async t=>{
 const p=await page(t),open=p.getByRole('button',{name:'打开行业任务',exact:true}),dialog=p.getByRole('dialog',{name:await tr(p,'market.industry.taskForm.aria'),exact:true})
 await open.click();const goal=dialog.locator('textarea').first();await goal.fill('行业任务草稿')
 await dragOut(p,dialog);assert.equal(await dialog.isVisible(),true)
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'});assert.deepEqual(await calls(p),[],'外点不创建')
 await open.click();assert.equal(await goal.inputValue(),'行业任务草稿','再打开恢复草稿')
 await dialog.getByRole('textbox',{name:await tr(p,'market.industry.taskForm.inputAria',{index:1,requirement:'需求一'}),exact:true}).fill('补充内容')
 await dialog.getByRole('button',{name:await tr(p,'market.industry.taskForm.create'),exact:true}).click();await p.waitForFunction(()=>window.lightFixture.calls.length===1)
 await p.mouse.click(3,3);await p.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true,'创建进行中不关闭')
 await p.evaluate(()=>window.lightFixture.release());await dialog.waitFor({state:'hidden'})
 await open.click();assert.equal(await goal.inputValue(),'','明确创建后下次从空白开始')
})

test('行业自动化表单：外点只收起，不创建',async t=>{
 const p=await page(t),open=p.getByRole('button',{name:'打开行业自动化',exact:true}),dialog=p.getByRole('dialog',{name:await tr(p,'market.industry.planForm.aria'),exact:true})
 await open.click();await dialog.getByRole('heading',{name:'行业模板自动化',exact:true}).waitFor()
 const goal=dialog.locator('textarea').first(),editable=await goal.isEditable()
 if(editable)await goal.fill('自动化草稿')
 await dragOut(p,dialog);assert.equal(await dialog.isVisible(),true)
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'});assert.deepEqual(await calls(p),[])
 await open.click();await dialog.getByRole('heading',{name:'行业模板自动化',exact:true}).waitFor()
 if(editable)assert.equal(await goal.inputValue(),'自动化草稿','再打开恢复草稿')
 await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
})

test('旧行业任务、业务任务：外点只收起并保留草稿，提交才写入',async t=>{
 const p=await page(t)
 const industry=p.getByRole('dialog',{name:await tr(p,'market.industry.taskForm.aria'),exact:true}),openIndustry=p.getByRole('button',{name:'打开旧行业任务',exact:true})
 await openIndustry.click();const goal=industry.locator('textarea').first();await goal.fill('旧任务草稿')
 await p.mouse.click(3,3);await industry.waitFor({state:'hidden'});await openIndustry.click();assert.equal(await goal.inputValue(),'旧任务草稿');await p.keyboard.press('Escape');await industry.waitFor({state:'hidden'})
 const business=p.getByRole('dialog',{name:await tr(p,'business.form.task.aria'),exact:true}),openBusiness=p.getByRole('button',{name:'打开业务任务',exact:true})
 await openBusiness.click();const name=business.locator('input').first();await name.fill('业务任务草稿')
 await dragOut(p,business);assert.equal(await business.isVisible(),true)
 await p.mouse.click(3,3);await business.waitFor({state:'hidden'});await openBusiness.click();assert.equal(await name.inputValue(),'业务任务草稿')
 await business.getByRole('button',{name:await tr(p,'business.form.close'),exact:true}).click();await business.waitFor({state:'hidden'})
 assert.deepEqual(await calls(p),[],'外点、Esc、关闭都不提交')
})

test('业务空间改名：外点保留改名草稿，保存进行中不关',async t=>{
 const p=await page(t),open=p.getByRole('button',{name:'打开业务空间',exact:true}),dialog=p.getByRole('dialog',{name:await tr(p,'business.space.edit'),exact:true}),name=dialog.locator('input').first()
 await open.click();assert.equal(await name.inputValue(),'个人工作');await name.fill('改名草稿')
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'});assert.deepEqual(await calls(p),[])
 await open.click();assert.equal(await name.inputValue(),'改名草稿')
 await dialog.getByRole('button',{name:await tr(p,'business.space.save'),exact:true}).click();await p.waitForFunction(()=>window.lightFixture.calls.length===1)
 await p.mouse.click(3,3);await p.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true,'保存进行中不关闭')
 await p.evaluate(()=>window.lightFixture.release());await dialog.waitFor({state:'hidden'})
 await open.click();assert.equal(await name.inputValue(),'改名草稿（已保存）','保存后按新版本打开宿主保存的名称，不残留旧版本草稿')
})
