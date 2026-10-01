import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {TASK_DETAIL_MESSAGE_ROWS} from '../src/client/i18n/locales/task-details.ts'

// 真实组件走 tsc 产物；CSS Modules 只替换类名，不模拟组件行为。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {TaskDetail}=await import('../lib/types/client/TaskDetail.js')
const {readTaskInputs}=await import('../lib/types/client/task-inputs.js')
const {emptyBusinessPreview}=await import('../lib/types/client/business-preview.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const noop=()=>{}
const now='2026-09-21T04:30:00.000Z'
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const task={storage:'persistent',id:'task-1',title:'季度安全审计',goal:'核对全部外部访问记录。',scope:'general',object:'审计',version:3,state:'ready',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:[],createdAt:now,updatedAt:now,result:'',evidence:['依据一'],history:[],supplements:[],approvalRequired:false,risk:{key:'task.approval.risk.none'},execution:'not_started'}
const paint=(props:Record<string,unknown>={})=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(TaskDetail as never,{
 attentionNeeds:[],attention:undefined,attentionReason:undefined,securityItems:[],securityActions:null,industrySource:null,executions:()=>null,knowledge:null,handoffs:null,handoffRows:[],
 conversations:()=>null,draft:readTaskInputs({},task as never),patch:noop,clear:noop,review:noop,openArtifacts:noop,openPlans:noop,
 task,approvals:[],artifacts:[],change:noop,back:noop,backHidden:false,openSource:noop,roles:[],team:noop,openRole:noop,business:emptyBusinessPreview(),openBusiness:noop,saveTemplate:noop,...props,
} as never)))
const source=await readFile(new URL('../src/client/TaskDetail.tsx',import.meta.url),'utf8')

test('持久就绪任务：状态框唯一主按钮是「指派负责人」，待运行表单按需展开',()=>{
 const html=paint()
 assert.match(html,/data-teloa-status-box/)
 assert.match(html,/<button[^>]*data-teloa-primary[^>]*>指派负责人<\/button>/)
 assert.equal(html.match(/data-teloa-primary/g)?.length,1)
 assert.match(html,/aria-label="过程记录"/)
 assert.match(html,/<li[^>]*data-teloa-event="run"[^>]*data-teloa-anchor="run"/)
 const run=html.match(/<li[^>]*data-teloa-event="run"[\s\S]*?<\/li>/)?.[0]??''
 assert.match(run,/aria-expanded="false"/)
 assert.match(run,/<div[^>]*hidden=""/)
 assert.match(html,/执行记录/)
 assert.doesNotMatch(html,/还没有运行，准备第一次执行/,'服务端首次渲染尚未读取运行记录')
})

test('任务概要区区分负责人和创建者，业务与来源不依赖展开配置才能看见',()=>{
 const html=paint()
 assert.match(html,/<dl[^>]*aria-label="任务概要"/)
 assert.match(html,/<dt>业务范围<\/dt>/)
 assert.match(html,/<dt>来源<\/dt>/)
 assert.match(html,/本机任务/)
 assert.match(html,/<dt>创建者<\/dt>/)
 assert.doesNotMatch(html,/<dt>负责人<\/dt>/)
 assert.doesNotMatch(html,/原作者 我/)
})

test('群来源解析具体群名，使用来源群而非另一个关联群',()=>{
 const html=paint({task:{...task,groupId:'linked',source:{groupId:'origin',messageId:'message-1',rootId:'message-1',text:'调查异常访问'}},groups:[{id:'origin',name:'安全值班群',scope:'SOC'},{id:'linked',name:'复核群',scope:'SOC'}]})
 const summary=html.match(/<dl[^>]*aria-label="任务概要"[\s\S]*?<\/dl>/)?.[0]??''
 assert.match(summary,/<dt>来源<\/dt>[\s\S]*?安全值班群/)
 assert.doesNotMatch(summary,/origin|message-1/)
})

test('任务成果显示当前任务的真实标题，固定引用未读到正文时仍可打开',()=>{
 const artifact={id:'artifact-1',source:{kind:'task',id:'task-1'},versions:[{number:1,title:'外部访问核对报告',at:now}],links:[],feedback:[]}
 const html=paint({task:{...task,artifact:{id:'artifact-1',version:1}},artifacts:[artifact,{...artifact,id:'other-artifact',source:{kind:'task',id:'other-task'},versions:[{number:1,title:'其他任务的机密报告',at:now}]}]})
 const section=html.match(/<section[^>]*aria-label="工作成果"[\s\S]*?<\/section>/)?.[0]??''
 assert.match(section,/外部访问核对报告/)
 assert.doesNotMatch(section,/其他任务的机密报告/)
 const unloaded=paint({task:{...task,artifact:{id:'artifact-1',version:1}},artifacts:[]})
 assert.match(unloaded,/查看工作成果/)
 assert.doesNotMatch(unloaded,/没有工作成果|尚未保存成果/)
 const unloadedResults=unloaded.match(/<section[^>]*aria-label="工作成果"[\s\S]*?<\/section>/)?.[0]??''
 assert.equal(unloadedResults.match(/查看工作成果/g)?.length,1)
})

test('没有交接或外部动作内容时不生成空的独立披露，恢复组件仍保持挂载',()=>{
 const Empty=()=>null
 const html=paint({task:{...task,state:'completed'},handoffs:createElement(Empty),securityActions:createElement(Empty)})
 assert.doesNotMatch(html,/>安排接任<\/button>|>外部动作<\/button>/)
 const recovery=paint({handoffs:createElement('div',null,'交接结果核验中')})
 assert.equal(recovery.match(/交接结果核验中/g)?.length,1)
 assert.match(recovery,/data-teloa-anchor="owner"/)
})

test('审批与交接的关注项变化只增加时间线入口，表单固定在任务信息且只有一份',()=>{
 const pending={id:'action-1',target:{kind:'security-action',taskId:task.id,actionId:'action-1'},occurredAt:now}
 for(const securityItems of [[],[pending],[pending,{...pending,id:'action-2'}]]){
  const html=paint({securityItems,securityActions:createElement('span',null,'未提交的审批草稿'),handoffs:createElement('span',null,'未提交的交接草稿')})
  assert.equal(html.match(/未提交的审批草稿/g)?.length,1)
  assert.equal(html.match(/未提交的交接草稿/g)?.length,1)
  const configuration=html.slice(html.indexOf('执行配置与任务信息'))
  assert.match(configuration,/data-teloa-anchor="approval"[^>]*><span>未提交的审批草稿/)
  assert.match(configuration,/data-teloa-anchor="owner"[^>]*>[\s\S]*?未提交的交接草稿/)
 }
})

test('资料内容只挂载一次；编号、时间与模式收起但保留锚点定位',()=>{
 const html=paint({knowledge:createElement('span',null,'已核验的安全告警判据')})
 assert.equal(html.match(/已核验的安全告警判据/g)?.length,1)
 assert.match(html,/资料与关联会话/)
 assert.match(html,/执行配置与任务信息/)
 assert.match(html,/data-teloa-anchor="evidence"/)
 assert.doesNotMatch(html,/<dt>任务知识<\/dt>[\s\S]*?<span>—<\/span>/)
})

test('页头：··· 菜单触发按钮 aria-haspopup="menu" 且可访问名称为「更多操作」；页面 aria 与 Esc 钉子保留',()=>{
 const html=paint()
 assert.match(html,/<button[^>]*aria-haspopup="menu"[^>]*aria-label="更多操作"/)
 assert.match(html,/<article[^>]*data-teloa-pane="detail"[^>]*aria-label="任务详情"/)
 assert.match(html,/<h2 aria-label="季度安全审计"><button[^>]*aria-label="修改任务目标"[^>]*><span[^>]*title="季度安全审计"[^>]*>季度安全审计/)
})

test('八个平铺分区与说明段不再出现',()=>{
 const html=paint()
 for(const phrase of ['工作过程与会话','结果与待处理','更多管理与记录','会话保存讨论与代拟','工作成果、任务结项与外部执行效果分别记录'])assert.doesNotMatch(html,new RegExp(phrase),phrase)
})

test('源码不含 dangerouslySetInnerHTML，不读 WorkError.details',()=>{
 assert.doesNotMatch(source,/dangerouslySetInnerHTML/)
 assert.doesNotMatch(source,/\.details\b/)
})

test('task.status.* / task.timeline.* / task.rail.* / task.menu.* 每行 11 列且 zh-CN 不含禁词',()=>{
 const rows=TASK_DETAIL_MESSAGE_ROWS.filter(row=>/^task\.(status|timeline|rail|menu)\./.test(row[0]))
 for(const prefix of ['status','timeline','rail','menu'])assert.ok(rows.some(row=>row[0].startsWith(`task.${prefix}.`)),prefix)
 for(const row of rows){
  assert.equal(row.length,11,row[0])
  assert.doesNotMatch(row[1]!,/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/,row[0])
 }
})
