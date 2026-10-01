import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes} from './market-component-harness.ts'
import * as presets from '../src/client/role-hire-presets.ts'
import * as runtime from '../src/client/role-runtime-config.ts'
import * as models from '../src/client/role-models.ts'
import * as scopes from '../src/client/role-scope-options.ts'
import * as avatars from '../src/client/staff-avatar-seed.ts'

function form(runtimeConfigs?:runtime.RoleRuntimeConfigApi){
 const mounted=mount('TeamPage.tsx',{
  './role-hire-presets.ts':presets,'./role-runtime-config.js':runtime,'./role-models.js':models,
  './role-scope-options.js':scopes,'./staff-avatar-seed.ts':avatars,
  './business-scope-context.js':{useBusinessScopes:()=>({general:'General'})},
  './RoleModelFields.js':{RoleModelFields:'model-fields'},
 })
 let saved:any
 const props={work:{},resourceApi:{},runtimeConfigs,close:()=>{},save:(value:any)=>{saved=value}}
 const render=()=>mounted.render('RoleForm',props)
 const setName=()=>nodes(render()).find(node=>node.type==='input'&&node.props.maxLength===80)!.props.onChange({target:{value:'Alice'}})
 const next=()=>render().props.submit()
 return {render,setName,next,saved:()=>saved,load:async()=>{render();for(const effect of mounted.effects)effect();await Promise.resolve();await Promise.resolve()}}
}

test('self-fill recruitment saves no imaginary Skill IDs for default or specialist roles',()=>{
 for(const selectSpecialist of [false,true]){
  const ui=form();ui.setName();ui.next()
  if(selectSpecialist)nodes(ui.render()).find(node=>node.type==='button'&&node.children.some(child=>child?.type==='strong'&&child.children.includes('team.hire.preset.code.name')))!.props.onClick()
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

test('入职默认不请求模型目录；主动展开后改选的首选、备用与思考档位随岗位保存',async()=>{
 let reads=0
 const local={provider:'ollama',model:'small'},remote={provider:'cloud',model:'large',reasoningEffort:'high'}
 const ui=form({list:async()=>{throw Error('入职不读预设目录')},models:async()=>{reads++;return {default:remote,groups:[{id:'ollama',name:'Ollama',remote:false,models:[{id:'small',name:'Small'}]},{id:'cloud',name:'Cloud',remote:true,models:[{id:'large',name:'Large',reasoning:{efforts:[{id:'high',name:'High'}]}}]}],failures:[]}}})
 ui.setName();ui.next();ui.next();ui.next();await ui.load();assert.equal(reads,0)
 const detail=nodes(ui.render()).find(node=>node.type==='details'&&node.children.some(child=>child?.type==='summary'&&child.children.includes('roleModels.title')))
 assert.ok(detail);detail.props.onToggle({currentTarget:{open:true}});await ui.load();assert.equal(reads,1)
 let picker=nodes(ui.render()).find(node=>node.type==='model-fields')!;picker.props.change('model',local)
 picker=nodes(ui.render()).find(node=>node.type==='model-fields')!;picker.props.change('fallbackModel',remote)
 ui.next();assert.deepEqual(ui.saved().runtimeConfig,{model:local,fallbackModel:remote})
})
