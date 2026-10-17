import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes} from './market-component-harness.ts'
import * as presets from '../src/client/role-hire-presets.ts'
import * as runtime from '../src/client/role-runtime-config.ts'
import * as models from '../src/client/role-models.ts'
import * as scopes from '../src/client/role-scope-options.ts'
import * as avatars from '../src/client/staff-avatar-seed.ts'
import {employeeCopy} from '../src/client/employee-copy.ts'

const avatarModule={employeeAvatarName:(key:string)=>key==='researcher'?'Researcher':'General',employeeAvatars:[{key:'general',en:'General',zh:'通用工作伙伴'},{key:'researcher',en:'Researcher',zh:'研究助手'}]}
function form(runtimeConfigs?:runtime.RoleRuntimeConfigApi,initial?:any){
 // 形象网格是共享组件 EmployeeAvatarPicker：用同一手动调度器挂真实组件，网格节点仍在 RoleForm 树里可查。
 const picker=mount('EmployeeAvatarPicker.tsx',{'./employee-copy.js':{employeeCopy},'./employee-avatars.js':avatarModule})
 const mounted=mount('TeamPage.tsx',{
  './EmployeeAvatarPicker.js':{EmployeeAvatarPicker:function EmployeeAvatarPicker(props:any){return picker.render('EmployeeAvatarPicker',props)}},
  './role-hire-presets.ts':presets,'./role-runtime-config.js':runtime,'./role-models.js':models,
  './role-scope-options.js':scopes,'./staff-avatar-seed.ts':avatars,
  './business-scope-context.js':{useBusinessScopes:()=>({general:'General'})},
  './RoleModelFields.js':{RoleModelFields:'model-fields'},
  './employee-copy.js':{employeeCopy},
  './employee-avatars.js':avatarModule,
 })
 let saved:any
 const props={work:{},resourceApi:{},runtimeConfigs,initial,close:()=>{},save:(value:any)=>{saved=value}}
 const render=()=>mounted.render('RoleForm',props)
 const setName=()=>nodes(render()).find(node=>node.type==='input'&&node.props.maxLength===80)!.props.onChange({target:{value:'Alice'}})
 const next=()=>render().props.submit()
 const setMission=(value='Research and draft a sourced report.')=>nodes(render()).find(node=>node.type==='textarea'&&node.props.placeholder==='team.form.missionPlaceholder')!.props.onChange({target:{value}})
 return {render,setName,setMission,next,saved:()=>saved,load:async()=>{render();for(const effect of mounted.effects)effect();await Promise.resolve();await Promise.resolve()}}
}

test('描述职责创建员工不把岗位文案保存成虚构 Skill ID',()=>{
 for(const duty of ['Research a launch.','Review a code change.']){
  const ui=form();ui.setName();ui.next();ui.setMission(duty)
  ui.next();ui.next();ui.next()
  assert.ok(ui.saved(),'recruitment must reach save')
  assert.deepEqual(ui.saved().skills,[],'display labels must never become runtime Skill IDs')
 }
})

test('a custom non-security mission survives boundaries and appears on the final badge and saved role',()=>{
 const ui=form();ui.setName();ui.next()
 const mission=nodes(ui.render()).find(node=>node.type==='textarea'&&node.props.placeholder==='team.form.missionPlaceholder')
 assert.ok(mission,'new colleagues need an editable mission before creation')
 mission.props.onChange({target:{value:'Research the Lumen launch and deliver a sourced content brief.'}})
 ui.next()
 nodes(ui.render()).find(node=>node.type==='button'&&node.props.role==='radio'&&node.children.includes('team.hire.level.never'))!.props.onClick()
 ui.next()
 assert.ok(nodes(ui.render()).some(node=>node.children.includes('Research the Lumen launch and deliver a sourced content brief.')),'badge shows the edited mission')
 ui.next()
 assert.equal(ui.saved().duty,'Research the Lumen launch and deliver a sourced content brief.')
})

test('空白职责留在职责步骤并给出字段错误，其他草稿不丢失',()=>{
 const ui=form();ui.setName();ui.next()
 const mission=nodes(ui.render()).find(node=>node.type==='textarea'&&node.props.placeholder==='team.form.missionPlaceholder')!
 mission.props.onChange({target:{value:'   '}})
 ui.next()
 const tree=nodes(ui.render())
 assert.ok(tree.some(node=>node.type==='textarea'&&node.props.placeholder==='team.form.missionPlaceholder'),'空白职责不能进入边界步骤')
 assert.ok(tree.some(node=>node.props.role==='alert'),'必须明确说明缺失字段')
 assert.equal(ui.saved(),undefined)
})

test('入职默认不请求模型目录；主动展开后改选的首选、备用与思考档位随岗位保存',async()=>{
 let reads=0
 const local={provider:'ollama',model:'small'},remote={provider:'cloud',model:'large',reasoningEffort:'high'}
 const ui=form({list:async()=>{throw Error('入职不读预设目录')},models:async()=>{reads++;return {default:remote,groups:[{id:'ollama',name:'Ollama',remote:false,models:[{id:'small',name:'Small'}]},{id:'cloud',name:'Cloud',remote:true,models:[{id:'large',name:'Large',reasoning:{efforts:[{id:'high',name:'High'}]}}]}],failures:[]}}})
 ui.setName();ui.next();ui.setMission();ui.next();ui.next();await ui.load();assert.equal(reads,0)
 const detail=nodes(ui.render()).find(node=>node.type==='details'&&node.children.some(child=>child?.type==='summary'&&child.children.includes('roleModels.title')))
 assert.ok(detail);detail.props.onToggle({currentTarget:{open:true}});await ui.load();assert.equal(reads,1)
 let picker=nodes(ui.render()).find(node=>node.type==='model-fields')!;picker.props.change('model',local)
 picker=nodes(ui.render()).find(node=>node.type==='model-fields')!;picker.props.change('fallbackModel',remote)
 ui.next();assert.deepEqual(ui.saved().runtimeConfig,{model:local,fallbackModel:remote})
})

test('小松鼠选择保存准确标识，SOP导入与描述共用职责草稿',async()=>{
 const ui=form();ui.setName()
 nodes(ui.render()).find(node=>node.props.role==='radio'&&node.props['aria-label']==='Researcher')!.props.onClick()
 ui.next();ui.setMission('Draft still kept.')
 nodes(ui.render()).find(node=>node.type==='button'&&node.children.includes(employeeCopy('en','importSop')))!.props.onClick()
 const upload=nodes(ui.render()).find(node=>node.type==='input'&&node.props.type==='file')!
 await upload.props.onChange({target:{files:[{name:'role.md',size:80,arrayBuffer:async()=>new TextEncoder().encode('Review sources and deliver a report.').buffer}]}})
 assert.equal(nodes(ui.render()).find(node=>node.type==='textarea'&&node.props.placeholder==='team.form.missionPlaceholder')!.props.value,'Review sources and deliver a report.')
 nodes(ui.render()).find(node=>node.type==='button'&&node.children.includes(employeeCopy('en','describe')))!.props.onClick()
 ui.next();ui.next();ui.next()
 assert.equal(ui.saved().avatarKey,'researcher')
 assert.equal(ui.saved().duty,'Review sources and deliver a report.')
})

test('无效SOP显式报错并保留本人职责，返回描述可继续确认',async()=>{
 const ui=form();ui.setName();ui.next();ui.setMission('Keep this description.')
 nodes(ui.render()).find(node=>node.type==='button'&&node.children.includes(employeeCopy('en','importSop')))!.props.onClick()
 await nodes(ui.render()).find(node=>node.type==='input'&&node.props.type==='file')!.props.onChange({target:{files:[{name:'role.pdf',size:8}]}})
 assert.ok(nodes(ui.render()).some(node=>node.props.role==='alert'))
 ui.next()
 assert.ok(nodes(ui.render()).some(node=>node.type==='textarea'&&node.props.value==='Keep this description.'))
 nodes(ui.render()).find(node=>node.type==='button'&&node.children.includes(employeeCopy('en','describe')))!.props.onClick()
 ui.next();ui.next();ui.next()
 assert.equal(ui.saved().duty,'Keep this description.')
})

test('恢复员工草稿保持姓名、职责、头像及已选择的动作边界',()=>{
 const first=form();first.setName();first.next();first.setMission('Review the same sources.');first.next()
 nodes(first.render()).find(node=>node.type==='button'&&node.props.role==='radio'&&node.children.includes('team.hire.level.never'))!.props.onClick()
 first.next();first.next()
 const restored=form(undefined,first.saved());restored.next()
 assert.equal(nodes(restored.render()).find(node=>node.type==='textarea'&&node.props.placeholder==='team.form.missionPlaceholder')!.props.value,'Review the same sources.')
 restored.next()
 assert.equal(nodes(restored.render()).find(node=>node.type==='button'&&node.props.role==='radio'&&node.children.includes('team.hire.level.never'))!.props['aria-checked'],true)
 restored.next();restored.next()
 assert.deepEqual(restored.saved(),first.saved())
})
