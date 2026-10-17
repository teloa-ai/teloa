import test from 'node:test'
import assert from 'node:assert/strict'
import * as contract from '@teloa/contract'
import * as savedState from '../src/client/saved-collaboration-state.ts'
import {mount,nodes} from './market-component-harness.ts'

test('通用群任务选择目标业务后只可指派原范围员工，并把固定业务交给原创建链',()=>{
 const app=mount('SavedCollaborationPage.tsx',{'@teloa/contract':contract,'./saved-collaboration-state.js':savedState,'./business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作',SOC:'安全运营',AppSec:'应用安全'})}},['SavedGroupTaskForm'])
 const created:unknown[]=[],props={form:{message:{text:'核对固定业务'}},scope:'general',members:[{roleId:null},{roleId:'soc'},{roleId:'app'}],roles:[{id:'soc',name:'安全运营员工',kind:'employee',state:'active',scopes:['SOC'],version:1},{id:'app',name:'应用安全员工',kind:'employee',state:'active',scopes:['AppSec'],version:2}],grants:{},close(){},create:(...values:unknown[])=>created.push(values),error:undefined}
 let tree=app.render('SavedGroupTaskForm',props)
 const pick=(key:string)=>nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']===key)!
 assert.ok(pick('group.task.business'),'原任务抽屉应提供目标业务选择')
 pick('group.task.business').props.onChange({target:{value:'SOC'}});tree=app.render('SavedGroupTaskForm',props)
 const owner=nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='collaboration.task.assignee')!
 assert.deepEqual(nodes(owner).filter(node=>node.type==='option').map(node=>node.props.value),['','soc'])
 const collapsed:string[]=[]
 owner.props.onChange({target:{value:'soc'},currentTarget:{closest:(selector:string)=>{assert.equal(selector,'details');return {removeAttribute:(name:string)=>collapsed.push(name)}}}});tree=app.render('SavedGroupTaskForm',props)
 assert.deepEqual(collapsed,['open'],'选中员工只收起原表单的局部配置')
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.deepEqual(created,[['核对固定业务',{roleId:'soc',expectedVersion:1},{scope:'SOC'}]])
})
