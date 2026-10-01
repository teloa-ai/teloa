import test from 'node:test'
import assert from 'node:assert/strict'
import { persistentPlanCreation,persistentPlanUpdate } from '../src/client/continuous-persistence.ts'
import type { PlanFields } from '../src/client/continuous-preview.ts'
import type { SavedPlan } from '../src/client/plan-api.ts'
import type { PlanTemplate } from '../src/client/plan-template.ts'
import type { PreviewRole } from '../src/client/role-preview.ts'
import { fixedPlanSource } from '../src/client/plan-template.ts'
import type { MarketItem } from '../src/client/market-preview.ts'

const roleId='22222222-2222-4222-8222-222222222222'
const role:PreviewRole={storage:'persistent',id:roleId,name:'研究岗位',kind:'employee',scopes:['general'],state:'active',version:3,duty:'研究',dataScope:'获准资料',executionScope:'代拟',skills:[],knowledge:[],memories:[],history:[]}
const fields:PlanFields={title:'每日核对',goal:'核对新增资料。',scope:'general',dataScope:'本人已授权资料。',delivery:'变化与待核对项。',roleId,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'}

test('行业计划携带原子资源身份与版本，而不是加载实例ID或引用的工作模板版本',()=>{
 const template:PlanTemplate={key:'fixed',itemId:'industry-item',templateId:'work',title:'每日核对',version:'1.0.0',scope:'general',hash:'a'.repeat(64),example:false,source:'行业',author:'本人',license:'MIT',description:'核对',requirements:[],output:'结果',skills:[],industry:{loadId:'load',resourceId:'load:daily',localId:'daily',version:'2.0.0'}}
 const item={id:'industry-item',hash:'b'.repeat(64),packageContent:{hash:template.hash},contentStorage:{contentId:'44444444-4444-4444-8444-444444444444',createdAt:'2026-09-11T00:00:00Z',loaded:true}} as MarketItem
 const source=fixedPlanSource(template,item)
 assert.equal(source.resourceId,'daily');assert.equal(source.resourceVersion,'2.0.0')
 assert.deepEqual(persistentPlanCreation(fields,template,[role],source).source,source)
 const {contentStorage:_,...unsaved}=item
 assert.throws(()=>fixedPlanSource(template,unsaved),/固定|保存/)
 assert.throws(()=>fixedPlanSource(template,{...item,packageContent:{...item.packageContent!,hash:'c'.repeat(64)}}),/来源|一致/)
 assert.throws(()=>fixedPlanSource(template,{...item,id:'other'}),/来源|一致/)
})

test('真实日程计划固定同业务在岗持久岗位版本，手工创建保留 manual 来源',()=>{
 assert.deepEqual(persistentPlanCreation(fields,undefined,[role]),{fields:{...fields,expectedRoleVersion:3},source:{kind:'manual'}})
 const {notificationPolicy:_notificationPolicy,...legacy}=fields
 assert.throws(()=>persistentPlanCreation(legacy,undefined,[role]),/通知策略|核对/)
 const {storage:_storage,...pageRole}=role
 assert.throws(()=>persistentPlanCreation(fields,undefined,[pageRole]),/已保存|岗位/)
 assert.throws(()=>persistentPlanCreation(fields,undefined,[{...role,state:'paused'}]),/在岗|岗位/)
 // 2026-09-21 用户裁定改判：通用工作（general）计划对所有在岗持久岗位开放（契约 roleSupportsScope），不再要求岗位声明包含 general。
 assert.deepEqual(persistentPlanCreation(fields,undefined,[{...role,scopes:['SOC']}]),{fields:{...fields,expectedRoleVersion:3},source:{kind:'manual'}})
 // 业务范围计划仍严格要求岗位声明包含该范围。
 assert.throws(()=>persistentPlanCreation({...fields,scope:'SOC'},undefined,[{...role,scopes:['AppSec']}]),/同业务|岗位/)
 assert.throws(()=>persistentPlanCreation({...fields,trigger:{kind:'event',source:'告警',event:'新增'}},undefined,[role]),/事件.*未接入/)
})

test('已保存计划只能更新可变定义，不得改业务、岗位或伪造事件触发',()=>{
 const plan:SavedPlan={...fields,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},id:'55555555-5555-4555-8555-555555555555',ownerId:'local:test',roleVersion:3,source:{kind:'manual'},version:4,configVersion:1,state:'active',archivedReason:null,archivedAt:null,createdAt:'2026-09-18T00:00:00.000Z',updatedAt:'2026-09-18T00:00:00.000Z'}
 const update=persistentPlanUpdate({...fields,title:'每日风险核对',notificationPolicy:'always'},plan)
 assert.deepEqual(update,{title:'每日风险核对',goal:fields.goal,dataScope:fields.dataScope,delivery:fields.delivery,trigger:fields.trigger,notificationPolicy:'always'})
 assert.throws(()=>persistentPlanUpdate({...fields,scope:'SOC'},plan),/业务范围/)
 assert.throws(()=>persistentPlanUpdate({...fields,roleId:'33333333-3333-4333-8333-333333333333'},plan),/员工/)
 assert.throws(()=>persistentPlanUpdate({...fields,trigger:{kind:'event',source:'告警',event:'新增'}},plan),/事件.*未接入/)
 assert.throws(()=>persistentPlanUpdate({...fields,notificationPolicy:'legacy' as never},plan),/通知策略|核对/)
})

test('市场模板只有携带真实固定内容身份才能成为来源，不能降级为 manual',()=>{
 const template:PlanTemplate={key:'fixed',itemId:'directory-'+('a'.repeat(64)),templateId:'daily-review',title:'每日核对',version:'1.0.0',scope:'general',hash:'a'.repeat(64),example:false,source:'本人固定内容',author:'本人',license:'待核对',description:'核对',requirements:[],output:'结果',skills:[]}
 const source={kind:'market-content' as const,contentId:'44444444-4444-4444-8444-444444444444',contentHash:template.hash!,resourceId:'daily-review',resourceVersion:'1.0.0'}
 assert.throws(()=>persistentPlanCreation(fields,template,[role]),/真实固定内容来源|市场/)
 assert.deepEqual(persistentPlanCreation(fields,template,[role],source).source,source)
 assert.throws(()=>persistentPlanCreation(fields,template,[role],{...source,contentHash:'b'.repeat(64)}),/来源.*不一致|市场/)
 assert.throws(()=>persistentPlanCreation(fields,{...template,example:true},[role]),/真实固定内容来源|市场/)
})
