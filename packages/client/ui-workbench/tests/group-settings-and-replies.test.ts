import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'

const render=()=>mount('SavedCollaborationPage.tsx',{
 './business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作',SOC:'安全运营'})},
 './team-presentation.js':{twinDisplayName:(name:string)=>name+' 的分身'},
 './i18n/provider.js':{useI18n:()=>({t:(key:string,values?:{count:number})=>key+(values?.count??''),time:(at:string)=>at,dateTime:(at:string)=>at,locale:'zh-CN'})},
})
const content=(node:any):string=>typeof node==='string'?node:node?.children?.map(content).join('')??''
const roles=[{id:'r1',name:'林析',kind:'employee',state:'active',scopes:['SOC'],duty:'核对证据'},
 {id:'r2',name:'程简',kind:'employee',state:'active',scopes:['general'],duty:'检查代码'},
 {id:'r3',name:'暂停同事',kind:'employee',state:'paused',scopes:['general'],duty:'历史职责'}]
const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

test('群设置跨页签保留名称、成员和规则草稿，提交完整原有设置',()=>{
 const app=render();let saved:any
 const props={form:{kind:'change',snapshot:{group:{name:'核对群',scope:'general',announcement:'原公告',rules,pinned:true,archived:false},members:[{roleId:null},{roleId:'r1'},{roleId:'r3'}]}},roles,profileName:'Max',close(){},save:(value:unknown)=>{saved=value},error:undefined}
 let tree=app.render('SavedGroupForm',props)
 const pick=(type:string,predicate:(node:any)=>boolean)=>nodes(tree).find(node=>node.type===type&&predicate(node))!
 const tab=(key:string)=>pick('button',node=>node.props.role==='tab'&&content(node).includes('collaboration.form.tab.'+key))
 pick('input',node=>node.props.required).props.onChange({target:{value:'新的群名'}})
 tab('members').props.onClick();tree=app.render('SavedGroupForm',props)
 assert.equal(tab('members').props['aria-selected'],true)
 pick('button',node=>content(node)==='collaboration.form.addMembers').props.onClick();tree=app.render('SavedGroupForm',props)
 const member=pick('label',node=>node.props.className==='groupMemberChoice'&&content(node).includes('程简'))
 nodes(member).find(node=>node.type==='input')!.props.onChange({target:{checked:true}})
 tree=app.render('SavedGroupForm',props);pick('form',()=>true).props.onSubmit({preventDefault(){}});tree=app.render('SavedGroupForm',props)
 const paused=pick('label',node=>node.props.className==='groupMemberChoice'&&content(node).includes('暂停同事'))
 assert.equal(nodes(paused).find(node=>node.type==='button')!.props.disabled,true)
 tab('rules').props.onClick();tree=app.render('SavedGroupForm',props)
 const rule=pick('label',node=>content(node).includes('collaboration.form.rule.mentionAll'))
 nodes(rule).find(node=>node.type==='input')!.props.onChange({target:{checked:false}})
 tab('info').props.onClick();tree=app.render('SavedGroupForm',props)
 assert.equal(pick('input',node=>node.props.required).props.value,'新的群名')
 pick('form',()=>true).props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved,{name:'新的群名',announcement:'原公告',rules:{...rules,mentionAllAllowed:false},memberRoleIds:['r1','r3','r2'],pinned:true,archived:false})
})

test('搜索成员只过滤视图，隐藏的勾选仍随设置提交',()=>{
 const app=render();let saved:any
 const props={form:{kind:'change',snapshot:{group:{name:'核对群',scope:'general',announcement:'',rules,pinned:false,archived:false},members:[{roleId:null},{roleId:'r1'}]}},roles,profileName:'Max',close(){},save:(value:unknown)=>{saved=value},error:undefined}
 let tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='collaboration.form.searchMembers')!.props.onChange({target:{value:'程简'}})
 tree=app.render('SavedGroupForm',props)
 const rows=nodes(tree).filter(node=>node.props.className==='groupMemberChoice')
 assert.equal(rows.length,1)
 assert.ok(!rows.some(row=>content(row).includes('程简')),'未加入的员工不混在成员名单里')
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved.memberRoleIds,['r1'])
})

test('直接添加只列未加入的在岗同事，搜索隐藏选中项也能完整添加',()=>{
 const app=render();let saved:any
 const props={form:{kind:'change',addMembers:true,snapshot:{group:{name:'核对群',scope:'general',announcement:'保留公告',rules,pinned:true,archived:false},members:[{roleId:null},{roleId:'r1'}]}},roles,profileName:'Max',close(){},save:(value:unknown)=>{saved=value},error:undefined}
 let tree=app.render('SavedGroupForm',props)
 const rows=nodes(tree).filter(node=>node.props.className==='groupMemberChoice')
 assert.equal(rows.length,1);assert.ok(content(rows[0]).includes('程简'))
 nodes(rows[0]).find(node=>node.type==='input')!.props.onChange({target:{checked:true}})
 tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='input'&&node.props['aria-label'])!.props.onChange({target:{value:'没有结果'}})
 tree=app.render('SavedGroupForm',props)
 assert.ok(content(tree).includes('程简'),'已选成员以可移除标签保留')
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved,{name:'核对群',announcement:'保留公告',rules,memberRoleIds:['r1','r2'],pinned:true,archived:false})
})

test('新建群先填信息再选成员，返回修改信息不丢选择且最后一步才写入',()=>{
 const app=render();let saved:any
 const props={form:{kind:'create'},roles,profileName:'Max',close(){},save:(value:unknown)=>{saved=value},error:undefined}
 let tree=app.render('SavedGroupForm',props)
 const submit=()=>nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 nodes(tree).find(node=>node.type==='input'&&node.props.required)!.props.onChange({target:{value:'新群'}})
 tree=app.render('SavedGroupForm',props);submit();tree=app.render('SavedGroupForm',props)
 assert.equal(typeof saved,'undefined')
 const row=nodes(tree).find(node=>node.props.className==='groupMemberChoice'&&content(node).includes('林析'))!
 nodes(row).find(node=>node.type==='input')!.props.onChange({target:{checked:true}})
 tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='button'&&content(node)==='collaboration.form.back')!.props.onClick()
 tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='select')!.props.onChange({target:{value:'SOC'}})
 tree=app.render('SavedGroupForm',props);submit();tree=app.render('SavedGroupForm',props);submit()
 assert.equal(saved.scope,'SOC');assert.equal(saved.name,'新群');assert.deepEqual(saved.memberRoleIds,['r1'])
})

test('群弹窗只接受完整的遮罩点击，内部点击、跨边界拖选和草稿不触发关闭',()=>{
 const app=render();let closed=0
 const props={form:{kind:'create'},roles,profileName:'Max',close(){closed++},save(){},error:undefined}
 let tree=app.render('SavedGroupForm',props)
 const currentTarget={getBoundingClientRect:()=>({left:100,right:500,top:100,bottom:600})}
 const outside={target:currentTarget,currentTarget,clientX:30,clientY:200}
 const inside={target:{},currentTarget,clientX:200,clientY:200}
 tree.props.onPointerDown(inside);tree.props.onClick(inside)
 tree.props.onPointerDown(inside);tree.props.onClick(outside)
 tree.props.onPointerDown(outside);tree.props.onPointerCancel();tree.props.onClick(outside)
 assert.equal(closed,0)
 tree.props.onPointerDown(outside);tree.props.onClick(outside)
 assert.equal(closed,1,'未编辑的表单仍能点遮罩关闭')
 nodes(tree).find(node=>node.type==='input'&&node.props.required)!.props.onChange({target:{value:'保留草稿'}})
 tree=app.render('SavedGroupForm',props)
 tree.props.onPointerDown(outside);tree.props.onClick(outside)
 assert.equal(closed,1,'已有群名时遮罩点击不能丢弃草稿')
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='collaboration.form.close')!.props.onClick()
 assert.equal(closed,2,'显式叉号仍能关闭')
})

test('话题摘要按实际时间取最近回复，去重参与者并保留打开回调',()=>{
 const app=render();let opened=false
 const common={groupId:'g',rootId:'root',references:[]}
 const replies=[{...common,id:'new',authorId:'r1',runId:'run',text:'**已核对**，可以继续。',createdAt:'2026-09-22T03:00:00Z'},
 {...common,id:'old',authorId:'r1',runId:'run',text:'正在核对',createdAt:'2026-09-22T01:00:00Z'},
 {...common,id:'middle',authorId:'self',mentions:[],text:'请继续',createdAt:'2026-09-22T02:00:00Z'}]
 const tree=app.render('GroupReplyPreview',{replies,roleNames:{r1:'林析'},open:()=>{opened=true}})
 assert.ok(content(tree).includes('已核对，可以继续。'))
 assert.ok(content(tree).includes('林析'))
 assert.equal(nodes(tree).filter(node=>node.props.title==='林析').length,1)
 assert.equal(nodes(tree).find(node=>node.type==='time')!.props.dateTime,replies[0]!.createdAt)
 assert.ok(content(tree).includes('collaboration.reply.count3'))
 tree.props.onClick();assert.equal(opened,true)
 assert.equal(replies[0]!.id,'new','展示排序不能修改目录原数组')
})

test('话题摘录不创建链接、图片或 HTML；无正文引用回复有可见提示',()=>{
 const app=render(),excerpt=app.exported.groupReplyExcerpt
 assert.equal(excerpt('# 结论\n\n**证据一致**，见[报告](https://example.test)与 `code_id`。'),'结论 证据一致，见报告与 code_id。')
 assert.equal(excerpt('![流程图](https://example.test/image.png)'),'流程图')
 assert.equal(excerpt('x'.repeat(400)).length,180)
 const tree=app.render('GroupReplyPreview',{replies:[{id:'reply',authorId:'unknown',runId:'r',text:'',createdAt:'2026-09-22T03:00:00Z',references:[{kind:'attachment'}]}],roleNames:{},open(){}})
 assert.ok(content(tree).includes('collaboration.message.historicalMember'))
 assert.ok(content(tree).includes('collaboration.reply.sharedReference'))
 assert.equal(nodes(tree).some(node=>node.type==='img'||node.type==='a'),false)
})
