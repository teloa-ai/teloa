import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
import * as contract from '@teloa/contract'

test('群关联案件和项目点击名称打开原件；添加为加号，不增加打开按钮',async()=>{
 const opened:unknown[]=[],group={id:'group-a',version:1,scope:'general',archived:false},items=[{kind:'business',scope:'SOC',type:'incident',id:'INC-207',title:'凭据调查',state:'调查中',available:true,objectVersion:2},{kind:'project',scope:'general',id:'project-a',title:'季度交付',state:'planning',available:true,objectVersion:1}]
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作',SOC:'安全运营'})}})
 const props={group,api:{get:async()=>({groupId:group.id,version:1,groupVersion:1,items}),subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined},tasks:[],open:(item:unknown)=>opened.push(item),openTask:()=>{}}
 let tree=app.render('GroupLinkedWork',props)
 for(const effect of app.effects)effect()
 await new Promise(resolve=>setImmediate(resolve))
  tree=app.render('GroupLinkedWork',props)
  const buttons=nodes(tree).filter(node=>node.type==='button'),name=buttons.find(button=>button.children.includes('凭据调查'))!
  assert.ok(name,'原对象标题是直接入口');name.props.onClick();assert.deepEqual(opened,[items[0]])
  assert.ok(buttons.some(button=>button.props['aria-label']==='Link work'))
  assert.equal(buttons.some(button=>button.children.includes('打开原工作')),false)
})
test('保存非空关联只发送原对象身份，切群不能被上一群的保存状态锁住',async()=>{
 const deferred:{resolve?:()=>void}={},calls:unknown[]=[],group={id:'10000000-0000-4000-8000-000000000001',version:1,scope:'general',archived:false},item={kind:'project',scope:'general',id:'20000000-0000-4000-8000-000000000001',title:'Original project',state:'planning',available:true,objectVersion:1}
 const api={get:async(id:string)=>({groupId:id,groupVersion:1,version:1,items:[item]}),candidates:async()=>[],subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined,change:async(...args:unknown[])=>{calls.push(args);await new Promise<void>(resolve=>{deferred.resolve=resolve});return {groupId:group.id,groupVersion:1,version:2,items:[item]}}}
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})}}),props={group,api,tasks:[],open:()=>{},openTask:()=>{}}
 const paint=()=>app.render('GroupLinkedWork',props),settle=()=>new Promise(resolve=>setImmediate(resolve))
 let tree=paint();for(const effect of app.effects)effect();await settle();tree=paint()
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='Link work')!.props.onClick();tree=paint()
 nodes(tree).find(node=>node.type==='button'&&node.children.includes('Save links'))!.props.onClick();await settle()
 assert.equal(calls.length,1,'展示元数据不能使合法的非空关联在提交前被拒绝')
 assert.deepEqual((calls[0] as unknown[])[3],[{kind:'project',scope:'general',id:item.id}])
 props.group={...group,id:'30000000-0000-4000-8000-000000000001'};paint();for(const effect of app.effects)effect();await settle();tree=paint()
 assert.equal(nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='Link work')!.props.disabled,false)
 deferred.resolve!();await settle();tree=paint();assert.equal(nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='Link work')!.props.disabled,false)
})


test('群消息派生任务也进入同一原对象详情入口，重复标题保留负责员工',async()=>{
 const opened:unknown[]=[],global:unknown[]=[],group={id:'10000000-0000-4000-8000-000000000001',version:1,scope:'general',archived:false}
 const tasks=[{id:'20000000-0000-4000-8000-000000000001',version:3,title:'Review shared material',scope:'general',state:'waiting',assigneeId:'employee-a'},{id:'20000000-0000-4000-8000-000000000002',version:4,title:'Review shared material',scope:'general',state:'waiting',assigneeId:'employee-b'}]
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})}})
 const props={group,api:{get:async()=>({groupId:group.id,version:1,groupVersion:1,items:[]}),subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined},tasks,roles:[{id:'employee-a',name:'Alice'},{id:'employee-b',name:'Bob'}],open:(item:unknown)=>opened.push(item),openTask:(id:string)=>global.push(id)}
 let tree=app.render('GroupLinkedWork',props);for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve));tree=app.render('GroupLinkedWork',props)
 const rows=nodes(tree).filter(node=>node.type==='article')
 assert.equal(rows.length,2)
 assert.ok(nodes(rows[0]).some(node=>node.children?.includes('Alice')))
 assert.ok(nodes(rows[1]).some(node=>node.children?.includes('Bob')))
 const name=nodes(rows[0]).find(node=>node.type==='button'&&node.children.includes('Review shared material'))!;name.props.onClick()
 assert.deepEqual(opened,[{kind:'task',scope:'general',id:tasks[0]!.id,title:tasks[0]!.title,state:'waiting',available:true,objectVersion:3}])
 assert.deepEqual(global,[],'点击原任务不能导航到全局任务页')
})


test('显式关联的普通任务从全目录显示负责人，不把无群关系任务变成隐式关联',async()=>{
 const group={id:'10000000-0000-4000-8000-000000000001',version:1,scope:'general',archived:false},item={kind:'task',scope:'general',id:'20000000-0000-4000-8000-000000000001',title:'Shared title',state:'ready',available:true,objectVersion:2}
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})}})
 const props={group,api:{get:async()=>({groupId:group.id,version:1,groupVersion:1,items:[item]}),subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined},tasks:[],taskDirectory:[{...item,version:2,assigneeId:'employee-a'},{...item,id:'other-task',assigneeId:'employee-b'}],roles:[{id:'employee-a',name:'Alice'},{id:'employee-b',name:'Bob'}],open:()=>{}}
 let tree=app.render('GroupLinkedWork',props);for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve));tree=app.render('GroupLinkedWork',props)
 const rows=nodes(tree).filter(node=>node.type==='article');assert.equal(rows.length,1)
 assert.ok(nodes(rows[0]).some(node=>node.children?.includes('Alice')))
 assert.equal(nodes(tree).some(node=>node.children?.includes('Bob')),false)
 assert.equal(nodes(rows[0]).find(node=>node.type==='button')?.props['aria-label'],'Shared title · Alice')
})

test('群中展示项目侧原关联并点击原项目；保存群侧选择不能复制项目侧关系',async()=>{
 const group={id:'10000000-0000-4000-8000-000000000001',version:1,scope:'general',archived:false},project={kind:'project',scope:'SOC',id:'20000000-0000-4000-8000-000000000001',title:'Original security project',state:'running',available:true,objectVersion:2},opened:unknown[]=[],saved:unknown[]=[]
 const api={get:async()=>({groupId:group.id,version:0,groupVersion:1,items:[],projectLinks:[project]}),candidates:async()=>[],subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined,change:async(...args:unknown[])=>{saved.push(args);return {groupId:group.id,version:1,groupVersion:1,items:[],projectLinks:[project]}}}
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General',SOC:'Security'})}}),props={group,api,tasks:[],open:(item:unknown)=>opened.push(item)}
 const paint=()=>app.render('GroupLinkedWork',props);let tree=paint();for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve));tree=paint()
 const button=nodes(tree).find(node=>node.type==='button'&&node.children?.includes(project.title));assert.ok(button,'项目侧关联必须显示在同一个原群');button.props.onClick();assert.deepEqual(opened,[project])
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='Link work')!.props.onClick();tree=paint()
 assert.equal(nodes(tree).some(node=>node.type==='button'&&node.props['aria-label']==='Unlink: '+project.title),false)
 nodes(tree).find(node=>node.type==='button'&&node.children?.includes('Save links'))!.props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(saved,[[group.id,1,0,[]]],'只保存群侧关系，不把项目只读投影重新写入群表')
})

test('双方已有同一原关联只显示一行，仍允许管理旧群侧关系',async()=>{
 const group={id:'10000000-0000-4000-8000-000000000001',version:1,scope:'general',archived:false},project={kind:'project',scope:'general',id:'20000000-0000-4000-8000-000000000001',title:'Original project',state:'planning',available:true,objectVersion:2}
 const api={get:async()=>({groupId:group.id,version:1,groupVersion:1,items:[project],projectLinks:[project]}),candidates:async()=>[],subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined}
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})}}),props={group,api,tasks:[],open:()=>{}}
 let tree=app.render('GroupLinkedWork',props);for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve));tree=app.render('GroupLinkedWork',props)
 assert.equal(nodes(tree).filter(node=>node.type==='article').length,1)
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='Link work')!.props.onClick();tree=app.render('GroupLinkedWork',props)
 assert.equal(nodes(tree).filter(node=>node.type==='button'&&node.props['aria-label']==='Unlink: '+project.title).length,1)
})

test('关联选择器为紧凑搜索与类型切换：无通栏创建按钮、无冗余说明、单空间不出下拉，新建任务为次级动作',async()=>{
 const group={id:'10000000-0000-4000-8000-000000000001',version:1,scope:'general',archived:false},item={kind:'project',scope:'general',id:'20000000-0000-4000-8000-000000000001',title:'Original project',state:'planning',available:true,objectVersion:1}
 const candidateCalls:unknown[][]=[],created:string[]=[]
 const api={get:async()=>({groupId:group.id,version:1,groupVersion:1,items:[item]}),candidates:async(...args:unknown[])=>{candidateCalls.push(args);return []},subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined}
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})}}),props={group,api,tasks:[],open:()=>{},createTask:(id:string)=>created.push(id)}
 // 夹具不分依赖地重跑全部 effect（含切群重置），所以打开抽屉并跑完候选读取后需再次打开。
 const paint=()=>app.render('GroupLinkedWork',props),run=async()=>{for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve))},openDrawer=()=>{nodes(paint()).find(node=>node.type==='button'&&node.props['aria-label']==='Link work')!.props.onClick()}
 paint();await run();openDrawer();paint();await run();openDrawer()
 let tree=paint();const all=nodes(tree)
 assert.equal(all.some(node=>node.type==='select'),false,'单一业务空间不显示业务空间下拉')
 assert.equal(all.some(node=>typeof node.children[0]==='string'&&/do not copy originals/i.test(node.children[0])),false,'去掉冗余说明')
 const chips=all.filter(node=>node.type==='button'&&'aria-pressed' in node.props)
 assert.deepEqual(chips.map(chip=>chip.children[0]),['Business record','Project','Task'])
 assert.deepEqual(chips.map(chip=>chip.props['aria-pressed']),[false,false,true],'通用群默认搜任务')
 assert.deepEqual(candidateCalls.at(-1)!.slice(0,3),[group.id,'general','task'])
 const search=all.findIndex(node=>node.type==='input'&&node.props['aria-label']==='Search original work'),create=all.findIndex(node=>node.type==='button'&&node.props['aria-label']==='collaboration.task.create')
 assert.ok(search>=0&&create>search,'新建任务排在搜索与候选之后，作为次级动作')
 assert.equal(all.filter(node=>node.type==='button'&&node.props['aria-label']==='collaboration.task.create').length,1)
 assert.ok(all.some(node=>node.type==='h3'&&node.children.includes('Selected')),'已选计数标题存在')
 assert.ok(all.some(node=>node.type==='span'&&node.children.includes(1)),'已选计数显示 1')
 assert.ok(all.some(node=>node.type==='button'&&node.props['aria-label']==='Unlink: Original project'))
 assert.ok(all.some(node=>node.type==='button'&&node.children.includes('Save links')))
 assert.ok(all.some(node=>typeof node.children[0]==='string'&&node.children[0]==='No matching work'),'候选读取完成后给出空结果提示')
 chips[1]!.props.onClick();tree=paint()
 assert.deepEqual(nodes(tree).filter(node=>node.type==='button'&&'aria-pressed' in node.props).map(chip=>chip.props['aria-pressed']),[false,true,false])
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='collaboration.task.create')!.props.onClick()
 assert.deepEqual(created,[group.id])
})

test('存在多个业务空间时才显示业务空间筛选，默认沿用原群空间并先搜业务记录',async()=>{
 const group={id:'10000000-0000-4000-8000-000000000001',version:1,scope:'SOC',archived:false},candidateCalls:unknown[][]=[]
 const api={get:async()=>({groupId:group.id,version:1,groupVersion:1,items:[]}),candidates:async(...args:unknown[])=>{candidateCalls.push(args);return []},subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined}
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General',SOC:'Security'})}}),props={group,api,tasks:[],open:()=>{}}
 const paint=()=>app.render('GroupLinkedWork',props),run=async()=>{for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve))},openDrawer=()=>{nodes(paint()).find(node=>node.type==='button'&&node.props['aria-label']==='Link work')!.props.onClick()}
 paint();await run();openDrawer();paint();await run();openDrawer()
 const tree=paint(),select=nodes(tree).find(node=>node.type==='select')!
 assert.ok(select,'多空间时显示业务空间筛选');assert.equal(select.props.value,'SOC')
 assert.deepEqual(nodes(tree).filter(node=>node.type==='button'&&'aria-pressed' in node.props).map(chip=>chip.props['aria-pressed']),[true,false,false])
 assert.deepEqual(candidateCalls.at(-1)!.slice(1,3),['SOC','business'])
 assert.equal(nodes(tree).some(node=>node.type==='button'&&node.props['aria-label']==='collaboration.task.create'),false,'未提供新建任务能力时不显示该动作')
})

test('概览“全部关联工作”按实际类型筛选同一份关联，负责员工进入原档案',async()=>{
 const group={id:'10000000-0000-4000-8000-000000000001',version:1,scope:'SOC',archived:false},reads:string[]=[],roleOpened:string[]=[]
 const items=[{kind:'business',scope:'SOC',type:'incident',id:'INC-207',title:'凭据调查',state:'调查中',available:true,objectVersion:2},{kind:'business',scope:'SOC',type:'alert',id:'ALT-521',title:null,state:null,available:false,objectVersion:null},{kind:'project',scope:'general',id:'project-a',title:'季度交付',state:'planning',available:true,objectVersion:1}]
 const tasks=[{id:'20000000-0000-4000-8000-000000000001',version:1,title:'补查审计窗口',scope:'SOC',state:'waiting',assigneeId:'employee-a'}]
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作',SOC:'安全运营'})}})
 const props={group,api:{get:async(id:string)=>{reads.push(id);return {groupId:group.id,version:1,groupVersion:1,items}},subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined},tasks,roles:[{id:'employee-a',name:'Alice'}],open:()=>{},openRole:(id:string)=>roleOpened.push(id)}
 const paint=()=>app.render('GroupLinkedWork',props)
 paint();for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve))
 let tree=paint()
 const filter=()=>nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='Filter linked work')!
 assert.ok(filter(),'出现多种关联工作时提供筛选')
 assert.equal(filter().props.value,'all')
 // 业务类型没有本地化名称来源，只按工作类型分组，不向用户显示 incident/alert 等原始标识。
 assert.deepEqual(nodes(filter()).filter(node=>node.type==='option').map(node=>[node.props.value,node.children.join('')]),[['all','All linked work'],['business','Business record · 2'],['project','Project · 1'],['task','Task · 1']])
 assert.equal(nodes(tree).filter(node=>node.type==='article').length,4)
 filter().props.onChange({target:{value:'business'}});tree=paint()
 const rows=nodes(tree).filter(node=>node.type==='article')
 assert.equal(rows.length,2,'只显示所选类型')
 assert.equal(nodes(rows[1]).find(node=>node.type==='button')!.props.disabled,true,'无权限或已不可用的原对象保持不可打开')
 assert.ok(nodes(rows[1]).some(node=>node.children?.includes('Original work is unavailable')))
 filter().props.onChange({target:{value:'task'}});tree=paint()
 const taskRow=nodes(tree).filter(node=>node.type==='article')
 assert.equal(taskRow.length,1)
 const owner=nodes(taskRow[0]).find(node=>node.type==='button'&&node.children.includes('Alice'))!
 assert.equal(owner.props['aria-label'],'View Alice’s profile: 补查审计窗口','同名员工在多行任务中可由读屏区分')
 owner.props.onClick()
 assert.deepEqual(roleOpened,['employee-a'])
 assert.deepEqual(reads,[group.id],'筛选不重新读取或另建关联来源')
 props.group={...group,id:'10000000-0000-4000-8000-000000000002'};paint();for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve));tree=paint()
 assert.equal(filter().props.value,'all','切群后筛选回到全部，不把上一群的选择带过去')
})

test('概览计数与关联列表同源：含项目侧与派生任务，未读到不给 0，不可用任务不推断负责人',()=>{
 const {exported}=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})}})
 const tasks=[{id:'derived',title:'派生任务',assigneeId:'r1',state:'ready',scope:'general'},{id:'linked',title:'显式任务',assigneeId:'r1',state:'ready',scope:'general'}]
 assert.equal(exported.groupLinkedWorkSummary(undefined,tasks),undefined,'未读到时不能显示为 0')
 const detail={groupId:'g',groupVersion:1,version:1,items:[{kind:'task',scope:'general',id:'linked',title:'显式任务',state:'ready',available:true,objectVersion:1},{kind:'task',scope:'general',id:'hidden',title:null,state:null,available:false,objectVersion:null}],projectLinks:[{kind:'business',scope:'SOC',type:'incident',id:'INC-1',title:'项目侧案件',state:'running',available:true,objectVersion:1}]}
 assert.deepEqual(exported.groupLinkedWorkSummary(detail,tasks),{count:4,taskIds:['linked','derived']},'不可用行计入列表数量，但不进入负责事项')
})

test('纯回复已有同来源员工的正式回帖时不再占隐式关联工作，列表、数量与负责事项同步',()=>{
 const {exported}=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract})
 const source={groupId:'g',messageId:'m',rootId:'m',text:'只回复收到',trigger:'routed',executionMode:'reply',createdAssignee:{roleId:'employee',roleVersion:1}}
 const task={id:'reply-task',contentVersion:1,assigneeId:'employee',assigneeRoleVersion:1,state:'waiting',source},detail={groupId:'g',groupVersion:1,version:0,items:[]}
 const recipient={roleId:'employee',name:'员工',taskId:task.id,runId:'run',phase:'completed',resultMessageId:'formal-reply',executionMode:'reply'}
 const status={messageId:'m',attemptVersion:1,phase:'completed',recipients:[recipient],hintCode:null,canRetry:false}
 assert.deepEqual(exported.groupLinkedWorkRows(detail,[task],[status]).implicit,[])
 assert.deepEqual(exported.groupLinkedWorkSummary(detail,[task],[status]),{count:0,taskIds:[]})
 const explicit={...detail,items:[{kind:'task',scope:'general',id:task.id,title:'本人保留的关联',state:'waiting',available:true,objectVersion:3}]}
 assert.deepEqual(exported.groupLinkedWorkSummary(explicit,[task],[status]),{count:1,taskIds:[task.id]},'本人显式关联优先保留')
 for(const variant of [
  {...status,recipients:[{...recipient,resultMessageId:null}]},
  {...status,recipients:[{...recipient,runId:null}]},
  ...['blocked','unknown','awaiting-approval','delivering'].map(phase=>({...status,recipients:[{...recipient,phase}]})),
  {...status,messageId:'other-message'},
  {...status,recipients:[{...recipient,roleId:'other-employee'}]},
  {...status,recipients:[{...recipient,taskId:'other-task'}]},
  {...status,recipients:[{...recipient,executionMode:'work'}]},
 ])assert.deepEqual(exported.groupLinkedWorkRows(detail,[task],[variant]).implicit,[task],'没有同一来源/任务/员工的正式完成回帖就保留原工作')
 assert.deepEqual(exported.groupLinkedWorkRows(detail,[task]).implicit,[task],'状态未读到时保留')
 assert.deepEqual(exported.groupLinkedWorkRows({...detail,groupId:'other-group'},[task],[status]).implicit,[task],'其他群的来源不能影响当前群工作')
 for(const sourcePatch of [{executionMode:'work'},{executionMode:undefined},{trigger:'manual'},{trigger:'mention'},{createdAssignee:null},{createdAssignee:undefined},{createdAssignee:{roleId:'other-employee',roleVersion:1}},{createdAssignee:{roleId:'employee',roleVersion:2}}]){
  const kept={...task,source:{...source,...sourcePatch}}
  assert.deepEqual(exported.groupLinkedWorkRows(detail,[kept],[status]).implicit,[kept],'routed work、历史无mode、手动和提及任务保留')
 }
 for(const unknown of [{contentVersion:undefined},{assigneeRoleVersion:undefined},{assigneeRoleVersion:null}]){
  const kept={...task,...unknown}
  assert.deepEqual(exported.groupLinkedWorkRows(detail,[kept],[status]).implicit,[kept],'内容或当前岗位版本未知时保留原工作')
 }
 for(const state of ['ready','running','blocked','paused','cancelled']){
  const kept={...task,state}
  assert.deepEqual(exported.groupLinkedWorkRows(detail,[kept],[status]).implicit,[kept],'不能拿旧回帖掩盖新的在途或失败状态')
 }
})

test('关联工作组件在真实状态变化后同步正文与summary，未读到正式回帖时仍可打开原任务',async()=>{
 const group={id:'g',version:1,scope:'general',archived:false},task={id:'reply-task',title:'本轮群回复',version:3,contentVersion:1,scope:'general',assigneeId:'employee',assigneeRoleVersion:1,state:'waiting',source:{groupId:'g',messageId:'m',rootId:'m',text:'只回复收到',trigger:'routed',executionMode:'reply',createdAssignee:{roleId:'employee',roleVersion:1}}}
 const recipient:contract.GroupRecipientStatus={roleId:'employee',name:'员工',taskId:task.id,runId:'run',phase:'completed',resultMessageId:'formal-reply',executionMode:'reply'},status:contract.GroupRoutingStatusView={messageId:'m',attemptVersion:1,phase:'completed',recipients:[recipient],hintCode:null,canRetry:false}
 const app=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})}}),summaries:unknown[]=[],opened:unknown[]=[]
 const props={group,tasks:[task],roles:[{id:'employee',name:'员工'}],messageStatuses:[status],api:{get:async()=>({groupId:group.id,version:0,groupVersion:1,items:[]}),subscribe:()=>()=>{},revision:()=>0,pending:()=>undefined,recoveryError:()=>undefined},open:(value:unknown)=>opened.push(value),summarize:(value:unknown)=>summaries.push(value)}
 app.render('GroupLinkedWork',props);for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve));let tree=app.render('GroupLinkedWork',props);for(const effect of app.effects)effect()
 assert.equal(nodes(tree).filter(node=>node.type==='article').length,0)
 assert.deepEqual(summaries.at(-1),{count:0,taskIds:[]})
 await new Promise(resolve=>setImmediate(resolve))
 props.messageStatuses=[{...status,recipients:[{...recipient,resultMessageId:null}]}]
 tree=app.render('GroupLinkedWork',props);for(const effect of app.effects)effect()
 assert.equal(nodes(tree).filter(node=>node.type==='article').length,1)
 assert.deepEqual(summaries.at(-1),{count:1,taskIds:[task.id]})
 nodes(tree).find(node=>node.type==='button'&&node.children.includes(task.title))!.props.onClick()
 assert.equal(opened.length,1,'结果尚未正式贴回时保留原任务入口')
})

for(const [label,change] of [
 ['等待中编辑目标',{contentVersion:2,goal:'请正式分析新资料'}],
 ['同员工改派新岗位版本',{assigneeRoleVersion:2}],
] as const)test(`旧回复不能隐藏${label}的正式工作`,()=>{
 const {exported}=mount('GroupLinkedWork.tsx',{'@teloa/contract':contract})
 const source={groupId:'g',messageId:'m',rootId:'m',text:'只回复收到',trigger:'routed',executionMode:'reply',createdAssignee:{roleId:'employee',roleVersion:1}}
 const original={id:'reply-task',version:3,contentVersion:1,assigneeId:'employee',assigneeRoleVersion:1,state:'waiting',goal:'原自动回复约束',source},changed={...original,version:4,...change}
 const detail={groupId:'g',groupVersion:1,version:0,items:[]},status={messageId:'m',attemptVersion:1,phase:'completed',recipients:[{roleId:'employee',name:'员工',taskId:original.id,runId:'original-run',phase:'completed',resultMessageId:'original-reply',executionMode:'reply'}],hintCode:null,canRetry:false}
 assert.deepEqual(exported.groupLinkedWorkRows(detail,[changed],[status]).implicit,[changed])
 assert.deepEqual(exported.groupLinkedWorkSummary(detail,[changed],[status]),{count:1,taskIds:[changed.id]})
 assert.deepEqual(exported.groupLinkedWorkRows(detail,[original],[status]).implicit,[],'未编辑且岗位版本一致的原回复仍可收起')
})
