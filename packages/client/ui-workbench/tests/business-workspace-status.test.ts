import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
import * as presentation from '../src/client/business-workspace-presentation.ts'

test('员工身份已读取但任务失败时，进展保持未知；注意事项失败可重试',()=>{
 const app=mount('BusinessWorkspace.tsx',{
  './business-workspace-presentation.js':presentation,
  './business-workspace-copy.js':{businessWorkspaceText:(_locale:string,key:string)=>key},
  './i18n/provider.js':{useI18n:()=>({t:(key:string)=>key,locale:'en',number:String,dateTime:String})},
 })
 let refreshed=0
 const services={groups:{},attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:false,tasksFailed:true,attentionKnown:false,attentionFailed:true,refresh:()=>refreshed++}
 const tree=app.render('BusinessWorkspace',{scope:'sales',title:'Sales',target:{scope:'sales',section:'overview'},state:{tasks:[],roles:[{id:'employee',name:'Analyst',storage:'persistent',kind:'employee',state:'active',scopes:['sales'],duty:'Analyze'}]},services,dashboardApi:{}})
 const flat=nodes(tree),children=flat.flatMap(row=>row.children)
 assert.ok(children.includes('Analyst'))
 assert.ok(children.includes('failed'))
 assert.ok(children.includes('—'))
 assert.ok(!children.includes('idle'))
 const retry=flat.find(row=>row.type==='button'&&row.children.includes('retry'))!
 retry.props.onClick();assert.equal(refreshed,1)
})

test('通用工作只保留通用协作入口；旧数据或看板目标恢复到总览，不挂载受保护的数据子页',()=>{
 for(const section of ['overview','data','dashboards','resources']){
  const app=mount('BusinessWorkspace.tsx',{'./business-workspace-presentation.js':presentation,'./business-workspace-copy.js':{businessWorkspaceText:(_locale:string,key:string)=>key},'./i18n/provider.js':{useI18n:()=>({t:(key:string)=>key,locale:'en',number:String,dateTime:String})}})
  const services={groups:{},attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:true,tasksFailed:false,attentionKnown:true,attentionFailed:false,refresh:()=>{}}
  const protectedChild={type:'protected-data',props:{},children:[]}
  const flat=nodes(app.render('BusinessWorkspace',{scope:'general',title:'General',target:{scope:'general',section},state:{tasks:[],roles:[]},services,dashboardApi:{},children:protectedChild}))
  const nav=flat.find(row=>row.type==='nav')!
  assert.deepEqual(nodes(nav).filter(row=>row.type==='button').flatMap(row=>row.children),['overview','employees','groups','projects'])
  assert.equal(flat.some(row=>row.type==='protected-data'),false,'旧目标不能调用被 general 明确排除的数据接口')
  assert.equal(flat.some(row=>row.type==='button'&&row.props['aria-label']==='configure'),false)
  assert.equal(flat.some(row=>row.type==='h2'&&row.children.includes('dashboards')),false)
  assert.ok(flat.some(row=>row.type==='h2'&&row.children.includes('work')),'任务与员工协作仍可用')
 }
})

test('任意具体业务仍保留全部业务入口，项目子页保持原目标与内容',()=>{
 for(const scope of ['sales','manufacturing','SOC','AppSec']){
  const app=mount('BusinessWorkspace.tsx',{'./business-workspace-presentation.js':presentation,'./business-workspace-copy.js':{businessWorkspaceText:(_locale:string,key:string)=>key},'./i18n/provider.js':{useI18n:()=>({t:(key:string)=>key,locale:'en',number:String,dateTime:String})}})
  const services={groups:{},attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:true,tasksFailed:false,attentionKnown:true,attentionFailed:false,refresh:()=>{}}
  const content={type:'saved-project',props:{id:'same-project'},children:[]}
  const flat=nodes(app.render('BusinessWorkspace',{scope,title:scope,target:{scope,section:'projects',id:'same-project'},state:{tasks:[],roles:[]},services,dashboardApi:{},children:content}))
  const nav=flat.find(row=>row.type==='nav')!
  assert.deepEqual(nodes(nav).filter(row=>row.type==='button').flatMap(row=>row.children),['overview','data','dashboards','employees','groups','projects'])
  assert.equal(flat.find(row=>row.type==='saved-project')?.props.id,'same-project')
 }
})

test('通用员工组织不读取业务专属负责人；具体业务保留同一负责关系端口',()=>{
 const organization=()=>null,responsibility={api:{read:()=>{throw Error('不应在通用工作调用')}},roles:{list:()=>[]}}
 for(const scope of ['general','sales']){
  const app=mount('BusinessWorkspace.tsx',{'./BusinessTeamOrganization.js':{BusinessTeamOrganization:organization},'./business-workspace-presentation.js':presentation,'./business-workspace-copy.js':{businessWorkspaceText:(_locale:string,key:string)=>key},'./i18n/provider.js':{useI18n:()=>({t:(key:string)=>key,locale:'en',number:String,dateTime:String})}})
  const services={responsibility,groups:{},attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:true,tasksFailed:false,attentionKnown:true,attentionFailed:false,refresh:()=>{}}
  const state={tasks:[],roles:[{id:'same-employee',storage:'persistent',kind:'employee',state:'active',scopes:['sales'],name:'Analyst'}]}
  const org=nodes(app.render('BusinessWorkspace',{scope,title:scope,target:{scope,section:'employees'},state,services,dashboardApi:{}})).find(row=>row.type===organization)!
  assert.ok(org)
  assert.equal(org.props.roles[0].id,'same-employee')
  assert.equal(org.props.responsibility,scope==='general'?undefined:responsibility)
 }
})
