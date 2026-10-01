import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {builtinBusinessNames,businessScopeNames,changeBusinessDirectory,industryLoadScopeLabels,initialBusinessSpaces,registeredBusinessScope,type BusinessScopeLabel,type BusinessSpaceRecord} from '../src/client/business-directory.ts'
import {emptyTaskPreview,changeTaskPreview} from '../src/client/task-preview.ts'
import {marketTargets} from '../src/client/market-target.ts'
import {emptyCollaboration} from '../src/client/collaboration-preview.ts'
import {localizeWorkError} from '../lib/types/client/i18n/errors.js'

const label=(scope:string,title:string):BusinessScopeLabel=>({scope,title,kind:'domain',loads:1,activeLoads:1,tasks:0,groups:0})
const space=():BusinessSpaceRecord=>({id:'11111111-1111-4111-8111-111111111111',name:'我的工作空间',description:'',version:1,kind:'personal',createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-11T00:00:00.000Z'})

test('业务范围标签取代空间身份，任务按标签隔离且未登记范围拒绝',()=>{
 const initial=emptyTaskPreview(),labels=[...initialBusinessSpaces(),label('east','东区安全'),label('west','西区安全')]
 let state={...initial,business:{...initial.business,spaces:labels}}
 state=changeTaskPreview(state,{type:'create',id:'task-east',title:'调查',goal:'核对来源',scope:'east',now:'2026-09-11T00:00:00Z'})
 assert.equal(state.tasks[0]!.scope,'east');assert.equal(state.tasks.filter(row=>row.scope==='west').length,0)
 assert.throws(()=>changeTaskPreview(state,{type:'create',id:'unknown',title:'调查',goal:'核对',scope:'missing',now:'2026-09-11T00:00:00Z'}),/范围/)
 assert.equal(marketTargets([],emptyCollaboration(),labels).filter(row=>row.kind==='business').length,5)
})

test('工作空间改名保持身份、提升版本，过期版本与非法名称拒绝',()=>{
 const directory={space:space(),labels:initialBusinessSpaces()}
 const changed=changeBusinessDirectory(directory,{type:'rename',expectedVersion:1,name:'调查工作空间',description:'新说明'})
 assert.equal(changed.space.id,directory.space.id)
 assert.equal(changed.space.name,'调查工作空间');assert.equal(changed.space.description,'新说明');assert.equal(changed.space.version,2)
 assert.equal(directory.space.version,1)
 assert.throws(()=>changeBusinessDirectory(changed,{type:'rename',expectedVersion:1,name:'过期修改',description:''}),/变化/)
 assert.throws(()=>changeBusinessDirectory(directory,{type:'rename',expectedVersion:1,name:'  ',description:''}),/1～80/)
 assert.throws(()=>changeBusinessDirectory(directory,{type:'rename',expectedVersion:1,name:'过长说明',description:'x'.repeat(2001)}),/2000/)
})

test('内置范围只剩三个，Design 已不再登记，且目录未读到时内置范围仍成立',()=>{
 assert.deepEqual(Object.keys(builtinBusinessNames),['general','SOC','AppSec'])
 assert.equal(builtinBusinessNames.general,'通用工作')
 assert.equal(Object.hasOwn(builtinBusinessNames,'Design'),false)
 for(const scope of ['general','SOC','AppSec'])assert.equal(registeredBusinessScope(scope,[]),true)
 assert.equal(registeredBusinessScope('Design',[]),false)
 assert.equal(registeredBusinessScope('finance',[label('finance','财务')]),true)
 assert.equal(registeredBusinessScope(12,[]),false)
})

test('内置范围可以按界面语言呈现，模板登记的标签保留宿主标题',()=>{
 assert.deepEqual(businessScopeNames([],{general:'General work',SOC:'Security operations',AppSec:'Application security'}),{},'内置词典不能自行生成可见目录')
 const names=businessScopeNames([...initialBusinessSpaces(),label('east','东区安全')],{general:'General work',SOC:'Security operations',AppSec:'Application security'})
 assert.equal(names.general,'General work')
 assert.equal(names.SOC,'Security operations')
 assert.equal(names['east'],'东区安全')
 assert.equal(Object.hasOwn(names,'Design'),false)
})

test('业务范围上下文不缓存稳定翻译函数的旧语言结果',async()=>{
 const source=await readFile(new URL('../src/client/business-scope-context.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/useMemo\(/,'翻译函数身份稳定，按 t 缓存会在切换语言后保留旧名称')
 assert.match(source,/businessScopeNames\(labels,\{general:t\('business\.scope\.general'\)/)
})

test('新增业务范围贯穿岗位与计划目录，载入示例不覆盖已登记标签',async()=>{
 const {changeTeamPreview}=await import('../src/client/team-preview.ts'),{changeContinuousWork}=await import('../src/client/continuous-work.ts'),{withBusinessExamples}=await import('../src/client/business-work-preview.ts')
 const initial=emptyTaskPreview(),labels=[...initial.business.spaces,label('east','东区安全')]
 let state={...initial,business:{...initial.business,spaces:labels}}
 state=changeTeamPreview(state,{type:'create',id:'east-role',now:'2026-09-11T00:00:00Z',fields:{name:'东区调查岗',kind:'employee',scopes:['east'],duty:'核对证据',dataScope:'东区数据',executionScope:'只读核验',skills:[],knowledge:[]}})
 state=changeContinuousWork(state,{type:'save',id:'east-plan',now:'2026-09-11T00:00:00Z',fields:{title:'每日核对',scope:'east',goal:'检查新数据',dataScope:'东区对象',delivery:'核对记录',roleId:'east-role',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Shanghai'},notificationPolicy:'attention'}})
 assert.equal(state.continuous.plans[0]!.fields.scope,'east')
 assert.ok(withBusinessExamples(state,'2026-09-11T00:00:00Z').business.spaces.some(row=>row.scope==='east'))
})

test('已保存加载投影成范围标签时标题取模板标题，不是恒为“我的工作空间”的空间名',async()=>{
 const load=(scope:string,templateTitle:string)=>({space:{id:'11111111-1111-4111-8111-111111111111',name:'我的工作空间',version:3,scope},templateTitle})
 const labels=industryLoadScopeLabels([load('soc','安全运营模板'),load('finance','财务模板'),load('soc','安全运营模板')])
 assert.deepEqual(labels.map(row=>[row.scope,row.title,row.kind]),[['soc','安全运营模板','domain'],['finance','财务模板','domain']])
 assert.ok(labels.every(row=>row.title!=='我的工作空间'))
 assert.deepEqual(industryLoadScopeLabels([{space:{scope:'legacy'}}]).map(row=>row.title),['legacy'])
 assert.deepEqual(industryLoadScopeLabels([{space:{scope:'legacy'},templateTitle:'   '}]).map(row=>row.title),['legacy'])
 const preview=await readFile(new URL('../src/client/IndustryUpdatePreview.tsx',import.meta.url),'utf8')
 assert.match(preview,/\?\.title\|\|load\.templateTitle\|\|load\.space\.scope/,'目录未读到时也退回模板标题而不是空间名')
 const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(frame,/const labels=industryLoadScopeLabels\(loads\)/)
})

test('改名失败带稳定 code：界面读到的是版本冲突 / 输入无效，不是“操作未完成”',()=>{
 const space:BusinessSpaceRecord={id:'11111111-1111-4111-8111-111111111111',name:'我的工作空间',description:'',version:3,kind:'personal',createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-11T00:00:00.000Z'}
 const directory={space,labels:[] as BusinessScopeLabel[]}
 const thrown=(change:Parameters<typeof changeBusinessDirectory>[1])=>{try{changeBusinessDirectory(directory,change);return undefined}catch(error){return error}}
 const stale=thrown({type:'rename',expectedVersion:2,name:'调查空间',description:''})
 assert.equal((stale as {code?:unknown}).code,'teloa/version-conflict')
 assert.equal((stale as {rejected?:unknown}).rejected,true)
 assert.equal(localizeWorkError('zh-CN',stale),localizeWorkError('zh-CN',{code:'teloa/version-conflict'}))
 assert.notEqual(localizeWorkError('zh-CN',stale),localizeWorkError('zh-CN',Error('无 code')))
 for(const change of [{name:'  ',description:''},{name:'名称',description:'x'.repeat(2001)},{name:'x'.repeat(81),description:''}]){
  const invalid=thrown({type:'rename',expectedVersion:3,...change})
  assert.equal((invalid as {code?:unknown}).code,'teloa/invalid-input',change.name.trim().slice(0,4))
  assert.equal(localizeWorkError('zh-CN',invalid),localizeWorkError('zh-CN',{code:'teloa/invalid-input'}))
 }
 // 未知错误的兜底文案必须与上面两条都不同，否则 code 加了也白加。
 assert.notEqual(localizeWorkError('zh-CN',{code:'teloa/invalid-input'}),localizeWorkError('zh-CN',{code:'teloa/version-conflict'}))
})
