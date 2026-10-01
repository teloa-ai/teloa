import test from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {BusinessTaskActionPanel,withBusinessTaskSource,businessTasksForMode,persistentBusinessTaskAssignees} from '../src/client/business-task-presentation.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'

const role=(id:string,storage:PreviewRole['storage']):PreviewRole=>({id,name:id,...(storage?{storage}:{}),kind:'employee',scopes:['SOC'],state:'active',version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]})
const task=(id:string,storage:PreviewTask['storage']):PreviewTask=>({id,...(storage?{storage}:{}),title:id,goal:id,scope:'SOC',object:'告警',version:1,state:'ready',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:[],createdAt:'2026-09-13T00:00:00.000Z',updatedAt:'2026-09-13T00:00:00.000Z',result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'',execution:'not_started'})

test('正式对象详情仅列出当前范围的持久化在岗员工，沙盒与正式任务目录隔离',()=>{
 assert.deepEqual(persistentBusinessTaskAssignees([role('saved','persistent'),role('sandbox',undefined),{...role('paused','persistent'),state:'paused'}],'SOC').map(item=>item.id),['saved'])
 // 候选按当前对象所在范围筛选；是否展示动作入口由台账能力位决定。
 const other={...role('appsec','persistent'),scopes:['AppSec']}
 assert.deepEqual(persistentBusinessTaskAssignees([role('saved','persistent'),other],'SOC').map(item=>item.id),['saved'])
 assert.deepEqual(persistentBusinessTaskAssignees([role('saved','persistent'),other],'SOC').map(item=>item.id),['saved'])
 assert.deepEqual(persistentBusinessTaskAssignees([role('saved','persistent'),other],'AppSec').map(item=>item.id),['appsec'])
 const rows=[task('saved','persistent'),task('sandbox',undefined)]
 assert.deepEqual(businessTasksForMode(rows,'SOC','real').map(item=>item.id),['saved'])
 assert.deepEqual(businessTasksForMode(rows,'SOC','sandbox').map(item=>item.id),['sandbox'])
 // 2026-09-21 用户裁定：与契约 roleSupportsScope 同口径——通用工作（general）候选不按岗位业务声明过滤。
 assert.deepEqual(persistentBusinessTaskAssignees([role('saved','persistent'),other],'general').map(item=>item.id).sort(),['appsec','saved'])
})

test('待恢复请求只显示恢复入口，错误在恢复记录清除后仍由父层呈现',()=>{
 const node=(name:string)=>createElement('div',{'data-slot':name},name)
 const pending=renderToStaticMarkup(createElement(BusinessTaskActionPanel,{pending:true,error:null,recovery:node('recover'),creation:node('create')}))
 assert.match(pending,/data-slot="recover"/)
 assert.doesNotMatch(pending,/data-slot="create"/)
 const rejected=renderToStaticMarkup(createElement(BusinessTaskActionPanel,{pending:false,error:node('error'),recovery:node('recover'),creation:node('create')}))
 assert.match(rejected,/data-slot="error"/)
 assert.match(rejected,/data-slot="create"/)
 assert.doesNotMatch(rejected,/data-slot="recover"/)
})

test('真实任务来源保留完整固定引用，所有对象入口与返回来源一致',async()=>{
 const {objectRefTarget}=await import('../src/client/business-preview.ts')
 const reference={scope:'SOC',type:'order',id:'one',version:3,snapshotHash:'a'.repeat(64)}
 const result=withBusinessTaskSource(task('saved','persistent'),{schema:'teloa.business-task-source/v1',taskId:'saved',ownerId:'owner',sourceId:'records-local',reference,createdAssignee:null,createdAt:'2026-09-29T00:00:00.000Z'})
 assert.deepEqual(result.businessSource,{scope:'SOC',section:'data',objectType:'order',id:'one',recordReference:reference})
 assert.deepEqual(objectRefTarget(result.objectRefs![0]!),result.businessSource)
 assert.deepEqual(objectRefTarget({scope:'SOC',type:'legacy',id:'old',version:1,title:'Old'}),{scope:'SOC',section:'data',objectType:'legacy',id:'old'})
})
