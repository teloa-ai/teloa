import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'

const people=[
 {id:'self',name:'我',kind:'human' as const,state:'active' as const},
 {id:'investigator',name:'调查岗',kind:'digital' as const,state:'active' as const},
 {id:'twin',name:'我的分身',kind:'draft' as const,state:'active' as const},
 {id:'retired',name:'旧岗',kind:'digital' as const,state:'retired' as const},
]
const openRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
const group={id:'g1',name:'SOC 协作',scope:'SOC',memberIds:['self','investigator'],announcement:'先核对证据。',createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z',pinned:false,archived:false,version:1}
const page=()=>mount('CollaborationPage.tsx',{
 './business-scope-context.js':{useBusinessScopes:()=>({general:'通用',SOC:'SOC'})},
 './SavedCollaborationPage.js':{SavedCollaborationPage:()=>null},
 './role-preview.js':{rolePeople:()=>people},
 './team-presentation.js':{twinDisplayName:(name:string)=>`${name} 的分身`},
})
const keys=(tree:any,type:string)=>nodes(tree).filter(node=>node.type===type).flatMap(node=>node.children.filter((child:unknown)=>typeof child==='string'))

test('创建协作群弹层只留名称、业务范围、成员下限与边界句，没有公告与群规则',()=>{
 const rendered=page()
 const tree=rendered.render('GroupForm',{people,profileName:'Max',error:undefined,group:undefined,rules:openRules,close:()=>{},save:()=>{}})
 assert.equal(tree.props['aria-label'],'collaboration.action.new')
 assert.deepEqual(keys(tree,'h2'),['collaboration.action.new'])
 assert.deepEqual(keys(tree,'legend'),['collaboration.form.memberLimit'])
 assert.ok(nodes(tree).some(node=>node.type==='select'))
 assert.equal(nodes(tree).some(node=>node.type==='textarea'),false)
 assert.deepEqual(keys(tree,'p'),['collaboration.form.memberBoundary'])
 assert.equal(nodes(tree).some(node=>node.children.includes('collaboration.form.rule.history')),false)
 assert.deepEqual(keys(tree,'button').filter(key=>key.startsWith('collaboration.')),['collaboration.form.cancel','collaboration.action.new'])
 const rows=nodes(tree).filter(node=>node.props.className==='memberChoice')
 assert.deepEqual(rows.map(row=>nodes(row).find(node=>node.type==='span')!.children[0]),['Max','调查岗','Max 的分身','旧岗'])
 assert.deepEqual(rows.map(row=>nodes(row).find(node=>node.type==='small')!.children[0]),['collaboration.message.selfRole','collaboration.member.digital','collaboration.member.twin','collaboration.member.digital · role.state.retired'])
 assert.equal(nodes(rows[0]!).find(node=>node.type==='input')!.props.disabled,true)
})

test('成员不足两位时不能创建，补足后提交空公告与默认群规则',()=>{
 const rendered=page()
 const props={people,profileName:'Max',error:undefined,group:undefined,rules:openRules,close:()=>{},save:(value:unknown)=>{saved=value}}
 let saved:unknown
 let tree=rendered.render('GroupForm',props)
 const submit=()=>nodes(tree).find(node=>node.type==='button'&&node.props.type==='submit')!
 assert.equal(submit().props.disabled,true)
 nodes(tree).find(node=>node.type==='input'&&node.props.required)!.props.onChange({target:{value:'SOC 协作'}})
 tree=rendered.render('GroupForm',props)
 assert.equal(submit().props.disabled,true)
 nodes(tree).filter(node=>node.type==='input'&&node.props.type==='checkbox')[1]!.props.onChange({target:{checked:true}})
 tree=rendered.render('GroupForm',props)
 assert.equal(submit().props.disabled,false)
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved,{name:'SOC 协作',scope:'general',announcement:'',memberIds:['self','investigator'],rules:openRules})
})

test('成员与群设置弹层留公告、成员与职责、三条群规则和对象引用边界句',()=>{
 const rendered=page()
 const props={people,profileName:'Max',error:undefined,group,rules:{historyVisibleToNewMembers:false,draftsVisibleInGroup:true,mentionAllAllowed:true},close:()=>{},save:(value:unknown)=>{saved=value}}
 let saved:any
 let tree=rendered.render('GroupForm',props)
 assert.equal(tree.props['aria-label'],'collaboration.form.edit')
 assert.deepEqual(keys(tree,'h2'),['collaboration.form.edit'])
 assert.deepEqual(keys(tree,'legend'),['collaboration.form.members'])
 assert.ok(nodes(tree).some(node=>node.type==='textarea'))
 assert.equal(nodes(tree).some(node=>node.type==='select'),false)
 assert.deepEqual(keys(tree,'p'),['collaboration.form.ruleBoundary'])
 const ruleRows=nodes(tree).filter(node=>node.props.className==='memberChoice').slice(people.length)
 assert.deepEqual(ruleRows.map(row=>nodes(row).find(node=>node.type==='span')!.children[0]),['collaboration.form.rule.history','collaboration.form.rule.drafts','collaboration.form.rule.mentionAll'])
 assert.deepEqual(ruleRows.map(row=>nodes(row).find(node=>node.type==='input')!.props.checked),[false,true,true])
 assert.deepEqual(keys(tree,'button').filter(key=>key.startsWith('collaboration.')),['collaboration.form.cancel','collaboration.form.saveSettings'])
 nodes(ruleRows[2]!).find(node=>node.type==='input')!.props.onChange({target:{checked:false}})
 tree=rendered.render('GroupForm',props)
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved.rules,{historyVisibleToNewMembers:false,draftsVisibleInGroup:true,mentionAllAllowed:false})
 assert.equal(saved.announcement,'先核对证据。')
})
