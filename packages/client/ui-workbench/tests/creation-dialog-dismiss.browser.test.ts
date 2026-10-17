import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import type {TaskDefinition} from '@teloa/contract'
import type {PreviewTask} from '../src/client/task-preview.ts'
import type {PreviewRole,RoleFields} from '../src/client/role-preview.ts'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// N13：新会话、员工、任务等创建轻窗口统一外点关闭；关闭只收起并保留草稿，只有明确提交才写入。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
type CreationEdit={kind:'task';id:PreviewTask['id'];version:PreviewTask['version'];fields:Pick<TaskDefinition,'title'|'goal'>}|{kind:'role';id:PreviewRole['id'];version:PreviewRole['version'];fields:RoleFields}
declare global {interface Window {creationScopeDirectory?:boolean;creationDismissFixture:{groupDraft?:TaskDefinition;groupSaves:{fields:TaskDefinition;assignee?:{roleId:string;expectedVersion:number}}[];reviewSaves:TaskDefinition[];saved:string[];taskDraft?:{title:string;goal:string};roleDraft?:{name:string};release:()=>void;setBusy:(value:boolean)=>void;inlineRenders:number;inlineDraftCalls:number;refreshInlineParent:()=>void;refreshTask:()=>void;refreshRole:()=>void;failTask:boolean;failRole:boolean;edits:CreationEdit[];objects:()=>{task:Pick<PreviewTask,'id'|'version'|'title'|'goal'>;role:Pick<PreviewRole,'id'|'version'|'name'|'duty'|'dataScope'|'executionScope'>}}}}
const entry=`
import tokens from '${client}theme-tokens.module.css';import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {TaskForm} from '${client}TaskPage.tsx';import {TaskDetail} from '${client}TaskDetail.tsx';import {RoleForm,RoleDetail} from '${client}TeamPage.tsx';import {CreateConversationDialog} from '${client}CreateConversationDialog.tsx';import {ConversationScopeDialog} from '${client}ConversationScopeDialog.tsx';import {readTaskInputs} from '${client}task-inputs.ts';import {emptyTaskPreview} from '${client}task-preview.ts';import {emptyCollaboration} from '${client}collaboration-preview.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const work={readHomeSkills:async()=>[]},resources={directory:async()=>({resources:[]}),sources:async()=>[]};
const managed={ready:true,baseline:true,archived:[],workspaces:[{workspaceId:'w1',title:'主工作区',path:'/tmp/w1',sessionIds:[]}],pending:{},copies:{},uncertain:[],copyHistory:[]},management={subscribe:()=>()=>{},getSnapshot:()=>managed};
const f=window.creationDismissFixture={groupSaves:[],reviewSaves:[],saved:[],release:()=>{},setBusy:()=>{},inlineRenders:0,inlineDraftCalls:0,refreshInlineParent:()=>{},refreshTask:()=>{},refreshRole:()=>{},failTask:true,failRole:true,edits:[],objects:()=>({})};
const taskDraft=value=>{f.taskDraft=value},roleDraft=value=>{f.roleDraft=value};
const at='2026-10-14T02:00:00.000Z',noop=()=>{},preview=emptyTaskPreview(),collaboration=emptyCollaboration();
const originalTask={storage:'persistent',id:'original-task',version:4,title:'原任务标题',goal:'原任务目标',scope:'general',object:'本机任务',state:'ready',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:[],createdAt:at,updatedAt:at,result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:{key:'task.approval.risk.none'},execution:'not_started'};
const originalRole={storage:'persistent',id:'original-role',version:7,name:'原员工名称',kind:'employee',state:'paused',scopes:['general'],duty:'原岗位职责',dataScope:'只读原群已共享资料',executionScope:'只读核对，执行须本人确认',skills:[],knowledge:[],memories:[],history:[]};
function InlineTaskFixture({close}){
 const [draft,setDraft]=useState(),[revision,setRevision]=useState(0);f.refreshInlineParent=()=>setRevision(value=>value+1);
 if(++f.inlineRenders>16)throw Error('内联草稿回调触发重复父子渲染');
 return <TaskForm persistent initial={{title:'内联原标题',goal:'内联原目标',scope:'general',groupId:null,skills:[]}} onDraft={fields=>{f.inlineDraftCalls++;setDraft({...fields})}} close={close} save={()=>{f.saved.push('inline')}}/>;
}
function EditObjects({kind}){
 const [task,setTask]=useState(originalTask),[role,setRole]=useState(originalRole);f.objects=()=>({task,role});
 f.refreshTask=()=>setTask(current=>({...current,version:current.version+4,title:'另一端任务标题',goal:'另一端任务目标'}));f.refreshRole=()=>setRole(current=>({...current,version:current.version+3,name:'另一端员工姓名',duty:'另一端员工职责'}));
 const editTask=async(baseline,fields)=>{f.edits.push({kind:'task',id:baseline.id,version:baseline.version,fields});if(f.failTask)throw Object.assign(Error(),{code:'teloa/version-conflict'});setTask({...baseline,...fields,version:baseline.version+1});f.saved.push('task-edit')};
 const editRole=async(baseline,fields)=>{f.edits.push({kind:'role',id:baseline.id,version:baseline.version,fields});if(f.failRole)throw Object.assign(Error(),{code:'teloa/version-conflict'});setRole({...baseline,...fields,version:baseline.version+1});f.saved.push('role-edit')};
 return kind==='taskDetail'?<TaskDetail attentionNeeds={[]} attention={null} attentionReason={undefined} securityItems={[]} securityActions={null} industrySource={null} executions={()=>null} knowledge={null} handoffs={null} handoffRows={[]} editSaved={editTask} conversations={()=>null} draft={readTaskInputs({},task)} patch={noop} clear={noop} review={noop} openArtifacts={noop} openPlans={noop} task={task} approvals={[]} artifacts={[]} change={()=>{throw Error('不得转向演示写口')}} back={noop} backHidden={false} openSource={noop} roles={[]} team={noop} openRole={noop} business={preview.business} openBusiness={noop} saveTemplate={noop}/>:<RoleDetail work={work} resourceApi={resources} role={role} input={{draft:undefined,editing:false}} update={noop} state={{...preview,roles:[role]}} collaboration={collaboration} change={()=>{throw Error('不得转向演示写口')}} back={noop} openTask={noop} openGroup={noop} resources={noop} nativeSettings={noop} capabilities={()=>null} plans={()=>null} conversations={()=>null} persistence={{edit:editRole,lifecycle:{pending:undefined,error:undefined,change:async()=>{throw Error('不得改变生命周期')},recover:async()=>{}}}}/>;
}
document.body.className=tokens.tokens;
function App(){
 const [open,setOpen]=useState(null),[busy,setBusy]=useState(false);f.setBusy=setBusy;
 const close=()=>setOpen(null);
 return <main id="teloa-main" tabIndex={-1}>
  <button onClick={()=>setOpen('reviewTask')}>打开复核任务</button><button onClick={()=>setOpen('groupTask')}>打开群任务</button><button onClick={()=>setOpen('task')}>打开任务</button><button onClick={()=>setOpen('role')}>打开员工</button><button onClick={()=>setOpen('conversation')}>打开会话</button><button onClick={()=>setOpen('scope')}>打开范围</button><button onClick={()=>setOpen('inlineTask')}>打开内联任务</button><button onClick={()=>setOpen('taskDetail')}>打开原任务详情</button><button onClick={()=>setOpen('roleDetail')}>打开原员工详情</button>
  {open==='task'&&<TaskForm persistent initial={f.taskDraft?{...f.taskDraft,scope:'general',groupId:null,skills:[]}:undefined} onDraft={taskDraft} close={close} save={value=>{f.saved.push('task:'+value.title);return new Promise(resolve=>{f.release=()=>{resolve();f.taskDraft=undefined;close()}})}}/>}
  {open==='groupTask'&&<TaskForm persistent initial={f.groupDraft??{title:'',goal:'',scope:'SOC',groupId:'10000000-0000-4000-8000-000000000001',skills:[]}} groups={[{id:'10000000-0000-4000-8000-000000000001',name:'安全项目群',scope:'SOC'},{id:'10000000-0000-4000-8000-000000000002',name:'其他业务群',scope:'general'}]} assignees={[{id:'20000000-0000-4000-8000-000000000001',name:'安全研究员',version:4,scopes:['SOC']}]} initialAssigneeId="20000000-0000-4000-8000-000000000001" onDraft={value=>{f.groupDraft=value}} close={close} save={(fields,assignee)=>{f.groupSaves.push({fields,assignee});close()}}/>}
  {open==='reviewTask'&&<TaskForm persistent review initial={{title:'已核对的原标题',goal:'原复核目标',scope:'SOC',groupId:'10000000-0000-4000-8000-000000000001',skills:['原技能']}} groups={[{id:'10000000-0000-4000-8000-000000000001',name:'安全项目群',scope:'SOC'}]} close={close} save={fields=>{f.reviewSaves.push(fields);close()}}/>}
  {open==='role'&&<RoleForm work={work} resourceApi={resources} persistent={false} initial={f.roleDraft} onDraft={roleDraft} close={close} save={value=>{f.saved.push('role:'+value.name)}}/>}
  {open==='conversation'&&<CreateConversationDialog management={management} current={undefined} initialWorkspaceId={undefined} pendingRequestId={undefined} restart={()=>{}} locked={false} busy={busy} goal="原目标草稿" create={async()=>{f.saved.push('conversation')}} close={close} settings={()=>{}}/>}
  {open==='scope'&&<ConversationScopeDialog name="研究员" options={[{id:'general',label:'通用'},{id:'SOC',label:'安全运营'}]} close={close} select={scope=>{f.saved.push('scope:'+scope)}}/>}
  {open==='inlineTask'&&<InlineTaskFixture close={close}/>}
  {(open==='taskDetail'||open==='roleDetail')&&<EditObjects kind={open}/>}
 </main>;
}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}>{window.creationScopeDirectory===false?<App/>:<BusinessScopeProvider labels={[{scope:'general',title:'通用工作',kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0},{scope:'SOC',title:'安全运营',kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}]}><App/></BusinessScopeProvider>}</I18nProvider>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-creation-dismiss-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'CreationDismissFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

async function page(t:any,scopeDirectory=true){
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[]
 page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')
 await page.evaluate((value:boolean)=>{window.creationScopeDirectory=value},scopeDirectory)
 await page.addStyleTag({content:'body{margin:0;font:14px system-ui}'+styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'打开任务',exact:true}).waitFor()
 return page
}
const state=(page:any)=>page.evaluate(()=>({saved:window.creationDismissFixture.saved,taskDraft:window.creationDismissFixture.taskDraft,roleDraft:window.creationDismissFixture.roleDraft}))
async function dragOut(page:any,dialog:any){const box=await dialog.boundingBox();assert.ok(box);await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.mouse.move(3,3);await page.mouse.up()}

test('任务表单：外点、Esc、取消只收起并保留草稿，拖出不关，保存中不关，只有创建才写入',async t=>{
 const p=await page(t),open=p.getByRole('button',{name:'打开任务',exact:true}),dialog=p.getByRole('dialog',{name:'交办一项工作',exact:true}),title=()=>dialog.getByLabel('任务名称',{exact:true})
 await open.click();await dialog.locator('summary').filter({hasText:'更多选项'}).click();await title().fill('未保存的任务草稿')
 await dragOut(p,dialog);assert.equal(await dialog.isVisible(),true,'窗内按下窗外松开不关闭')
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'})
 assert.deepEqual((await state(p)).saved,[],'外点不创建任务');assert.equal((await state(p)).taskDraft?.title,'未保存的任务草稿','关闭时草稿已回传')
 assert.equal(await open.evaluate((node:HTMLElement)=>document.activeElement===node),true,'焦点回到入口')
 await open.click();await dialog.locator('summary').filter({hasText:'更多选项'}).click();assert.equal(await title().inputValue(),'未保存的任务草稿');await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 await open.click();await dialog.locator('summary').filter({hasText:'更多选项'}).click();assert.equal(await title().inputValue(),'未保存的任务草稿');await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'})
 await open.click();await dialog.locator('summary').filter({hasText:'更多选项'}).click();await dialog.getByLabel('工作目标',{exact:true}).fill('整理目标');await dialog.getByRole('button',{name:'创建任务',exact:true}).click()
 await p.waitForFunction(()=>window.creationDismissFixture.saved.length===1)
 await p.mouse.click(3,3);await p.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true,'保存进行中外点与 Esc 都不关闭')
 await p.evaluate(()=>window.creationDismissFixture.release());await dialog.waitFor({state:'hidden'})
 assert.deepEqual((await state(p)).saved,['task:未保存的任务草稿'])
 await open.click();await dialog.locator('summary').filter({hasText:'更多选项'}).click();assert.equal(await title().inputValue(),'','明确创建后下次从空白开始')
})

test('员工表单：外点只收起并保留姓名草稿，noValidate 的产品错误提示不受影响，不保存',async t=>{
 const p=await page(t),open=p.getByRole('button',{name:'打开员工',exact:true}),dialog=p.getByRole('dialog',{name:'添加 AI 员工',exact:true}),name=()=>dialog.locator('input[maxlength="80"]').first()
 await open.click();await name().fill('张三草稿')
 await dragOut(p,dialog);assert.equal(await dialog.isVisible(),true)
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'})
 assert.deepEqual((await state(p)).saved,[]);assert.equal((await state(p)).roleDraft?.name,'张三草稿')
 await open.click();assert.equal(await name().inputValue(),'张三草稿')
 assert.equal(await dialog.locator('form').evaluate((form:HTMLFormElement)=>form.noValidate),true,'保留 noValidate，由产品自己校验')
 await name().fill('');await dialog.locator('form button[type=submit]').first().click();await dialog.getByRole('alert').first().waitFor()
 assert.equal(await dialog.isVisible(),true,'产品错误提示仍显示在同一窗口');await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.deepEqual((await state(p)).saved,[])
})

test('新建会话与会话范围：外点只收起，不创建会话；会话忙碌时外点与 Esc 都不关闭',async t=>{
 const p=await page(t),conversation=p.getByRole('dialog',{name:'新建工作会话',exact:true}),scope=p.getByRole('dialog',{name:'选择会话范围',exact:true})
 await p.getByRole('button',{name:'打开会话',exact:true}).click();await conversation.getByRole('combobox').waitFor()
 await dragOut(p,conversation);assert.equal(await conversation.isVisible(),true)
 await p.mouse.click(3,3);await conversation.waitFor({state:'hidden'});assert.deepEqual((await state(p)).saved,[])
 await p.evaluate(()=>window.creationDismissFixture.setBusy(true));await p.getByRole('button',{name:'打开会话',exact:true}).click();await conversation.waitFor()
 await p.mouse.click(3,3);await p.keyboard.press('Escape');assert.equal(await conversation.isVisible(),true,'忙碌时不关闭')
 // Chrome 对被阻止过的 cancel 要求新的用户激活（Esc 不算），先在窗内点一下再按 Esc。
 await p.evaluate(()=>window.creationDismissFixture.setBusy(false));await conversation.getByRole('heading',{name:'新建工作会话',exact:true}).click();await p.keyboard.press('Escape');await conversation.waitFor({state:'hidden'})
 await p.getByRole('button',{name:'打开范围',exact:true}).click();await scope.waitFor();await p.mouse.click(3,3);await scope.waitFor({state:'hidden'});assert.deepEqual((await state(p)).saved,[])
 await p.getByRole('button',{name:'打开范围',exact:true}).click();await scope.getByRole('button',{name:'开始会话',exact:true}).click();assert.deepEqual((await state(p)).saved,['scope:general'],'只有明确开始才选择范围')
})

test('任务草稿内联回调只在输入改变时回传，父页更新不会造成重渲染循环或重置输入',async t=>{
 const p=await page(t);await p.getByRole('button',{name:'打开内联任务',exact:true}).click()
 const dialog=p.getByRole('dialog',{name:'交办一项工作',exact:true}),title=dialog.getByLabel('任务名称',{exact:true})
 await dialog.locator('summary').filter({hasText:'更多选项'}).click();await title.waitFor();await p.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
 assert.equal(await title.inputValue(),'内联原标题');assert.equal(await p.evaluate(()=>window.creationDismissFixture.inlineDraftCalls),1,'挂载仅回传一份初始草稿')
 const before=await p.evaluate(()=>window.creationDismissFixture.inlineRenders);await p.evaluate(()=>window.creationDismissFixture.refreshInlineParent())
 await p.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
 assert.equal(await p.evaluate(()=>window.creationDismissFixture.inlineRenders),before+1,'父页更新只重渲染一次')
 assert.equal(await p.evaluate(()=>window.creationDismissFixture.inlineDraftCalls),1,'内联函数身份变化不重新回传草稿')
 await title.fill('内联编辑草稿');await p.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
 assert.equal(await title.inputValue(),'内联编辑草稿');assert.equal(await p.evaluate(()=>window.creationDismissFixture.inlineDraftCalls),2,'实际字段变更仍回传')
 assert.deepEqual((await state(p)).saved,[])
})

test('原任务详情编辑失败后外点重开保留标题与目标，保存仍核对原任务版本',async t=>{
 const p=await page(t);await p.getByRole('button',{name:'打开原任务详情',exact:true}).click()
 const detail=p.getByRole('article',{name:'任务详情',exact:true}),edit=detail.getByRole('button',{name:'修改任务目标',exact:true}),dialog=p.getByRole('dialog',{name:'修改任务目标',exact:true})
 await edit.click();const title=dialog.getByRole('textbox',{name:'任务名称',exact:true}),goal=dialog.getByRole('textbox',{name:'工作目标',exact:true})
 assert.equal(await title.inputValue(),'原任务标题');assert.equal(await goal.inputValue(),'原任务目标')
 await title.fill('原任务待保存标题');await goal.fill('原任务待保存目标');await dialog.getByRole('button',{name:'保存目标',exact:true}).click();await dialog.getByRole('alert').waitFor()
 assert.deepEqual(await p.evaluate(()=>window.creationDismissFixture.edits),[{kind:'task',id:'original-task',version:4,fields:{title:'原任务待保存标题',goal:'原任务待保存目标'}}])
 assert.equal((await p.evaluate(()=>window.creationDismissFixture.objects())).task.version,4);assert.deepEqual((await state(p)).saved,[],'失败不能清空草稿或伪装保存成功')
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'});await edit.click()
 assert.equal(await title.inputValue(),'原任务待保存标题');assert.equal(await goal.inputValue(),'原任务待保存目标')
 await p.evaluate(()=>{window.creationDismissFixture.failTask=false});await dialog.getByRole('button',{name:'保存目标',exact:true}).click();await dialog.waitFor({state:'hidden'})
 assert.deepEqual((await p.evaluate(()=>window.creationDismissFixture.edits)).map((row:CreationEdit)=>[row.id,row.version]),[['original-task',4],['original-task',4]],'重试仍使用同一任务与编辑基线')
 assert.deepEqual((await state(p)).saved,['task-edit']);assert.equal((await p.evaluate(()=>window.creationDismissFixture.objects())).task.version,5)
 await edit.click();assert.equal(await title.inputValue(),'原任务待保存标题');assert.equal(await goal.inputValue(),'原任务待保存目标')
 await title.fill('第二轮未保存标题');await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await edit.click();assert.equal(await title.inputValue(),'第二轮未保存标题')
 await p.evaluate(()=>{window.creationDismissFixture.failTask=true;window.creationDismissFixture.refreshTask()});await dialog.getByRole('button',{name:'保存目标',exact:true}).click();await dialog.getByRole('alert').waitFor()
 assert.equal((await p.evaluate(()=>window.creationDismissFixture.objects())).task.version,9,'只读刷新可呈现另一端新版本')
 assert.equal((await p.evaluate(()=>window.creationDismissFixture.edits)).at(-1)!.version,5,'保存使用打开编辑时的原版本，不悄悄采纳刷新版本')
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'});await edit.click();assert.equal(await title.inputValue(),'第二轮未保存标题');assert.equal(await goal.inputValue(),'原任务待保存目标')
 await dialog.getByRole('button',{name:'保存目标',exact:true}).click();await dialog.getByRole('alert').waitFor()
 assert.deepEqual((await p.evaluate(()=>window.creationDismissFixture.edits)).slice(-2).map((row:CreationEdit)=>[row.id,row.version]),[['original-task',5],['original-task',5]],'失败关闭重开仍核对同一原编辑基线')
 assert.deepEqual((await state(p)).saved,['task-edit'])
})

test('原员工详情编辑失败后外点重开保留姓名与职责，原身份版本与授权边界不变',async t=>{
 const p=await page(t);await p.getByRole('button',{name:'打开原员工详情',exact:true}).click()
 await p.getByRole('button',{name:'更多员工操作',exact:true}).click();await p.getByRole('button',{name:'员工管理',exact:true}).click()
 const management=p.getByRole('dialog',{name:'员工管理',exact:true}),edit=management.getByRole('button',{name:'编辑职责与范围',exact:true}),dialog=p.getByRole('dialog',{name:'编辑员工',exact:true})
 await edit.click();const name=dialog.getByRole('textbox',{name:'员工名称',exact:true}),duty=dialog.getByRole('textbox',{name:'岗位使命',exact:true})
 assert.equal(await name.inputValue(),'原员工名称');assert.equal(await duty.inputValue(),'原岗位职责')
 await name.fill('原员工待保存姓名');await duty.fill('原员工待保存职责')
 for(let step=0;step<4;step++)await dialog.getByRole('button',{name:'下一步',exact:true}).click()
 await dialog.getByRole('button',{name:'保存员工',exact:true}).click();await dialog.getByRole('alert').waitFor()
 const failed=(await p.evaluate(()=>window.creationDismissFixture.edits))[0]
 assert.equal(failed.kind,'role');assert.equal(failed.id,'original-role');assert.equal(failed.version,7);assert.equal(failed.fields.name,'原员工待保存姓名');assert.equal(failed.fields.duty,'原员工待保存职责')
 assert.equal(failed.fields.dataScope,'只读原群已共享资料');assert.equal(failed.fields.executionScope,'只读核对，执行须本人确认');assert.deepEqual((await state(p)).saved,[])
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'});await edit.click()
 assert.equal(await name.inputValue(),'原员工待保存姓名');assert.equal(await duty.inputValue(),'原员工待保存职责')
 const original=(await p.evaluate(()=>window.creationDismissFixture.objects())).role;assert.equal(original.id,'original-role');assert.equal(original.version,7);assert.equal(original.name,'原员工名称');assert.equal(original.duty,'原岗位职责')
 await p.evaluate(()=>{window.creationDismissFixture.failRole=false});for(let step=0;step<4;step++)await dialog.getByRole('button',{name:'下一步',exact:true}).click()
 await dialog.getByRole('button',{name:'保存员工',exact:true}).click();await dialog.waitFor({state:'hidden'})
 assert.deepEqual((await p.evaluate(()=>window.creationDismissFixture.edits)).map((row:CreationEdit)=>[row.id,row.version]),[['original-role',7],['original-role',7]])
 const saved=(await p.evaluate(()=>window.creationDismissFixture.objects())).role;assert.equal(saved.id,'original-role');assert.equal(saved.version,8);assert.equal(saved.name,'原员工待保存姓名');assert.equal(saved.duty,'原员工待保存职责');assert.equal(saved.dataScope,original.dataScope);assert.equal(saved.executionScope,original.executionScope)
 assert.deepEqual((await state(p)).saved,['role-edit']);await edit.click();assert.equal(await name.inputValue(),'原员工待保存姓名');assert.equal(await duty.inputValue(),'原员工待保存职责')
 await name.fill('第二轮员工姓名');await duty.fill('第二轮员工职责');await p.evaluate(()=>{window.creationDismissFixture.failRole=true;window.creationDismissFixture.refreshRole()})
 for(let step=0;step<4;step++)await dialog.getByRole('button',{name:'下一步',exact:true}).click();await dialog.getByRole('button',{name:'保存员工',exact:true}).click();await dialog.getByRole('alert').waitFor()
 assert.equal((await p.evaluate(()=>window.creationDismissFixture.objects())).role.version,11);assert.equal((await p.evaluate(()=>window.creationDismissFixture.edits)).at(-1)!.version,8)
 await p.mouse.click(3,3);await dialog.waitFor({state:'hidden'});await edit.click();assert.equal(await name.inputValue(),'第二轮员工姓名');assert.equal(await duty.inputValue(),'第二轮员工职责')
 for(let step=0;step<4;step++)await dialog.getByRole('button',{name:'下一步',exact:true}).click();await dialog.getByRole('button',{name:'保存员工',exact:true}).click();await dialog.getByRole('alert').waitFor()
 assert.deepEqual((await p.evaluate(()=>window.creationDismissFixture.edits)).slice(-2).map((row:CreationEdit)=>[row.id,row.version]),[['original-role',8],['original-role',8]],'目录刷新与重开不能更换保存失败的员工编辑基线')
 assert.deepEqual((await state(p)).saved,['role-edit'])
})


test('群任务以一段Markdown创建，继承业务与群且仅按需补选，完整原文和手改名称保留',async t=>{
 const p=await page(t),open=p.getByRole('button',{name:'打开群任务',exact:true}),dialog=p.getByRole('dialog',{name:'交办一项工作',exact:true})
 await open.click()
 const goal=dialog.getByRole('textbox',{name:'工作目标',exact:true})
 await goal.waitFor();assert.deepEqual({textareas:await dialog.locator('textarea').count(),hasExample:/例如.*Markdown/s.test(await goal.getAttribute('placeholder')??''),visibleSelects:await dialog.getByRole('combobox').count(),visibleName:await dialog.getByRole('textbox',{name:'任务名称',exact:true}).count()},{textareas:1,hasExample:true,visibleSelects:0,visibleName:0},'主路径为一段描述与短例，其余字段按需展开')
 assert.equal(await goal.evaluate((element:HTMLElement)=>document.activeElement===element),true)
 assert.match(await dialog.textContent(),/安全项目群/)
 const markdown='核对发布资料\n\n- 保留 **完整 Markdown**\n- 列出尚缺资料；先给摘要，不发布。\n'
 await goal.fill(markdown)
 await dialog.locator('summary').filter({hasText:'更多选项'}).click()
 const title=dialog.getByRole('textbox',{name:'任务名称',exact:true})
 assert.equal(await title.inputValue(),'核对发布资料')
 assert.equal(await dialog.getByRole('combobox',{name:/^主责范围/}).inputValue(),'SOC');assert.equal(await dialog.getByRole('combobox',{name:/^关联协作群/}).inputValue(),'10000000-0000-4000-8000-000000000001')
 await title.fill('本人拟定的任务名');await dialog.getByLabel('使用技能（可选）',{exact:true}).fill('check-one、check-two')
 const complete=markdown+'\n只核对已有资料。\n';await goal.fill(complete);assert.equal(await title.inputValue(),'本人拟定的任务名','手改名称后继续写目标不能覆盖名称')
 await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.deepEqual(await p.evaluate(()=>window.creationDismissFixture.groupSaves),[])
 await open.click();assert.equal(await goal.inputValue(),complete,'关闭重开原文与末换行不丢')
 assert.equal(await dialog.getByRole('combobox').count(),0)
 await p.setViewportSize({width:1440,height:960});await p.screenshot({path:join(temp,'task-create-1440.png')})
 await p.setViewportSize({width:430,height:900});await p.screenshot({path:join(temp,'task-create-430.png')})
 const size=await dialog.evaluate((element:HTMLElement)=>({left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,width:innerWidth}));assert.ok(size.left>=0&&size.right<=size.width,'窄屏无横向溢出')
 await dialog.locator('summary').filter({hasText:'更多选项'}).click();assert.equal(await title.inputValue(),'本人拟定的任务名');assert.equal(await dialog.getByLabel('使用技能（可选）',{exact:true}).inputValue(),'check-one、check-two')
 await dialog.getByRole('button',{name:'创建任务',exact:true}).click();await dialog.waitFor({state:'hidden'})
 assert.deepEqual(await p.evaluate(()=>window.creationDismissFixture.groupSaves),[{fields:{title:'本人拟定的任务名',goal:complete,scope:'SOC',groupId:'10000000-0000-4000-8000-000000000001',skills:['check-one','check-two']},assignee:{roleId:'20000000-0000-4000-8000-000000000001',expectedVersion:4}}])
 assert.deepEqual((await state(p)).saved,[],'仅调用原创建回调，没有发送或执行入口')
})


test('复核任务保持原表单与已拟名称，修改目标不重新拟名或改变原业务群',async t=>{
 const p=await page(t);await p.getByRole('button',{name:'打开复核任务',exact:true}).click()
 const dialog=p.getByRole('dialog',{name:'核对工作',exact:true}),title=dialog.getByRole('textbox',{name:'任务名称',exact:true}),goal=dialog.getByRole('textbox',{name:'工作目标',exact:true})
 await title.waitFor();assert.equal(await title.inputValue(),'已核对的原标题');assert.equal(await dialog.locator('details').count(),0)
 assert.equal(await dialog.getByRole('combobox').count(),2);assert.equal(await dialog.getByRole('combobox',{name:/^主责范围/}).inputValue(),'SOC')
 await goal.fill('修订后的完整目标\n\n**保留原名称**。\n');assert.equal(await title.inputValue(),'已核对的原标题')
 await dialog.getByRole('button',{name:'创建任务',exact:true}).click();await dialog.waitFor({state:'hidden'})
 assert.deepEqual(await p.evaluate(()=>window.creationDismissFixture.reviewSaves),[{title:'已核对的原标题',goal:'修订后的完整目标\n\n**保留原名称**。\n',scope:'SOC',groupId:'10000000-0000-4000-8000-000000000001',skills:['原技能']}])
 assert.deepEqual((await state(p)).saved,[])
})


test('业务目录尚未就绪时仍可为继承SOC群描述工作，拟名称不校验或改写范围',async t=>{
 const p=await page(t,false),open=p.getByRole('button',{name:'打开群任务',exact:true}),dialog=p.getByRole('dialog',{name:'交办一项工作',exact:true})
 await open.click();const goal=dialog.getByRole('textbox',{name:'工作目标',exact:true}),body='目录加载中的本次工作\n\n完整 **原文** 保留。\n'
 await goal.fill(body);await dialog.locator('summary').filter({hasText:'更多选项'}).click()
 assert.equal(await dialog.getByRole('textbox',{name:'任务名称',exact:true}).inputValue(),'目录加载中的本次工作')
 assert.equal((await p.evaluate(()=>window.creationDismissFixture.groupDraft))?.scope,'SOC')
 await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await open.click();assert.equal(await goal.inputValue(),body)
 assert.deepEqual(await p.evaluate(()=>window.creationDismissFixture.groupSaves),[],'未提交不创建，不改变继承范围')
})
