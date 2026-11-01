import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import ts from 'typescript'
import {build} from 'vite'
// @ts-expect-error 复用本工作树已有的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string
// 挂载完整生产 Frame/store/BindingClient，仅隔离无关页面；TeamPage 探针读取真实入参并驱动真实保存/刷新回调。
before(async()=>{
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('fixture.ts',source,ts.ScriptTarget.Latest,true)
 let expression:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='entry')expression=node.initializer;ts.forEachChild(node,visit)};visit(ast);assert.ok(expression)
 let entry=new Function('client','return '+expression.getText(ast))(client) as string
 const setup=`
 f.attentionVersion=0;const attentionListeners=new Set();props.workAttentionConnection={getSnapshot:()=>f.attentionVersion,subscribe:listener=>{attentionListeners.add(listener);return()=>attentionListeners.delete(listener)}};f.bumpConnection=()=>{f.attentionVersion++;attentionListeners.forEach(listener=>listener())};
 f.roleRequests=[];f.accessRequests=[];f.owner=0;f.nextRows=[{...employee,id:'employee-a'},{...employee,id:'employee-b'},{...employee,id:'default-twin',kind:'twin'}];
 const roleApiFor=owner=>new Proxy(generic,{get:(target,key)=>key==='list'?()=>{const rows=structuredClone(f.nextRows);f.roleReads++;if(f.failRoles)return Promise.reject(Error('directory unavailable'));if(f.holdRoles)return new Promise((resolve,reject)=>f.roleRequests.push({owner,resolve:()=>resolve(rows),reject}));return Promise.resolve(rows)}:key==='create'?async fields=>{if(f.holdWrite)await new Promise(resolve=>f.releaseWrite=resolve);const row={...employee,...fields,id:'created-role',version:1};f.nextRows=[...f.nextRows,row];return row}:key==='edit'?async(id,version,fields)=>{const row={...employee,...fields,id,version:version+1};f.nextRows=f.nextRows.map(previous=>previous.id===id?row:previous);return row}:key==='updateProfile'?async(id,version,baseline,fields)=>{const row={...baseline,...fields,id,version,updatedAt:stamp};f.nextRows=f.nextRows.map(previous=>previous.id===id?row:previous);return row}:target[key]});
 props.roleApi=roleApiFor(0);
 props.roleLifecycle={pending:()=>undefined,change:async(id,version,action)=>{const previous=f.nextRows.find(row=>row.id===id),role={...previous,version:version+1,state:action==='retire'?'retired':action==='pause'?'paused':'active'};f.nextRows=f.nextRows.map(row=>row.id===id?role:row);f.lifecycleSaved={role,handoffTaskIds:[]};return f.lifecycleSaved},recover:async()=>f.lifecycleSaved};
 props.roleDelegationApi={get:roleId=>{const row=f.nextRows.find(role=>role.id===roleId);const read={roleId,roleVersion:row?.version??3,delegations:[],consents:[],canEditExecution:true};return f.holdAccess?new Promise(resolve=>f.accessRequests.push(()=>resolve(read))):Promise.resolve(read)}};
 f.historicalTask={id:'historical-task',ownerId:'owner',title:'Original completed task',goal:'Keep original evidence',scope:'general',groupId:null,skills:[],state:'completed',version:2,assigneeRoleId:'employee-a',assigneeRoleVersion:3,createdAt:stamp,updatedAt:stamp};
 props.taskApi=new Proxy(generic,{get:(target,key)=>key==='attention'?async()=>({items:[{task:f.historicalTask,attention:null}]}):key==='create'||key==='createConfirmed'?async()=>{f.taskCreateCalls=(f.taskCreateCalls??0)+1;throw Error('unexpected task creation')}:target[key]});
 f.swapOwner=()=>{f.owner++;props.roleApi=roleApiFor(f.owner);renderFrame()};f.preview=id=>store.actions.previewRole(id);f.selectRole=id=>store.actions.openRole(id);
 `
 assert.ok(entry.includes('const frameRoot='));entry=entry.replace('const frameRoot=',setup+'const frameRoot=')
 const isolated=new Set(['WorkDirectory','WorkHome','TaskPage','TeamPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage'].map(name=>join(client,name+'.tsx')))
 const virtual=root+'__role_directory_frame.tsx'
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'role-directory-frame',enforce:'pre',resolveId:id=>id.endsWith('role-directory-frame')?virtual:null,load:async id=>{
  if(id===virtual)return entry
  if(!isolated.has(id))return
  if(id===join(client,'TeamPage.tsx'))return `import {roleName,canReceiveTask} from ${JSON.stringify(join(client,'role-preview.ts'))};export const RoleForm=()=>null;export const TeamPage=props=>{if(!props.embedded){window.frameFixture.directory=props;window.frameFixture.formerName=roleName(props.state.roles,'employee-a',undefined,{known:props.persistence.directoryKnown,loading:props.persistence.loading,error:props.persistence.error});window.frameFixture.canAssignFormer=canReceiveTask(props.state.roles.find(role=>role.id==='employee-a'),'general')}return null};`
  const original=await readFile(id,'utf8');return [...original.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(match=>'export const '+match[1]+'=()=>null;').join('\n')
 }}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:'role-directory-frame',name:'RoleDirectoryFrame',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(row=>row.type==='chunk')!.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<html lang="en"><body><div id="root"></div></body></html>'}):route.abort());await page.goto('http://127.0.0.1:49328/');await page.addScriptTag({content:script})
 await page.waitForFunction(()=>!!(window as any).frameFixture?.controller&&document.querySelector('#teloa-main')!==null)
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'));await page.waitForFunction(()=>(window as any).frameFixture.directory?.state.roles.filter((r:any)=>r.storage==='persistent').length===3)
 await settle(page);return page
}
async function settle(page:any){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
async function ids(page:any){return page.evaluate(()=>(window as any).frameFixture.directory.state.roles.filter((r:any)=>r.storage==='persistent').map((r:any)=>r.id).sort())}
async function reload(page:any){await page.evaluate(()=>(window as any).frameFixture.directory.persistence.load());await settle(page)}

test('真实 Frame 缓存三人成功空快照清目录、移除选中资料，读取失败保缓存',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.oldDirectory=f.directory;f.oldRole=f.directory.state.roles.find((row:any)=>row.id==='employee-a');f.selectRole('employee-a');f.preview('employee-a')});await settle(page)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.failRoles=true});await reload(page)
 assert.equal((await ids(page)).length,3);assert.ok(await page.evaluate(()=>(window as any).frameFixture.directory.persistence.error))
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.failRoles=false;f.nextRows=[]});await reload(page)
 assert.deepEqual(await ids(page),[])
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().roleId),null)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.formerName),'历史成员')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.canAssignFormer),false)
 await page.evaluate(async()=>{const f=(window as any).frameFixture;for(const method of ['assign','assignConfirmed']){try{await f.oldDirectory.persistence[method](f.oldRole,{title:'Forbidden stale assignment'})}catch{}}})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.taskCreateCalls??0),0)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.directory.state.tasks.find((task:any)=>task.id==='historical-task')?.title),'Original completed task')
 assert.ok(!(await page.getByRole('dialog').allTextContents()).join(' ').includes('原姓名'),'移除后的抽屉不继续显示旧员工资料')
 await reload(page);assert.deepEqual(await ids(page),[])
})

test('真实 Frame 最后员工缺席保留返回的默认分身；退役行仍是当前成员',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nextRows=f.nextRows.filter((row:any)=>row.kind==='twin')});await reload(page)
 assert.deepEqual(await ids(page),['default-twin'])
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nextRows.push({...f.employee,id:'retired-employee',state:'retired'})});await reload(page)
 assert.deepEqual(await ids(page),['default-twin','retired-employee'])
})

test('真实 Frame 创建可信回执作废此前空列表，后续完整快照确认成员',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nextRows=[];f.holdRoles=true});await reload(page)
 await page.waitForFunction(()=>(window as any).frameFixture.roleRequests.length===1)
 await page.evaluate(async()=>{const f=(window as any).frameFixture;await f.directory.persistence.create({...f.employee,name:'Created employee'})})
 await page.waitForFunction(()=>(window as any).frameFixture.directory.state.roles.some((row:any)=>row.id==='created-role'))
 await page.evaluate(()=>(window as any).frameFixture.roleRequests[0].resolve());await settle(page)
 assert.ok((await ids(page)).includes('created-role'))
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=false;f.roleRequests.slice(1).forEach((request:any)=>request.resolve())});await reload(page)
 assert.deepEqual(await ids(page),['created-role'])
})

test('真实 Frame 编辑及同版本同时间资料回执不被旧列表覆盖',async t=>{
 const page=await mount(t)
 for(const profile of [false,true]){
  await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=true;f.roleRequests=[]});await reload(page)
  await page.evaluate(async(profile:boolean)=>{const f=(window as any).frameFixture,role=f.directory.state.roles.find((row:any)=>row.id==='employee-a');if(profile)await f.directory.persistence.updateProfile(role,{name:'Profile saved same timestamp'});else await f.directory.persistence.edit(role,{...role,name:'Edited execution v4'})},profile)
  await page.evaluate(()=>(window as any).frameFixture.roleRequests[0].resolve());await settle(page)
  assert.deepEqual(await page.evaluate(()=>{const role=(window as any).frameFixture.directory.state.roles.find((row:any)=>row.id==='employee-a');return [role.name,role.version]}),[profile?'Profile saved same timestamp':'Edited execution v4',4])
  await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=false;f.roleRequests.slice(1).forEach((request:any)=>request.resolve())});await reload(page)
 }
})

test('真实 Frame 后发空快照优先；迟到关联查找列表不能重新并回成员',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=true;f.talk=f.directory.talk('missing-role')});await settle(page)
 await page.waitForFunction(()=>(window as any).frameFixture.roleRequests.length===1)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nextRows=[]});await reload(page)
 await page.waitForFunction(()=>(window as any).frameFixture.roleRequests.length===2)
 await page.evaluate(()=>(window as any).frameFixture.roleRequests[1].resolve());await settle(page)
 assert.deepEqual(await ids(page),[])
 await page.evaluate(async()=>{const f=(window as any).frameFixture;f.roleRequests[0].resolve();await f.talk});await settle(page)
 assert.deepEqual(await ids(page),[])
})

test('真实 Frame 移除成员使在途许可和旧资料操作失效，撤销许可不能被旧读覆盖',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdAccess=true});await reload(page)
 await page.waitForFunction(()=>(window as any).frameFixture.accessRequests.length===3)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.directory.delegationChanged({roleId:'employee-a',roleVersion:3,delegations:[],consents:[],canEditExecution:false});f.accessRequests.forEach((resolve:any)=>resolve())});await settle(page)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.directory.state.roles.find((row:any)=>row.id==='employee-a').workAccess.canEditExecution),false)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.accessRequests=[]});await reload(page)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.oldDelegationChanged=f.directory.delegationChanged;f.nextRows=[]});await reload(page)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.accessRequests.forEach((resolve:any)=>resolve());f.oldDelegationChanged({roleId:'employee-a',roleVersion:3,delegations:[],consents:[],canEditExecution:true})});await settle(page)
 assert.deepEqual(await ids(page),[])
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nextRows=[{...f.employee,id:'employee-a'}]});await reload(page)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.oldDelegationChanged({roleId:'employee-a',roleVersion:3,delegations:[],consents:[],canEditExecution:true})});await settle(page)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.directory.state.roles.find((row:any)=>row.id==='employee-a').workAccess),undefined)
})

test('真实 Frame 更换 API 后旧列表和旧写回执不能进入新目录',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=true;f.holdWrite=true;f.write=f.directory.persistence.create({...f.employee}).catch((error:any)=>error.code)});await reload(page)
 await page.waitForFunction(()=>(window as any).frameFixture.roleRequests.length===1)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nextRows=[];f.swapOwner()});await settle(page)
 assert.deepEqual(await ids(page),[],'新身份未接收名单前已清旧成员')
 await page.evaluate(async()=>{const f=(window as any).frameFixture;f.roleRequests[0].resolve();f.releaseWrite();f.writeResult=await f.write});await settle(page)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.writeResult),'teloa/cancelled')
 assert.deepEqual(await ids(page),[])
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.roleRequests.slice(1).forEach((request:any)=>request.resolve())});await settle(page)
 assert.deepEqual(await ids(page),[])
})

test('真实 Frame 同一 API 重连世代变化也清旧成员，旧许可不进入新世代',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdAccess=true});await reload(page)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=true;f.nextRows=[];f.bumpConnection()});await settle(page)
 assert.deepEqual(await ids(page),[])
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.accessRequests.forEach((resolve:any)=>resolve());f.roleRequests.forEach((request:any)=>request.resolve())});await settle(page)
 assert.deepEqual(await ids(page),[])
})

test('真实 Frame 长生命周期创建回调采用当前业务范围与目录刷新入口',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.oldCreate=f.directory.persistence.create;f.scopeRows=[{scope:'sales',title:'Sales',kind:'domain'},{scope:'new-owned',title:'New business',kind:'domain'}];f.nextRows.push({...f.employee,id:'new-business-employee',scopes:['new-owned']})});await reload(page)
 await page.waitForFunction(()=>(window as any).frameFixture.directory.state.roles.some((row:any)=>row.id==='new-business-employee'))
 const before=await page.evaluate(()=>(window as any).frameFixture.roleReads)
 await page.evaluate(async()=>{const f=(window as any).frameFixture;await f.oldCreate({...f.employee,name:'Created in new business',scopes:['new-owned']})});await settle(page)
 assert.ok(await page.evaluate(()=>(window as any).frameFixture.roleReads)>before)
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.directory.state.roles.find((row:any)=>row.id==='created-role').scopes),['new-owned'])
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.directory.persistence.error),undefined)
})

test('真实 Frame 生命周期变更与恢复回执统一作废旧名单，不恢复旧接单资格',async t=>{
 const page=await mount(t)
 for(const recover of [false,true]){
  await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=true;f.roleRequests=[]});await reload(page)
  await page.evaluate(async(recover:boolean)=>{const f=(window as any).frameFixture,role=f.directory.state.roles.find((row:any)=>row.id==='employee-a');if(recover){const saved={...role,version:role.version+1,state:'retired'};f.nextRows=f.nextRows.map((row:any)=>row.id===saved.id?saved:row);f.lifecycleSaved={role:saved,handoffTaskIds:[]};await f.directory.persistence.lifecycle.recover()}else await f.directory.persistence.lifecycle.change(role,'pause','Owner pause')},recover)
  await page.evaluate(()=>(window as any).frameFixture.roleRequests[0].resolve());await settle(page)
  assert.equal(await page.evaluate(()=>(window as any).frameFixture.directory.state.roles.find((row:any)=>row.id==='employee-a').state),recover?'retired':'paused')
  assert.equal(await page.evaluate(()=>(window as any).frameFixture.canAssignFormer),false)
  await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=false;f.roleRequests.slice(1).forEach((request:any)=>request.resolve())});await reload(page)
 }
})
