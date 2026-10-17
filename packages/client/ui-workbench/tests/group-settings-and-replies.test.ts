import test from 'node:test'
import assert from 'node:assert/strict'
import * as savedCollaborationState from '../src/client/saved-collaboration-state.ts'
import {mount,nodes} from './market-component-harness.ts'

if(!('requestAnimationFrame' in globalThis))globalThis.requestAnimationFrame=(run:any)=>{run();return 0}

const render=()=>mount('SavedCollaborationPage.tsx',{
 './saved-collaboration-state.js':savedCollaborationState,
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
 assert.equal(nodes(paused).find(node=>node.type==='button')!.props.disabled,false)
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

test('直接添加列出未加入的在岗与暂停同事，搜索隐藏选中项也能完整添加',()=>{
 const app=render();let saved:any
 const props={form:{kind:'change',addMembers:true,snapshot:{group:{name:'核对群',scope:'general',announcement:'保留公告',rules,pinned:true,archived:false},members:[{roleId:null},{roleId:'r1'}]}},roles,profileName:'Max',close(){},save:(value:unknown)=>{saved=value},error:undefined}
 let tree=app.render('SavedGroupForm',props)
 const rows=nodes(tree).filter(node=>node.props.className==='groupMemberChoice')
 assert.equal(rows.length,2);assert.ok(rows.some(row=>content(row).includes('暂停同事')))
 const active=rows.find(row=>content(row).includes('程简'))!
 assert.equal(nodes(active).find(node=>node.type==='input')!.props.disabled,false)
 nodes(active).find(node=>node.type==='input')!.props.onChange({target:{checked:true}})
 tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='input'&&node.props['aria-label'])!.props.onChange({target:{value:'没有结果'}})
 tree=app.render('SavedGroupForm',props)
 assert.ok(content(tree).includes('程简'),'已选成员以可移除标签保留')
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved,{name:'核对群',announcement:'保留公告',rules,memberRoleIds:['r1','r2'],pinned:true,archived:false})
})

test('显式添加暂停同事仅保存成员关系，不激活员工或附带执行授权',()=>{
 const app=render();let saved:unknown
 const states=roles.map(role=>({id:role.id,state:role.state}))
 const props={form:{kind:'change',addMembers:true,snapshot:{group:{name:'核对群',scope:'general',announcement:'保留公告',rules,pinned:true,archived:false},members:[{roleId:null},{roleId:'r1'}]}},roles,profileName:'Max',close(){},save:(value:unknown)=>{saved=value},error:undefined}
 let tree=app.render('SavedGroupForm',props)
 const paused=nodes(tree).find(node=>node.props.className==='groupMemberChoice'&&content(node).includes('暂停同事'))!
 assert.ok(content(paused).includes('role.state.paused'))
 const pick=nodes(paused).find(node=>node.type==='input')!
 assert.equal(pick.props.disabled,false);pick.props.onChange({target:{checked:true}})
 tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved,{name:'核对群',announcement:'保留公告',rules,memberRoleIds:['r1','r3'],pinned:true,archived:false})
 assert.deepEqual(roles.map(role=>({id:role.id,state:role.state})),states)
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

test('群设置抽屉关闭保留编辑字段，保存期间不能离开',async()=>{
 const app=render();let closed=0,finish:()=>void
 const props={form:{kind:'create'},roles,profileName:'Max',close(){closed++},save:()=>new Promise<void>(resolve=>{finish=resolve}),error:undefined}
 let tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='input'&&node.props.required)!.props.onChange({target:{value:'保留草稿'}})
 tree=app.render('SavedGroupForm',props)
 tree.props.close()
 tree=app.render('SavedGroupForm',{...props,open:false})
 assert.equal(closed,1)
 assert.equal(nodes(tree).find(node=>node.type==='input'&&node.props.required)!.props.value,'保留草稿')
 tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 tree=app.render('SavedGroupForm',props)
 const member=nodes(tree).find(node=>node.props.className==='groupMemberChoice'&&content(node).includes('林析'))!
 nodes(member).find(node=>node.type==='input')!.props.onChange({target:{checked:true}})
 tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 tree=app.render('SavedGroupForm',props)
 assert.equal(tree.props.canClose,false)
 finish!();await Promise.resolve()
 tree=app.render('SavedGroupForm',props)
 assert.equal(tree.props.canClose,true)
})

test('话题入口按实际时间取最近回复，去重参与者并保留计数与打开回调',()=>{
 const app=render();let opened=false
 const common={groupId:'g',rootId:'root',references:[]}
 const replies=[{...common,id:'new',authorId:'r1',runId:'run',text:'**已核对**，可以继续。',createdAt:'2026-09-22T03:00:00Z'},
 {...common,id:'old',authorId:'r1',runId:'run',text:'正在核对',createdAt:'2026-09-22T01:00:00Z'},
 {...common,id:'middle',authorId:'self',mentions:[],text:'请继续',createdAt:'2026-09-22T02:00:00Z'}]
 const tree=app.render('GroupReplyPreview',{replies,roleNames:{r1:'林析'},open:()=>{opened=true}})
 assert.ok(!content(tree).includes('已核对，可以继续。'),'轻量话题入口不重复展示回复正文')
 assert.equal(nodes(tree).filter(node=>node.props.title==='林析').length,1)
 assert.equal(nodes(tree).find(node=>node.type==='time')!.props.dateTime,replies[0]!.createdAt)
 assert.ok(content(tree).includes('collaboration.reply.count3'))
 tree.props.onClick();assert.equal(opened,true)
 assert.equal(replies[0]!.id,'new','展示排序不能修改目录原数组')
})

test('摘录函数只输出纯文本；话题入口保留历史成员身份与回复计数且不加载正文引用',()=>{
 const app=render(),excerpt=app.exported.groupReplyExcerpt
 assert.equal(excerpt('# 结论\n\n**证据一致**，见[报告](https://example.test)与 `code_id`。'),'结论 证据一致，见报告与 code_id。')
 assert.equal(excerpt('![流程图](https://example.test/image.png)'),'流程图')
 assert.equal(excerpt('x'.repeat(400)).length,180)
 const tree=app.render('GroupReplyPreview',{replies:[{id:'reply',authorId:'unknown',runId:'r',text:'',createdAt:'2026-09-22T03:00:00Z',references:[{kind:'attachment'}]}],roleNames:{},open(){}})
 assert.ok(nodes(tree).some(node=>node.props.title==='collaboration.message.historicalMember'))
 assert.ok(content(tree).includes('collaboration.reply.count1'))
 assert.ok(!content(tree).includes('collaboration.reply.sharedReference'))
 assert.equal(nodes(tree).some(node=>node.type==='img'||node.type==='a'),false)
})
