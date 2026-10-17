import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'

const role={id:'employee',kind:'employee',name:'核查员',state:'active',duty:'核查资料',scopes:['general']}
const group={id:'group',version:1,name:'协作群',scope:'general',announcement:'',pinned:false,archived:false,rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}}
const props={open:true,form:{kind:'change',snapshot:{group,members:[{roleId:null},{roleId:role.id}]}},roles:[role],profileName:'Max',close:()=>{},save:()=>{},error:undefined}
const fixture=()=>mount('SavedCollaborationPage.tsx',{'./business-scope-context.js':{useBusinessScopes:()=>({general:'通用'})}})

test('群说明与公告独立编辑，业务归属只读，关闭重开保留说明并向原群提交',async()=>{
 let saved:any
 const app=fixture(),input={...props,form:{...props.form,snapshot:{...props.form.snapshot,group:{...group,purpose:'共同核查采购资料'}}},save:async(value:any)=>{saved=value}}
 let tree=app.render('SavedGroupForm',input)
 const purpose=()=>nodes(tree).find(node=>node.type==='input'&&node.props.maxLength===240)!
 assert.ok(purpose(),'群说明必须有独立输入，不复用公告')
 assert.equal(purpose().props.value,'共同核查采购资料')
 purpose().props.onChange({target:{value:'持续核查采购与付款资料'}})
 nodes(tree).find(node=>node.type==='textarea')!.props.onChange({target:{value:'周五前提供发票'}})
 app.render('SavedGroupForm',{...input,open:false});tree=app.render('SavedGroupForm',input)
 assert.equal(purpose().props.value,'持续核查采购与付款资料')
 assert.ok(nodes(tree).some(node=>node.children.includes('collaboration.form.scope')))
 assert.ok(nodes(tree).some(node=>node.children.includes('通用')))
 assert.equal(nodes(tree).some(node=>node.type==='select'&&!node.props['aria-label']),false,'已有群归属不是可随意修改的配置')
 await nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.equal(saved.purpose,'持续核查采购与付款资料');assert.equal(saved.announcement,'周五前提供发票')
 assert.equal('scope' in saved,false)
})

test('选择刚保存的新群时，不清其他业务的新建草稿',()=>{
 const app=mount('CollaborationPage.tsx')
 const input={visible:true,target:{groupId:'old',rootId:''},roles:[],profileName:'Max',persistence:{api:{},directory:{}}}
 let tree=app.render('CollaborationPage',input)
 tree.props.creationForms.change([{kind:'create',scope:'SOC',draft:{name:'SOC 草稿'}},{kind:'create',scope:'AppSec',draft:{name:'AppSec 草稿'}}])
 tree=app.render('CollaborationPage',input)
 tree.props.creationForms.change((current:any[])=>current.filter(row=>row.scope!=='AppSec'))
 tree=app.render('CollaborationPage',{...input,target:{groupId:'new-appsec',rootId:''}})
 assert.equal(tree.props.key,'new-appsec')
 assert.deepEqual(tree.props.creationForms.items.map((row:any)=>[row.scope,row.draft.name]),[['SOC','SOC 草稿']])
})

test('从业务入口新建群默认跨业务协作（general），本人主动选择业务后关闭重开按草稿恢复名称与所选业务',()=>{
 let draft:any
 const input={...props,form:{kind:'create',scope:'SOC'},draftChanged:(next:any)=>{draft=next}}
 const first=fixture()
 let tree=first.render('SavedGroupForm',input)
 assert.equal(nodes(tree).find(node=>node.type==='select')!.props.value,'general','入口业务不自动成为新群归属')
 nodes(tree).find(node=>node.type==='input'&&node.props.required)!.props.onChange({target:{value:'SOC 草稿'}})
 nodes(tree).find(node=>node.type==='select')!.props.onChange({target:{value:'SOC'}})
 first.render('SavedGroupForm',input)
 for(const effect of first.effects)effect()
 assert.equal(draft.name,'SOC 草稿');assert.equal(draft.scope,'SOC','本人明确选择的业务进入未提交草稿')
 const restored=fixture().render('SavedGroupForm',{...input,form:{...input.form,draft}})
 assert.equal(nodes(restored).find(node=>node.type==='input'&&node.props.required)!.props.value,'SOC 草稿')
 assert.equal(nodes(restored).find(node=>node.type==='select')!.props.value,'SOC')
})

test('群设置关闭再开保留未保存公告、成员筛选与原对象基线',()=>{
 const app=fixture()
 let tree=app.render('SavedGroupForm',props)
 nodes(tree).find(node=>node.type==='textarea')!.props.onChange({target:{value:'未保存公告'}})
 nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='collaboration.form.searchMembers')!.props.onChange({target:{value:'核查'}})
 app.render('SavedGroupForm',{...props,open:false})
 tree=app.render('SavedGroupForm',props)
 assert.equal(nodes(tree).find(node=>node.type==='textarea')!.props.value,'未保存公告')
 assert.equal(nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='collaboration.form.searchMembers')!.props.value,'核查')
 assert.equal(tree.props.open,true)
})

test('群成员选择器Escape先回父成员面板并恢复筛选，未提交成员变更',()=>{
 const previous=globalThis.requestAnimationFrame
 globalThis.requestAnimationFrame=(run:any)=>{run();return 0}
 try{
  let saved=0,closed=0
  const app=fixture(),input={...props,close:()=>closed++,save:()=>saved++}
  let tree=app.render('SavedGroupForm',input)
  nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='collaboration.form.searchMembers')!.props.onChange({target:{value:'核查'}})
  tree=app.render('SavedGroupForm',input)
  nodes(tree).find(node=>node.type==='button'&&node.children.includes('collaboration.form.addMembers'))!.props.onClick()
  tree=app.render('SavedGroupForm',input)
  assert.equal(tree.props.title,'collaboration.form.addMembers')
  let prevented=0
  nodes(tree).find(node=>node.type==='form')!.props.onKeyDown({key:'Escape',preventDefault:()=>prevented++,stopPropagation(){}})
  tree=app.render('SavedGroupForm',input)
  assert.equal(tree.props.title,'collaboration.form.edit')
  assert.equal(nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='collaboration.form.searchMembers')!.props.value,'核查')
  assert.equal(prevented,1);assert.equal(saved,0);assert.equal(closed,0)
 }finally{globalThis.requestAnimationFrame=previous}
})


test('群资料关闭再开保留新增标题正文，放弃草稿是单独显式动作',()=>{
 let closed=0,discarded=0,saved=0
 const app=fixture(),input={open:true,form:{groupId:'group',resource:undefined,markdown:''},close:()=>closed++,discard:()=>discarded++,save:()=>saved++,error:undefined}
 let tree=app.render('SavedResourceForm',input)
 nodes(tree).find(node=>node.type==='input')!.props.onChange({target:{value:'新资料草稿'}})
 nodes(tree).find(node=>node.type==='textarea')!.props.onChange({target:{value:'尚未保存正文'}})
 tree.props.close();app.render('SavedResourceForm',{...input,open:false})
 tree=app.render('SavedResourceForm',input)
 assert.equal(nodes(tree).find(node=>node.type==='input')!.props.value,'新资料草稿')
 assert.equal(nodes(tree).find(node=>node.type==='textarea')!.props.value,'尚未保存正文')
 assert.equal(closed,1);assert.equal(discarded,0);assert.equal(saved,0)
 nodes(tree).find(node=>node.type==='button'&&node.children.includes('collaboration.resources.discardDraft'))!.props.onClick()
 assert.equal(discarded,1);assert.equal(saved,0)
})

test('原模板团队正式创建确认展示暂停成员、原协调者和权限边界，关闭重开不提交或激活',async()=>{
 const source={kind:'industry-load',loadId:'original-load',contentId:'original-content',contentHash:'a'.repeat(64),mappingHash:'b'.repeat(64)}
 const other={...role,id:'writer',name:'编辑员',state:'paused'},paused={...role,state:'paused'}
 const team={name:'Marketing',scope:'general',memberRoleIds:[paused.id,other.id],coordinatorRoleId:paused.id,source}
 let saved:any,calls=0
 const app=fixture(),input={...props,form:{kind:'create',scope:'general',team},roles:[paused,other],save:async(value:any)=>{calls++;saved=value}}
 let tree=app.render('SavedGroupForm',input)
 assert.equal(nodes(tree).find(n=>n.type==='input'&&n.props.required)!.props.value,'Marketing')
 assert.equal(nodes(tree).filter(n=>n.type==='input'&&n.props.type==='checkbox'&&n.props.checked).length,2)
 assert.ok(nodes(tree).some(n=>n.children.includes('collaboration.form.memberBoundary')))
 app.render('SavedGroupForm',{...input,open:false});tree=app.render('SavedGroupForm',input);assert.equal(calls,0)
 await nodes(tree).find(n=>n.type==='form')!.props.onSubmit({preventDefault(){}})
 tree=app.render('SavedGroupForm',input)
 await nodes(tree).find(n=>n.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.equal(calls,1);assert.deepEqual(saved.source,source);assert.deepEqual(saved.memberRoleIds,[paused.id,other.id]);assert.equal(saved.coordinatorRoleId,paused.id)
 assert.equal('activate' in saved,false)
})

test('移除已暂停协调者与清除协调者在同一群变更，source不进入change请求',async()=>{
 const other={...role,id:'writer',name:'编辑员'},paused={...role,state:'paused'}
 const app=fixture();let saved:any
 const input={...props,roles:[paused,other],form:{kind:'change',snapshot:{group:{...group,coordinatorRoleId:paused.id,source:{kind:'industry-load'}},members:[{roleId:null},{roleId:paused.id},{roleId:other.id}]}},save:async(value:any)=>{saved=value}}
 let tree=app.render('SavedGroupForm',input)
 const remove=nodes(tree).find(n=>n.type==='button'&&n.props['aria-label']==='collaboration.form.removeMember'&&n.props.className==='replyButton')!
 assert.equal(remove.props.disabled,false);remove.props.onClick();tree=app.render('SavedGroupForm',input)
 await nodes(tree).find(n=>n.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved.memberRoleIds,[other.id]);assert.equal(saved.coordinatorRoleId,null);assert.equal('source' in saved,false)
})
