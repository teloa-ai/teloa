import {test,before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {build} from 'vite'
// @ts-expect-error 复用当前工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

type Fixture={update:(target:'version'|'other'|'same')=>void;directory:(known:boolean,loading:boolean,error?:string,named?:boolean,self?:boolean)=>void;late:boolean;reject:()=>void;calls:string[];finishStop:()=>void;stopCalls:number;taskVersion:number;otherError:boolean}
declare global{interface Window{taskCurrentStateFixture:Fixture}}
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:Awaited<ReturnType<ReturnType<typeof loadPlaywright>['chromium']['launch']>>,script:string,styles:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {TaskDetail} from '${client}TaskDetail.tsx';import {TaskPage} from '${client}TaskPage.tsx';import {readTaskInputs} from '${client}task-inputs.ts';import {emptyTaskPreview} from '${client}task-preview.ts';import {emptyBusinessPreview} from '${client}business-preview.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {TaskExecutions} from '${client}TaskExecutions.tsx';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},at='2026-10-15T02:00:00Z',noop=()=>{};
const role={storage:'persistent',id:'owner-role',name:'Known investigator',kind:'employee',scopes:['general'],state:'active',version:1,duty:'Review',dataScope:'Assigned work',executionScope:'Read',skills:[],knowledge:[],memories:[],history:[]};
const initial={storage:'persistent',id:'original-task',title:'Original task',goal:'Keep the original goal',scope:'general',object:'Evidence',version:5,state:'running',need:null,request:'',authorId:'self',assigneeId:role.id,assigneeHistory:[],createdAt:at,updatedAt:at,result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:{key:'task.approval.risk.none'},execution:'running'};
const f=window.taskCurrentStateFixture={update:noop,directory:noop,late:false,reject:noop,calls:[],stopCalls:0,taskVersion:initial.version,otherError:false};
let currentRun={id:'current-run',taskId:initial.id,taskVersion:initial.version,roleVersion:1,sessionId:'run-session',nativeRequestId:'00000000-0000-4000-8000-000000000001',state:'active',stopRequestedAt:null,goal:initial.goal,roleName:role.name,createdAt:at,skills:[],knowledge:[]};
const runApi={origin:async()=>({taskId:initial.id,source:null}),list:async()=>[structuredClone(currentRun)],pending:()=>undefined,recoveryMessage:()=>undefined,reconcile:async()=>structuredClone(currentRun),stop:async()=>{f.stopCalls++;currentRun={...currentRun,stopRequestedAt:at};return structuredClone(currentRun)}};
f.finishStop=()=>{currentRun={...currentRun,state:'ended',reason:'aborted'}};
function App(){
 const [task,setTask]=React.useState(initial),[roles,setRoles]=React.useState([]),[directory,setDirectory]=React.useState({known:false,loading:true,error:undefined});
 f.taskVersion=task.version;
 const {known:roleDirectoryKnown,loading:roleLoading,error:roleLoadError}=directory,roleDirectory=FRAME_DIRECTORY;
 const [draft]=React.useState({...readTaskInputs({},initial),fields:{...readTaskInputs({},initial).fields,materialNote:'Keep my unsent task draft'}});
 f.update=target=>setTask(previous=>target==='version'?{...previous,version:previous.version+1}:target==='other'?{...previous,id:'different-task',version:8,title:'Different task'}:{...previous,title:'Renamed task'});
 f.directory=(known,loading,error,named=false,self=false)=>{setDirectory({known,loading,error});setRoles(named?[role]:[]);setTask(previous=>({...previous,assigneeId:self?'self':role.id}));};
 const change=async action=>{f.calls.push(action.action);if(action.action==='cancel'){if(f.otherError)throw Object.assign(Error('not allowed'),{code:'teloa/forbidden'});if(f.late)await new Promise((_,reject)=>f.reject=()=>reject(Object.assign(Error('Stop this run before cancelling the task.'),{code:'teloa/conflict',details:{reason:'task-work-outstanding'}})));throw Object.assign(Error('Stop this run before cancelling the task.'),{code:'teloa/conflict',details:{reason:'task-work-outstanding'}});}setTask(previous=>({...previous,state:'paused'}));};
 const props={attentionNeeds:[],attention:null,attentionReason:undefined,securityItems:[],securityActions:null,industrySource:null,executions:onRuns=>document.documentElement.dataset.surface==='runs'?<TaskExecutions taskId={task.id} taskVersion={task.version} taskState={task.state} assigned api={runApi} open={async()=>{}} changed={noop} onRuns={onRuns}/>:null,knowledge:null,handoffs:null,handoffRows:[],conversations:()=>null,draft,patch:noop,clear:noop,review:noop,openArtifacts:noop,openPlans:noop,task,approvals:[],artifacts:[],change,back:noop,backHidden:false,openSource:noop,roles,roleDirectory,team:noop,openRole:noop,business:emptyBusinessPreview(),openBusiness:noop,saveTemplate:noop};
 const persistence={directoryKnown:true,attention:{rows:[],known:true},handoffs:{rows:[]},completion:{},stateRequest:undefined,stateError:undefined,recoverState:async()=>{},edit:async()=>{},create:async()=>'',pendingFields:()=>undefined,load:noop,loading:false,error:undefined};
 return document.documentElement.dataset.surface==='page'?<TaskPage {...props} persistence={persistence} visible mode="tasks" state={{...emptyTaskPreview(),tasks:[task],roles}} selected={task.id} select={noop} attentionItems={[]} switchMode={noop} openAttention={noop}/>:<TaskDetail {...props}/>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><I18nProvider runtime={runtime}><App/></I18nProvider></React.StrictMode>);
`
before(async()=>{
 const frame=ts.createSourceFile('WorkbenchFrame.tsx',await readFile(client+'WorkbenchFrame.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let directory='undefined'
 const visit=(node:ts.Node)=>{if((ts.isJsxSelfClosingElement(node)||ts.isJsxOpeningElement(node))&&node.tagName.getText(frame)==='TaskPage'){const attribute=node.attributes.properties.find(value=>ts.isJsxAttribute(value)&&value.name.getText(frame)==='roleDirectory');if(attribute&&ts.isJsxAttribute(attribute)&&attribute.initializer&&ts.isJsxExpression(attribute.initializer))directory=attribute.initializer.expression?.getText(frame)??'undefined'}ts.forEachChild(node,visit)};visit(frame)
 const virtual=root+'__task_detail_current_state.tsx',fixture=entry.replace('FRAME_DIRECTORY',directory)
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'task-detail-current-state',resolveId:id=>id.endsWith('task-detail-current-state')?virtual:null,load:id=>id===virtual?fixture:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'task-detail-current-state',name:'TaskDetailCurrentState',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function mount(t:TestContext,surface='detail',locale='en'){
 const page=await browser.newPage({viewport:{width:1150,height:950}}),errors:string[]=[];page.setDefaultTimeout(2500);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 const url='http://127.0.0.1:49327/task-detail-current-state';await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.route(url,(route:{fulfill:(response:{status:number;contentType:string;body:string})=>Promise<void>})=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="'+locale+'" data-surface="'+surface+'"><body><div id="root"></div></body></html>'}));await page.goto(url);await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.locator('[data-teloa-pane="detail"]').waitFor();return page
}
async function cancel(page:Awaited<ReturnType<typeof mount>>){await page.getByRole('button',{name:'More actions',exact:true}).click();await page.getByRole('menuitem',{name:'Cancel task',exact:true}).click()}
async function memberLabel(page:Awaited<ReturnType<typeof mount>>,label:string){await page.locator('[data-teloa-entry="original-task"]').getByText(label,{exact:true}).waitFor();await page.locator('[data-teloa-pane="detail"] dl').first().getByText(label,{exact:true}).waitFor()}
const stopError='Stop this run before cancelling the task.'
test('当前版本错误保留，任务版本更新后旧取消错误消失且未提交输入保留',async t=>{
 const page=await mount(t);await cancel(page);await page.getByRole('alert').filter({hasText:stopError}).waitFor()
 await page.evaluate(()=>window.taskCurrentStateFixture.update('same'));assert.equal(await page.getByRole('alert').innerText(),stopError)
 await page.evaluate(()=>window.taskCurrentStateFixture.update('version'));await page.waitForFunction(()=>!document.querySelector('[role="alert"]'))
 await page.getByText('Retained unsubmitted input · This page only',{exact:true}).click();assert.equal(await page.getByText('Keep my unsent task draft',{exact:true}).isVisible(),true)
})
test('同一任务停止操作成功后清除当前取消错误',async t=>{
 const page=await mount(t);await cancel(page);await page.getByRole('alert').waitFor();
 // 任务级暂停只对本人/非执行型任务开放；交给员工的运行型任务由运行控制推进，这里切成本人任务验证原语义。
 await page.evaluate(()=>window.taskCurrentStateFixture.directory(true,false,undefined,true,true))
 await page.getByRole('button',{name:'More actions',exact:true}).click();await page.getByRole('menuitem',{name:'Pause task',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role="alert"]'));assert.deepEqual(await page.evaluate(()=>window.taskCurrentStateFixture.calls),['cancel','pause'])
})
test('真实运行停止必须等终态才清先停止提示，任务版本不变也清除且保留草稿',async t=>{
 const page=await mount(t,'runs');await page.getByRole('button',{name:'View run',exact:true}).click();await page.getByRole('button',{name:'Stop',exact:true}).waitFor()
 await cancel(page);await page.getByRole('alert').filter({hasText:stopError}).waitFor()
 await page.getByRole('button',{name:'Stop',exact:true}).click()
 await page.getByText('Stop requested. Waiting for the runner to finish.',{exact:true}).waitFor()
 assert.equal(await page.getByRole('alert').filter({hasText:stopError}).count(),1,'受理停止不是执行收口')
 await page.evaluate(()=>window.taskCurrentStateFixture.finishStop())
 await page.getByRole('button',{name:'Check run status',exact:true}).click()
 await page.waitForFunction(()=>!document.querySelector('[role="alert"]'))
 assert.equal(await page.evaluate(()=>window.taskCurrentStateFixture.taskVersion),5)
 assert.equal(await page.evaluate(()=>window.taskCurrentStateFixture.stopCalls),1)
 await page.getByText('Retained unsubmitted input · This page only',{exact:true}).click();assert.equal(await page.getByText('Keep my unsent task draft',{exact:true}).isVisible(),true)
})
test('运行收口只清过时先停止错误，保留当前版本的其他错误',async t=>{
 const page=await mount(t,'runs');await page.getByRole('button',{name:'View run',exact:true}).click();await page.getByRole('button',{name:'Stop',exact:true}).waitFor()
 await page.evaluate(()=>{window.taskCurrentStateFixture.otherError=true});await cancel(page);await page.getByRole('alert').waitFor()
 const message=await page.getByRole('alert').innerText()
 await page.evaluate(()=>window.taskCurrentStateFixture.finishStop());await page.getByRole('button',{name:'Check run status',exact:true}).click()
 await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'})
 assert.equal(await page.getByRole('alert').innerText(),message)
})
test('既有终态快照不能吞掉随后服务端新返回的先停止错误',async t=>{
 const page=await mount(t,'runs');await page.getByRole('button',{name:'View run',exact:true}).click()
 await page.evaluate(()=>window.taskCurrentStateFixture.finishStop());await page.getByRole('button',{name:'Check run status',exact:true}).click()
 await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'})
 await cancel(page);await page.getByRole('alert').filter({hasText:stopError}).waitFor()
})
test('同版本运行已核实收口后迟到的旧取消失败不重新显示先停止提示',async t=>{
 const page=await mount(t,'runs');await page.getByRole('button',{name:'View run',exact:true}).click()
 await page.evaluate(()=>{window.taskCurrentStateFixture.late=true});await cancel(page);await page.waitForFunction(()=>window.taskCurrentStateFixture.calls.length===1)
 await page.evaluate(()=>window.taskCurrentStateFixture.finishStop());await page.getByRole('button',{name:'Check run status',exact:true}).click()
 await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'})
 await page.evaluate(()=>window.taskCurrentStateFixture.reject())
 await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')?.disabled)
 assert.equal(await page.getByRole('alert').count(),0)
})
test('旧任务和旧版本的迟到取消失败不能污染当前详情',async t=>{
 for(const target of ['version','other'] as const){const page=await mount(t);await page.evaluate(()=>{window.taskCurrentStateFixture.late=true});await cancel(page);await page.waitForFunction(()=>window.taskCurrentStateFixture.calls.length===1);await page.evaluate((target:'version'|'other')=>window.taskCurrentStateFixture.update(target),target);await page.evaluate(()=>window.taskCurrentStateFixture.reject());await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')?.disabled);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.getByRole('alert').count(),0)}
})
test('刷新任务目录和详情都区分成员加载、读取失败与确认缺失，并优先保留姓名和本人',async t=>{
 const page=await mount(t,'page');await memberLabel(page,'Loading member…');assert.equal(await page.getByText('Former member',{exact:true}).count(),0)
 await page.evaluate(()=>window.taskCurrentStateFixture.directory(false,false,'Directory unavailable'));await memberLabel(page,'Member unavailable');assert.equal(await page.getByText('Former member',{exact:true}).count(),0)
 await page.evaluate(()=>window.taskCurrentStateFixture.directory(true,true,'Directory unavailable',true));await memberLabel(page,'Known investigator');await page.getByRole('button',{name:'Known investigator',exact:true}).waitFor();assert.equal(await page.getByText('Member unavailable',{exact:true}).count(),0)
 await page.evaluate(()=>window.taskCurrentStateFixture.directory(true,false));await memberLabel(page,'Former member')
 await page.evaluate(()=>window.taskCurrentStateFixture.directory(false,true,undefined,false,true));await memberLabel(page,'Me');assert.equal(await page.getByText('Loading member…',{exact:true}).count(),0)
})
test('成员目录新增状态使用简中繁中英文，区域繁体沿用对应词条',async t=>{
 for(const [locale,loading,failed] of [['zh-CN','正在加载成员…','成员信息暂不可用'],['zh-Hant','正在載入成員…','成員資料暫時無法取得'],['zh-TW','正在載入成員…','成員資料暫時無法取得'],['zh-HK','正在載入成員…','成員資料暫時無法取得'],['en','Loading member…','Member unavailable']] as const){const page=await mount(t,'page',locale);await memberLabel(page,loading);await page.evaluate(()=>window.taskCurrentStateFixture.directory(false,false,'Directory unavailable'));await memberLabel(page,failed)}
})
