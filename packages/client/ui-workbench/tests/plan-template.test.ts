import test from 'node:test'
import assert from 'node:assert/strict'
import { sandboxMarket, createTeamTemplate, itemFromManifest, parseMarketManifest, type MarketState } from '../src/client/market-preview.ts'
import { planTemplate, templatePlanFields } from '../src/client/plan-template.ts'
import { emptyTaskPreview } from '../src/client/task-preview.ts'
import { withRoleExamples } from '../src/client/role-preview.ts'
import { changeContinuousWork } from '../src/client/continuous-work.ts'
const now='2026-09-11T04:40:00Z'
const base=()=>({...emptyTaskPreview(),roles:withRoleExamples([],now)})
test('市场模板固定真实清单、摘要和技能引用，演示目录不伪造摘要',async()=>{
  const parsed=await parseMarketManifest(JSON.stringify({format:'teloa.work-template/v1',id:'review',title:'核对资料',version:'1.2',domain:'general',description:'保留来源',requirements:['获准资料'],output:'工作稿',skills:[{id:'brief',title:'资料简报',version:'v3'}]}))
  const item=itemFromManifest(parsed,{kind:'paste'}),template=planTemplate(item)
  assert.equal(template.hash,parsed.hash);assert.equal(template.templateId,'review');assert.equal(template.skills[0]!.version,'v3')
  assert.ok(item.manifest?.format==='teloa.work-template/v1')
  item.manifest.requirements[0]='被修改的目录字段'
  assert.deepEqual(template.requirements,['获准资料'])
  const example=planTemplate(sandboxMarket().items.find(item=>item.id==='template-weekly')!)
  assert.equal(example.hash,null);assert.equal(example.example,true)
  assert.throws(()=>planTemplate(sandboxMarket().items.find(item=>item.kind==='skill')!),/模板/)
})
test('保存前来源变化或消失拒绝；已保存计划与执行保留原模板',()=>{
  const market=sandboxMarket(),template=planTemplate(market.items.find(item=>item.id==='template-weekly')!)
  const command={type:'save' as const,id:'p1',fields:{...templatePlanFields(template),roleId:'researcher',notificationPolicy:'attention' as const},template,now}
  assert.throws(()=>changeContinuousWork(base(),command),/来源/)
  assert.throws(()=>changeContinuousWork(base(),command,{items:[],intents:[]}),/来源/)
  const changed:MarketState={...market,items:market.items.map(item=>item.id===template.itemId?{...item,summary:'已更改的方法'}:item)}
  assert.throws(()=>changeContinuousWork(base(),command,changed),/变化/)
  let state=changeContinuousWork(base(),command,market)
  assert.equal(state.continuous.plans[0]!.enabled,false)
  state=changeContinuousWork(state,{type:'enabled',planId:'p1',expectedRevision:1,enabled:true,now})
  state=changeContinuousWork(state,{type:'trigger',planId:'p1',id:'r1',occurrenceId:'o1',input:'本次资料',now})
  assert.deepEqual(state.continuous.runs[0]!.snapshot.template,template)
  state=changeContinuousWork(state,{type:'save',id:'p1',expectedRevision:2,fields:{...command.fields,goal:'具体化本次目标'},now},changed)
  assert.deepEqual(state.continuous.plans[0]!.template,template)
  assert.deepEqual(state.continuous.runs[0]!.snapshot.template,template)
})
test('通用模板支持已注册业务，行业模板不能静默改业务，未知业务明确拒绝',async()=>{
  const market=sandboxMarket(),general=planTemplate(market.items.find(item=>item.id==='template-weekly')!),appsec=planTemplate(market.items.find(item=>item.id==='template-code')!)
  const state=changeContinuousWork(base(),{type:'save',id:'soc',template:general,fields:{...templatePlanFields(general),scope:'SOC',roleId:'investigator',notificationPolicy:'attention'},now},market)
  assert.equal(state.continuous.plans[0]!.fields.scope,'SOC')
  assert.throws(()=>changeContinuousWork(base(),{type:'save',id:'bad',template:appsec,fields:{...templatePlanFields(appsec),scope:'SOC',roleId:'investigator',notificationPolicy:'attention'},now},market),/业务/)
  const item=await createTeamTemplate({id:'new-domain',title:'新业务',domain:'Finance',description:'财务核对',requirements:['凭据'],output:'工作稿',visibility:'personal'})
  assert.throws(()=>templatePlanFields(planTemplate(item)),/注册/)
})
test('模板输入要求完整保留，不因计划资料字段长度被截断或阻止建稿',async()=>{
  const item=await createTeamTemplate({id:'large-inputs',title:'大量输入',domain:'general',description:'核对',requirements:Array.from({length:30},(_,i)=>String(i)+'项'.repeat(400)),output:'工作稿',visibility:'personal'})
  const template=planTemplate(item),fields=templatePlanFields(template)
  assert.equal(template.requirements.length,30);assert.equal(template.requirements[29],item.requirements[29])
  assert.ok(fields.dataScope.length<8000)
  const state=changeContinuousWork(base(),{type:'save',id:'large',fields:{...fields,roleId:'researcher',notificationPolicy:'attention'},template,now},{items:[item],intents:[]})
  assert.deepEqual(state.continuous.plans[0]!.template?.requirements,item.requirements)
})
