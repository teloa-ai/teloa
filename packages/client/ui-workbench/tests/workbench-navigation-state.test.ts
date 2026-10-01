import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {
  WORKBENCH_NAVIGATION_STORAGE_KEY,
  attachWorkbenchNavigationPersistence,
  captureWorkbenchNavigationState,
  emptyWorkbenchNavigationState,
  loadWorkbenchNavigationState,
  readWorkbenchNavigationState,
  readDirectoryFilterCategory,
  reconcileAvailableDirectoryTarget,
  restoredBusinessTarget,
  restoredContinuousTarget,
  restoreAvailableTarget,
  writeWorkbenchNavigationState,
  writeDirectoryFilterCategory,
  type WorkbenchNavigationState,
} from '../src/client/workbench-navigation-state.ts'
import {directoryScroller,directoryScrollTopForEvent,visibleDirectoryPane} from '../src/client/directory-focus.ts'

const saved=():WorkbenchNavigationState=>({
  schema:WORKBENCH_NAVIGATION_STORAGE_KEY,
  view:'tasks',
  messageMode:'native',
  capabilityMode:'catalog',
  marketMode:'catalog',
  selected:{taskId:'task-2'},
  directories:{tasks:{category:'open',query:'审计',selectedId:'task-2',scrollTop:480}},
  detail:{open:true,target:{kind:'directory-object',view:'tasks',id:'task-2',source:{kind:'directory'}}},
})

test('损坏的 sessionStorage 记录会被清除并安全回到首页',()=>{
  const values=new Map<string,string>([[WORKBENCH_NAVIGATION_STORAGE_KEY,'{"bad":true}']])
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
  assert.deepEqual(loadWorkbenchNavigationState(storage),emptyWorkbenchNavigationState())
  assert.equal(values.has(WORKBENCH_NAVIGATION_STORAGE_KEY),false)
  storage.setItem(WORKBENCH_NAVIGATION_STORAGE_KEY,writeWorkbenchNavigationState(saved()))
  assert.deepEqual(loadWorkbenchNavigationState(storage),saved())
})

test('工作台状态变更会同步写入恢复记录，刷新不依赖 React effect 时序',()=>{
  const values=new Map<string,string>()
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
  let current:Parameters<typeof captureWorkbenchNavigationState>[0]={
    view:'tasks',messageMode:'native',capabilityMode:'catalog',marketMode:'catalog',
    taskId:'task-2',roleId:null,resourceTarget:null,capabilityBindingId:null,marketItemId:null,marketIntentId:null,installationId:null,
    businessTarget:{scope:'SOC',section:'overview'},continuousTarget:{kind:'plans'},
    navigationDirectories:{tasks:{category:'open',query:'审计',selectedId:'task-2',scrollTop:480},resources:{query:''}},detail:saved().detail,
  },listener=()=>{}
  const dispose=attachWorkbenchNavigationPersistence({getSnapshot:()=>current,subscribe:next=>{listener=next;return()=>{listener=()=>{}}}},storage)
  assert.equal(readWorkbenchNavigationState(values.get(WORKBENCH_NAVIGATION_STORAGE_KEY)!).view,'tasks')
  current={...current,view:'capabilities',navigationDirectories:{...current.navigationDirectories,capabilities:{category:'{"category":"skill","mobileLayer":"detail"}',selectedId:'find-skills'}}}
  listener()
  const persistedState=loadWorkbenchNavigationState(storage)
  assert.deepEqual(persistedState,captureWorkbenchNavigationState(current))
  assert.equal(persistedState.directories.resources?.query,undefined)
  dispose()
  current={...current,view:'home'}
  listener()
  assert.equal(loadWorkbenchNavigationState(storage).view,'capabilities')
})

test('恢复记录拒绝未知字段且无效对象回退首个真实对象',()=>{
  assert.throws(()=>readWorkbenchNavigationState('{"schema":"teloa.workbench-navigation/v1","view":"tasks","evil":true}'))
  assert.equal(restoreAvailableTarget({id:'gone'},['task-2','task-3']),'task-2')
  assert.equal(restoreAvailableTarget({id:'task-3'},['task-2','task-3']),'task-3')
  assert.equal(restoreAvailableTarget({id:'gone'},[]),undefined)
})

test('空目录会清除失效对象与详情，非空目录将二者一起回退',()=>{
  const detail=saved().detail
  assert.deepEqual(reconcileAvailableDirectoryTarget({id:'gone'},[],detail,'tasks'),{id:undefined,detail:{open:false,target:null}})
  assert.deepEqual(reconcileAvailableDirectoryTarget({id:'gone'},['task-2'],detail,'tasks'),{
    id:'task-2',detail:{open:true,target:{kind:'directory-object',view:'tasks',id:'task-2',source:{kind:'directory'}}},
  })
  const unrelated={open:true,target:{kind:'directory-object' as const,view:'team' as const,id:'r1',source:{kind:'directory' as const}}}
  assert.deepEqual(reconcileAvailableDirectoryTarget({id:'gone'},[],unrelated,'tasks'),{id:undefined,detail:unrelated})
})

test('只记录确定的目录滚动容器，正文或详情滚动不覆盖位置',()=>{
  const rows={scrollTop:420,scrollHeight:1200,clientHeight:400,querySelectorAll:()=>[]}
  const nested={scrollTop:31,scrollHeight:200,clientHeight:100,querySelectorAll:()=>[]}
  const pane={scrollTop:0,scrollHeight:400,clientHeight:400,querySelectorAll:()=>[rows,nested]}
  const detail={scrollTop:800,scrollHeight:1600,clientHeight:500,querySelectorAll:()=>[]}
  assert.equal(directoryScrollTopForEvent(pane,rows),420)
  assert.equal(directoryScrollTopForEvent(pane,nested),undefined)
  assert.equal(directoryScrollTopForEvent(pane,detail),undefined)
})

test('次像素滚动位置取整后再回报，恢复记录不会因为小数整条写不进去',()=>{
  // 真实浏览器在触控板与高 DPI 下给的是小数；解析器按整数校验，小数会让整条恢复记录作废。
  const rows={scrollTop:420.5,scrollHeight:1200,clientHeight:400,querySelectorAll:()=>[]}
  const pane={scrollTop:0,scrollHeight:400,clientHeight:400,querySelectorAll:()=>[rows]}
  const top=directoryScrollTopForEvent(pane,rows)
  assert.equal(top,421)
  assert.equal(Number.isSafeInteger(top),true)
  const ancestor={scrollTop:260.25,scrollHeight:1400,clientHeight:500,querySelectorAll:()=>[],contains:(node:unknown)=>node===inner}
  const inner={scrollTop:0,scrollHeight:300,clientHeight:300,querySelectorAll:()=>[],parentElement:ancestor,contains:()=>false}
  assert.equal(directoryScrollTopForEvent(inner,ancestor),260)
})

test('目录协议选择当前可见面板，并允许真实滚动容器位于面板祖先',()=>{
  const parent={scrollTop:260,scrollHeight:1400,clientHeight:500,querySelectorAll:()=>[],contains:(node:unknown)=>node===pane}
  const pane={scrollTop:0,scrollHeight:300,clientHeight:300,querySelectorAll:()=>[],parentElement:parent,getClientRects:()=>[{}],contains:()=>false}
  const hidden={...pane,getClientRects:()=>[]}
  const root={querySelectorAll:()=>[hidden,pane]}
  assert.equal(visibleDirectoryPane(root),pane)
  assert.equal(directoryScroller(pane),parent)
  assert.equal(directoryScrollTopForEvent(pane,parent),260)
})

test('目录筛选分类严格解析，损坏、未知字段和越界值回退默认值',()=>{
  const defaults={scope:'all',status:'all',kind:'all'},allowed={scope:['all','SOC'],status:['all','active'],kind:['all','employee']}
  const encoded=writeDirectoryFilterCategory({scope:'SOC',status:'active',kind:'employee'})
  assert.deepEqual(readDirectoryFilterCategory(encoded,defaults,allowed),{scope:'SOC',status:'active',kind:'employee'})
  assert.deepEqual(readDirectoryFilterCategory('{',defaults,allowed),defaults)
  assert.deepEqual(readDirectoryFilterCategory(JSON.stringify({scope:'SOC',status:'all',kind:'all',evil:'x'}),defaults,allowed),defaults)
  assert.deepEqual(readDirectoryFilterCategory(JSON.stringify({scope:'finance',status:'all',kind:'all'}),defaults,allowed),defaults)
})

test('目录筛选新增键后，旧记录缺这个字段只退回该键默认值，不牵连其它字段',()=>{
  const defaults={status:'all',kind:'all',open:''},allowed={status:['all','active'],kind:['all','employee']}
  const legacy=JSON.stringify({status:'active',kind:'employee'})
  assert.deepEqual(readDirectoryFilterCategory(legacy,defaults,allowed),{status:'active',kind:'employee',open:''})
  // 字段存在但不合法仍要整份回退，不因为「缺失即用默认」的新逻辑放松对篡改值的校验。
  assert.deepEqual(readDirectoryFilterCategory(JSON.stringify({status:'evil',kind:'employee'}),defaults,allowed),defaults)
})

test('折叠记忆写成空串不得打掉同一份记录里的 status/kind',()=>{
  const defaults={status:'all',kind:'all',open:''},allowed={status:['all','paused'],kind:['all','twin']}
  assert.deepEqual(readDirectoryFilterCategory(JSON.stringify({status:'paused',kind:'twin',open:''}),defaults,allowed),{status:'paused',kind:'twin',open:''})
})

test('目录筛选写入器写出的值原样读回：没有折叠记忆时不写 open 键',()=>{
  const defaults={status:'all',kind:'all',open:''},allowed={status:['all','paused'],kind:['all','twin']}
  assert.deepEqual(readDirectoryFilterCategory(writeDirectoryFilterCategory({status:'paused',kind:'twin'}),defaults,allowed),{status:'paused',kind:'twin',open:''})
  assert.deepEqual(readDirectoryFilterCategory(writeDirectoryFilterCategory({status:'paused',kind:'twin',open:'general'}),defaults,allowed),{status:'paused',kind:'twin',open:'general'})
})

test('序列化只保留导航身份、模式、详情和有限目录状态',()=>{
  const raw=writeWorkbenchNavigationState(saved())
  assert.deepEqual(readWorkbenchNavigationState(raw),saved())
  assert.equal(raw.includes('审计'),true)
  assert.equal(raw.includes('body'),false)
})

test('解析拒绝过大、损坏、负滚动位置；未知详情类型只丢这条详情',()=>{
  assert.throws(()=>readWorkbenchNavigationState('x'.repeat(16*1024+1)))
  assert.throws(()=>readWorkbenchNavigationState('{'))
  assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...saved(),directories:{tasks:{scrollTop:-1}}})))
  // 认不得的详情类型退成“没开详情”，视图、目录与滚动位置照常恢复，不作废整份记录。
  const degraded=readWorkbenchNavigationState(JSON.stringify({...saved(),detail:{open:true,target:{kind:'future'}}}))
  assert.deepEqual(degraded.detail,{open:false,target:null})
  assert.equal(degraded.view,saved().view)
  assert.deepEqual(degraded.directories,saved().directories)
  // 已知类型里的字段仍然严格：写错的会话对象照旧拒绝整份记录。
  assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...saved(),detail:{open:true,target:{kind:'conversation-object',sessionId:'s1',objectKind:'task'}}})))
  assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...saved(),detail:{open:true,target:null}})))
})

test('空记录提供安全首页默认值且写入同样受 16 KiB 限制',()=>{
  assert.deepEqual(emptyWorkbenchNavigationState(),{
    schema:'teloa.workbench-navigation/v1',view:'home',messageMode:'native',capabilityMode:'catalog',marketMode:'catalog',selected:{},directories:{},detail:{open:false,target:null},
  })
  assert.throws(()=>writeWorkbenchNavigationState({...saved(),directories:{tasks:{query:'x'.repeat(16*1024)}}}))
  assert.throws(()=>writeWorkbenchNavigationState({...saved(),directories:{tasks:{category:'中'.repeat(3000),query:'中'.repeat(1000),selectedId:'中'.repeat(3000)}}}))
})

test('store 从恢复记录建立模块与对象状态，并持续记录目录状态',()=>{
  const sourceHooks=registerHooks({resolve(specifier,context,next){
    if(specifier==='./workbench-detail-target.js')return next('./workbench-detail-target.ts',context)
    if(specifier==='./workbench-navigation-state.js')return next('./workbench-navigation-state.ts',context)
    return next(specifier,context)
  }})
  return import('../src/client/store.ts').then(({createWorkbenchStore})=>{
  const store=createWorkbenchStore('dark',saved()).create()
  const persisted=new Map<string,string>(),storage={getItem:(key:string)=>persisted.get(key)??null,setItem:(key:string,value:string)=>{persisted.set(key,value)},removeItem:(key:string)=>{persisted.delete(key)}}
  const detach=attachWorkbenchNavigationPersistence(store,storage)
  assert.equal(store.getSnapshot().view,'tasks')
  assert.equal(store.getSnapshot().taskId,'task-2')
  assert.deepEqual(store.getSnapshot().detail,saved().detail)
  assert.deepEqual(store.getSnapshot().navigationDirectories.tasks,{category:'open',query:'审计',selectedId:'task-2',scrollTop:480})
  const unchangedDirectorySnapshot=store.getSnapshot()
  store.actions.rememberDirectory('tasks',{category:'open',query:'审计'})
  assert.equal(store.getSnapshot(),unchangedDirectorySnapshot,'相同目录筛选不得发布新的工作台快照')
  store.actions.rememberDirectory('tasks',{selectedId:'task-3',scrollTop:720})
  assert.deepEqual(store.getSnapshot().navigationDirectories.tasks,{category:'open',query:'审计',selectedId:'task-3',scrollTop:720})
  store.actions.rememberDirectory('tasks',{selectedId:undefined})
  assert.deepEqual(store.getSnapshot().navigationDirectories.tasks,{category:'open',query:'审计',scrollTop:720})
  store.actions.selectTask('task-4')
  store.actions.openBusiness({scope:'space-finance',section:'analysis',id:'run-4'})
  store.actions.openPlans({kind:'run',id:'plan-run-4',scope:'space-finance'})
  store.actions.navigate('capabilities')
  assert.equal(loadWorkbenchNavigationState(storage).view,'capabilities')
  assert.equal(store.getSnapshot().navigationDirectories.tasks?.selectedId,'task-4')
  assert.equal(store.getSnapshot().navigationDirectories.spaces?.selectedId,'run-4')
  assert.equal(store.getSnapshot().navigationDirectories.plans?.selectedId,'plan-run-4')
  const restored=captureWorkbenchNavigationState(store.getSnapshot())
  const reloaded=createWorkbenchStore('dark',restored).create().getSnapshot()
  assert.deepEqual(reloaded.businessTarget,{scope:'space-finance',section:'analysis',id:'run-4'})
  assert.deepEqual(reloaded.continuousTarget,{kind:'run',id:'plan-run-4',scope:'space-finance'})
  detach()
  sourceHooks.deregister()
  })
})

test('从工作台快照只提取可恢复导航，不复制正文或临时表单',()=>{
  const snapshot={
    view:'spaces',messageMode:'groups',capabilityMode:'bindings',marketMode:'installations',
    taskId:'task-2',roleId:'role-2',resourceTarget:{id:'resource-2'},capabilityBindingId:'binding-2',marketItemId:'market-2',marketIntentId:null,installationId:'install-2',
    businessTarget:{scope:'space-finance',section:'data',id:'invoice-2',objectType:'invoice'},continuousTarget:{kind:'plan',id:'plan-2'},
    navigationDirectories:{spaces:{category:'{"mode":"real"}',scrollTop:300}},detail:{open:false,target:null},
    ignoredBody:'不得写入',
  } as const
  const navigation=captureWorkbenchNavigationState(snapshot)
  assert.equal(navigation.selected.businessId,'invoice-2')
  assert.equal(navigation.selected.planId,'plan-2')
  assert.equal(navigation.directories.spaces?.category,'space-finance:data:invoice\n{"mode":"real"}')
  assert.equal(JSON.stringify(navigation).includes('不得写入'),false)
  assert.deepEqual(readWorkbenchNavigationState(writeWorkbenchNavigationState(navigation)),navigation)
})

test('统一对话目录根态可恢复，刷新后不会自动落入上次 DSH 会话',()=>{
 const state={...saved(),view:'messages' as const,messageMode:'directory' as const}
 assert.deepEqual(readWorkbenchNavigationState(writeWorkbenchNavigationState(state)),state)
})

test('恢复的业务范围是空间内的标签文本：内置与模板 domain 都保留，空串丢弃',()=>{
 const withScope=(scope:string):WorkbenchNavigationState=>({...saved(),view:'spaces',directories:{spaces:{category:scope+':overview'}},selected:{}})
 assert.deepEqual(restoredBusinessTarget(withScope('SOC')),{scope:'SOC',section:'overview'})
 assert.deepEqual(restoredBusinessTarget(withScope('research')),{scope:'research',section:'overview'})
 assert.deepEqual(restoredBusinessTarget(withScope('space-finance')),{scope:'space-finance',section:'overview'})
 assert.equal(restoredBusinessTarget(withScope('')),undefined)
 assert.equal(restoredBusinessTarget(withScope('   ')),undefined)
 assert.equal(restoredBusinessTarget(withScope('x'.repeat(81))),undefined)
 const withPlanScope=(scope:string):WorkbenchNavigationState=>({...saved(),view:'plans',directories:{plans:{category:'plans:'+scope}},selected:{}})
 assert.deepEqual(restoredContinuousTarget(withPlanScope('research')),{kind:'plans',scope:'research'})
 assert.equal(restoredContinuousTarget(withPlanScope('x'.repeat(81))),undefined)
})

test('看板目标刷新恢复：第三段按栏目分派为看板标识或对象类型，互不污染',()=>{
 const base={
  view:'spaces',messageMode:'native',capabilityMode:'catalog',marketMode:'catalog',
  taskId:null,roleId:null,resourceTarget:null,capabilityBindingId:null,marketItemId:null,marketIntentId:null,installationId:null,
  continuousTarget:{kind:'plans'},navigationDirectories:{},detail:{open:false,target:null},
 } as const
 const dashboards=captureWorkbenchNavigationState({...base,businessTarget:{scope:'SOC',section:'dashboards',dashboardId:'soc-ops'}})
 assert.equal(dashboards.directories.spaces?.category?.split('\n')[0],'SOC:dashboards:soc-ops')
 assert.deepEqual(restoredBusinessTarget(readWorkbenchNavigationState(writeWorkbenchNavigationState(dashboards))),{scope:'SOC',section:'dashboards',dashboardId:'soc-ops'})
 const data=captureWorkbenchNavigationState({...base,businessTarget:{scope:'SOC',section:'data',objectType:'soc-alert'}})
 assert.equal(data.directories.spaces?.category?.split('\n')[0],'SOC:data:soc-alert')
 assert.deepEqual(restoredBusinessTarget(data),{scope:'SOC',section:'data',objectType:'soc-alert'})
 const withRoute=(route:string):WorkbenchNavigationState=>({...saved(),view:'spaces',directories:{spaces:{category:route}},selected:{}})
 assert.deepEqual(restoredBusinessTarget(withRoute('SOC:analysis:')),{scope:'SOC',section:'analysis'})
 assert.deepEqual(restoredBusinessTarget(withRoute('SOC:dashboards:')),{scope:'SOC',section:'dashboards'})
 assert.equal(restoredBusinessTarget(withRoute('SOC:dashboards:soc:ops')),undefined)
 assert.equal(restoredBusinessTarget(withRoute('SOC:dashboards:'+'a'.repeat(121))),undefined)
 assert.equal(restoredBusinessTarget(withRoute('SOC:dashboards:-bad')),undefined)
})

test('会话业务详情目标认看板栏目与看板标识，其余栏目带看板标识即拒绝',()=>{
 const state=(target:Record<string,unknown>):string=>JSON.stringify({...saved(),detail:{open:true,target:{kind:'conversation-object',sessionId:'s1',objectKind:'business',target}}})
 assert.deepEqual(readWorkbenchNavigationState(state({scope:'SOC',section:'dashboards',dashboardId:'soc-ops'})).detail.target,{kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope:'SOC',section:'dashboards',dashboardId:'soc-ops'}})
 assert.throws(()=>readWorkbenchNavigationState(state({scope:'SOC',section:'data',dashboardId:'soc-ops'})))
})

test('下钻目标带 match：导航目录与会话详情都能存入并原样恢复；取值里的冒号不串段',async()=>{
 const {businessTargetKey}=await import('../src/client/workbench-business-navigation.ts')
 const base={
  view:'spaces',messageMode:'native',capabilityMode:'catalog',marketMode:'catalog',
  taskId:null,roleId:null,resourceTarget:null,capabilityBindingId:null,marketItemId:null,marketIntentId:null,installationId:null,
  continuousTarget:{kind:'plans'},navigationDirectories:{},detail:{open:false,target:null},
 } as const
 for(const target of [
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:'高'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'host',value:'a:b / 100%'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',id:'soc-alert-7',match:{field:'_id',value:'soc-alert-7'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:'长'.repeat(200)}},
 ] as const){
  const state=captureWorkbenchNavigationState({...base,businessTarget:target})
  assert.deepEqual(restoredBusinessTarget(readWorkbenchNavigationState(writeWorkbenchNavigationState(state))),target,JSON.stringify(target))
  const detail=JSON.stringify({...saved(),detail:{open:true,target:{kind:'conversation-object',sessionId:'s1',objectKind:'business',target}}})
  assert.deepEqual(readWorkbenchNavigationState(detail).detail.target,{kind:'conversation-object',sessionId:'s1',objectKind:'business',target})
 }
 // 没有 match 的目标路由段与此前逐字相同。
 assert.equal(captureWorkbenchNavigationState({...base,businessTarget:{scope:'SOC',section:'data',objectType:'alert-ticket'}}).directories.spaces?.category,'SOC:data:alert-ticket')
 const withRoute=(route:string):WorkbenchNavigationState=>({...saved(),view:'spaces',directories:{spaces:{category:route}},selected:{}})
 for(const route of ['SOC:analysis:alert-ticket:severity:%E9%AB%98','SOC:data::severity:%E9%AB%98','SOC:data:alert-ticket:severity','SOC:data:alert-ticket:Bad:x','SOC:data:alert-ticket:severity:%E9%AB','SOC:data:alert-ticket:severity:','SOC:data:alert-ticket:severity:a:b','SOC:data:alert-ticket:severity:%0A'])
  assert.equal(restoredBusinessTarget(withRoute(route)),undefined,route)
 const state=(target:Record<string,unknown>):string=>JSON.stringify({...saved(),detail:{open:true,target:{kind:'conversation-object',sessionId:'s1',objectKind:'business',target}}})
 for(const target of [
  {scope:'SOC',section:'dashboards',dashboardId:'soc-ops',match:{field:'severity',value:'高'}},
  {scope:'SOC',section:'data',match:{field:'severity',value:'高'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:'高',op:'ne'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'Severity',value:'高'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:''}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:'x'.repeat(201)}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:{field:'severity',value:'高\u0007'}},
  {scope:'SOC',section:'data',objectType:'alert-ticket',match:'severity=高'},
 ])assert.throws(()=>readWorkbenchNavigationState(state(target)),JSON.stringify(target))
 const plain={scope:'SOC',section:'data',objectType:'alert-ticket'} as const
 const keys=new Set([plain,{...plain,match:{field:'severity',value:'高'}},{...plain,match:{field:'severity',value:'低'}},{...plain,match:{field:'verdict',value:'高'}}].map(businessTargetKey))
 assert.equal(keys.size,4,'businessTargetKey 随 match 的字段与取值变化')
 assert.equal(businessTargetKey(plain),JSON.stringify(['SOC','data',null,'alert-ticket']),'不带 match 时指纹与此前逐字相同')
})

test('固定记录来源刷新与右栏恢复保留版本/hash，拒绝错scope/type/id和混入筛选',async()=>{
 const {businessTargetKey}=await import('../src/client/workbench-business-navigation.ts')
 const reference={scope:'sales',type:'order',id:'order:one',version:3,snapshotHash:'a'.repeat(64)}
 const target={scope:'sales',section:'data',objectType:'order',id:reference.id,recordReference:reference} as const
 const base={view:'spaces',messageMode:'native',capabilityMode:'catalog',marketMode:'catalog',taskId:null,roleId:null,resourceTarget:null,capabilityBindingId:null,marketItemId:null,marketIntentId:null,installationId:null,continuousTarget:{kind:'plans'},navigationDirectories:{},detail:{open:false,target:null}} as const
 const persisted=captureWorkbenchNavigationState({...base,businessTarget:target})
 assert.deepEqual(restoredBusinessTarget(readWorkbenchNavigationState(writeWorkbenchNavigationState(persisted))),target)
 assert.equal(persisted.selected.businessId,reference.id)
 assert.equal(restoredBusinessTarget({...persisted,selected:{...persisted.selected,businessId:'another'}}),undefined)
 assert.equal(restoredBusinessTarget({...persisted,selected:{}}),undefined)
 for(const corrupted of [{...reference,snapshotHash:'bad'},{...reference,scope:'other'},{...reference,type:'other'},{...reference,version:0}]){
  const altered={...persisted,directories:{spaces:{category:'sales:data:order:@record:'+encodeURIComponent(JSON.stringify(corrupted))}}}
  assert.equal(restoredBusinessTarget(altered),undefined)
 }
 assert.throws(()=>captureWorkbenchNavigationState({...base,businessTarget:{...target,id:'another'}}))
 assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...persisted,directories:{spaces:{category:'sales:data:order:@record:'+'a'.repeat(4096)}}})))
 const detail=(next:unknown)=>JSON.stringify({...saved(),detail:{open:true,target:{kind:'conversation-object',sessionId:'s1',objectKind:'business',target:next}}})
 assert.deepEqual(readWorkbenchNavigationState(detail(target)).detail.target,{kind:'conversation-object',sessionId:'s1',objectKind:'business',target})
 for(const patch of [{scope:'other'},{id:'other'},{objectType:'other'},{section:'overview'},{match:{field:'_id',value:reference.id}},{recordReference:{...reference,snapshotHash:'invalid'}}])assert.throws(()=>readWorkbenchNavigationState(detail({...target,...patch})))
 assert.notEqual(businessTargetKey(target),businessTargetKey({...target,recordReference:{...reference,version:4}}))
})
