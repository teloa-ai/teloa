import {useEffect,useState,type ReactNode} from 'react'
import {ArrowRight,ArrowUpRight,RefreshCw} from 'lucide-react'
import type {Group,BusinessObjectSnapshot} from '@teloa/contract'
import {loadBusinessTeamCollaboration,type TeamCollaboration,type TeamCollaborationServices,teamDecisionSubject,teamRecordTarget} from './business-team-collaboration.js'
import type {BusinessTarget} from './business-preview.js'
import type {PreviewRole} from './role-preview.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {BusinessTeamDecision} from './BusinessTeamDecision.js'
import {ContextDrawer} from './ContextDrawer.js'
import {WorkArtifactCard} from './WorkArtifactCard.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import base from './BusinessWorkspace.module.css'
import light from './light-actions.module.css'
import {taskStates} from './task-preview.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessTeamCollaboration.module.css'

const copy={
 title:['AI 团队协作','AI 團隊協作','AI team collaboration'],hint:['AI团队负责执行与交付，你专注审批与质量监督。','AI團隊負責執行與交付，你專注審批與品質監督。','AI teams execute and deliver. You review decisions and quality.'],

 loading:['正在读取团队交付…','正在讀取團隊交付…','Loading team deliveries…'],failure:['团队来源读取失败，状态未知。','團隊來源讀取失敗，狀態未知。','Unable to read team sources. Status unknown.'],retry:['刷新协作状态','重新整理協作狀態','Refresh collaboration'],
 empty:['尚无这项业务的协作群。','尚無這項業務的協作群。','No teams in this business yet.'],unconfigured:['尚无结构化交接记录；可查看群内原工作。','尚無結構化交接記錄；可查看群內原工作。','No structured handoff record yet. Open the group to inspect its work.'],
 decide:['审阅业务候选','審閱業務候選','Review business record'],
 teams:['团队交付与交接','團隊交付與交接','Team deliveries and handoffs'],details:['查看协作与交付','查看協作與交付','Inspect collaboration and deliveries'],group:['打开协作群','開啟協作群','Open group'],lead:['协调员工','協調員工','Coordinator'],
 delivered:['固定成果可审阅','固定成果可審閱','Versioned outputs ready for review'],working:['任务尚在推进','工作仍在推進','Work in progress'],review:['独立质量意见','獨立品質意見','Independent quality review'],noReview:['尚无独立质量意见','尚無獨立品質意見','No independent review recorded'],
 boundary:['证据缺口与交付边界','證據缺口與交付邊界','Evidence gaps and delivery boundaries'],handoff:['已登记的交接依赖','已登記的交接依賴','Recorded handoff dependencies'],noHandoff:['尚无已登记的交接依赖；不依据卡片顺序推断。','尚無已登記的交接依賴；不根據卡片順序推斷。','No recorded dependencies. Card order does not imply handoffs.'],
 record:['查看审阅记录','查看審閱記錄','View review record'],outputs:['固定成果','固定成果','Versioned outputs'],checks:['复核意见与质量反馈','覆核意見與品質回饋','Reviews and quality feedback'],
 separate:['交接来自版本化团队说明；任务状态、成果版本及本人决定从原生记录读取。关闭详情不提交决定。','工作完成、獨立覆核、本人採用和實際執行分開記錄。關閉詳情不會提交決定。','Task completion, independent review, your acceptance and execution are tracked separately. Closing details submits no decision.'],
 qualityHint:['打开固定成果可核对证据并提交反馈；退回修改沿用成果反馈与续改流程。','開啟固定成果可核對證據並提交回饋；退回修改沿用成果回饋與續改流程。','Inspect evidence and submit feedback on a versioned output. Revisions use the existing feedback workflow.'],
 version:['版本','版本','Version'],
 savedBrief:['已保存的团队说明','已儲存的團隊說明','Saved team brief'],
} as const
type Props={scope:string;title:string;groups:readonly Group[];api:TeamCollaborationServices;roles:readonly PreviewRole[];revision:number;openRole:(id:string)=>void;openGroup:(id:string)=>void;openTask:(id:string)=>void;openArtifact?:((taskId:string,artifactId:string,version:number)=>void)|undefined;go:(target:BusinessTarget)=>void;renderRecord?:((record:BusinessObjectSnapshot,close:()=>void)=>ReactNode)|undefined;renderOverview:(content:{collaboration:ReactNode;review:ReactNode;reviewCount:number;reviewKnown:boolean;reviewFailed:boolean})=>ReactNode}
export function BusinessTeamCollaboration({scope,title,groups,api,roles,revision,openRole,openGroup,openTask,openArtifact,go,renderRecord,renderOverview}:Props){
 const {locale,t,dateTime}=useI18n(),text=(key:keyof typeof copy)=>copy[key][locale.startsWith('zh')?(/Hant|TW|HK/i.test(locale)?1:0):2]
 const [data,setData]=useState<{scope:string;phase:'loading'|'ready'|'failed';teams:TeamCollaboration[]}>({scope,phase:'loading',teams:[]}),[reload,setReload]=useState(0),[selected,setSelected]=useState<string>(),[decision,setDecision]=useState<TeamCollaboration['decisions'][number]>(),[drafts,setDrafts]=useState<Record<string,string>>({}),[receipt,setReceipt]=useState<string>(),[recordDetail,setRecordDetail]=useState<BusinessObjectSnapshot>()
 useEffect(()=>{const c=new AbortController();setData({scope,phase:'loading',teams:[]});setSelected(undefined);setDecision(undefined);setRecordDetail(undefined)
  void loadBusinessTeamCollaboration(scope,groups,api,c.signal).then(teams=>{if(!c.signal.aborted)setData({scope,phase:'ready',teams})},()=>{if(!c.signal.aborted)setData({scope,phase:'failed',teams:[]})});return()=>c.abort()
 },[scope,groups,api.groups,api.tasks,api.artifacts,api.records,revision,reload])
 const teams=data.scope===scope&&data.phase==='ready'?data.teams:[],team=teams.find(g=>g.group.id===selected),decisions=[...new Map(teams.flatMap(g=>g.decisions).map(d=>[JSON.stringify([d.record.type,d.record.id]),d])).values()]
 const role=(id:string)=>roles.find(r=>r.id===id),roleName=(id:string)=>role(id)?.name??t('task.status.unassigned')
 const open=(row:TeamCollaboration['deliveries'][number])=>openArtifact?openArtifact(row.taskId,row.artifact.id,row.artifact.version):openTask(row.taskId)
 const needs=decisions.length?<div className={base.groupList}>{decisions.map(d=><button type="button" key={d.record.type+d.record.id} aria-label={text('decide')+' · '+d.record.title} onClick={()=>d.reviewType?setDecision(d):go(teamRecordTarget(d.record))}><span><strong>{d.label}</strong><small>{d.record.title} · {text('version')} {d.record.version}</small></span><ArrowUpRight size={14}/></button>)}</div>:null
 const output=(row:TeamCollaboration['deliveries'][number],detail:ReactNode)=><WorkArtifactCard key={row.artifact.id+row.artifact.version} label={row.label} detail={detail} onPreview={()=>open(row)}/>
 const fixed=(g:TeamCollaboration)=><>{g.deliveries.map(row=>output(row,<>{row.version.title} · {text('version')} {row.artifact.version}</>))}</>
 const board=<section className={css.board} aria-label={text('title')}>
  <header className={css.header}><div><h2>{text('title')}</h2><p>{text('hint')}</p></div><ToolbarIconButton label={text('retry')} icon={RefreshCw} onClick={()=>setReload(v=>v+1)}/></header>
  {receipt&&<p role="status">{receipt}</p>}
  {data.phase==='loading'||data.scope!==scope?<p role="status">{text('loading')}</p>:data.phase==='failed'?<p role="alert">{text('failure')}</p>:<>
   <><h3 className={css.sectionTitle}>{text('teams')}</h3>{!teams.length&&<p>{text('empty')}</p>}<div className={css.teams}>{teams.map(g=><article className={`${base.panel} ${css.card}`} key={g.group.id}><header><h3>{g.group.name}</h3><span className={css.status}>{g.phase==='ready'?g.deliveries.length?text('delivered'):text('working'):g.phase==='failed'?text('failure'):text('unconfigured')}</span></header><p className={css.outcome}>{g.brief&&<small>{text('savedBrief')} · </small>}{g.brief?.summary??g.group.purpose}</p>{g.group.coordinatorRoleId&&<small>{text('lead')} · <button type="button" className={light.link} onClick={()=>openRole(g.group.coordinatorRoleId!)}>{roleName(g.group.coordinatorRoleId)}</button></small>}
    <ol className={css.steps}>{g.steps.map(s=><li key={s.id}><button type="button" className={`${light.link} ${css.identity}`} onClick={()=>openRole(s.roleId)}><EmployeeAvatar avatarKey={role(s.roleId)?.avatarKey} size="sm"/><span>{roleName(s.roleId)}</span></button><button type="button" className={`${light.link} ${css.stepTask}`} onClick={()=>openTask(s.taskId)}>{s.label}<small>{t(taskStates[s.task.state])}</small></button></li>)}</ol>
    {g.activeTasks.length>0&&<div className={css.active}><strong>{text('working')} · {g.activeTasks.length}</strong>{g.activeTasks.slice(0,4).map(task=><button type="button" className={light.link} key={task.id} onClick={()=>openTask(task.id)}>{task.title}<small>{t(taskStates[task.state])}</small></button>)}</div>}<div className={css.review}><span>{text('review')}</span><strong>{g.reviews.length?g.reviews.map(r=>r.label).join(' · '):text('noReview')}</strong></div>{g.brief?.notes[0]&&<p className={css.note}>{g.brief.notes[0]}</p>}<button type="button" className={`${light.link} ${css.inspect}`} onClick={()=>setSelected(g.group.id)}>{text('details')}<ArrowRight size={14}/></button></article>)}</div><section className={base.panel}><h3>{text('handoff')}</h3>{teams.flatMap(g=>g.brief?.handoffs.map((h,i)=><div className={css.handoff} key={g.group.id+i}><button type="button" className={light.link} onClick={()=>openTask(g.steps.find(s=>s.id===h.from)!.taskId)}>{roleName(g.steps.find(s=>s.id===h.from)!.roleId)}</button><ArrowRight size={15}/><button type="button" className={light.link} onClick={()=>openTask(g.steps.find(s=>s.id===h.to)!.taskId)}>{roleName(g.steps.find(s=>s.id===h.to)!.roleId)}</button><span>{h.label}</span></div>)??[])}{!teams.some(g=>g.brief?.handoffs.length)&&<p>{text('noHandoff')}</p>}</section></>

  </>}
 </section>
 return <>{renderOverview({collaboration:board,review:needs,reviewCount:decisions.length,reviewKnown:data.scope===scope&&data.phase==='ready'&&!teams.some(g=>g.phase==='failed'),reviewFailed:data.phase==='failed'||teams.some(g=>g.phase==='failed')})}
  {decision?.reviewType&&api.records&&<BusinessTeamDecision record={decision.record} reviewType={decision.reviewType} scopeName={title} sourceName={teams.find(g=>g.decisions.some(d=>d.record.id===decision.record.id))?.group.name??title} reviewSummary={teams.find(g=>g.decisions.some(d=>d.record.id===decision.record.id))?.reviews.map(r=>roleName(r.task.assigneeRoleId!)+' · '+r.label+' · v'+r.artifact.version).join('；')??''} api={api.records} reviewContext={(()=>{const g=teams.find(g=>g.decisions.some(d=>d.record.id===decision.record.id&&d.record.type===decision.record.type));return g&&<section><h3>{text('review')}</h3>{g.reviews.map(r=>output(r,<>{roleName(r.task.assigneeRoleId!)} · v{r.artifact.version}</>))}<h3>{text('boundary')}</h3>{g.brief?.notes.map((n,i)=><p key={i}>{n}</p>)}{fixed(g)}</section>})()} returnWork={(()=>{const g=teams.find(g=>g.decisions.some(d=>d.record.id===decision.record.id&&d.record.type===decision.record.type));const lead=g?.group.coordinatorRoleId?role(g.group.coordinatorRoleId):undefined;const output=g?.deliveries.at(-1)?.artifact;return lead&&api.businessTasks&&output?{api:api.businessTasks,artifacts:api.artifacts,output,assignee:{roleId:lead.id,expectedVersion:lead.version}}:undefined})()} note={drafts[teamDecisionSubject(decision.record)]??''} changeNote={note=>setDrafts(old=>({...old,[teamDecisionSubject(decision.record)]:note}))} close={()=>setDecision(undefined)} changed={r=>{setDecision(undefined);setReceipt(r.summary);setReload(v=>v+1)}}/>}
  {recordDetail&&renderRecord?.(recordDetail,()=>setRecordDetail(undefined))}
  {team&&<ContextDrawer padded title={team.group.name} close={()=>setSelected(undefined)}><div className={css.detail}><p>{team.brief?.summary??team.group.purpose}</p><button type="button" className={light.link} onClick={()=>openGroup(team.group.id)}>{text('group')}<ArrowUpRight size={14}/></button><section><h3>{text('boundary')}</h3>{team.phase==='failed'&&<p role="alert">{text('failure')}</p>}{team.brief?.notes.map((n,i)=><p key={i}>{n}</p>)}</section><section><h3>{text('outputs')}</h3>{fixed(team)}</section><section><h3>{text('checks')}</h3><p>{text('qualityHint')}</p>{team.reviews.map(r=>output(r,<>{roleName(r.task.assigneeRoleId!)} · v{r.artifact.version} · {dateTime(r.version.at)}</>))}{!team.reviews.length&&<p>{text('noReview')}</p>}{team.ownerReviews.map(r=><div key={r.id}><p>{r.summary}</p><button type="button" className={light.link} onClick={()=>{setSelected(undefined);setRecordDetail(r)}}>{text('record')}</button></div>)}</section><p>{text('separate')}</p></div></ContextDrawer>}
 </>
}
